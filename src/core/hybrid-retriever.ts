import { MemoryStore } from '../storage/db.js';
import { MemoryConfig } from '../config.js';
import { MemoryRecord, RecallOptions, ScoredMemory } from '../types/memory.js';
import { extractErrorFingerprint } from './error-fingerprint.js';

export class HybridRetriever {
  constructor(
    private store: MemoryStore,
    private config: MemoryConfig['retrieval']
  ) {}

  public async retrieve(query: string, options: RecallOptions = {}): Promise<ScoredMemory[]> {
    const topK = options.topK ?? this.config.defaultTopK;
    const minScore = options.minScore ?? this.config.minScore;
    const currentFilePath = options.currentFilePath || '';
    const currentGitBranch = options.currentGitBranch || '';
    const now = Date.now();

    // Context-Aware Error Fingerprint from Query
    const queryFp = extractErrorFingerprint(query);
    const isErrorQuery = queryFp.errorType !== 'RUNTIME_EXCEPTION' || query.toLowerCase().includes('error');

    // 1. Vector Search
    const embeddingAdapter = this.store.getEmbeddingAdapter();
    const queryVec = await embeddingAdapter.embed(query, true);
    const vectorMatches = this.store.getVectorStore().search(queryVec, topK * 3);
    const vectorScoreMap = new Map<string, number>();
    for (const vm of vectorMatches) {
      vectorScoreMap.set(vm.id, vm.similarity);
    }

    // 2. FTS5 BM25 Search
    const ftsMatches = this.store.getFtsStore().searchFts(query, topK * 3);
    const bm25ScoreMap = new Map<string, number>();
    for (const fm of ftsMatches) {
      bm25ScoreMap.set(fm.id, fm.bm25Score);
    }

    // 3. Collect all candidate memory IDs
    const candidateIds = new Set<string>([
      ...vectorScoreMap.keys(),
      ...bm25ScoreMap.keys()
    ]);

    if (candidateIds.size === 0) {
      const stmt = this.store.getDb().prepare(`
        SELECT id FROM memories
        WHERE (invalid_at IS NULL OR invalid_at > ?)
        ORDER BY importance DESC, last_accessed_at DESC
        LIMIT ?
      `);
      const fallbackRows = stmt.all(now, topK) as Array<{ id: string }>;
      for (const r of fallbackRows) candidateIds.add(r.id);
    }

    // 4. Fetch full records & compute composite scores with Domain Guard & Git Branch Visibility
    const scoredList: ScoredMemory[] = [];
    const queryLower = query.toLowerCase();

    for (const id of candidateIds) {
      const memory = this.store.getMemoryById(id);
      if (!memory) continue;

      if (memory.invalid_at && memory.invalid_at <= now) {
        continue;
      }

      if (!options.includeTentative && memory.status === 'deprecated') {
        continue;
      }

      if (options.scope && options.scope !== 'all' && memory.scope !== options.scope) {
        continue;
      }

      if (options.tier && options.tier !== 'all' && memory.tier !== options.tier) {
        continue;
      }

      if (options.category && memory.category !== options.category) {
        continue;
      }

      // Git Branch Visibility Gating: Prevent future branch pollution
      if (!this.isBranchVisible(currentGitBranch, memory.git_branch)) {
        continue;
      }

      // Monorepo Path-pattern filter
      if (currentFilePath && !this.matchesPathPattern(currentFilePath, memory.path_pattern)) {
        continue;
      }

      // Domain Guard: Anti-Overfitting Check for Post-Mortems
      if (memory.tier === 'episodic' && isErrorQuery && memory.error_signature) {
        const memSig = memory.error_signature;

        if (queryFp.errorType === 'MISSING_PACKAGE' && memSig.includes('[MISSING_LOCAL_FILE:')) {
          continue;
        }

        if (queryFp.errorType === 'MISSING_LOCAL_FILE' && memSig.includes('[MISSING_PACKAGE:')) {
          continue;
        }
      }

      // Component scores
      let vecScore = vectorScoreMap.get(id) || 0.0;
      let bm25Score = bm25ScoreMap.get(id) || 0.0;
      const recencyScore = this.calculateRecencyScore(memory.last_accessed_at, now);
      const importanceScore = this.calculateImportanceScore(memory.importance, memory.access_count);

      // Exact signature / entity key match boost
      if (memory.entity_key && queryLower.includes(memory.entity_key.toLowerCase())) {
        bm25Score = Math.max(bm25Score, 0.95);
      }
      if (memory.error_signature && queryLower.includes(memory.error_signature.toLowerCase())) {
        bm25Score = Math.max(bm25Score, 0.98);
        vecScore = Math.max(vecScore, 0.90);
      }

      // Target Symbol match boost
      if (queryFp.targetSymbol && memory.error_signature && memory.error_signature.includes(queryFp.targetSymbol)) {
        bm25Score = Math.max(bm25Score, 0.99);
        vecScore = Math.max(vecScore, 0.95);
      }

      const totalScore = (
        this.config.vectorWeight * vecScore +
        this.config.bm25Weight * bm25Score +
        this.config.recencyWeight * recencyScore +
        this.config.importanceWeight * importanceScore
      );

      if (totalScore >= minScore) {
        scoredList.push({
          memory,
          score: totalScore,
          breakdown: {
            vectorScore: vecScore,
            bm25Score,
            recencyScore,
            importanceScore
          }
        });
      }
    }

    scoredList.sort((a, b) => b.score - a.score);
    const results = scoredList.slice(0, topK);

    for (const res of results) {
      this.store.recordMemoryAccess(res.memory.id);
    }

    return results;
  }

  private isBranchVisible(currentBranch: string, memoryBranch?: string): boolean {
    if (!memoryBranch || memoryBranch === '*' || memoryBranch === 'main' || memoryBranch === 'master') {
      return true; // Baseline rules are globally visible across all branches
    }
    if (!currentBranch) {
      return true;
    }
    return memoryBranch === currentBranch;
  }

  private calculateRecencyScore(lastAccessedAt: number, now: number): number {
    const elapsedDays = Math.max(0, (now - lastAccessedAt) / (1000 * 60 * 60 * 24));
    const halfLife = Math.max(1, this.config.decayHalfLifeDays);
    return Math.pow(2, -elapsedDays / halfLife);
  }

  private calculateImportanceScore(importance: number, accessCount: number): number {
    const base = Math.min(1.0, Math.max(0.0, importance / 5.0));
    const accessBoost = 0.05 * Math.log(1 + accessCount);
    return Math.min(1.0, base + accessBoost);
  }

  public matchesPathPattern(filePath: string, pattern: string): boolean {
    if (!pattern || pattern === '*') return true;
    const normalizedFile = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

    if (normalizedFile === normalizedPattern) return true;

    const regexPattern = normalizedPattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/(?<!\.)\*/g, '[^/]*');
    return new RegExp(`^${regexPattern}$`).test(normalizedFile);
  }
}

import { MemoryStore } from '../storage/db.js';
import { MemoryConfig } from '../config.js';
import { MemoryRecord, RecallOptions, ScoredMemory } from '../types/memory.js';
import { extractErrorFingerprint } from './error-fingerprint.js';

export type QueryRewriter = (query: string) => Promise<string>;

/** Retrieval signal maps, max-merged across every query variant. */
interface SignalMaps {
  vector: Map<string, number>;
  bm25: Map<string, number>;
}

export class HybridRetriever {
  constructor(
    private store: MemoryStore,
    private config: MemoryConfig['retrieval'],
    private rewriter?: QueryRewriter
  ) {}

  public async retrieve(query: string, options: RecallOptions = {}): Promise<ScoredMemory[]> {
    const topK = options.topK ?? this.config.defaultTopK;
    const minScore = options.minScore ?? this.config.minScore;
    const now = Date.now();

    // Query variants: raw query always; rewritten query when a rewriter is
    // configured (failure degrades to raw-only). All variants are searched
    // and max-merged, so a weak variant can never lose what another found.
    const queries: string[] = [query];
    if (this.rewriter) {
      try {
        const rewritten = await this.rewriter(query);
        if (rewritten && rewritten !== query) queries.push(rewritten);
      } catch {
        // fall back to the raw query only
      }
    }

    const maps = await this.collectSignals(queries);

    // Pseudo-relevance feedback (local & free): expand with the entity keys /
    // signatures of the first pass's top hits, closing the cold-vocabulary
    // gap (the query lacks a term that only exists inside stored memories).
    if (this.config.prf !== false) {
      const firstPass = this.scoreCandidates(maps, query, options, minScore, now);
      const expansionSource = firstPass.slice(0, 3);
      if (expansionSource.length > 0) {
        const expansion = expansionSource
          .map((s) => `${s.memory.summary} ${s.memory.entity_key ?? ''} ${s.memory.error_signature ?? ''}`.trim())
          .join(' ')
          .slice(0, 400);
        await this.collectSignals([expansion], maps);
      }
    }

    const scoredList = this.scoreCandidates(maps, query, options, minScore, now);
    scoredList.sort((a, b) => b.score - a.score);
    const results = scoredList.slice(0, topK);

    for (const res of results) {
      this.store.recordMemoryAccess(res.memory.id);
    }

    return results;
  }

  /** Vector + BM25 for every query, max-merged into `maps` (created when absent). */
  private async collectSignals(queries: string[], maps?: SignalMaps): Promise<SignalMaps> {
    const result: SignalMaps = maps ?? { vector: new Map(), bm25: new Map() };
    const embeddingAdapter = this.store.getEmbeddingAdapter();
    const topK = this.config.defaultTopK;

    for (const q of queries) {
      const queryVec = await embeddingAdapter.embed(q, true);
      for (const vm of this.store.getVectorStore().search(queryVec, topK * 4)) {
        result.vector.set(vm.id, Math.max(result.vector.get(vm.id) ?? 0, vm.similarity));
      }
      for (const fm of this.store.getFtsStore().searchFts(q, topK * 4)) {
        result.bm25.set(fm.id, Math.max(result.bm25.get(fm.id) ?? 0, fm.bm25Score));
      }
    }
    return result;
  }

  /** Filter, boost, and composite-score every candidate id in the signal maps. */
  private scoreCandidates(
    maps: SignalMaps,
    query: string,
    options: RecallOptions,
    minScore: number,
    now: number
  ): ScoredMemory[] {
    const currentFilePath = options.currentFilePath || '';
    const currentGitBranch = options.currentGitBranch || '';
    const candidateIds = new Set<string>([...maps.vector.keys(), ...maps.bm25.keys()]);

    if (candidateIds.size === 0) {
      // Cold-store fallback: importance-ranked ids (origin-visible only).
      const stmt = this.store.getDb().prepare(`
        SELECT id FROM memories
        WHERE (invalid_at IS NULL OR invalid_at > ?)
          AND (scope = 'global' OR origin_cwd IS NULL OR origin_cwd = '*' OR origin_cwd = ?)
        ORDER BY importance DESC, last_accessed_at DESC
        LIMIT ?
      `);
      const fallbackRows = stmt.all(now, process.cwd(), this.config.defaultTopK) as Array<{ id: string }>;
      for (const r of fallbackRows) candidateIds.add(r.id);
    }

    // Error fingerprints always come from the RAW query: signatures match
    // literal text, not paraphrases.
    const queryFp = extractErrorFingerprint(query);
    const isErrorQuery = queryFp.errorType !== 'RUNTIME_EXCEPTION' || query.toLowerCase().includes('error');
    const queryLower = query.toLowerCase();

    const scoredList: ScoredMemory[] = [];

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

      // Project-origin visibility (user-level scope): workspace rows only
      // surface inside their originating project; global rows follow the user.
      if (!this.store.isOriginVisible(memory)) {
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
      let vecScore = maps.vector.get(id) || 0.0;
      let bm25Score = maps.bm25.get(id) || 0.0;
      const recencyScore = this.calculateRecencyScore(memory.last_accessed_at, now);
      const importanceScore = this.calculateImportanceScore(memory.importance, memory.access_count);

      // Exact signature / entity key match boost (raw query)
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

      // User-authored corrections are privileged ground truth: on a topical
      // match they should outrank ordinary facts of equal relevance (bounded
      // boost, consistent with the working set's dedicated top section).
      const finalScore = memory.category === 'correction' ? totalScore + 0.05 : totalScore;

      if (finalScore >= minScore) {
        scoredList.push({
          memory,
          score: finalScore,
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
    return scoredList;
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

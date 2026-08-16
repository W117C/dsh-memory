import { MemoryStore } from '../storage/db.js';
import { MemoryConfig } from '../config.js';
import { MemoryRecord } from '../types/memory.js';

interface CachedWorkingSet {
  content: string;
  filePath: string;
  gitBranch: string;
  builtAt: number;
}

export function normalizeForKvCache(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export class WorkingSetBuilder {
  private sessionCache = new Map<string, CachedWorkingSet>();

  constructor(
    private store: MemoryStore,
    private config: MemoryConfig['retrieval']
  ) {}

  public getOrCreateWorkingSet(sessionId: string, currentFilePath = '', currentGitBranch = ''): string {
    const cached = this.sessionCache.get(sessionId);

    // If cached and neither package root nor git branch changed, return cached to preserve KV-Cache
    if (cached) {
      if (
        !this.hasPackageRootChanged(cached.filePath, currentFilePath) &&
        cached.gitBranch === currentGitBranch
      ) {
        return cached.content;
      }
    }

    const workingSet = this.buildWorkingSet(currentFilePath, currentGitBranch);
    this.sessionCache.set(sessionId, {
      content: workingSet,
      filePath: currentFilePath,
      gitBranch: currentGitBranch,
      builtAt: Date.now()
    });
    return workingSet;
  }

  private hasPackageRootChanged(oldPath: string, newPath: string): boolean {
    if (!oldPath || !newPath) return false;
    const getRoot = (p: string) => p.replace(/\\/g, '/').split('/')[0] || '';
    return getRoot(oldPath) !== getRoot(newPath);
  }

  public invalidateSession(sessionId: string): void {
    this.sessionCache.delete(sessionId);
  }

  public buildWorkingSet(currentFilePath = '', currentGitBranch = ''): string {
    const now = Date.now();
    const maxTokens = this.config.maxWorkingSetTokens;
    let approxTokenCount = 0;
    const cwd = process.cwd();
    // Origin visibility: global rows + legacy '*' rows are always visible;
    // workspace rows only inside their originating project.
    const originVisible = `(scope = 'global' OR origin_cwd IS NULL OR origin_cwd = '*' OR origin_cwd = @cwd)`;

    // 0. User corrections — highest priority (user-authored, cross-project)
    const stmtCorrections = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'semantic'
        AND category = 'correction'
        AND status = 'verified'
        AND (invalid_at IS NULL OR invalid_at > @now)
        AND ${originVisible}
      ORDER BY importance DESC, last_accessed_at DESC
      LIMIT 20
    `);
    const corrections = (stmtCorrections.all({ now, cwd }) as MemoryRecord[])
      .filter(r => this.isBranchVisible(currentGitBranch, r.git_branch));

    // 1. Fetch active verified rules & preferences (Up to 50 candidates)
    const stmtRules = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'semantic'
        AND status = 'verified'
        AND category != 'correction'
        AND (invalid_at IS NULL OR invalid_at > @now)
        AND ${originVisible}
      ORDER BY importance DESC, access_count DESC
      LIMIT 50
    `);
    const allCandidateRules = stmtRules.all({ now, cwd }) as MemoryRecord[];

    // 2. Fetch top verified post-mortems
    const stmtPostMortems = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'episodic'
        AND category = 'post_mortem'
        AND status = 'verified'
        AND (invalid_at IS NULL OR invalid_at > @now)
        AND ${originVisible}
      ORDER BY importance DESC, verification_count DESC
      LIMIT 10
    `);
    const allPostMortems = stmtPostMortems.all({ now, cwd }) as MemoryRecord[];

    // 3. Fetch top verified workflow recipes
    const stmtRecipes = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'procedural'
        AND category = 'workflow'
        AND status = 'verified'
        AND (invalid_at IS NULL OR invalid_at > @now)
        AND ${originVisible}
      ORDER BY importance DESC
      LIMIT 10
    `);
    const allRecipes = stmtRecipes.all({ now, cwd }) as MemoryRecord[];

    const lines: string[] = ['<dsh_memory version="1.1">'];

    if (corrections.length > 0) {
      lines.push('[User Corrections — do not repeat]');
      for (const c of corrections) {
        const line = `- ${c.summary}`;
        const tokens = this.estimateTokens(line);
        if (approxTokenCount + tokens > maxTokens * 0.3) break;
        lines.push(line);
        approxTokenCount += tokens;
      }
    }

    // 4. Branch Visibility & Specificity-Aware Rule Ranking:
    const matchedRules = allCandidateRules
      .filter(r => this.isBranchVisible(currentGitBranch, r.git_branch))
      .filter(r => this.matchesPath(currentFilePath, r.path_pattern));

    matchedRules.sort((a, b) => {
      const specA = this.calculatePathSpecificity(currentFilePath, a.path_pattern);
      const specB = this.calculatePathSpecificity(currentFilePath, b.path_pattern);
      const prioA = specA * 4.0 + (a.importance || 1.0) * 2.0 + 0.5 * Math.log(1 + a.access_count);
      const prioB = specB * 4.0 + (b.importance || 1.0) * 2.0 + 0.5 * Math.log(1 + b.access_count);
      return prioB - prioA;
    });

    if (matchedRules.length > 0) {
      lines.push('[Active Rules & Norms]');
      for (const rule of matchedRules) {
        const line = `- ${rule.entity_key ? `${rule.entity_key}: ` : ''}${rule.summary}`;
        const tokens = this.estimateTokens(line);
        if (approxTokenCount + tokens > maxTokens * 0.5) break;
        lines.push(line);
        approxTokenCount += tokens;
      }
    }

    // 5. Assemble Post-Mortems with path & branch relevance
    const matchedPostMortems = allPostMortems
      .filter(pm => this.isBranchVisible(currentGitBranch, pm.git_branch))
      .filter(pm => this.matchesPath(currentFilePath, pm.path_pattern));

    if (matchedPostMortems.length > 0 && approxTokenCount < maxTokens * 0.8) {
      lines.push('[High-Frequency Post-Mortems]');
      for (const pm of matchedPostMortems) {
        const line = `- ${pm.error_signature || 'Error'}: ${pm.solution_code || pm.summary}`;
        const tokens = this.estimateTokens(line);
        if (approxTokenCount + tokens > maxTokens * 0.8) break;
        lines.push(line);
        approxTokenCount += tokens;
      }
    }

    // 6. Assemble Recipes
    const matchedRecipes = allRecipes
      .filter(rc => this.isBranchVisible(currentGitBranch, rc.git_branch))
      .filter(rc => this.matchesPath(currentFilePath, rc.path_pattern));

    if (matchedRecipes.length > 0 && approxTokenCount < maxTokens) {
      lines.push('[Verified Workflow Recipes]');
      for (const rc of matchedRecipes) {
        const line = `- ${rc.entity_key || 'Recipe'}: ${rc.solution_code || rc.summary}`;
        const tokens = this.estimateTokens(line);
        if (approxTokenCount + tokens > maxTokens) break;
        lines.push(line);
        approxTokenCount += tokens;
      }
    }

    lines.push('</dsh_memory>');

    if (lines.length <= 2) {
      return '';
    }

    return normalizeForKvCache(lines.join('\n'));
  }

  private isBranchVisible(currentBranch: string, memoryBranch?: string): boolean {
    if (!memoryBranch || memoryBranch === '*' || memoryBranch === 'main' || memoryBranch === 'master') {
      return true;
    }
    if (!currentBranch) {
      return true;
    }
    return memoryBranch === currentBranch;
  }

  public calculatePathSpecificity(currentFilePath: string, pattern: string): number {
    if (!pattern || pattern === '*') return 1.0;
    if (!currentFilePath) return 1.5;

    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalizedPattern.split('/').filter(s => s && s !== '**' && s !== '*');
    return 1.5 + Math.min(3.0, segments.length * 0.8);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  private matchesPath(filePath: string, pattern: string): boolean {
    if (!pattern || pattern === '*' || !filePath) return true;
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

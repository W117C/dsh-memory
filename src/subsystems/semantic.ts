import { MemoryStore } from '../storage/db.js';
import { MemoryRecord, MemoryCreateInput } from '../types/memory.js';
import { ConflictResolver } from '../core/conflict-resolver.js';

export class SemanticMemoryManager {
  private resolver: ConflictResolver;

  constructor(private store: MemoryStore) {
    this.resolver = new ConflictResolver(store);
  }

  public async setRule(key: string, ruleContent: string, pathPattern = '*'): Promise<MemoryRecord> {
    const input: MemoryCreateInput = {
      tier: 'semantic',
      category: 'rule',
      entity_key: key,
      path_pattern: pathPattern,
      content: ruleContent,
      summary: ruleContent.slice(0, 100).replace(/\n/g, ' '),
      importance: 4.0,
      status: 'verified'
    };

    const res = await this.resolver.resolveAndApply(input);
    return this.store.getMemoryById(res.memoryId)!;
  }

  public async setPreference(key: string, preference: string, pathPattern = '*'): Promise<MemoryRecord> {
    const input: MemoryCreateInput = {
      tier: 'semantic',
      category: 'preference',
      entity_key: key,
      path_pattern: pathPattern,
      content: preference,
      summary: preference.slice(0, 100).replace(/\n/g, ' '),
      importance: 3.5,
      status: 'verified'
    };

    const res = await this.resolver.resolveAndApply(input);
    return this.store.getMemoryById(res.memoryId)!;
  }

  /**
   * Hierarchical Scoped Lookup:
   * 1. Check for exact pathPattern match (e.g. apps/web/**::config.port)
   * 2. Fallback to global match (*::config.port)
   */
  public getRule(key: string, pathPattern = '*'): MemoryRecord | null {
    const now = Date.now();

    // 1. Exact scope lookup
    const stmtExact = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'semantic' AND category = 'rule'
        AND entity_key = ? AND path_pattern = ?
        AND (invalid_at IS NULL OR invalid_at > ?)
      LIMIT 1
    `);
    const exact = stmtExact.get(key, pathPattern, now) as MemoryRecord | undefined;
    if (exact) return exact;

    // 2. Global fallback lookup
    if (pathPattern !== '*') {
      const stmtGlobal = this.store.getDb().prepare(`
        SELECT * FROM memories
        WHERE tier = 'semantic' AND category = 'rule'
          AND entity_key = ? AND path_pattern = '*'
          AND (invalid_at IS NULL OR invalid_at > ?)
        LIMIT 1
      `);
      const global = stmtGlobal.get(key, now) as MemoryRecord | undefined;
      if (global) return global;
    }

    return null;
  }

  public getAllActiveRules(currentFilePath = ''): MemoryRecord[] {
    const now = Date.now();
    const stmt = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'semantic' AND category = 'rule'
        AND (invalid_at IS NULL OR invalid_at > ?)
      ORDER BY importance DESC, access_count DESC
    `);
    const rows = stmt.all(now) as MemoryRecord[];

    if (!currentFilePath) return rows;
    return rows.filter(r => this.matchesPath(currentFilePath, r.path_pattern));
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

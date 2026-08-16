import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryConfig } from '../config.js';
import { MemoryRecord, MemoryCreateInput, MemoryUpdateInput, MemoryRelation, MemoryStats, MemoryHistoryRecord } from '../types/memory.js';
import { VectorStore } from './vector-store.js';
import { FtsStore } from './fts-store.js';
import { EmbeddingAdapter } from './embedding.js';
import { redactSecrets } from '../core/secret-redactor.js';

export interface ExtendedMemoryUpdateInput extends MemoryUpdateInput {
  verification_count?: number;
  error_signature?: string;
  reason?: string;
}

export class MemoryStore {
  private db: Database.Database;
  private vectorStore: VectorStore;
  private ftsStore: FtsStore;
  private embeddingAdapter: EmbeddingAdapter;
  private dbPath: string;

  constructor(config: MemoryConfig, customPath?: string) {
    this.dbPath = customPath || this.resolveDatabasePath(config);
    this.ensureDirectoryExists(this.dbPath);

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.embeddingAdapter = new EmbeddingAdapter(config.embedding);
    this.initTables();

    this.vectorStore = new VectorStore(
      this.db,
      this.embeddingAdapter.getDimension(),
      config.storage.forceJsVector
    );
    this.ftsStore = new FtsStore(this.db);
  }

  public getVectorStore(): VectorStore {
    return this.vectorStore;
  }

  public getFtsStore(): FtsStore {
    return this.ftsStore;
  }

  public getEmbeddingAdapter(): EmbeddingAdapter {
    return this.embeddingAdapter;
  }

  public getDb(): Database.Database {
    return this.db;
  }

  private resolveDatabasePath(config: MemoryConfig): string {
    if (config.storage.workspaceDbPath) {
      return config.storage.workspaceDbPath;
    }
    if (config.storage.globalDbPath) {
      return config.storage.globalDbPath;
    }
    // Single user-level store by default: scope='global' memories follow the
    // user across projects; scope='workspace' rows are isolated per project
    // through the origin_cwd visibility rule (legacy '*' rows stay visible).
    return path.join(os.homedir(), '.dsh', 'memory.db');
  }

  /**
   * Origin visibility: global-scope rows are always visible; workspace rows
   * are visible inside their originating project; legacy rows stamped '*'
   * (pre-v2.2 or hand-seeded) remain visible everywhere.
   */
  public isOriginVisible(memory: Pick<MemoryRecord, 'scope' | 'origin_cwd'>, cwd: string = process.cwd()): boolean {
    if (memory.scope === 'global') return true;
    if (!memory.origin_cwd || memory.origin_cwd === '*') return true;
    return path.resolve(memory.origin_cwd) === path.resolve(cwd);
  }

  private ensureDirectoryExists(filePath: string): void {
    if (filePath === ':memory:') return;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('workspace', 'global')),
        tier TEXT NOT NULL CHECK(tier IN ('semantic', 'episodic', 'procedural', 'working')),
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'tentative' CHECK(status IN ('tentative', 'verified', 'deprecated')),
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        entity_key TEXT,
        path_pattern TEXT DEFAULT '*',
        error_signature TEXT,
        solution_code TEXT,
        git_branch TEXT DEFAULT '*',
        git_commit TEXT,
        origin_cwd TEXT DEFAULT '*',
        verification_count INTEGER DEFAULT 0,
        importance REAL DEFAULT 1.0,
        access_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        valid_from INTEGER NOT NULL,
        invalid_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_mem_lookup ON memories(scope, tier, status, invalid_at);
      CREATE INDEX IF NOT EXISTS idx_mem_entity ON memories(entity_key) WHERE invalid_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_mem_path ON memories(path_pattern);
      CREATE INDEX IF NOT EXISTS idx_mem_branch ON memories(git_branch);
      CREATE INDEX IF NOT EXISTS idx_mem_origin ON memories(origin_cwd);

      CREATE TABLE IF NOT EXISTS memory_relations (
        source_entity TEXT NOT NULL,
        relation TEXT NOT NULL,
        target_entity TEXT NOT NULL,
        memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(source_entity, relation, target_entity)
      );

      CREATE INDEX IF NOT EXISTS idx_rel_src ON memory_relations(source_entity);
      CREATE INDEX IF NOT EXISTS idx_rel_tgt ON memory_relations(target_entity);

      CREATE TABLE IF NOT EXISTS memory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        event TEXT NOT NULL CHECK(event IN ('created', 'updated', 'deleted', 'promoted', 'deprecated')),
        before_json TEXT,
        after_json TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hist_memory ON memory_history(memory_id, id DESC);
    `);

    try {
      this.db.exec('ALTER TABLE memories ADD COLUMN git_branch TEXT DEFAULT "*"');
    } catch {}
    try {
      this.db.exec('ALTER TABLE memories ADD COLUMN git_commit TEXT')
    } catch {}
    try {
      this.db.exec('ALTER TABLE memories ADD COLUMN origin_cwd TEXT DEFAULT "*"');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_mem_origin ON memories(origin_cwd)');
    } catch {}
  }

  public async createMemory(input: MemoryCreateInput): Promise<MemoryRecord> {
    const id =
      input.id && /^mem_[A-Za-z0-9_-]{1,120}$/.test(input.id)
        ? input.id
        : `mem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();

    // Pervasive Secret Redaction before persistence
    const sanitizedContent = redactSecrets(input.content);
    const rawSummary = input.summary || input.content.slice(0, 120).replace(/\n/g, ' ');
    const sanitizedSummary = redactSecrets(rawSummary);
    const sanitizedSolution = input.solution_code ? redactSecrets(input.solution_code) : undefined;
    const sanitizedErrorSig = input.error_signature ? redactSecrets(input.error_signature) : undefined;

    const record: MemoryRecord = {
      id,
      scope: input.scope || 'workspace',
      tier: input.tier,
      category: input.category,
      status: input.status || 'tentative',
      content: sanitizedContent,
      summary: sanitizedSummary,
      entity_key: input.entity_key,
      path_pattern: input.path_pattern || '*',
      error_signature: sanitizedErrorSig,
      solution_code: sanitizedSolution,
      git_branch: input.git_branch || '*',
      git_commit: input.git_commit,
      origin_cwd: (input.scope || 'workspace') === 'global' ? '*' : process.cwd(),
      verification_count: input.status === 'verified' ? 1 : 0,
      importance: input.importance ?? 1.0,
      access_count: 0,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      valid_from: now,
      invalid_at: null
    } as MemoryRecord;

    // Document-side embedding: summary + keys carry the salient terms, the
    // content head adds the semantic body summaries alone are too terse for.
    const textToEmbed = `${record.summary} ${record.entity_key || ''} ${record.error_signature || ''} ${sanitizedContent.slice(0, 300)}`;
    const embedding = await this.embeddingAdapter.embed(textToEmbed, false);

    const insertTx = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO memories (
          id, scope, tier, category, status, content, summary,
          entity_key, path_pattern, error_signature, solution_code,
          git_branch, git_commit, origin_cwd,
          verification_count, importance, access_count,
          created_at, updated_at, last_accessed_at, valid_from, invalid_at
        ) VALUES (
          @id, @scope, @tier, @category, @status, @content, @summary,
          @entity_key, @path_pattern, @error_signature, @solution_code,
          @git_branch, @git_commit, @origin_cwd,
          @verification_count, @importance, @access_count,
          @created_at, @updated_at, @last_accessed_at, @valid_from, @invalid_at
        )
      `);
      stmt.run(record);

      this.ftsStore.upsertFts(id, record.content, record.summary, record.error_signature || '');
      this.vectorStore.upsertVector(id, embedding);
    });

    insertTx();
    this.recordHistory(id, 'created', null, record, input.reason);
    return record;
  }

  public getMemoryById(id: string): MemoryRecord | null {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    const row = stmt.get(id) as MemoryRecord | undefined;
    return row || null;
  }

  public updateMemory(id: string, updates: ExtendedMemoryUpdateInput): MemoryRecord | null {
    const existing = this.getMemoryById(id);
    if (!existing) return null;

    const now = Date.now();
    const newContent = updates.content !== undefined ? redactSecrets(updates.content) : existing.content;
    const newSummary = updates.summary !== undefined
      ? redactSecrets(updates.summary)
      : (updates.content ? redactSecrets(updates.content.slice(0, 120)) : existing.summary);
    const newPath = updates.path_pattern ?? existing.path_pattern;
    const newSolution = updates.solution_code !== undefined ? redactSecrets(updates.solution_code) : existing.solution_code;
    const newImportance = updates.importance ?? existing.importance;
    const newStatus = updates.status ?? existing.status;
    const newInvalidAt = updates.invalid_at !== undefined ? updates.invalid_at : existing.invalid_at;
    const newCount = updates.verification_count !== undefined ? updates.verification_count : existing.verification_count;
    const newErrorSig = updates.error_signature !== undefined ? redactSecrets(updates.error_signature) : existing.error_signature;
    const newBranch = updates.git_branch ?? existing.git_branch;

    const updateTx = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE memories SET
          content = ?,
          summary = ?,
          path_pattern = ?,
          solution_code = ?,
          importance = ?,
          status = ?,
          invalid_at = ?,
          verification_count = ?,
          error_signature = ?,
          git_branch = ?,
          updated_at = ?
        WHERE id = ?
      `);

      stmt.run(newContent, newSummary, newPath, newSolution, newImportance, newStatus, newInvalidAt, newCount, newErrorSig, newBranch, now, id);

      if (updates.content || updates.summary || updates.error_signature) {
        this.ftsStore.upsertFts(id, newContent, newSummary, newErrorSig || '');
      }
    });

    updateTx();
    const after = this.getMemoryById(id);
    const event = this.classifyUpdate(existing, after, updates);
    this.recordHistory(id, event, existing, after, (updates as { reason?: string }).reason);
    return after;
  }

  private classifyUpdate(
    before: MemoryRecord,
    after: MemoryRecord | null,
    updates: ExtendedMemoryUpdateInput
  ): 'updated' | 'promoted' | 'deprecated' {
    if (after && before.status !== 'verified' && after.status === 'verified') return 'promoted';
    if (after && after.status === 'deprecated' && before.status !== 'deprecated') return 'deprecated';
    void updates;
    return 'updated';
  }

  private recordHistory(
    memoryId: string,
    event: 'created' | 'updated' | 'deleted' | 'promoted' | 'deprecated',
    before: MemoryRecord | null,
    after: MemoryRecord | null,
    reason?: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_history (memory_id, event, before_json, after_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      memoryId,
      event,
      before ? JSON.stringify(this.projectForHistory(before)) : null,
      after ? JSON.stringify(this.projectForHistory(after)) : null,
      reason ?? null,
      Date.now()
    );
  }

  /** History projection: the fields a change review actually diffs. */
  private projectForHistory(mem: MemoryRecord): Record<string, unknown> {
    return {
      id: mem.id,
      tier: mem.tier,
      category: mem.category,
      status: mem.status,
      content: mem.content,
      summary: mem.summary,
      entity_key: mem.entity_key,
      path_pattern: mem.path_pattern,
      solution_code: mem.solution_code,
      importance: mem.importance,
      verification_count: mem.verification_count,
      valid_from: mem.valid_from,
      invalid_at: mem.invalid_at
    };
  }

  public getMemoryHistory(memoryId: string, limit = 50): MemoryHistoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, memory_id, event, before_json, after_json, reason, created_at
      FROM memory_history
      WHERE memory_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(memoryId, limit) as MemoryHistoryRecord[];
  }

  public getAllHistory(limit = 200): MemoryHistoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, memory_id, event, before_json, after_json, reason, created_at
      FROM memory_history
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as MemoryHistoryRecord[];
  }

  public recordMemoryAccess(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories SET
        access_count = access_count + 1,
        last_accessed_at = ?
      WHERE id = ?
    `);
    stmt.run(Date.now(), id);
  }

  public deleteMemory(id: string): boolean {
    let changes = 0;
    const existing = this.getMemoryById(id);
    const deleteTx = this.db.transaction(() => {
      const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
      const result = stmt.run(id);
      changes = result.changes;
      this.vectorStore.deleteVector(id);
      this.ftsStore.deleteFts(id);
    });
    deleteTx();
    if (existing && changes > 0) this.recordHistory(id, 'deleted', existing, null);
    return changes > 0;
  }

  public addRelation(rel: MemoryRelation): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_relations (source_entity, relation, target_entity, memory_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_entity, relation, target_entity) DO UPDATE SET
        memory_id = excluded.memory_id
    `);
    stmt.run(rel.source_entity, rel.relation, rel.target_entity, rel.memory_id || null, Date.now());
  }

  public getRelationsForEntity(entity: string): MemoryRelation[] {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT r.* FROM memory_relations r
      LEFT JOIN memories m ON r.memory_id = m.id
      WHERE (r.source_entity = ? OR r.target_entity = ?)
        AND (m.invalid_at IS NULL OR m.invalid_at > ?)
    `);
    return stmt.all(entity, entity, now) as MemoryRelation[];
  }

  public vacuum(retentionDays = 30): { prunedCount: number } {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let prunedCount = 0;

    const vacuumTx = this.db.transaction(() => {
      const stmtFind = this.db.prepare(`
        SELECT id FROM memories
        WHERE status = 'deprecated' AND invalid_at IS NOT NULL AND invalid_at < ?
      `);
      const staleRows = stmtFind.all(cutoff) as Array<{ id: string }>;

      for (const row of staleRows) {
        this.deleteMemory(row.id);
        prunedCount++;
      }

      this.db.prepare(`
        DELETE FROM memory_relations
        WHERE memory_id IS NOT NULL AND memory_id NOT IN (SELECT id FROM memories)
      `).run();
    });

    vacuumTx();

    try {
      this.db.pragma('incremental_vacuum');
    } catch {}

    return { prunedCount };
  }

  public getStats(): MemoryStats {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as any).count;

    const byTier: Record<string, number> = { semantic: 0, episodic: 0, procedural: 0, working: 0 };
    const tierRows = this.db.prepare('SELECT tier, COUNT(*) as count FROM memories GROUP BY tier').all() as any[];
    for (const r of tierRows) byTier[r.tier] = r.count;

    const byStatus: Record<string, number> = { tentative: 0, verified: 0, deprecated: 0 };
    const statusRows = this.db.prepare('SELECT status, COUNT(*) as count FROM memories GROUP BY status').all() as any[];
    for (const r of statusRows) byStatus[r.status] = r.count;

    const byScope: Record<string, number> = { workspace: 0, global: 0 };
    const scopeRows = this.db.prepare('SELECT scope, COUNT(*) as count FROM memories GROUP BY scope').all() as any[];
    for (const r of scopeRows) byScope[r.scope] = r.count;

    return {
      total,
      byTier: byTier as any,
      byStatus: byStatus as any,
      byScope: byScope as any,
      vectorEngineMode: this.vectorStore.getMode(),
      databasePath: this.dbPath
    };
  }

  public close(): void {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }
}

import Database from 'better-sqlite3';

export interface FtsSearchResult {
  id: string;
  bm25Score: number; // 0.0 - 1.0 normalized score
}

export class FtsStore {
  constructor(private db: Database.Database) {
    this.initFtsTable();
  }

  private initFtsTable(): void {
    // Existing databases may already carry an FTS table without the
    // topic_keywords column (derived data — safe to rebuild from `memories`).
    const cols = this.db.prepare('PRAGMA table_info(memory_fts)').all() as Array<{ name: string }>;
    const needsRebuild = cols.length > 0 && !cols.some((c) => c.name === 'topic_keywords');
    if (needsRebuild) {
      this.db.exec('DROP TABLE IF EXISTS memory_fts');
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        content,
        summary,
        error_signature,
        topic_keywords,
        tokenize = 'unicode61'
      );
    `);
    if (needsRebuild) this.rebuildFromMemories();
  }

  /** Re-derive the whole FTS index from `memories` after a schema rebuild. */
  private rebuildFromMemories(): void {
    const rows = this.db.prepare('SELECT id, content, summary, error_signature, topic_keywords FROM memories').all() as Array<{
      id: string; content: string; summary: string; error_signature: string | null; topic_keywords: string | null;
    }>;
    const stmt = this.db.prepare(`
      INSERT INTO memory_fts (id, content, summary, error_signature, topic_keywords)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(r.id, r.content, r.summary, r.error_signature ?? '', r.topic_keywords ?? '');
      }
    });
    tx();
  }

  public upsertFts(id: string, content: string, summary: string, errorSignature = '', topicKeywords = ''): void {
    // Delete existing entry if any to prevent duplicates in FTS5
    this.deleteFts(id);

    const stmt = this.db.prepare(`
      INSERT INTO memory_fts (id, content, summary, error_signature, topic_keywords)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, content, summary, errorSignature, topicKeywords);
  }

  public deleteFts(id: string): void {
    const stmt = this.db.prepare('DELETE FROM memory_fts WHERE id = ?');
    stmt.run(id);
  }

  public searchFts(query: string, topK = 10): FtsSearchResult[] {
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) return [];

    try {
      // bm25(memory_fts) returns negative scores in sqlite (lower is better, e.g. -15.2)
      const stmt = this.db.prepare(`
        SELECT id, bm25(memory_fts) as rank
        FROM memory_fts
        WHERE memory_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);

      const rows = stmt.all(sanitized, topK) as Array<{ id: string; rank: number }>;
      return rows.map(r => ({
        id: r.id,
        // Map negative BM25 rank to normalized 0..1 score via sigmoid function
        bm25Score: this.normalizeBm25(r.rank)
      }));
    } catch (err) {
      console.warn('[FtsStore] FTS5 search error:', err);
      return [];
    }
  }

  private normalizeBm25(rank: number): number {
    // SQLite BM25 returns negative numbers where smaller is more relevant (e.g. -10 is better than -1)
    const positiveScore = Math.abs(rank);
    // Sigmoid mapping: 1 / (1 + e^(-0.25 * score))
    return 2 / (1 + Math.exp(-0.2 * positiveScore)) - 1;
  }

  private sanitizeQuery(raw: string): string {
    // Remove FTS5 control characters and tokenize words
    const cleaned = raw.replace(/[^\p{L}\p{N}\s_.-]/gu, ' ').trim();
    const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return '';
    // Format as NEAR or OR terms
    return tokens.map(t => `"${t}"`).join(' OR ');
  }
}

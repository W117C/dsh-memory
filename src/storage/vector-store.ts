import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export interface VectorSearchResult {
  id: string;
  similarity: number; // 0.0 - 1.0 (Cosine similarity)
}

export class VectorStore {
  private mode: 'sqlite-vec' | 'js-float32' | 'bm25-only' = 'sqlite-vec';
  private inMemoryIndex = new Map<string, Float32Array>();
  private dimension: number;

  constructor(
    private db: Database.Database,
    dimension = 512,
    forceJsVector = false
  ) {
    this.dimension = dimension;

    // 1. Initialize fallback table
    this.initFallbackTable();

    // 2. Determine engine mode
    if (forceJsVector) {
      this.mode = 'js-float32';
      this.loadInMemoryVectors();
      return;
    }

    try {
      // Level 1: Try loading sqlite-vec extension
      sqliteVec.load(this.db);
      this.initSqliteVecTable();
      this.mode = 'sqlite-vec';
    } catch (err) {
      console.warn('[VectorStore] Failed to load native sqlite-vec extension, falling back to JS-Float32 engine:', err);
      this.mode = 'js-float32';
      this.loadInMemoryVectors();
    }
  }

  public getMode(): 'sqlite-vec' | 'js-float32' | 'bm25-only' {
    return this.mode;
  }

  private initFallbackTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors_blob (
        id TEXT PRIMARY KEY,
        dimension INTEGER NOT NULL,
        vector_blob BLOB NOT NULL
      );
    `);
  }

  private initSqliteVecTable(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimension}]
      );
    `);
  }

  private loadInMemoryVectors(): void {
    const stmt = this.db.prepare('SELECT id, dimension, vector_blob FROM memory_vectors_blob');
    const rows = stmt.all() as Array<{ id: string; dimension: number; vector_blob: Buffer }>;
    for (const row of rows) {
      const floatArray = new Float32Array(
        row.vector_blob.buffer,
        row.vector_blob.byteOffset,
        row.vector_blob.byteLength / 4
      );
      this.inMemoryIndex.set(row.id, floatArray);
    }
  }

  public upsertVector(id: string, vector: Float32Array): void {
    // 1. Persist to blob table (Level 2 storage)
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const stmtBlob = this.db.prepare(`
      INSERT INTO memory_vectors_blob (id, dimension, vector_blob)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dimension = excluded.dimension,
        vector_blob = excluded.vector_blob
    `);
    stmtBlob.run(id, vector.length, buffer);

    // 2. Insert into sqlite-vec virtual table (Delete first then Insert because virtual tables do not support UPSERT)
    if (this.mode === 'sqlite-vec') {
      try {
        this.db.prepare('DELETE FROM vec_memories WHERE id = ?').run(id);
        const stmtVec = this.db.prepare(`
          INSERT INTO vec_memories (id, embedding)
          VALUES (?, ?)
        `);
        stmtVec.run(id, vector);
      } catch (err) {
        console.warn(`[VectorStore] sqlite-vec insert failed for ${id}, switching to js-float32:`, err);
        this.mode = 'js-float32';
        this.loadInMemoryVectors();
      }
    }

    if (this.mode === 'js-float32') {
      this.inMemoryIndex.set(id, vector);
    }
  }

  public deleteVector(id: string): void {
    this.db.prepare('DELETE FROM memory_vectors_blob WHERE id = ?').run(id);
    if (this.mode === 'sqlite-vec') {
      try {
        this.db.prepare('DELETE FROM vec_memories WHERE id = ?').run(id);
      } catch {
        // ignore
      }
    }
    if (this.mode === 'js-float32') {
      this.inMemoryIndex.delete(id);
    }
  }

  public search(queryVector: Float32Array, topK = 10): VectorSearchResult[] {
    if (this.mode === 'sqlite-vec') {
      try {
        const stmt = this.db.prepare(`
          SELECT id, distance
          FROM vec_memories
          WHERE embedding MATCH ?
          ORDER BY distance ASC
          LIMIT ?
        `);
        const rows = stmt.all(queryVector, topK) as Array<{ id: string; distance: number }>;
        return rows.map(r => ({
          id: r.id,
          // distance in vec0 for normalized vectors is cosine distance (0..2)
          similarity: Math.max(0, Math.min(1, 1 - r.distance / 2))
        }));
      } catch (err) {
        console.warn('[VectorStore] sqlite-vec search failed, falling back to js-float32:', err);
        this.mode = 'js-float32';
        this.loadInMemoryVectors();
      }
    }

    if (this.mode === 'js-float32') {
      return this.searchJs(queryVector, topK);
    }

    return [];
  }

  private searchJs(queryVector: Float32Array, topK: number): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];
    const qLen = queryVector.length;

    for (const [id, vec] of this.inMemoryIndex.entries()) {
      if (vec.length !== qLen) continue;
      // Dot product for normalized vectors
      let dot = 0;
      for (let i = 0; i < qLen; i++) {
        dot += queryVector[i] * vec[i];
      }
      // Map -1..1 cosine to 0..1 range
      const sim = Math.max(0, Math.min(1, (dot + 1) / 2));
      results.push({ id, similarity: sim });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }
}

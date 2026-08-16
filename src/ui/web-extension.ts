/**
 * Panel backend: the read/review surface the native dsh web client renders.
 * Pure host-side logic (SQLite reads + review mutations); the HTTP transport
 * lives in `../api/memory-http.ts`, the browser half in `src/client`.
 */
import { MemoryStore } from '../storage/db.js';
import { VerificationGate } from '../pipeline/verification-gate.js';
import { MemoryRecord, MemoryRelation } from '../types/memory.js';

export interface GraphData {
  nodes: Array<{ id: string; label: string; type: string; status?: string }>;
  edges: Array<{ source: string; target: string; relation: string }>;
}

export interface MemoryListItem {
  id: string;
  tier: MemoryRecord['tier'];
  category: MemoryRecord['category'];
  status: MemoryRecord['status'];
  entity_key?: string;
  summary: string;
  importance: number;
  verification_count: number;
  created_at: number;
  updated_at: number;
}

export class MemoryWebExtension {
  private gate: VerificationGate;

  constructor(private store: MemoryStore) {
    this.gate = new VerificationGate(store);
  }

  public getGraphData(): GraphData {
    const now = Date.now();
    const stmtMem = this.store.getDb().prepare(`
      SELECT id, tier, category, summary, status, entity_key FROM memories
      WHERE invalid_at IS NULL OR invalid_at > ?
    `);
    const memories = stmtMem.all(now) as MemoryRecord[];

    const stmtRel = this.store.getDb().prepare('SELECT * FROM memory_relations');
    const relations = stmtRel.all() as MemoryRelation[];

    const nodes: GraphData['nodes'] = [];
    const edges: GraphData['edges'] = [];
    const nodeSet = new Set<string>();

    for (const mem of memories) {
      const label = mem.entity_key || mem.summary.slice(0, 30);
      nodes.push({
        id: mem.id,
        label,
        type: mem.tier,
        status: mem.status
      });
      nodeSet.add(mem.id);
    }

    for (const rel of relations) {
      if (!nodeSet.has(rel.source_entity)) {
        nodes.push({ id: rel.source_entity, label: rel.source_entity, type: 'entity' });
        nodeSet.add(rel.source_entity);
      }
      if (!nodeSet.has(rel.target_entity)) {
        nodes.push({ id: rel.target_entity, label: rel.target_entity, type: 'entity' });
        nodeSet.add(rel.target_entity);
      }
      edges.push({
        source: rel.source_entity,
        target: rel.target_entity,
        relation: rel.relation
      });
    }

    return { nodes, edges };
  }

  public listMemories(filter: { status?: string; tier?: string; limit?: number }): MemoryListItem[] {
    const now = Date.now();
    const conditions = ['(invalid_at IS NULL OR invalid_at > ?)'];
    const params: unknown[] = [now];

    if (filter.status && filter.status !== 'all') {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.tier && filter.tier !== 'all') {
      conditions.push('tier = ?');
      params.push(filter.tier);
    }

    const stmt = this.store.getDb().prepare(`
      SELECT id, tier, category, status, entity_key, summary, importance, verification_count, created_at, updated_at
      FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `);
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    return stmt.all(...params) as MemoryListItem[];
  }

  /**
   * Explicit Human/Admin Review Action from the web panel:
   * Instantly promotes a tentative memory to verified status.
   */
  public promoteMemory(id: string): MemoryRecord | null {
    const mem = this.store.getMemoryById(id);
    if (!mem) return null;

    return this.store.updateMemory(id, {
      status: 'verified',
      verification_count: Math.max(2, (mem.verification_count || 0) + 1),
      importance: Math.min(5.0, mem.importance + 0.5)
    });
  }

  public deprecateMemory(id: string): MemoryRecord | null {
    return this.gate.recordVerificationFailure(id);
  }
}

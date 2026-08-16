import { MemoryStore } from '../storage/db.js';
import { MemoryCreateInput, MemoryRecord } from '../types/memory.js';

export type ConflictResolutionAction = 'ADD' | 'UPDATE' | 'OVERWRITE' | 'IGNORE';

export interface ConflictResolutionResult {
  action: ConflictResolutionAction;
  memoryId: string;
  supersededMemoryId?: string;
  reason: string;
}

export class ConflictResolver {
  constructor(private store: MemoryStore) {}

  public async resolveAndApply(input: MemoryCreateInput): Promise<ConflictResolutionResult> {
    const now = Date.now();
    const scope = input.scope || 'workspace';
    const pathPattern = input.path_pattern || '*';

    // 1. Composite-Key based scoped entity match: (scope, path_pattern, entity_key)
    if (input.entity_key) {
      const stmt = this.store.getDb().prepare(`
        SELECT * FROM memories
        WHERE scope = ? AND path_pattern = ? AND entity_key = ?
          AND (invalid_at IS NULL OR invalid_at > ?)
        LIMIT 1
      `);
      const existing = stmt.get(scope, pathPattern, input.entity_key, now) as MemoryRecord | undefined;

      if (existing) {
        // Compare content within the exact same scope & path_pattern
        if (this.isIdentical(existing.content, input.content)) {
          this.store.recordMemoryAccess(existing.id);
          this.store.updateMemory(existing.id, {
            importance: Math.max(existing.importance, input.importance ?? existing.importance)
          });
          return {
            action: 'IGNORE',
            memoryId: existing.id,
            reason: `Identical memory active in '${pathPattern}' scope. Boosted importance.`
          };
        }

        // Direct contradiction / update on same composite entity: Bi-temporal overwrite
        this.store.updateMemory(existing.id, { invalid_at: now });

        const newRecord = await this.store.createMemory({
          ...input,
          status: input.status || 'verified'
        });

        this.store.addRelation({
          source_entity: newRecord.id,
          relation: 'supersedes',
          target_entity: existing.id,
          memory_id: newRecord.id,
          created_at: now
        });

        return {
          action: 'OVERWRITE',
          memoryId: newRecord.id,
          supersededMemoryId: existing.id,
          reason: `Superseded '${pathPattern}::${input.entity_key}' with updated definition.`
        };
      }
    }

    // 2. Semantic vector-based near-duplicate check (scoped by path_pattern)
    const embedding = await this.store.getEmbeddingAdapter().embed(input.content, true);
    const vectorMatches = this.store.getVectorStore().search(embedding, 5);

    for (const match of vectorMatches) {
      if (match.similarity > 0.93) {
        const existing = this.store.getMemoryById(match.id);
        if (
          existing &&
          existing.scope === scope &&
          existing.path_pattern === pathPattern &&
          (!existing.invalid_at || existing.invalid_at > now)
        ) {
          if (this.isIdentical(existing.content, input.content)) {
            this.store.recordMemoryAccess(existing.id);
            return {
              action: 'IGNORE',
              memoryId: existing.id,
              reason: `Near-identical semantic memory already exists in scope '${pathPattern}'.`
            };
          }
        }
      }
    }

    // 3. Clean addition of new scoped memory
    const created = await this.store.createMemory(input);
    return {
      action: 'ADD',
      memoryId: created.id,
      reason: `Created new distinct memory record for scope '${pathPattern}'.`
    };
  }

  private isIdentical(a: string, b: string): boolean {
    return a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
  }
}

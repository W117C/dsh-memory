import { MemoryStore } from '../storage/db.js';
import { ConflictResolver } from './conflict-resolver.js';
import { MemoryCreateInput, MemoryRecord } from '../types/memory.js';

export interface SubagentSessionContext {
  subagentId: string;
  parentSessionId: string;
  stagedMemories: MemoryCreateInput[];
  createdAt: number;
}

export interface FiberMergeResult {
  committedMemories: MemoryRecord[];
  hasConflict: boolean;
  collidedKeys: string[];
  conflictResolutions: string[];
}

export class SubagentFiberManager {
  private activeSubagents = new Map<string, SubagentSessionContext>();

  constructor(
    private store: MemoryStore,
    private resolver: ConflictResolver
  ) {}

  public createSubagentContext(parentSessionId: string, subagentId: string): SubagentSessionContext {
    const ctx: SubagentSessionContext = {
      subagentId,
      parentSessionId,
      stagedMemories: [],
      createdAt: Date.now()
    };
    this.activeSubagents.set(subagentId, ctx);
    return ctx;
  }

  public stageMemory(subagentId: string, memoryInput: MemoryCreateInput): void {
    const ctx = this.activeSubagents.get(subagentId);
    if (ctx) {
      ctx.stagedMemories.push(memoryInput);
    }
  }

  /**
   * 3-Way Semantic Merge & Concurrent Collision Arbiter:
   * Detects if another parallel Sub-Agent modified the same entity key
   * during this fiber's execution, and executes non-destructive knowledge synthesis.
   */
  public async mergeOnSuccess(subagentId: string): Promise<FiberMergeResult> {
    const ctx = this.activeSubagents.get(subagentId);
    if (!ctx) {
      return {
        committedMemories: [],
        hasConflict: false,
        collidedKeys: [],
        conflictResolutions: []
      };
    }

    const committed: MemoryRecord[] = [];
    const collidedKeys: string[] = [];
    const conflictResolutions: string[] = [];
    let hasConflict = false;
    const now = Date.now();

    for (const staged of ctx.stagedMemories) {
      const scope = staged.scope || 'workspace';
      const pathPattern = staged.path_pattern || '*';

      // 1. Check for concurrent modification during this Fiber's execution window
      if (staged.entity_key) {
        const stmtCheck = this.store.getDb().prepare(`
          SELECT * FROM memories
          WHERE scope = ? AND path_pattern = ? AND entity_key = ?
            AND (invalid_at IS NULL OR invalid_at > ?)
            AND updated_at > ?
          LIMIT 1
        `);
        const concurrentExisting = stmtCheck.get(scope, pathPattern, staged.entity_key, now, ctx.createdAt) as MemoryRecord | undefined;

        if (concurrentExisting) {
          // CONCURRENT COLLISION DETECTED!
          hasConflict = true;
          collidedKeys.push(staged.entity_key);

          // Execute 3-Way Non-Destructive Synthesis
          const combinedContent = `${concurrentExisting.content}\n\n[Concurrent Discovery by Sub-Agent ${subagentId}]:\n${staged.content}`;
          const combinedSummary = `${concurrentExisting.summary} | [${subagentId}]: ${staged.summary || staged.content.slice(0, 40)}`;

          const updated = this.store.updateMemory(concurrentExisting.id, {
            content: combinedContent,
            summary: combinedSummary,
            importance: Math.min(5.0, Math.max(concurrentExisting.importance, staged.importance ?? 4.0) + 0.5),
            status: 'verified'
          });

          // Add Knowledge Relation
          this.store.addRelation({
            source_entity: `${staged.entity_key}.fiber_${subagentId}`,
            relation: 'complements',
            target_entity: concurrentExisting.id,
            memory_id: concurrentExisting.id,
            created_at: now
          });

          if (updated) committed.push(updated);
          conflictResolutions.push(`3-Way merged concurrent changes on '${staged.entity_key}' without knowledge loss.`);
          continue;
        }
      }

      // 2. Normal clean resolution & commit
      const res = await this.resolver.resolveAndApply(staged);
      const record = this.store.getMemoryById(res.memoryId);
      if (record) committed.push(record);
    }

    this.activeSubagents.delete(subagentId);

    return {
      committedMemories: committed,
      hasConflict,
      collidedKeys,
      conflictResolutions
    };
  }

  public discardOnFailure(subagentId: string): void {
    this.activeSubagents.delete(subagentId);
  }

  public getActiveContext(subagentId: string): SubagentSessionContext | undefined {
    return this.activeSubagents.get(subagentId);
  }
}

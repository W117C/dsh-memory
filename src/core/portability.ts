/**
 * Portability: batch writes plus lossless JSONL export/import.
 *
 * The export line format is one full MemoryRecord per line (the same shape
 * `createMemory` accepts back), so a dump is simultaneously a backup, a
 * migration artifact between workspaces, and an inspectable dataset.
 */
import { MemoryStore, mapRowToRecord } from '../storage/db.js';
import { ConflictResolver } from './conflict-resolver.js';
import { MemoryCreateInput, MemoryRecord } from '../types/memory.js';

export interface ExportOptions {
  /** Export only ACTIVE memories (default) or everything including deprecated. */
  includeDeprecated?: boolean;
  scope?: 'workspace' | 'global';
}

export interface ImportSummary {
  processed: number;
  added: number;
  ignored: number;
  overwritten: number;
  invalidLines: number;
}

export class MemoryPortability {
  constructor(
    private store: MemoryStore,
    private resolver: ConflictResolver
  ) {}

  public exportJsonl(options: ExportOptions = {}): string {
    const now = Date.now();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!options.includeDeprecated) {
      conditions.push('(invalid_at IS NULL OR invalid_at > ?)');
      params.push(now);
      conditions.push(`status != 'deprecated'`);
    }
    if (options.scope) {
      conditions.push('scope = ?');
      params.push(options.scope);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = (this.store.getDb()
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at ASC`)
      .all(...params) as MemoryRecord[]).map((r) => mapRowToRecord(r));

    return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
  }

  public async importJsonl(jsonl: string): Promise<ImportSummary> {
    const summary: ImportSummary = { processed: 0, added: 0, ignored: 0, overwritten: 0, invalidLines: 0 };

    for (const line of jsonl.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      summary.processed++;

      let record: Partial<MemoryRecord>;
      try {
        record = JSON.parse(trimmed);
      } catch {
        summary.invalidLines++;
        continue;
      }

      if (typeof record.content !== 'string' || !record.content) {
        summary.invalidLines++;
        continue;
      }

      const input: MemoryCreateInput = {
        scope: record.scope,
        tier: record.tier ?? 'semantic',
        category: record.category ?? 'rule',
        content: record.content,
        summary: record.summary,
        entity_key: record.entity_key,
        topic_keywords: Array.isArray(record.topic_keywords)
          ? (record.topic_keywords as string[]).map((t) => String(t))
          : typeof record.topic_keywords === 'string'
            ? (record.topic_keywords as string).split(',').map((t) => t.trim()).filter(Boolean)
            : undefined,
        path_pattern: record.path_pattern,
        error_signature: record.error_signature,
        solution_code: record.solution_code,
        git_branch: record.git_branch,
        git_commit: record.git_commit,
        importance: record.importance,
        status: record.status,
        reason: 'imported'
      };

      const result = await this.resolver.resolveAndApply(input);
      if (result.action === 'ADD') summary.added++;
      else if (result.action === 'IGNORE') summary.ignored++;
      else if (result.action === 'OVERWRITE' || result.action === 'UPDATE') summary.overwritten++;
    }

    return summary;
  }

  /** Batch write: sequential consolidation, one result per input. */
  public async importBatch(inputs: MemoryCreateInput[]): Promise<Array<{ index: number; action: string; memoryId: string }>> {
    const results: Array<{ index: number; action: string; memoryId: string }> = [];
    for (let i = 0; i < inputs.length; i++) {
      const result = await this.resolver.resolveAndApply(inputs[i]);
      results.push({ index: i, action: result.action, memoryId: result.memoryId });
    }
    return results;
  }
}

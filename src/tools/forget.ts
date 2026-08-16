import { MemoryStore } from '../storage/db.js';
import type { DshToolDefinition } from '../contracts/dsh.js';

export interface ForgetParams {
  memory_id?: string;
  entity_key?: string;
  reason?: string;
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    invalidatedCount: { type: 'number' },
    message: { type: 'string' }
  },
  required: ['success', 'invalidatedCount']
} as const;

export function createForgetTool(store: MemoryStore): DshToolDefinition {
  return {
    name: 'memory_forget',
    description: 'Invalidate or remove an obsolete, deprecated, or incorrect memory rule or post-mortem.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The exact ID of the memory to invalidate (e.g. "mem_1234")' },
        entity_key: { type: 'string', description: 'The entity key to invalidate (e.g. "config.package_manager")' },
        reason: { type: 'string', description: 'Reason for deprecation' }
      }
    },
    output: {
      schema: RESULT_SCHEMA as Record<string, unknown>,
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'object' && value ? JSON.stringify(value, null, 2) : String(value) }
      ]
    },
    execute: async (raw: unknown) => {
      const params = raw as ForgetParams;
      const now = Date.now();
      let invalidatedCount = 0;

      if (params.memory_id) {
        const mem = store.getMemoryById(params.memory_id);
        if (mem) {
          store.updateMemory(params.memory_id, {
            status: 'deprecated',
            invalid_at: now
          });
          invalidatedCount++;
        }
      } else if (params.entity_key) {
        const stmt = store.getDb().prepare(`
          SELECT id FROM memories
          WHERE entity_key = ? AND (invalid_at IS NULL OR invalid_at > ?)
        `);
        const rows = stmt.all(params.entity_key, now) as Array<{ id: string }>;
        for (const row of rows) {
          store.updateMemory(row.id, {
            status: 'deprecated',
            invalid_at: now
          });
          invalidatedCount++;
        }
      }

      return {
        success: invalidatedCount > 0,
        invalidatedCount,
        message: invalidatedCount > 0
          ? `Successfully invalidated ${invalidatedCount} memory entries.`
          : 'No active memory matched criteria.'
      };
    }
  };
}

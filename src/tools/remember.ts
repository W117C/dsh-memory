import type { DshToolDefinition } from '../contracts/dsh.js';
import type { ConsolidationOutcome } from '../core/consolidator.js';
import type { MemoryCreateInput, MemoryTier, MemoryCategory } from '../types/memory.js';
import type { RememberEngine } from './index.js';

export interface RememberParams {
  content: string;
  tier?: MemoryTier;
  category?: MemoryCategory;
  entity_key?: string;
  path_pattern?: string;
  importance?: number;
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    action: { type: 'string' },
    memoryId: { type: 'string' },
    message: { type: 'string' },
    events: { type: 'array', items: { type: 'string' } },
    engine: { type: 'string' }
  },
  required: ['success', 'action', 'memoryId']
} as const;

export function createRememberTool(rememberEngine: RememberEngine): DshToolDefinition {
  return {
    name: 'memory_remember',
    description:
      'Explicitly store a verified coding rule, user preference, architectural decision, or constraint into persistent memory.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The exact rule or fact to remember (markdown format)' },
        tier: { type: 'string', enum: ['semantic', 'episodic', 'procedural'], default: 'semantic' },
        category: { type: 'string', enum: ['preference', 'architecture', 'rule', 'workflow'], default: 'rule' },
        entity_key: { type: 'string', description: 'Unique dot-separated identifier (e.g. "config.package_manager")' },
        path_pattern: { type: 'string', description: 'Monorepo file glob path constraint (e.g. "apps/web/**")' },
        importance: { type: 'number', minimum: 1, maximum: 5, default: 4.0 }
      },
      required: ['content']
    },
    output: {
      schema: RESULT_SCHEMA as Record<string, unknown>,
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'object' && value ? JSON.stringify(value, null, 2) : String(value) }
      ]
    },
    execute: async (raw: unknown) => {
      const params = raw as RememberParams;
      const input: MemoryCreateInput = {
        tier: params.tier || 'semantic',
        category: params.category || 'rule',
        content: params.content,
        entity_key: params.entity_key,
        path_pattern: params.path_pattern || '*',
        importance: params.importance ?? 4.0,
        status: 'verified'
      };
      const result = await rememberEngine(input);

      return {
        success: true,
        action: result.action,
        memoryId: result.memoryId,
        message: result.reason,
        events: result.events,
        engine: result.engine
      };
    }
  };
}

import { HybridRetriever } from '../core/hybrid-retriever.js';
import { MemoryTier, ScoredMemory } from '../types/memory.js';
import type { DshToolDefinition, DshToolRunContext } from '../contracts/dsh.js';

export interface RecallParams {
  query?: string;
  memory_id?: string;
  tier?: 'all' | MemoryTier;
  limit?: number;
  max_tokens?: number;
  full_details?: boolean;
  current_file?: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 3.5);
}

/**
 * Compact Projection Serializer:
 * Projects scored memories into high-density text within a strict token budget.
 */
export function projectCompactRecallResponse(
  results: ScoredMemory[],
  maxTokens = 800,
  fullDetails = false
): { formattedOutput: string; totalTokens: number; truncatedCount: number } {
  if (results.length === 0) {
    return { formattedOutput: 'No matching memories found.', totalTokens: 0, truncatedCount: 0 };
  }

  const lines: string[] = [];
  let currentTokens = 0;
  let includedCount = 0;

  for (const r of results) {
    const mem = r.memory;
    let itemBlock = '';

    if (fullDetails) {
      // Full drill-down view
      itemBlock = [
        `### [${mem.id}] (${mem.tier}/${mem.category}) [Status: ${mem.status}] [Score: ${Math.round(r.score * 100) / 100}]`,
        `**Summary**: ${mem.summary}`,
        mem.error_signature ? `**Error Signature**: ${mem.error_signature}` : '',
        `**Full Content**:\n${mem.content}`,
        mem.solution_code ? `**Working Solution**:\n\`\`\`\n${mem.solution_code}\n\`\`\`` : ''
      ].filter(Boolean).join('\n');
    } else {
      // High-density compact view (Zero context flooding)
      const coreSolution = mem.solution_code
        ? `\n  - Verified Solution: ${mem.solution_code.slice(0, 200).replace(/\n/g, ' ')}`
        : '';

      itemBlock = `- [${mem.id}] (${mem.tier} | Score: ${Math.round(r.score * 100) / 100}) ${mem.summary}${coreSolution}`;
    }

    const itemTokens = estimateTokens(itemBlock);
    if (currentTokens + itemTokens > maxTokens && includedCount > 0) {
      break;
    }

    lines.push(itemBlock);
    currentTokens += itemTokens;
    includedCount++;
  }

  const truncatedCount = results.length - includedCount;
  if (truncatedCount > 0) {
    lines.push(`\n[Budget Cap: Showing top ${includedCount} of ${results.length} results (~${currentTokens} tokens). Use memory_recall with memory_id='...' and full_details=true to inspect full logs]`);
  }

  return {
    formattedOutput: lines.join('\n'),
    totalTokens: currentTokens,
    truncatedCount
  };
}

export interface RecallToolHooks {
  /**
   * Session-scoped sink for Tier 2 injection: called with the query and the
   * scored results so the injector can materialize them as a durable
   * user-role context snapshot for the following turns.
   */
  onRecallExecuted?: (sessionId: string, query: string, results: ScoredMemory[]) => void;
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'number' },
    output: { type: 'string' },
    tokens: { type: 'number' },
    truncated: { type: 'boolean' },
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tier: { type: 'string' },
          category: { type: 'string' },
          status: { type: 'string' },
          summary: { type: 'string' },
          score: { type: 'number' }
        }
      }
    }
  },
  required: ['found', 'output']
} as const;

export function createRecallTool(retriever: HybridRetriever, hooks: RecallToolHooks = {}): DshToolDefinition {
  return {
    name: 'memory_recall',
    description:
      'Actively search and recall relevant past debugging solutions, post-mortems, procedural skills, or project conventions on-demand within a strict token budget.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic search query or error message keywords' },
        memory_id: { type: 'string', description: 'Specific memory ID to drill down and retrieve full unabridged content' },
        tier: { type: 'string', enum: ['all', 'semantic', 'episodic', 'procedural'], default: 'all' },
        limit: { type: 'number', default: 5 },
        max_tokens: { type: 'number', default: 800, description: 'Maximum token budget for tool output response' },
        full_details: { type: 'boolean', default: false, description: 'Set true to output full un-truncated content' },
        current_file: { type: 'string', description: 'Current file path for Monorepo path-scoped filtering' }
      }
    },
    output: {
      schema: RESULT_SCHEMA as Record<string, unknown>,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            typeof value === 'object' && value && 'output' in value
              ? String((value as { output: unknown }).output)
              : JSON.stringify(value)
        }
      ]
    },
    execute: async (raw: unknown, exec?: DshToolRunContext) => {
      const params = raw as RecallParams;

      // 1. Single-Item Direct Lookup by ID
      if (params.memory_id) {
        const directResults = await retriever.retrieve(params.memory_id, {
          topK: 1,
          includeTentative: true
        });

        if (directResults.length > 0) {
          const projection = projectCompactRecallResponse(
            directResults,
            params.max_tokens ?? 2000,
            params.full_details ?? true
          );
          return {
            found: 1,
            output: projection.formattedOutput,
            tokens: projection.totalTokens
          };
        }
      }

      // 2. Query Search with Progressive Compact Disclosure
      const queryText = params.query || '';
      if (!queryText) {
        return { found: 0, output: 'Please provide either a query or a memory_id.' };
      }

      const results = await retriever.retrieve(queryText, {
        tier: params.tier || 'all',
        topK: params.limit || 5,
        currentFilePath: params.current_file,
        includeTentative: true
      });

      if (results.length === 0) {
        return {
          found: 0,
          output: `No active memories found matching query '${queryText}'.`
        };
      }

      // Tier 2, immediate leg: defer the compact digest as a plugin-sourced
      // instruction so the recall rides the CURRENT turn natively (dsh
      // `ToolRunContext.deferContext`), before the registry context snapshot
      // carries it across turns.
      if (exec) {
        deferRecallContext(exec, results);
        hooks.onRecallExecuted?.(exec.callId, queryText, results);
      }

      const projection = projectCompactRecallResponse(
        results,
        params.max_tokens ?? 800,
        params.full_details ?? false
      );

      return {
        found: results.length,
        output: projection.formattedOutput,
        tokens: projection.totalTokens,
        truncated: projection.truncatedCount > 0,
        memories: results.map(r => ({
          id: r.memory.id,
          tier: r.memory.tier,
          category: r.memory.category,
          status: r.memory.status,
          summary: r.memory.summary,
          score: Math.round(r.score * 100) / 100
        }))
      };
    }
  };
}

function deferRecallContext(exec: DshToolRunContext, results: ScoredMemory[]): void {
  const defer = (exec as { deferContext?: (message: unknown) => void }).deferContext;
  if (typeof defer !== 'function') return;

  const digest = results
    .slice(0, 5)
    .map(r => `- ${r.memory.error_signature ? `${r.memory.error_signature}: ` : ''}${r.memory.solution_code || r.memory.summary}`)
    .join('\n');

  defer({
    role: 'user',
    content: [{ type: 'text', text: `<memory_recall_digest>\n${digest}\n</memory_recall_digest>` }]
  });
}

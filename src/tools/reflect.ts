import { EpisodicMemoryManager } from '../subsystems/episodic.js';
import { ProceduralMemoryManager } from '../subsystems/procedural.js';
import type { DshToolDefinition } from '../contracts/dsh.js';

export interface ReflectParams {
  task_goal: string;
  outcome: 'success' | 'failure';
  error_encountered?: string;
  root_cause?: string;
  working_solution?: string;
  reusable_recipe?: string;
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    outcome: { type: 'string' },
    created: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' }
  },
  required: ['success', 'outcome', 'created']
} as const;

export function createReflectTool(
  episodicMgr: EpisodicMemoryManager,
  proceduralMgr: ProceduralMemoryManager
): DshToolDefinition {
  return {
    name: 'memory_reflect',
    description:
      'Explicitly record a debugging post-mortem or task reflection after solving a difficult issue or verifying a command workflow.',
    parameters: {
      type: 'object',
      properties: {
        task_goal: { type: 'string', description: 'What task or bug were you trying to solve?' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
        error_encountered: { type: 'string', description: 'Exact error signature or command error output' },
        root_cause: { type: 'string', description: 'Why did the error occur?' },
        working_solution: { type: 'string', description: 'The exact fix or code change that succeeded' },
        reusable_recipe: { type: 'string', description: 'Reusable terminal command chain or script' }
      },
      required: ['task_goal', 'outcome']
    },
    output: {
      schema: RESULT_SCHEMA as Record<string, unknown>,
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'object' && value ? JSON.stringify(value, null, 2) : String(value) }
      ]
    },
    execute: async (raw: unknown) => {
      const params = raw as ReflectParams;
      const recordsCreated: string[] = [];

      if (params.outcome === 'success' && params.error_encountered && params.working_solution) {
        const pm = await episodicMgr.recordPostMortem({
          errorSignature: params.error_encountered,
          rootCause: params.root_cause || 'Identified bug during turn execution',
          solutionCode: params.working_solution
        });
        recordsCreated.push(`Post-Mortem: ${pm.id} (${pm.summary})`);
      }

      if (params.outcome === 'success' && params.reusable_recipe) {
        const rc = await proceduralMgr.registerRecipe({
          taskName: params.task_goal,
          triggerCondition: `When performing ${params.task_goal}`,
          commandsOrScript: params.reusable_recipe
        });
        recordsCreated.push(`Recipe: ${rc.id} (${rc.summary})`);
      }

      return {
        success: true,
        outcome: params.outcome,
        created: recordsCreated,
        message: recordsCreated.length > 0
          ? `Recorded ${recordsCreated.length} reflection entries into tentative memory.`
          : 'Reflection noted.'
      };
    }
  };
}

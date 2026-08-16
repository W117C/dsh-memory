import type { Context } from '@deepseek-ai/cordis';
import { MemoryStore } from '../storage/db.js';
import { MemoryConfig } from '../config.js';
import { TrajectoryFilter, TrajectoryStep, PrunedTrajectory, stripReasoningContent } from './trajectory-filter.js';
import { VerificationGate } from './verification-gate.js';
import { ConflictResolver } from '../core/conflict-resolver.js';
import { EpisodicMemoryManager } from '../subsystems/episodic.js';
import { ProceduralMemoryManager } from '../subsystems/procedural.js';

export interface DistillSummary {
  semanticFactsExtracted: number;
  postMortemsExtracted: number;
  recipesExtracted: number;
  engineUsed: 'deterministic-fast' | 'llm-semantic-augmented';
}

export const DISTILL_JSON_SCHEMA = {
  type: "object",
  properties: {
    semantic_facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity_key: { type: "string" },
          content: { type: "string" },
          summary: { type: "string" },
          importance: { type: "number", minimum: 1, maximum: 5 }
        },
        required: ["content", "summary"]
      }
    },
    post_mortems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          error_signature: { type: "string" },
          root_cause: { type: "string" },
          solution_code: { type: "string" },
          summary: { type: "string" },
          importance: { type: "number", minimum: 1, maximum: 5 }
        },
        required: ["error_signature", "root_cause", "solution_code"]
      }
    },
    procedural_recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task_name: { type: "string" },
          commands: { type: "string" },
          summary: { type: "string" }
        },
        required: ["task_name", "commands"]
      }
    }
  },
  required: ["semantic_facts", "post_mortems", "procedural_recipes"]
};

/** Structural face of the dsh LLM service (`@deepseek-ai/dsh-llm`). */
export interface LlmStreamService {
  stream(options: {
    provider: string;
    model: string;
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
    maxTokens?: number;
  }): AsyncIterable<DistillChunk>;
}

export type DistillChunk =
  | { type: 'text-delta'; text: string }
  | { type: string; [extra: string]: unknown };

export function getLlmService(ctx: Context): LlmStreamService | undefined {
  const candidate = (ctx as { get?: (name: string) => unknown }).get?.('llm');
  if (candidate && typeof (candidate as LlmStreamService).stream === 'function') {
    return candidate as LlmStreamService;
  }
  return undefined;
}

export interface DistillSessionInput {
  id: string;
  trajectory: TrajectoryStep[];
}

export class TrajectoryDistiller {
  private filter: TrajectoryFilter;
  private gate: VerificationGate;
  private resolver: ConflictResolver;
  private episodicMgr: EpisodicMemoryManager;
  private proceduralMgr: ProceduralMemoryManager;

  constructor(
    private ctx: Context,
    private store: MemoryStore,
    private config: MemoryConfig['distillation'],
    managers?: {
      resolver?: ConflictResolver;
      episodicMgr?: EpisodicMemoryManager;
      proceduralMgr?: ProceduralMemoryManager;
    }
  ) {
    this.filter = new TrajectoryFilter();
    this.gate = new VerificationGate(store);
    this.resolver = managers?.resolver ?? new ConflictResolver(store);
    this.episodicMgr = managers?.episodicMgr ?? new EpisodicMemoryManager(store);
    this.proceduralMgr = managers?.proceduralMgr ?? new ProceduralMemoryManager(store);
  }

  public async distillSession(session: DistillSessionInput): Promise<DistillSummary> {
    const rawTrajectory = session.trajectory || [];
    if (rawTrajectory.length < this.config.minTurnsForDistill) {
      return {
        semanticFactsExtracted: 0,
        postMortemsExtracted: 0,
        recipesExtracted: 0,
        engineUsed: 'deterministic-fast'
      };
    }

    // 1. Level 1: Deterministic rule-based pruning (<80% token reduction) with CoT thought stripping
    const pruned = this.filter.prune(rawTrajectory);

    // 2. Check if complex Code Mode / Sandbox failure requires Level 2 LLM semantic distillation
    const hasComplexSandboxError = this.detectComplexSandboxExecution(rawTrajectory);
    const llmService = getLlmService(this.ctx);

    if (hasComplexSandboxError && llmService) {
      try {
        const llmSummary = await this.distillWithLlm(pruned, rawTrajectory, llmService);
        if (llmSummary) {
          return {
            ...llmSummary,
            engineUsed: 'llm-semantic-augmented'
          };
        }
      } catch (err) {
        this.ctx.logger('memory')?.warn?.('LLM-assisted distillation failed, falling back to deterministic results:', err);
      }
    }

    // 3. Level 1 Default: Fast Deterministic Ingestion
    return this.distillDeterministic(pruned);
  }

  private async distillDeterministic(pruned: PrunedTrajectory): Promise<DistillSummary> {
    let semanticCount = 0;
    let postMortemCount = 0;
    let recipeCount = 0;

    for (const directive of pruned.userDirectives) {
      const summary = directive.slice(0, 100).replace(/\n/g, ' ');
      await this.resolver.resolveAndApply({
        tier: 'semantic',
        category: 'rule',
        content: directive,
        summary,
        importance: 4.0,
        status: 'verified'
      });
      semanticCount++;
    }

    for (const pair of pruned.errorRecoveryPairs) {
      await this.episodicMgr.recordPostMortem({
        errorSignature: pair.errorMessage.slice(0, 150),
        rootCause: `Failed execution on ${pair.failedTool}`,
        solutionCode: pair.recoveryAction
      });
      postMortemCount++;
    }

    for (const cmd of pruned.reusableCommands) {
      await this.proceduralMgr.registerRecipe({
        taskName: 'Automated Trajectory Recipe',
        triggerCondition: 'When executing project build/test workflow',
        commandsOrScript: cmd.slice(0, 300)
      });
      recipeCount++;
    }

    return {
      semanticFactsExtracted: semanticCount,
      postMortemsExtracted: postMortemCount,
      recipesExtracted: recipeCount,
      engineUsed: 'deterministic-fast'
    };
  }

  private detectComplexSandboxExecution(steps: TrajectoryStep[]): boolean {
    return steps.some(s =>
      s.content.includes('execute_code') ||
      s.content.includes('sandbox') ||
      s.content.includes('Uncaught Exception') ||
      s.content.includes('UnhandledPromiseRejection')
    );
  }

  /**
   * Level 2 augmentation over the live dsh LLM service: one DeepSeek-V4
   * streaming call (`ctx.llm.stream`, the same adapter registry the harness
   * itself uses), text deltas assembled, strict-JSON parsed.
   */
  private async distillWithLlm(
    pruned: PrunedTrajectory,
    rawSteps: TrajectoryStep[],
    llmService: LlmStreamService
  ): Promise<DistillSummary | null> {
    const compactTrajectoryText = rawSteps
      .filter(s => s.type !== 'REASONING')
      .slice(-20)
      .map(s => {
        const cleanContent = stripReasoningContent(s.content).slice(0, 300);
        return cleanContent ? `[${s.type}] ${cleanContent}` : '';
      })
      .filter(Boolean)
      .join('\n');

    const prompt = `Analyze this AI coding agent session trajectory. Extract verified rules, debugging post-mortems and reusable workflows.\n\nRespond with strictly valid JSON matching this schema:\n${JSON.stringify(DISTILL_JSON_SCHEMA)}\n\nTrajectory:\n${compactTrajectoryText}`;

    let text = '';
    for await (const chunk of llmService.stream({
      provider: this.config.llmProvider,
      model: this.config.distillModel,
      system: 'You are an AI Memory Distiller. Output strictly valid JSON conforming to the requested schema. Output nothing else.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
      }
    }

    const parsed = this.parseJsonLoose(text);
    if (!parsed) return null;

    let sCount = 0, pCount = 0, rCount = 0;

    if (Array.isArray(parsed.semantic_facts)) {
      for (const f of parsed.semantic_facts) {
        await this.resolver.resolveAndApply({
          tier: 'semantic',
          category: 'rule',
          entity_key: f.entity_key,
          content: f.content,
          summary: f.summary || String(f.content).slice(0, 80),
          importance: f.importance || 4.0,
          status: 'verified'
        });
        sCount++;
      }
    }

    if (Array.isArray(parsed.post_mortems)) {
      for (const pm of parsed.post_mortems) {
        await this.episodicMgr.recordPostMortem({
          errorSignature: pm.error_signature,
          rootCause: pm.root_cause,
          solutionCode: pm.solution_code,
          importance: pm.importance || 4.5
        });
        pCount++;
      }
    }

    if (Array.isArray(parsed.procedural_recipes)) {
      for (const rc of parsed.procedural_recipes) {
        await this.proceduralMgr.registerRecipe({
          taskName: rc.task_name,
          triggerCondition: `When performing ${rc.task_name}`,
          commandsOrScript: rc.commands
        });
        rCount++;
      }
    }

    return {
      semanticFactsExtracted: sCount,
      postMortemsExtracted: pCount,
      recipesExtracted: rCount,
      engineUsed: 'llm-semantic-augmented'
    };
  }

  /** Tolerate code fences around the JSON body before parsing. */
  private parseJsonLoose(text: string): Record<string, unknown> | null {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

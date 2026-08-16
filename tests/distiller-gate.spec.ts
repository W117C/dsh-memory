import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { MemoryStore } from '../src/storage/db.js';
import { TrajectoryFilter, TrajectoryStep, stripReasoningContent } from '../src/pipeline/trajectory-filter.js';
import { VerificationGate } from '../src/pipeline/verification-gate.js';
import { TrajectoryDistiller } from '../src/pipeline/distiller.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DistillSessionInput } from '../src/pipeline/distiller.js';

describe('Phase 4: Trajectory Pruning, Distillation & Anti-Poisoning Gate', () => {
  let store: MemoryStore;
  let filter: TrajectoryFilter;
  let gate: VerificationGate;
  let distiller: TrajectoryDistiller;
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context();
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    filter = new TrajectoryFilter();
    gate = new VerificationGate(store);
    distiller = new TrajectoryDistiller(ctx, store, DEFAULT_CONFIG.distillation);
  });

  afterEach(() => {
    store.close();
  });

  it('should strip DeepSeek-R1 <think> internal monologues and prevent hypothetical delusions from entering memory', () => {
    const rawCoT = `<think>
Wait, should I tell the user to configure "allowSyntheticDefaultImports: true"?
No, that is completely wrong for this monorepo! It would cause circular import errors.
Instead, we must strictly use named exports and pnpm.
</think>
请使用具名导出，统一使用 pnpm`;

    const cleaned = stripReasoningContent(rawCoT);
    expect(cleaned).not.toContain('allowSyntheticDefaultImports');
    expect(cleaned).not.toContain('<think>');
    expect(cleaned).toBe('请使用具名导出，统一使用 pnpm');

    const stepsWithThought: TrajectoryStep[] = [
      {
        step_index: 1,
        type: 'MODEL',
        content: '<think>Let me guess: maybe we should run npm install -g ... no, never do that.</think>'
      },
      {
        step_index: 2,
        type: 'USER_INPUT',
        content: '必须使用 pnpm，严禁使用 npm'
      }
    ];

    const pruned = filter.prune(stepsWithThought);
    // The pure thinking step was cleanly dropped, only the true user directive is kept
    expect(pruned.userDirectives.length).toBe(1);
    expect(pruned.userDirectives[0]).toContain('必须使用 pnpm');
  });

  it('should deterministically prune noisy trajectory steps into salient pairs', () => {
    const rawSteps: TrajectoryStep[] = [
      { step_index: 1, type: 'USER_INPUT', content: '请帮我修复编译报错，并且在本项目中严禁使用 eval()' },
      { step_index: 2, type: 'MODEL', content: '我来查看文件' },
      { step_index: 3, type: 'TOOL_CALL', content: 'view_file src/index.ts' },
      { step_index: 4, type: 'TOOL_RESULT', status: 'DONE', content: 'const a = 1;' },
      { step_index: 5, type: 'TOOL_CALL', content: 'run_command pnpm build' },
      {
        step_index: 6,
        type: 'TOOL_RESULT',
        status: 'ERROR',
        content: 'Error: Cannot find module @cordisjs/core in /src/index.ts',
        metadata: { exitCode: 1, toolName: 'run_command' }
      },
      { step_index: 7, type: 'MODEL', content: '发现缺少依赖，正在修改 package.json 并执行 pnpm add' },
      { step_index: 8, type: 'TOOL_CALL', content: 'run_command pnpm add cordis' },
      {
        step_index: 9,
        type: 'TOOL_RESULT',
        status: 'DONE',
        content: 'Packages: +1, Done in 1.2s',
        metadata: { exitCode: 0, toolName: 'run_command' }
      }
    ];

    const pruned = filter.prune(rawSteps);

    expect(pruned.userDirectives.length).toBe(1);
    expect(pruned.userDirectives[0]).toContain('严禁使用 eval()');

    expect(pruned.errorRecoveryPairs.length).toBe(1);
    expect(pruned.errorRecoveryPairs[0].errorMessage).toContain('Cannot find module');
    expect(pruned.errorRecoveryPairs[0].recoveryAction).toContain('pnpm add');
  });

  it('should manage memory status progression from tentative to verified and deprecated', async () => {
    const mem = await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: 'Fix Prisma Connection pool timeout',
      status: 'tentative'
    });

    expect(mem.status).toBe('tentative');
    expect(gate.isEligibleForWorkingSet(mem)).toBe(false);

    const v1 = gate.recordVerificationSuccess(mem.id);
    expect(v1?.verification_count).toBe(1);
    expect(v1?.status).toBe('tentative');

    const v2 = gate.recordVerificationSuccess(mem.id);
    expect(v2?.verification_count).toBe(2);
    expect(v2?.status).toBe('verified');
    expect(gate.isEligibleForWorkingSet(v2!)).toBe(true);

    const v3 = gate.recordVerificationFailure(mem.id, 'Caused regression in v2');
    expect(v3?.status).toBe('deprecated');
    expect(v3?.invalid_at).not.toBeNull();
  });

  it('should distill full session trajectory using deterministic fast engine', async () => {
    const session: DistillSessionInput = {
      id: 'session_distill_test',
      trajectory: [
        { step_index: 1, type: 'USER_INPUT', content: '必须使用 pnpm，不要使用 npm' },
        { step_index: 2, type: 'TOOL_CALL', content: 'run_command pnpm test' },
        {
          step_index: 3,
          type: 'TOOL_RESULT',
          status: 'ERROR',
          content: 'SyntaxError: Unexpected token export',
          metadata: { exitCode: 1, toolName: 'run_command' }
        },
        { step_index: 4, type: 'MODEL', content: 'Fix tsconfig module resolution to NodeNext' },
        {
          step_index: 5,
          type: 'TOOL_RESULT',
          status: 'DONE',
          content: 'Tests passed 10/10',
          metadata: { exitCode: 0 }
        }
      ]
    };

    const summary = await distiller.distillSession(session);
    expect(summary.semanticFactsExtracted).toBe(1);
    expect(summary.postMortemsExtracted).toBe(1);
    expect(summary.engineUsed).toBe('deterministic-fast');

    const stats = store.getStats();
    expect(stats.total).toBe(2);
  });

  it('should trigger LLM semantic distillation when sandbox code execution is detected', async () => {
    const payload = JSON.stringify({
      semantic_facts: [
        { entity_key: 'sandbox.timeout', content: 'Sandbox script execution timeout is 30s', summary: 'timeout: 30s' }
      ],
      post_mortems: [
        { error_signature: 'UnhandledPromiseRejection', root_cause: 'Async fetch not awaited in sandbox script', solution_code: 'await fetch(url)' }
      ],
      procedural_recipes: []
    });
    const streamCalls: number[] = [];
    const mockLlm = {
      stream(options: { provider: string; model: string }): AsyncIterable<{ type: string; text?: string }> {
        streamCalls.push(1);
        expect(options.model).toBe('deepseek-v4-flash');
        expect(options.provider).toBe('deepseek-official');
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' } as never;
          yield { type: 'text-delta', index: 0, text: payload.slice(0, 40) };
          yield { type: 'text-delta', index: 0, text: payload.slice(40) };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } } as never;
        })();
      }
    };

    ctx.reflect.provide('llm', mockLlm);

    const codeModeSession: DistillSessionInput = {
      id: 'session_code_mode_test',
      trajectory: [
        { step_index: 1, type: 'USER_INPUT', content: 'Execute sandbox script to test API' },
        { step_index: 2, type: 'TOOL_CALL', content: 'execute_code sandbox script.js' },
        {
          step_index: 3,
          type: 'TOOL_RESULT',
          status: 'ERROR',
          content: 'UnhandledPromiseRejection: fetch failed inside sandbox'
        },
        { step_index: 4, type: 'MODEL', content: 'Fix: add await to fetch' }
      ]
    };

    const summary = await distiller.distillSession(codeModeSession);
    expect(streamCalls.length).toBe(1);
    expect(summary.engineUsed).toBe('llm-semantic-augmented');
    expect(summary.semanticFactsExtracted).toBe(1);
    expect(summary.postMortemsExtracted).toBe(1);
  });
});

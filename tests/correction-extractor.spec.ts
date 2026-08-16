import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { MemoryStore } from '../src/storage/db.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { TrajectoryDistiller } from '../src/pipeline/distiller.js';
import { CorrectionExtractor, isCorrectionText } from '../src/pipeline/correction-extractor.js';
import { WorkingSetBuilder } from '../src/core/working-set.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { TrajectoryStep } from '../src/pipeline/trajectory-filter.js';

function step(type: TrajectoryStep['type'], content: string, extra: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return { step_index: 0, type, status: 'DONE', content, ...extra };
}

const CORRECTED_TRAJECTORY: TrajectoryStep[] = [
  step('USER_INPUT', '帮我装一下依赖'),
  step('MODEL', '好的，执行 npm install lodash'),
  step('TOOL_RESULT', 'npm install 完成', { metadata: { toolName: 'bash', exitCode: 0 } }),
  step('USER_INPUT', '不对，别用 npm，这个仓库统一用 pnpm'),
  step('MODEL', '抱歉，改用 pnpm add lodash 执行'),
  step('TOOL_RESULT', 'pnpm add lodash 完成', { metadata: { toolName: 'bash', exitCode: 0 } }),
  step('USER_INPUT', '以后每次提交前必须先跑 pnpm test'),
  step('MODEL', '好的，已把 pnpm test 纳入提交流程。')
];

describe('Correction extraction (user pushback → behavior change)', () => {
  it('flags correction-like user texts', () => {
    expect(isCorrectionText('不对，重新生成')).toBe(true);
    expect(isCorrectionText('wrong, use the other approach')).toBe(true);
    expect(isCorrectionText('帮我写个测试')).toBe(false);
  });

  it('extracts the pushback→behavior pair and skips plain directives', () => {
    const pairs = new CorrectionExtractor().extract(CORRECTED_TRAJECTORY);
    expect(pairs.length).toBe(1);
    expect(pairs[0].trigger).toContain('别用 npm');
    expect(pairs[0].correctedBehavior).toContain('pnpm');

    const plain = new CorrectionExtractor().extract([
      step('USER_INPUT', 'you must always run tests before commit'),
      step('MODEL', 'Understood, running the full suite now with pnpm test.')
    ]);
    expect(plain.length).toBe(0);
  });

  it('distiller persists corrections as global verified memories and the working set surfaces them first', async () => {
    const ctx = new Context();
    const store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    try {
      const distiller = new TrajectoryDistiller(ctx, store, DEFAULT_CONFIG.distillation, {
        resolver: new ConflictResolver(store)
      });

      const summary = await distiller.distillSession({ id: 'sess_corr', trajectory: CORRECTED_TRAJECTORY });
      expect(summary.correctionsExtracted).toBe(1);
      expect(summary.engineUsed).toBe('deterministic-fast');

      const correction = store.getDb().prepare(
        "SELECT * FROM memories WHERE category = 'correction'"
      ).get() as any;
      expect(correction).toBeTruthy();
      expect(correction.scope).toBe('global');
      expect(correction.status).toBe('verified');

      const ws = new WorkingSetBuilder(store, DEFAULT_CONFIG.retrieval).buildWorkingSet('', 'main');
      expect(ws.indexOf('[User Corrections')).toBeGreaterThanOrEqual(0);
      expect(ws).toContain('别用 npm');
      // Corrections section precedes the rules section.
      expect(ws.indexOf('[User Corrections')).toBeLessThan(ws.indexOf('[Active Rules'));
    } finally {
      store.close();
    }
  });

  it('thinking-stream corrections are sanitized before extraction', () => {
    const pairs = new CorrectionExtractor().extract([
      step('MODEL', '<think>user seems unhappy</think>Switching to yarn as requested.'),
      step('USER_INPUT', '错了，我说的是 pnpm 不是 yarn'),
      step('MODEL', '<think>apology</think>Re-running with pnpm add lodash.')
    ]);
    expect(pairs.length).toBe(1);
    expect(pairs[0].correctedBehavior).not.toContain('<think>');
  });
});

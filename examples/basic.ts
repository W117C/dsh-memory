/**
 * Minimal host-side usage of @dsh-plugins/memory outside a full dsh profile:
 * a bare Cordis v4 context plus the service. In a real dsh process the
 * `systemPrompt` / `tools` / `llm` / `httpServer` services come from the
 * profile composition instead.
 *
 * Run: npx tsx examples/basic.ts
 */
import { Context } from '@deepseek-ai/cordis';
import { apply, DEFAULT_CONFIG } from '../src/index.js';

async function main(): Promise<void> {
  const ctx = new Context();
  const fiber = apply(ctx, {
    ...DEFAULT_CONFIG,
    storage: { workspaceDbPath: ':memory:' }
  } as never);
  await fiber;

  const memory = ctx.get('memory')!;

  // 1. Write path (consolidation engine with deterministic fallback)
  const outcome = await memory.rememberDetailed({
    tier: 'semantic',
    category: 'rule',
    entity_key: 'build.pipeline',
    content: '构建一律使用 `pnpm turbo run build`，见 apps/web。',
    status: 'verified'
  });
  console.log('consolidated:', outcome.action, outcome.events, outcome.engine);

  // 2. Recall
  const hits = await memory.recall('如何构建 monorepo');
  console.log('recall hits:', hits.map((h) => h.memory.summary));

  // 3. Change history (mem0-style audit log)
  console.log('history:', memory.getHistory(outcome.memoryId).map((h) => h.event));

  // 4. Knowledge graph (mentions + supersedes edges)
  console.log('graph:', JSON.stringify(memory.getStats()));

  // 5. Portability: export / import / batch
  const jsonl = memory.exportJsonl();
  console.log('exported lines:', jsonl.split('\n').filter((l) => l.trim()).length);
  const batch = await memory.rememberBatch([
    { tier: 'semantic', category: 'rule', content: '批量规则一', status: 'verified' },
    { tier: 'semantic', category: 'rule', content: '批量规则二', status: 'verified' }
  ]);
  console.log('batch:', batch.map((b) => b.action));

  await fiber.dispose();
}

void main();

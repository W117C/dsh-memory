import { describe, it, expect } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { DshToolDefinition } from '../src/contracts/dsh.js';
import type { PromptSection, PromptContext } from '@deepseek-ai/dsh-system-prompt';

/**
 * Native-contract integration harness: a REAL @deepseek-ai/cordis v4 context
 * with the dsh host surfaces (tools registry, system-prompt registry, llm,
 * webserver) provided as contract-faithful fakes through
 * `ctx.reflect.provide` — the same resolution path (`ctx.get`) the plugin
 * uses inside a live dsh process.
 */

class FakeToolRegistry {
  public tools = new Map<string, DshToolDefinition>();
  register(definition: DshToolDefinition): () => void {
    this.tools.set(definition.name, definition);
    return () => this.tools.delete(definition.name);
  }
}

class FakeSystemPrompt {
  public sections = new Map<string, PromptSection>();
  public contexts = new Map<string, PromptContext>();
  section(section: PromptSection): () => void {
    this.sections.set(section.name, section);
    return () => this.sections.delete(section.name);
  }
  context(context: PromptContext): () => void {
    this.contexts.set(context.name, context);
    return () => this.contexts.delete(context.name);
  }
  /** Evaluate a registered contribution the way assembly does. */
  resolve(kind: 'sections' | 'contexts', name: string): string {
    const entry = this[kind].get(name);
    if (!entry) throw new Error(`not registered: ${name}`);
    return typeof entry.text === 'function' ? entry.text({}) : entry.text;
  }
}

async function bootHarness(overrides: Record<string, unknown> = {}) {
  const ctx = new Context();
  const fakeTools = new FakeToolRegistry();
  const fakeSystemPrompt = new FakeSystemPrompt();
  ctx.reflect.provide('tools', fakeTools);
  ctx.reflect.provide('systemPrompt', fakeSystemPrompt);

  const fiber = apply(ctx, {
    ...DEFAULT_CONFIG,
    storage: { workspaceDbPath: ':memory:' },
    ...overrides
  } as never);
  await fiber;

  const memoryService = ctx.get('memory') as any;
  return { ctx, fakeTools, fakeSystemPrompt, memoryService, fiber };
}

describe('Native dsh integration: Cordis v4 + registry surfaces', () => {
  it('boots on a real @deepseek-ai/cordis context and exposes the memory service', async () => {
    const h = await bootHarness();
    const { ctx, memoryService } = h;
    expect(memoryService).toBeDefined();
    expect(typeof memoryService.remember).toBe('function');
    expect(typeof memoryService.recall).toBe('function');

    const rule = await memoryService.remember({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'config.strict_nulls',
      content: 'TypeScript strictNullChecks is mandatory',
      summary: 'strictNullChecks: true',
      importance: 5.0,
      status: 'verified'
    });
    expect(rule.id).toBeDefined();
    expect(memoryService.getStats().total).toBe(1);

    await h.fiber.dispose();
  });

  it('registers the four memory tools on the native tools registry', async () => {
    const h = await bootHarness();
    const { ctx, fakeTools } = h;
    for (const name of ['memory_remember', 'memory_recall', 'memory_reflect', 'memory_forget']) {
      expect(fakeTools.tools.has(name), name).toBe(true);
      const tool = fakeTools.tools.get(name)!;
      expect(tool.parameters.type).toBe('object');
      expect(tool.output.schema.type).toBe('object');
      expect(typeof tool.output.render).toBe('function');
    }
    await h.fiber.dispose();
  });

  it('registers memory:working-set (section) and memory:recall (context) natively', async () => {
    const h = await bootHarness();
    const { ctx, fakeSystemPrompt, memoryService } = h;

    await memoryService.remember({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'project.pkg_manager',
      content: 'Project uses pnpm only',
      summary: 'package_manager: pnpm',
      importance: 4.5,
      status: 'verified'
    });

    const section = fakeSystemPrompt.sections.get('memory:working-set');
    const recallContext = fakeSystemPrompt.contexts.get('memory:recall');
    expect(section).toBeDefined();
    expect(recallContext).toBeDefined();
    expect(section!.order).toBe(90);
    expect(recallContext!.order).toBe(500);

    await h.fiber.dispose();
  });

  it('keeps the Tier 1 section byte-identical across turns while Tier 2 context evolves (V4 prefix-cache contract)', async () => {
    const h = await bootHarness();
    const { ctx, fakeSystemPrompt, memoryService } = h;

    await memoryService.remember({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'project.pkg_manager',
      content: 'Project uses pnpm only',
      summary: 'package_manager: pnpm',
      importance: 4.5,
      status: 'verified'
    });

    ctx.emit('session/created', { id: 'session_kv' });

    // 10 turns: assemble the section each time; every byte must match.
    const first = fakeSystemPrompt.resolve('sections', 'memory:working-set');
    expect(first).toContain('<dsh_memory');
    expect(first).toContain('package_manager: pnpm');
    for (let turn = 1; turn <= 10; turn++) {
      expect(fakeSystemPrompt.resolve('sections', 'memory:working-set')).toBe(first);
    }

    // Tier 2 stays empty until a recall actually happens…
    expect(fakeSystemPrompt.resolve('contexts', 'memory:recall')).toBe('');

    // …then carries the recall digest WITHOUT touching the frozen section.
    await memoryService.recall('pnpm');
    memoryService.injector.recordRecall('session_kv', 'pnpm', []);
    memoryService.injector.recordRecall('session_kv', 'pnpm', [
      {
        memory: {
          id: 'm1', tier: 'semantic', category: 'rule', status: 'verified',
          content: '', summary: 'use pnpm', importance: 4, verification_count: 0,
          access_count: 0, created_at: 0, updated_at: 0, last_accessed_at: 0,
          valid_from: 0, scope: 'workspace', path_pattern: '*'
        },
        score: 0.9,
        breakdown: { vectorScore: 1, bm25Score: 1, recencyScore: 1, importanceScore: 1 }
      }
    ]);
    const recallText = fakeSystemPrompt.resolve('contexts', 'memory:recall');
    expect(recallText).toContain('pnpm');
    expect(fakeSystemPrompt.resolve('sections', 'memory:working-set')).toBe(first);

    await h.fiber.dispose();
  });

  it('executes native tool definitions end-to-end (reflect → recall)', async () => {
    const h = await bootHarness();
    const { ctx, fakeTools, memoryService } = h;

    const reflect = fakeTools.tools.get('memory_reflect')!;
    const reflectRes = (await reflect.execute(
      {
        task_goal: 'Fix Postgres connection timeout',
        outcome: 'success',
        error_encountered: 'ETIMEDOUT 5432',
        root_cause: 'Postgres pool max connections exceeded',
        working_solution: 'Increase max_connections in postgresql.conf and set pool size = 20',
        reusable_recipe: 'docker exec -it pg psql -U postgres -c "SHOW max_connections;"'
      },
      { callId: 'c1', name: 'memory_reflect', arguments: {}, signal: new AbortController().signal }
    )) as { success: boolean; created: string[] };

    expect(reflectRes.success).toBe(true);
    expect(reflectRes.created.length).toBe(2);

    const deferred: unknown[] = [];
    const recall = fakeTools.tools.get('memory_recall')!;
    const recallRes = (await recall.execute(
      { query: 'Postgres connection timeout 5432' },
      {
        callId: 'c2',
        name: 'memory_recall',
        arguments: {},
        signal: new AbortController().signal,
        deferContext: (message: unknown) => deferred.push(message)
      } as never
    )) as { found: number; output: string };

    expect(recallRes.found).toBeGreaterThan(0);
    expect(recallRes.output).toContain('max_connections');
    // Native context deferral carries the digest into the CURRENT turn.
    expect(deferred.length).toBe(1);

    expect(memoryService.getStats().total).toBeGreaterThanOrEqual(2);
    await h.fiber.dispose();
  });

  it('distills a session trajectory on session/disposed (deterministic engine)', async () => {
    const h = await bootHarness();
    const { ctx, memoryService } = h;

    ctx.emit('session/created', { id: 'session_distill' });
    ctx.emit('session/event', { id: 'session_distill' }, {
      type: 'message',
      message: { role: 'user', content: 'you must always run pnpm test before commit' }
    });
    ctx.emit('session/event', { id: 'session_distill' }, {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Understood, running tests.' }] }
    });
    ctx.emit('session/event', { id: 'session_distill' }, {
      type: 'tool/error',
      message: { role: 'tool', toolName: 'bash', content: 'Error: jest exit 1 flaky test timeout' }
    });
    ctx.emit('session/event', { id: 'session_distill' }, {
      type: 'message',
      message: { role: 'user', content: 'fixed the flaky test with retry' }
    });
    ctx.emit('session/event', { id: 'session_distill' }, {
      type: 'message',
      message: { role: 'tool', toolName: 'bash', content: 'pnpm test: all 12 passed, exit 0' }
    });

    const before = memoryService.getStats().total;
    ctx.emit('session/disposed', { id: 'session_distill' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(memoryService.getStats().total).toBeGreaterThan(before);

    await h.fiber.dispose();
  });

  it('withdraws all native registrations when the plugin fiber is disposed', async () => {
    const h = await bootHarness();
    const { ctx, fakeTools, fakeSystemPrompt } = h;
    expect(fakeTools.tools.size).toBe(4);
    expect(fakeSystemPrompt.sections.size).toBe(1);

    await h.fiber.dispose();

    expect(fakeTools.tools.size).toBe(0);
    expect(fakeSystemPrompt.sections.size).toBe(0);
    expect(fakeSystemPrompt.contexts.size).toBe(0);
  });
});

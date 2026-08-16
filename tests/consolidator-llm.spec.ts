import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { MemoryConsolidator, ConsolidationConfig } from '../src/core/consolidator.js';
import { DEFAULT_CONFIG } from '../src/config.js';

function makeConfig(overrides: Partial<ConsolidationConfig> = {}): ConsolidationConfig {
  return {
    llmAssisted: true,
    similarityTopK: 5,
    extractEntities: true,
    llmProvider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    ...overrides
  };
}

function provideLlm(ctx: Context, respondWith: string | Error): string[] {
  const calls: string[] = [];
  ctx.reflect.provide('llm', {
    stream(options: { provider: string; model: string; messages: Array<{ content: unknown }> }) {
      calls.push(String(options.messages[0]?.content ?? ''));
      if (respondWith instanceof Error) {
        return (async function* () {
          throw respondWith;
        })();
      }
      return (async function* () {
        yield { type: 'text-delta', text: respondWith };
      })();
    }
  });
  return calls;
}

describe('LLM-assisted memory consolidation (mem0-class ADD/UPDATE/DELETE decisions)', () => {
  let store: MemoryStore;
  let retriever: HybridRetriever;
  let resolver: ConflictResolver;
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context();
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);
    resolver = new ConflictResolver(store);
  });

  afterEach(() => {
    store.close();
  });

  it('applies an LLM UPDATE decision in place with history', async () => {
    const existing = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'build.timeout',
      content: 'build timeout is 30 seconds',
      status: 'verified'
    });

    const calls = provideLlm(
      ctx,
      JSON.stringify({
        add: false,
        decisions: [
          { memory_id: existing.id, action: 'UPDATE', new_value: 'build timeout is 60 seconds', reason: 'refined' }
        ]
      })
    );
    const consolidator = new MemoryConsolidator(ctx, store, retriever, resolver, makeConfig());

    const outcome = await consolidator.consolidate({
      tier: 'semantic',
      category: 'rule',
      content: 'the build timeout was raised to 60 seconds'
    });

    expect(outcome.engine).toBe('llm-assisted');
    expect(outcome.events).toEqual([`UPDATE:${existing.id}`]);
    expect(calls.length).toBe(1);

    const updated = store.getMemoryById(existing.id)!;
    expect(updated.content).toBe('build timeout is 60 seconds');
    expect(store.getStats().total).toBe(1); // no duplicate record created

    const history = store.getMemoryHistory(existing.id);
    expect(history[0].event).toBe('updated');
  });

  it('applies an LLM DELETE decision as bi-temporal deprecation', async () => {
    const existing = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'we use npm in this repo',
      status: 'verified'
    });

    provideLlm(
      ctx,
      JSON.stringify({
        add: true,
        decisions: [{ memory_id: existing.id, action: 'DELETE', reason: 'contradicted' }]
      })
    );
    const consolidator = new MemoryConsolidator(ctx, store, retriever, resolver, makeConfig());

    const outcome = await consolidator.consolidate({
      tier: 'semantic',
      category: 'rule',
      content: 'we switched this repo to pnpm, npm is forbidden'
    });

    expect(outcome.events).toEqual([`DELETE:${existing.id}`, 'ADD']);
    const after = store.getMemoryById(existing.id)!;
    expect(after.status).toBe('deprecated');
    expect(after.invalid_at).not.toBeNull();
    expect(store.getStats().total).toBe(2);
  });

  it('resolves NONE + add=false to IGNORE without touching the store', async () => {
    const existing = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'prefer named exports',
      status: 'verified'
    });

    provideLlm(ctx, JSON.stringify({ add: false, decisions: [{ memory_id: existing.id, action: 'NONE' }] }));
    const consolidator = new MemoryConsolidator(ctx, store, retriever, resolver, makeConfig());

    const outcome = await consolidator.consolidate({
      tier: 'semantic',
      category: 'rule',
      content: 'named exports are preferred here'
    });

    expect(outcome.action).toBe('IGNORE');
    expect(store.getStats().total).toBe(1);
  });

  it('falls back to the deterministic resolver on LLM failure', async () => {
    provideLlm(ctx, new Error('provider 500'));
    const consolidator = new MemoryConsolidator(ctx, store, retriever, resolver, makeConfig());

    const outcome = await consolidator.consolidate({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'tool.lint',
      content: 'always run eslint --fix'
    });

    expect(outcome.engine).toBe('deterministic');
    expect(outcome.action).toBe('ADD');
    expect(store.getStats().total).toBe(1);
  });

  it('skips the LLM entirely when llmAssisted is disabled', async () => {
    const calls = provideLlm(ctx, JSON.stringify({ add: true, decisions: [] }));
    const consolidator = new MemoryConsolidator(ctx, store, retriever, resolver, makeConfig({ llmAssisted: false }));

    const outcome = await consolidator.consolidate({
      tier: 'semantic',
      category: 'rule',
      content: 'plain deterministic path'
    });

    expect(calls.length).toBe(0);
    expect(outcome.engine).toBe('deterministic');
  });

  it('treats a store with no similar memories as a plain deterministic add', async () => {
    const calls = provideLlm(ctx, JSON.stringify({ add: true, decisions: [] }));
    const consolidator = new MemoryConsolidator(ctx, store, retriever, resolver, makeConfig());

    const outcome = await consolidator.consolidate({
      tier: 'semantic',
      category: 'rule',
      content: 'first ever memory'
    });

    expect(calls.length).toBe(0);
    expect(outcome.engine).toBe('deterministic');
    expect(outcome.action).toBe('ADD');
  });
});

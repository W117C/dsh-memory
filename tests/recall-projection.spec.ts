import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { createRecallTool, projectCompactRecallResponse } from '../src/tools/recall.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Dynamic Tool Recall Token Budget & Compact Projection', () => {
  let store: MemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);
  });

  afterEach(() => {
    store.close();
  });

  it('should project multiple verbose memories into a compact output within strict token budget', async () => {
    // Seed 5 memories with long stack traces
    for (let i = 1; i <= 5; i++) {
      await store.createMemory({
        tier: 'episodic',
        category: 'post_mortem',
        entity_key: `error.stack_${i}`,
        content: `Very long stack trace ${i}:\n` + 'at /src/server.ts:12:34\n'.repeat(50),
        summary: `Fix stack overflow error #${i}`,
        solution_code: `export const fix_${i} = () => true;`,
        importance: 4.0,
        status: 'verified'
      });
    }

    const recallTool = createRecallTool(retriever);

    // Call tool with tight budget (e.g. 150 tokens)
    const res = await recallTool.execute({
      query: 'stack overflow error',
      limit: 5,
      max_tokens: 150
    });

    expect(res.found).toBe(5);
    expect(res.output).toContain('Fix stack overflow error');
    // Verifies that output contains the budget cap notice
    expect(res.output).toContain('Budget Cap: Showing top');
    expect(res.tokens).toBeLessThanOrEqual(160);
  });

  it('should support full detail drill-down inspection for a specific memory_id', async () => {
    const mem = await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      entity_key: 'next.middleware_jwt',
      content: 'Detailed explanation: Middleware in Next.js 15 executes in Edge Runtime. You must use jose instead of jsonwebtoken.',
      summary: 'Next 15 Edge JWT: use jose',
      solution_code: 'import * as jose from "jose";\nconst secret = new TextEncoder().encode(process.env.JWT_SECRET);',
      importance: 5.0,
      status: 'verified'
    });

    const recallTool = createRecallTool(retriever);

    // 1. Default compact query
    const compactRes = await recallTool.execute({
      query: 'Next 15 Edge JWT jose'
    });
    expect(compactRes.output).toContain('- [');
    expect(compactRes.output).not.toContain('Detailed explanation:');

    // 2. Drill-down inspection with memory_id & full_details
    const fullRes = await recallTool.execute({
      memory_id: mem.id,
      full_details: true
    });

    expect(fullRes.found).toBe(1);
    expect(fullRes.output).toContain('Detailed explanation: Middleware in Next.js 15 executes in Edge Runtime');
    expect(fullRes.output).toContain('import * as jose from "jose"');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { TrajectoryDistiller, DistillSessionInput } from '../src/pipeline/distiller.js';
import { MarkdownProjection } from '../src/core/markdown-projection.js';
import { MemoryPortability } from '../src/core/portability.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { deriveTopicKeywords } from '../src/core/entity-extractor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Write-side topic keyword completion (cold-vocabulary fix)', () => {
  let store: MemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);
  });

  afterEach(() => {
    store.close();
  });

  it('L1 deterministic: createMemory derives topic keywords from bare technical tokens', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: '统一使用 pnpm 安装依赖，测试用 vitest 跑',
      summary: 'pnpm vitest 约定',
      importance: 4,
      status: 'verified'
    });

    expect(Array.isArray(mem.topic_keywords)).toBe(true);
    expect(mem.topic_keywords!.length).toBeGreaterThan(0);
    expect(mem.topic_keywords!.map((t) => t.toLowerCase())).toEqual(
      expect.arrayContaining(['pnpm', 'vitest'])
    );
    // Read back through the store: column decodes back to an array.
    const reread = store.getMemoryById(mem.id);
    expect(reread?.topic_keywords).toEqual(mem.topic_keywords);
  });

  it('L2 explicit topics win over deterministic derivation', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: '某次构建失败后，通过增加重试参数解决了问题',
      summary: 'retry fixes build',
      topic_keywords: ['jest', 'timeout', '测试', '超时', 'vitest'],
      status: 'verified'
    });

    expect(mem.topic_keywords).toContain('jest');
    expect(mem.topic_keywords).toContain('timeout');
    const reread = store.getMemoryById(mem.id);
    expect(reread?.topic_keywords).toContain('timeout');
  });

  it('bridges the cold-vocabulary gap: query terms only in topic_keywords now recall the memory', async () => {
    // "jest" / "timeout" appear ONLY in topic_keywords — not in content, summary,
    // entity_key, or error_signature. Before the fix, this query could not match.
    const mem = await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: '某次构建失败后，通过增加重试参数解决了问题',
      summary: 'retry fixes build',
      topic_keywords: ['jest', 'timeout', '测试', '超时'],
      error_signature: 'build-retry',
      status: 'verified'
    });

    const results = await retriever.retrieve('jest timeout 怎么处理', { topK: 3 });
    expect(results.some((r) => r.memory.id === mem.id)).toBe(true);
  });

  it('FTS5 index matches a topic-only term (direct lexical bridging)', async () => {
    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: '关于数据库连接池的约定',
      summary: 'pool 约定',
      topic_keywords: ['pgbouncer', '连接池', 'postgres'],
      status: 'verified'
    });

    const hits = store.getFtsStore().searchFts('pgbouncer', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('updateMemory re-derives topics on body change and re-indexes FTS', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: '用 webpack 打包',
      summary: 'webpack',
      status: 'verified'
    });
    expect(mem.topic_keywords).toContain('webpack');

    const updated = store.updateMemory(mem.id, { content: '改用 vite 打包，并开 sourcemap' });
    expect(updated?.topic_keywords).toContain('vite');

    const results = await retriever.retrieve('vite 打包', { topK: 3 });
    expect(results.some((r) => r.memory.id === mem.id)).toBe(true);
  });

  it('L2 distillation passes LLM topics through to stored memories', async () => {
    const payload = JSON.stringify({
      semantic_facts: [
        {
          entity_key: 'sandbox.timeout',
          content: 'Sandbox script execution timeout is 30s',
          summary: 'timeout: 30s',
          topics: ['sandbox', '超时', '执行超时', 'script']
        }
      ],
      post_mortems: [
        {
          error_signature: 'UnhandledPromiseRejection',
          root_cause: 'Async fetch not awaited in sandbox script',
          solution_code: 'await fetch(url)',
          topics: ['fetch', '异步', 'promise', 'await']
        }
      ],
      procedural_recipes: [],
      user_corrections: []
    });
    const mockLlm = {
      stream(): AsyncIterable<{ type: string; text?: string }> {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: payload };
        })();
      }
    };

    const ctx = new Context();
    ctx.reflect.provide('llm', mockLlm);
    const distiller = new TrajectoryDistiller(ctx, store, DEFAULT_CONFIG.distillation);

    const session: DistillSessionInput = {
      id: 'session_topic_test',
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

    await distiller.distillSession(session);

    const stats = store.getStats();
    expect(stats.total).toBe(2);

    const facts = store.getDb()
      .prepare(`SELECT * FROM memories WHERE entity_key = 'sandbox.timeout'`)
      .all();
    expect(facts.length).toBe(1);
    expect(store.getMemoryById((facts[0] as { id: string }).id)?.topic_keywords).toEqual(
      expect.arrayContaining(['sandbox', '超时'])
    );

    const pms = store.getDb()
      .prepare(`SELECT * FROM memories WHERE tier = 'episodic'`)
      .all();
    expect(pms.length).toBe(1);
    expect(store.getMemoryById((pms[0] as { id: string }).id)?.topic_keywords).toEqual(
      expect.arrayContaining(['fetch', 'await'])
    );
    store.close();
  });

  it('markdown projection round-trips topic_keywords', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'CI 全绿才能合并分支',
      summary: 'ci green merge',
      topic_keywords: ['CI', '流水线', 'merge', '合并'],
      importance: 4,
      status: 'verified'
    });

    const projection = new MarkdownProjection(store);
    const exported = projection.exportMarkdown();
    const doc = exported.files[`memories/${mem.id}.md`] ?? Object.values(exported.files).find((c) => c.includes('CI 全绿'))!;
    expect(doc).toContain('topics: "CI, 流水线, merge, 合并"');

    const target = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    const targetProjection = new MarkdownProjection(target);
    await targetProjection.importMarkdown(exported.files);
    const imported = target.getMemoryById(mem.id);
    expect(imported?.topic_keywords).toEqual(expect.arrayContaining(['CI', '流水线']));
    target.close();
  });

  it('JSONL portability round-trips topic_keywords', async () => {
    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: '文档用中文',
      summary: 'docs zh',
      topic_keywords: ['docs', '文档', '中文'],
      status: 'verified'
    });

    const portability = new MemoryPortability(store, new ConflictResolver(store));
    const jsonl = portability.exportJsonl();
    // The export line carries the topic_keywords array as JSON.
    expect(jsonl).toContain('"topic_keywords":["docs","文档","中文"]');

    const target = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    const targetPortability = new MemoryPortability(target, new ConflictResolver(target));
    await targetPortability.importJsonl(jsonl);

    const imported = target.getDb()
      .prepare(`SELECT * FROM memories WHERE content = '文档用中文'`)
      .get() as { id: string } | undefined;
    expect(imported).toBeTruthy();
    expect(target.getMemoryById(imported!.id)?.topic_keywords).toEqual(expect.arrayContaining(['docs', '文档', '中文']));
    target.close();
  });
});

describe('deriveTopicKeywords unit', () => {
  it('extracts entities + bare technical tokens and filters stopwords', () => {
    const topics = deriveTopicKeywords('统一使用 pnpm 安装依赖，vitest 跑测试，禁用 eval()');
    expect(topics).toEqual(expect.arrayContaining(['pnpm', 'vitest']));
    // Stopwords like "使用/安装" are Chinese (not captured), English stopwords excluded.
    expect(topics.some((t) => t === 'the' || t === 'use')).toBe(false);
  });

  it('is bounded and deduplicated', () => {
    const long = deriveTopicKeywords(
      'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(2) +
      'vitest vitest pnpm pnpm webpack webpack'
    );
    expect(long.length).toBeLessThanOrEqual(12);
    expect(new Set(long).size).toBe(long.length);
  });
});

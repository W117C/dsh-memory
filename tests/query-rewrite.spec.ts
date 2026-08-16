import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { DEFAULT_CONFIG } from '../src/config.js';

/**
 * Query rewrite + max-union semantics: the retriever searches with BOTH the
 * raw and the rewritten query and keeps the best score per id — a strong
 * rewrite rescues vocabulary-mismatched memories, a garbage rewrite can never
 * lose what the raw query already found.
 */
describe('HybridRetriever query rewrite (max-union)', () => {
  let store: MemoryStore;
  let strictId: string;

  beforeEach(async () => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    const strict = await store.createMemory({
      tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'ts.strict',
      content: 'strictNullChecks 必须开启', summary: 'strict nulls',
      importance: 4, status: 'verified'
    });
    strictId = strict.id;
    await store.createMemory({
      tier: 'semantic', category: 'rule', scope: 'global', entity_key: 'config.package_manager',
      content: '统一使用 pnpm 安装依赖', summary: 'pnpm only',
      importance: 5, status: 'verified'
    });
  });

  afterEach(() => {
    store.close();
  });

  it('a strong rewrite rescues vocabulary-mismatched gold memories', async () => {
    const rewriter = async (q: string) =>
      q.includes('强制配置') ? 'TypeScript tsconfig strict strictNullChecks 编译选项' : q;
    const results = await new HybridRetriever(store, DEFAULT_CONFIG.retrieval, rewriter)
      .retrieve('TypeScript 有哪些强制配置', { topK: 5 });
    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(strictId);
  });

  it('a garbage rewrite never loses raw-query hits (max union)', async () => {
    const rawHitId = (await new HybridRetriever(store, DEFAULT_CONFIG.retrieval)
      .retrieve('装依赖用什么包管理器', { topK: 1 })).map((r) => r.memory.id)[0];
    expect(rawHitId).toBeTruthy();

    const rewriter = async () => '完全不相关的词组 青花瓷 紫砂壶';
    const results = await new HybridRetriever(store, DEFAULT_CONFIG.retrieval, rewriter)
      .retrieve('装依赖用什么包管理器', { topK: 5 });
    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(rawHitId!);
  });

  it('a throwing rewriter degrades to the raw query without failing retrieval', async () => {
    const rewriter = async () => {
      throw new Error('llm unavailable');
    };
    const results = await new HybridRetriever(store, DEFAULT_CONFIG.retrieval, rewriter)
      .retrieve('装依赖用什么包管理器', { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('PRF second round returns results and stays opt-in-off by default', async () => {
    // prf defaults to false; enabling it must not break retrieval.
    const prfOn = new HybridRetriever(store, { ...DEFAULT_CONFIG.retrieval, prf: true });
    const results = await prfOn.retrieve('装依赖用什么包管理器', { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.retrieval.prf).toBe(false);
  });
});

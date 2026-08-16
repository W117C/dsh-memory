import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Phase 1: Storage Engine & Fallback Tests', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('should initialize database tables and stats cleanly', () => {
    const stats = store.getStats();
    expect(stats.total).toBe(0);
    expect(stats.byTier.semantic).toBe(0);
    expect(['sqlite-vec', 'js-float32', 'bm25-only']).toContain(stats.vectorEngineMode);
  });

  it('should insert and retrieve semantic memory with embedding & FTS', async () => {
    const mem = await store.createMemory({
      scope: 'workspace',
      tier: 'semantic',
      category: 'rule',
      content: '本项目所有导出一律使用具名导出，禁止 default export',
      summary: 'export_convention: Named exports only',
      entity_key: 'project.conventions.exports',
      importance: 4.5,
      status: 'verified'
    });

    expect(mem.id).toBeDefined();
    expect(mem.status).toBe('verified');
    expect(mem.importance).toBe(4.5);

    const retrieved = store.getMemoryById(mem.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.summary).toBe('export_convention: Named exports only');

    // Test FTS search
    const ftsResults = store.getFtsStore().searchFts('具名导出 default');
    expect(ftsResults.length).toBeGreaterThan(0);
    expect(ftsResults[0].id).toBe(mem.id);
    expect(ftsResults[0].bm25Score).toBeGreaterThan(0);

    // Test Vector search
    const embedding = await store.getEmbeddingAdapter().embed('如何导出模块？', true);
    const vecResults = store.getVectorStore().search(embedding, 5);
    expect(vecResults.length).toBeGreaterThan(0);
    expect(vecResults[0].id).toBe(mem.id);
  });

  it('should support JS-Float32 fallback when forced', async () => {
    const jsStore = new MemoryStore({
      ...DEFAULT_CONFIG,
      storage: { forceJsVector: true }
    }, ':memory:');

    expect(jsStore.getVectorStore().getMode()).toBe('js-float32');

    const mem = await jsStore.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: 'Next.js 15 中 cookies() 是异步函数，需要使用 await cookies()',
      summary: 'cookies() is async in Next 15',
      error_signature: 'TypeError: cookies is not a function or synchronous'
    });

    const queryEmbedding = await jsStore.getEmbeddingAdapter().embed('Next 15 cookies 报错', true);
    const results = jsStore.getVectorStore().search(queryEmbedding, 3);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(mem.id);
    expect(results[0].similarity).toBeGreaterThan(0.5);

    jsStore.close();
  });

  it('should support entity graph relations', () => {
    store.addRelation({
      source_entity: 'apps/web',
      relation: 'depends_on',
      target_entity: 'packages/core',
      created_at: Date.now()
    });

    const rels = store.getRelationsForEntity('apps/web');
    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe('depends_on');
    expect(rels[0].target_entity).toBe('packages/core');
  });

  it('should update memory and soft invalidate', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'preference',
      content: 'User prefers npm',
      entity_key: 'config.package_manager'
    });

    const now = Date.now();
    const updated = store.updateMemory(mem.id, {
      invalid_at: now
    });

    expect(updated?.invalid_at).toBe(now);
  });
});

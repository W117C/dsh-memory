import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { WorkingSetBuilder } from '../src/core/working-set.js';
import { DEFAULT_CONFIG } from '../src/config.js';

/**
 * User-level scope: global memories follow the user across projects;
 * workspace memories are visible only inside their originating project
 * (origin_cwd); legacy '*' rows stay visible everywhere.
 */
describe('User-level scope: origin visibility', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('isOriginVisible follows scope + origin rules', async () => {
    const global = await store.createMemory({ tier: 'semantic', category: 'rule', scope: 'global', content: 'g', status: 'verified' });
    const local = await store.createMemory({ tier: 'semantic', category: 'rule', scope: 'workspace', content: 'l', status: 'verified' });

    expect(store.isOriginVisible(global, '/some/other/project')).toBe(true);
    expect(store.isOriginVisible(local, process.cwd())).toBe(true);
    expect(store.isOriginVisible(local, '/some/other/project')).toBe(false);
    // Legacy hand-seeded row (origin '*') stays visible everywhere.
    expect(store.isOriginVisible({ scope: 'workspace', origin_cwd: '*' }, '/anywhere')).toBe(true);
    expect(store.isOriginVisible({ scope: 'workspace' }, '/anywhere')).toBe(true);
  });

  it('working set includes global memories but not foreign-project workspace rows', async () => {
    await store.createMemory({
      tier: 'semantic', category: 'rule', scope: 'global',
      entity_key: 'user.lang', content: 'Reply in Chinese', summary: 'Reply in Chinese',
      importance: 5, status: 'verified'
    });
    // Simulate a memory written from another project root.
    store.getDb().prepare(`
      INSERT INTO memories (id, scope, tier, category, status, content, summary, path_pattern, git_branch, origin_cwd, importance, access_count, created_at, updated_at, last_accessed_at, valid_from)
      VALUES ('mem_foreign', 'workspace', 'semantic', 'rule', 'verified', 'other project rule', 'other project rule', '*', '*', '/other/project/root', 5, 0, ?, ?, ?, ?)
    `).run(Date.now(), Date.now(), Date.now(), Date.now());

    const builder = new WorkingSetBuilder(store, DEFAULT_CONFIG.retrieval);
    const ws = builder.buildWorkingSet('src/index.ts', 'main');
    expect(ws).toContain('user.lang');
    expect(ws).not.toContain('other project rule');
  });

  it('retriever filters foreign workspace rows out of candidates', async () => {
    const retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);

    await store.createMemory({
      tier: 'semantic', category: 'rule', scope: 'global',
      entity_key: 'user.editor', content: 'always format with prettier before commit', summary: 'prettier before commit',
      importance: 4, status: 'verified'
    });

    // Foreign workspace row WITH vector+fts indexes (so it WOULD be a candidate).
    const embedding = await store.getEmbeddingAdapter().embed('always format with prettier before commit', false);
    store.getDb().prepare(`
      INSERT INTO memories (id, scope, tier, category, status, content, summary, path_pattern, git_branch, origin_cwd, importance, access_count, created_at, updated_at, last_accessed_at, valid_from)
      VALUES ('mem_foreign2', 'workspace', 'semantic', 'rule', 'verified', 'always format with prettier before commit', 'foreign prettier', '*', '*', '/other/project/root', 5, 0, ?, ?, ?, ?)
    `).run(Date.now(), Date.now(), Date.now(), Date.now());
    store.getVectorStore().upsertVector('mem_foreign2', embedding);
    store.getFtsStore().upsertFts('mem_foreign2', 'always format with prettier before commit', 'foreign prettier', '');

    const results = await retriever.retrieve('how should I format before commit?', { topK: 5 });
    const ids = results.map((r) => r.memory.id);
    expect(ids).not.toContain('mem_foreign2');
  });
});

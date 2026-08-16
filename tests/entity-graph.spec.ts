import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { extractEntities, linkEntitiesForMemory } from '../src/core/entity-extractor.js';
import { MemoryWebExtension } from '../src/ui/web-extension.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Entity extraction & knowledge-graph enrichment (Zep/Cognee-class edges)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('extracts the conservative entity surface forms', () => {
    const entities = extractEntities([
      'Use `pnpm workspace` for "monorepo scripts".',
      'See config.package_manager and apps/web/src/routes/page.tsx.',
      'Watch SQLITE_VEC_LIMIT and VectorStore internals.',
      'Failed with ETIMEDOUT 5432 and TypeError.'
    ].join('\n'));

    expect(entities).toContain('pnpm workspace');
    expect(entities).toContain('monorepo scripts');
    expect(entities).toContain('config.package_manager');
    expect(entities).toContain('apps/web/src/routes/page.tsx');
    expect(entities).toContain('SQLITE_VEC_LIMIT');
    expect(entities).toContain('VectorStore');
    expect(entities).toContain('ETIMEDOUT 5432');
  });

  it('rejects sentence fragments and noise', () => {
    expect(extractEntities('a plain sentence about nothing in particular here')).toEqual([]);
    expect(extractEntities('123 456 !!!')).toEqual([]);
  });

  it('links mentions edges on write and surfaces them in the graph', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'architecture',
      entity_key: 'build.pipeline',
      content: 'The build runs `pnpm turbo run build` across apps/web before deploy. Requires config.turbo_version >= 2.',
      status: 'verified'
    });

    const linked = linkEntitiesForMemory(store, mem);
    expect(linked).toBeGreaterThanOrEqual(2);

    const relations = store.getRelationsForEntity('build.pipeline');
    const mentioned = relations.filter((r) => r.relation === 'mentions').map((r) => r.target_entity);
    expect(mentioned).toContain('pnpm turbo run build');
    expect(mentioned).toContain('config.turbo_version');

    const graph = new MemoryWebExtension(store).getGraphData();
    expect(graph.edges.some((e) => e.relation === 'mentions')).toBe(true);
    expect(graph.nodes.length).toBeGreaterThan(1);
  });

  it('never links an entity to itself', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'config.package_manager',
      content: 'config.package_manager must stay pnpm',
      status: 'verified'
    });

    linkEntitiesForMemory(store, mem);
    const relations = store.getRelationsForEntity('config.package_manager');
    expect(relations.every((r) => r.source_entity !== r.target_entity)).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { MemoryPortability } from '../src/core/portability.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Portability: batch writes + lossless JSONL export/import', () => {
  let store: MemoryStore;
  let portability: MemoryPortability;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    portability = new MemoryPortability(store, new ConflictResolver(store));
  });

  afterEach(() => {
    store.close();
  });

  it('exports active memories as one-record-per-line JSONL', async () => {
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'rule one', status: 'verified' });
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'rule two', status: 'verified' });
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'deprecated one', status: 'deprecated' });

    const jsonl = portability.exportJsonl();
    const lines = jsonl.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const record = JSON.parse(line);
      expect(typeof record.content).toBe('string');
      expect(record.status).not.toBe('deprecated');
    }
  });

  it('round-trips: export → wipe → import restores the active set', async () => {
    await store.createMemory({
      tier: 'semantic', category: 'rule', entity_key: 'a.b', content: 'fact A', status: 'verified'
    });
    await store.createMemory({
      tier: 'episodic', category: 'post_mortem', content: 'post mortem B', status: 'verified'
    });
    const snapshot = portability.exportJsonl();

    // Wipe by deprecating everything, then import into the same store.
    for (const mem of store.getDb().prepare('SELECT id FROM memories').all() as Array<{ id: string }>) {
      store.updateMemory(mem.id, { status: 'deprecated', invalid_at: Date.now() });
    }
    expect(store.getStats().byStatus.verified ?? 0).toBe(0);

    const summary = await portability.importJsonl(snapshot);
    expect(summary.processed).toBe(2);
    expect(summary.invalidLines).toBe(0);

    const stats = store.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    const activeContents = (store.getDb().prepare(
      "SELECT content FROM memories WHERE status != 'deprecated'"
    ).all() as Array<{ content: string }>).map((r) => r.content);
    expect(activeContents).toContain('fact A');
    expect(activeContents).toContain('post mortem B');
  });

  it('reports invalid lines instead of failing the whole import', async () => {
    const summary = await portability.importJsonl('{"content": "ok", "tier": "semantic", "category": "rule"}\nnot json\n{"tier": "semantic"}\n');
    expect(summary.processed).toBe(3);
    expect(summary.added).toBe(1);
    expect(summary.invalidLines).toBe(2);
  });

  it('batch import consolidates duplicates', async () => {
    const results = await portability.importBatch([
      { tier: 'semantic', category: 'rule', entity_key: 'x.y', content: 'version one', status: 'verified' },
      { tier: 'semantic', category: 'rule', entity_key: 'x.y', content: 'version two', status: 'verified' },
      { tier: 'semantic', category: 'rule', content: 'unrelated', status: 'verified' }
    ]);

    expect(results.length).toBe(3);
    expect(results[0].action).toBe('ADD');
    expect(results[1].action).toBe('OVERWRITE');
    expect(results[2].action).toBe('ADD');
    // OVERWRITE keeps the superseded row bi-temporally: 3 total, 2 valid.
    expect(store.getStats().total).toBe(3);
    const active = store.getDb().prepare(
      'SELECT COUNT(*) AS n FROM memories WHERE invalid_at IS NULL'
    ).get() as { n: number };
    expect(active.n).toBe(2);
  });

  it('exports respect the scope filter', async () => {
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'ws', scope: 'workspace', status: 'verified' });
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'gl', scope: 'global', status: 'verified' });

    const globalOnly = portability.exportJsonl({ scope: 'global' });
    const lines = globalOnly.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).content).toBe('gl');
  });
});

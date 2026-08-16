import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { VerificationGate } from '../src/pipeline/verification-gate.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { MemoryHistoryRecord } from '../src/types/memory.js';

describe('Memory change history (mem0-style durable audit log)', () => {
  let store: MemoryStore;
  let gate: VerificationGate;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    gate = new VerificationGate(store);
  });

  afterEach(() => {
    store.close();
  });

  it('records a created event on write', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'use pnpm',
      status: 'verified'
    });

    const history = store.getMemoryHistory(mem.id);
    expect(history.length).toBe(1);
    expect(history[0].event).toBe('created');
    expect(history[0].before_json).toBeNull();
    const after = JSON.parse(history[0].after_json!) as { content: string };
    expect(after.content).toBe('use pnpm');
  });

  it('records updated events with before/after projections', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'timeout is 30s'
    });

    store.updateMemory(mem.id, { content: 'timeout is 60s' });

    const history = store.getMemoryHistory(mem.id);
    expect(history.length).toBe(2);
    const update = history[0];
    expect(update.event).toBe('updated');
    expect(JSON.parse(update.before_json!).content).toBe('timeout is 30s');
    expect(JSON.parse(update.after_json!).content).toBe('timeout is 60s');
  });

  it('classifies promoted and deprecated events', async () => {
    const mem = await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: 'fix conn leak'
    });

    store.updateMemory(mem.id, { status: 'verified', verification_count: 2 });
    let history = store.getMemoryHistory(mem.id);
    expect(history[0].event).toBe('promoted');

    store.updateMemory(mem.id, { status: 'deprecated', invalid_at: Date.now() });
    history = store.getMemoryHistory(mem.id);
    expect(history[0].event).toBe('deprecated');
  });

  it('records deleted events with the final state', async () => {
    const mem = await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'temporary'
    });
    store.deleteMemory(mem.id);

    const history = store.getMemoryHistory(mem.id);
    const deleted = history.find((h) => h.event === 'deleted');
    expect(deleted).toBeDefined();
    expect(deleted!.after_json).toBeNull();
    expect(JSON.parse(deleted!.before_json!).content).toBe('temporary');
  });

  it('verification-gate transitions flow through the history log', () => {
    return (async () => {
      const mem = await store.createMemory({
        tier: 'episodic',
        category: 'post_mortem',
        content: 'x'
      });
      gate.recordVerificationSuccess(mem.id);
      gate.recordVerificationSuccess(mem.id);

      const events = store.getMemoryHistory(mem.id).map((h: MemoryHistoryRecord) => h.event);
      expect(events).toContain('promoted');
    })();
  });

  it('getAllHistory returns cross-memory timeline in reverse order', async () => {
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'a' });
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'b' });

    const all = store.getAllHistory();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].id).toBeGreaterThan(all[1].id);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { SubagentFiberManager } from '../src/core/subagent-fiber.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Phase 5: Sub-Agent Fiber Isolation & Bubble-up Merge', () => {
  let store: MemoryStore;
  let resolver: ConflictResolver;
  let subagentMgr: SubagentFiberManager;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    resolver = new ConflictResolver(store);
    subagentMgr = new SubagentFiberManager(store, resolver);
  });

  afterEach(() => {
    store.close();
  });

  it('should isolate sub-agent staged memories and discard on sub-agent failure', async () => {
    const parentSession = 'session_main_1';
    const subagentId = 'sub_worker_fail';

    // 1. Initialize sub-agent context
    subagentMgr.createSubagentContext(parentSession, subagentId);

    // 2. Sub-agent stages an exploratory trial
    subagentMgr.stageMemory(subagentId, {
      tier: 'episodic',
      category: 'post_mortem',
      content: 'Failed attempt: modified webpack.config directly'
    });

    expect(subagentMgr.getActiveContext(subagentId)?.stagedMemories.length).toBe(1);

    // 3. Sub-agent execution fails: discard staged memories
    subagentMgr.discardOnFailure(subagentId);

    expect(subagentMgr.getActiveContext(subagentId)).toBeUndefined();

    // Verify main store was NOT polluted
    const stats = store.getStats();
    expect(stats.total).toBe(0);
  });

  it('should bubble-up and merge sub-agent memories into main store on success', async () => {
    const parentSession = 'session_main_1';
    const subagentId = 'sub_worker_success';

    subagentMgr.createSubagentContext(parentSession, subagentId);

    subagentMgr.stageMemory(subagentId, {
      tier: 'procedural',
      category: 'workflow',
      entity_key: 'workflow.git_rebase_clean',
      content: 'Run `git rebase -i HEAD~3` then `git push --force-with-lease`',
      summary: 'Safe git force push workflow',
      importance: 4.5,
      status: 'verified'
    });

    const res = await subagentMgr.mergeOnSuccess(subagentId);
    expect(res.committedMemories.length).toBe(1);
    expect(res.committedMemories[0].entity_key).toBe('workflow.git_rebase_clean');
    expect(res.hasConflict).toBe(false);

    const stats = store.getStats();
    expect(stats.total).toBe(1);

    const retrieved = store.getMemoryById(res.committedMemories[0].id);
    expect(retrieved?.summary).toBe('Safe git force push workflow');
  });

  it('should execute 3-Way non-destructive semantic synthesis when concurrent sub-agents collide on same entity', async () => {
    const parentSession = 'session_parallel_root';

    // 1. Fiber A and Fiber B start concurrently
    subagentMgr.createSubagentContext(parentSession, 'fiber_auth');
    subagentMgr.createSubagentContext(parentSession, 'fiber_middleware');

    // 2. Fiber A discovers header rule and finishes first
    subagentMgr.stageMemory('fiber_auth', {
      tier: 'semantic',
      category: 'rule',
      entity_key: 'auth.header_format',
      content: 'Client must send X-Auth-Token header',
      summary: 'auth.header: X-Auth-Token',
      importance: 4.0,
      status: 'verified'
    });

    const resA = await subagentMgr.mergeOnSuccess('fiber_auth');
    expect(resA.hasConflict).toBe(false);
    expect(resA.committedMemories.length).toBe(1);

    // 3. Fiber B finishes slightly later, having discovered a complementary Bearer format on the same key
    subagentMgr.stageMemory('fiber_middleware', {
      tier: 'semantic',
      category: 'rule',
      entity_key: 'auth.header_format',
      content: 'Legacy clients may send Authorization: Bearer <token>',
      summary: 'auth.header: Bearer fallback',
      importance: 4.0,
      status: 'verified'
    });

    const resB = await subagentMgr.mergeOnSuccess('fiber_middleware');

    // 4. 3-Way Semantic Merge detected the collision and synthesized both without data loss!
    expect(resB.hasConflict).toBe(true);
    expect(resB.collidedKeys).toContain('auth.header_format');
    expect(resB.conflictResolutions.length).toBe(1);

    const mergedRecord = store.getMemoryById(resA.committedMemories[0].id);
    // Both Fiber A's discovery and Fiber B's discovery are preserved!
    expect(mergedRecord?.content).toContain('X-Auth-Token');
    expect(mergedRecord?.content).toContain('Legacy clients may send Authorization: Bearer');

    // Relations graph linked the complementary discovery
    const relations = store.getRelationsForEntity('auth.header_format.fiber_fiber_middleware');
    expect(relations.length).toBeGreaterThan(0);
    expect(relations[0].relation).toBe('complements');
  });
});

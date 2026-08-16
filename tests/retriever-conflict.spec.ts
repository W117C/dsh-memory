import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { SemanticMemoryManager } from '../src/subsystems/semantic.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Phase 2: Hybrid Retrieval & Monorepo Scoped Conflict Resolution', () => {
  let store: MemoryStore;
  let retriever: HybridRetriever;
  let resolver: ConflictResolver;
  let semanticMgr: SemanticMemoryManager;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);
    resolver = new ConflictResolver(store);
    semanticMgr = new SemanticMemoryManager(store);
  });

  afterEach(() => {
    store.close();
  });

  it('should isolate同名 entity_key under distinct path_patterns without overwriting each other', async () => {
    // 1. Frontend records build command
    const webRule = await semanticMgr.setRule(
      'config.build',
      'Run `vite build` to bundle web assets',
      'apps/web/**'
    );
    expect(webRule.entity_key).toBe('config.build');
    expect(webRule.path_pattern).toBe('apps/web/**');

    // 2. Backend records SAME entity_key under different path_pattern
    const serverRule = await semanticMgr.setRule(
      'config.build',
      'Run `tsc && tsup` to compile server bundle',
      'apps/server/**'
    );
    expect(serverRule.entity_key).toBe('config.build');
    expect(serverRule.path_pattern).toBe('apps/server/**');

    // Verify BOTH rules are active and neither was superseded
    const webActive = semanticMgr.getRule('config.build', 'apps/web/**');
    const serverActive = semanticMgr.getRule('config.build', 'apps/server/**');

    expect(webActive?.content).toContain('vite build');
    expect(serverActive?.content).toContain('tsc && tsup');
    expect(webActive?.invalid_at).toBeNull();
    expect(serverActive?.invalid_at).toBeNull();

    // 3. Update frontend rule: only frontend is superseded, backend is unaffected
    const webUpdated = await semanticMgr.setRule(
      'config.build',
      'Run `vite build --mode production` with sourcemap',
      'apps/web/**'
    );

    const oldWeb = store.getMemoryById(webRule.id);
    const newWeb = semanticMgr.getRule('config.build', 'apps/web/**');
    const stillServer = semanticMgr.getRule('config.build', 'apps/server/**');

    expect(oldWeb?.invalid_at).not.toBeNull();
    expect(newWeb?.content).toContain('--mode production');
    expect(stillServer?.content).toContain('tsc && tsup');
    expect(stillServer?.invalid_at).toBeNull();
  });

  it('should perform hierarchical fallback lookup when querying rules', async () => {
    // Set a global fallback rule
    await semanticMgr.setRule('format.indent', 'Use 2 spaces for indentation', '*');

    // Set a specific override for python backend
    await semanticMgr.setRule('format.indent', 'Use 4 spaces for indentation', 'services/py/**');

    // Python backend gets 4 spaces
    const pyRule = semanticMgr.getRule('format.indent', 'services/py/**');
    expect(pyRule?.content).toContain('4 spaces');

    // Web frontend falls back to global 2 spaces
    const webRule = semanticMgr.getRule('format.indent', 'apps/web/**');
    expect(webRule?.content).toContain('2 spaces');
  });

  it('should retrieve memories matching path pattern and score composite ranking', async () => {
    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'Use Vitest for testing frontend components',
      path_pattern: 'apps/web/**',
      importance: 4.5,
      status: 'verified'
    });

    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      content: 'Use Pytest for testing backend services',
      path_pattern: 'apps/api/**',
      importance: 4.5,
      status: 'verified'
    });

    const webResults = await retriever.retrieve('testing components', {
      currentFilePath: 'apps/web/src/Button.test.tsx'
    });

    expect(webResults.length).toBe(1);
    expect(webResults[0].memory.content).toContain('Vitest');
  });
});

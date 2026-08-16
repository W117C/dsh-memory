import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { WorkingSetBuilder } from '../src/core/working-set.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Git Branch Context Tagging & Visibility Gating', () => {
  let store: MemoryStore;
  let retriever: HybridRetriever;
  let workingSetBuilder: WorkingSetBuilder;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);
    workingSetBuilder = new WorkingSetBuilder(store, DEFAULT_CONFIG.retrieval);
  });

  afterEach(() => {
    store.close();
  });

  it('should isolate feature branch rules and prevent cross-branch time-travel contamination', async () => {
    // 1. Seed baseline rule on main branch
    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'next.cookies',
      git_branch: 'main',
      content: 'Next.js 14: cookies() is synchronous',
      summary: 'cookies(): sync (Next 14)',
      importance: 4.5,
      status: 'verified'
    });

    // 2. Seed experimental upgrade rule on feature branch
    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'next.cookies_v15',
      git_branch: 'feat/v2-next15',
      content: 'Next.js 15: const cookieStore = await cookies();',
      summary: 'cookies(): async await (Next 15)',
      importance: 5.0,
      status: 'verified'
    });

    // Case 1: Agent works on 'main' branch
    const workingSetMain = workingSetBuilder.buildWorkingSet('src/routes.ts', 'main');
    expect(workingSetMain).toContain('cookies(): sync (Next 14)');
    expect(workingSetMain).not.toContain('Next 15'); // Blocked!

    const recallMain = await retriever.retrieve('how to use cookies', {
      currentGitBranch: 'main'
    });
    expect(recallMain.some(r => r.memory.summary.includes('Next 15'))).toBe(false);

    // Case 2: Agent works on 'feat/v2-next15' branch
    const workingSetFeat = workingSetBuilder.buildWorkingSet('src/routes.ts', 'feat/v2-next15');
    expect(workingSetFeat).toContain('cookies(): async await (Next 15)');

    const recallFeat = await retriever.retrieve('how to use cookies', {
      currentGitBranch: 'feat/v2-next15'
    });
    expect(recallFeat.some(r => r.memory.summary.includes('Next 15'))).toBe(true);
  });

  it('should invalidate working set cache upon Git branch switch', async () => {
    const sessionId = 'session_git_switch_1';

    // Seed feature rule
    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      git_branch: 'feat/mobile-app',
      content: 'Mobile: use React Native Paper components',
      summary: 'Mobile: React Native Paper components',
      importance: 4.5,
      status: 'verified'
    });

    // 1. Initial on main branch
    const ws1 = workingSetBuilder.getOrCreateWorkingSet(sessionId, 'src/App.tsx', 'main');
    expect(ws1).not.toContain('React Native Paper');

    // 2. Developer switches to mobile feature branch -> Cache invalidated, new branch rules included
    const ws2 = workingSetBuilder.getOrCreateWorkingSet(sessionId, 'src/App.tsx', 'feat/mobile-app');
    expect(ws2).toContain('React Native Paper');
  });
});

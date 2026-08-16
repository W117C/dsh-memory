import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { ConflictResolver } from '../src/core/conflict-resolver.js';
import { MarkdownProjection } from '../src/core/markdown-projection.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Markdown projection (human-readable view over SQLite truth)', () => {
  let store: MemoryStore;
  let projection: MarkdownProjection;

  beforeEach(async () => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    const resolver = new ConflictResolver(store);
    void resolver;
    projection = new MarkdownProjection(store);
  });

  afterEach(() => {
    store.close();
  });

  it('exports an index plus one frontmatter doc per memory', async () => {
    await store.createMemory({
      tier: 'semantic',
      category: 'rule',
      entity_key: 'config.package_manager',
      content: 'Use pnpm, never npm install in this monorepo.',
      summary: 'pnpm only',
      importance: 4,
      status: 'verified'
    });
    await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: 'jest exit 1 on flaky test',
      summary: 'flaky test fix',
      error_signature: 'jest exit 1',
      solution_code: 'pnpm test -- --retry',
      importance: 4.5,
      status: 'tentative'
    });

    const exported = projection.exportMarkdown();
    expect(exported.count).toBe(2);

    const index = exported.files['MEMORY.md'];
    expect(index).toContain('# Memory Projection');
    expect(index).toContain('config.package_manager');
    expect((index.match(/^- \[/gm) || []).length).toBe(2);

    const docPaths = Object.keys(exported.files).filter((p) => p.startsWith('memories/'));
    expect(docPaths.length).toBe(2);
    const doc = exported.files[docPaths[0]];
    expect(doc.startsWith('---\n')).toBe(true);
    expect(doc).toContain('id: mem_');
    expect(doc).toContain('## Solution');
  });

  it('round-trips: unchanged docs are no-ops, edited docs are updated, new ids are added', async () => {
    const original = await store.createMemory({
      tier: 'semantic',
      category: 'correction',
      scope: 'global',
      content: '用户纠正：不要用 var\n修正后的行为：改用 const',
      summary: '纠错: 不要用 var → const',
      importance: 4.5,
      status: 'verified'
    });

    const exported = projection.exportMarkdown();

    // 1. Re-importing the pristine projection is a no-op.
    const first = await projection.importMarkdown(exported.files);
    expect(first).toMatchObject({ processed: 1, added: 0, updated: 0, unchanged: 1 });
    expect(store.getStats().total).toBe(1);

    // 2. Editing the memory body updates the existing row (same id).
    const docPath = Object.keys(exported.files).find((p) => p.startsWith('memories/'))!;
    exported.files[docPath] = exported.files[docPath].replace('不要用 var', '绝对不要用 var，统一 const');
    const second = await projection.importMarkdown(exported.files);
    expect(second).toMatchObject({ processed: 1, added: 0, updated: 1, unchanged: 0 });
    expect(store.getStats().total).toBe(1);
    expect(store.getMemoryById(original.id)!.content).toContain('统一 const');

    // 3. A brand-new id is added with its id preserved.
    const newDoc =
      '---\n' +
      `id: ${'mem_imported_001'}\n` +
      'tier: procedural\n' +
      'category: workflow\n' +
      'status: verified\n' +
      'scope: workspace\n' +
      'importance: 3\n' +
      "path_pattern: \"*\"\n" +
      "git_branch: \"*\"\n" +
      '---\n\nRun the release with pnpm release.\n';
    const third = await projection.importMarkdown({ 'memories/new.md': newDoc });
    expect(third).toMatchObject({ processed: 1, added: 1 });
    expect(store.getMemoryById('mem_imported_001')).not.toBeNull();

    // 4. Garbage docs are counted invalid, not thrown.
    const fourth = await projection.importMarkdown({ 'memories/bad.md': 'no frontmatter here' });
    expect(fourth.invalid).toBe(1);
  });

  it('honors scope filtering on export', async () => {
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'a', status: 'verified', scope: 'workspace' });
    await store.createMemory({ tier: 'semantic', category: 'rule', content: 'b', status: 'verified', scope: 'global' });
    const globalOnly = projection.exportMarkdown({ scope: 'global' });
    expect(globalOnly.count).toBe(1);
    expect(Object.values(globalOnly.files).join('')).toContain('scope: global');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { VerificationGate, containsAntiPatterns } from '../src/pipeline/verification-gate.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Anti-Pattern Static Sentinel & Strict Promotion Admission', () => {
  let store: MemoryStore;
  let gate: VerificationGate;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    gate = new VerificationGate(store);
  });

  afterEach(() => {
    store.close();
  });

  it('should detect various technical debt and suppression anti-patterns', () => {
    // 1. TypeScript Suppressions
    const r1 = containsAntiPatterns('// @ts-ignore\nconst data: any = res.body;');
    expect(r1.isAntiPattern).toBe(true);
    expect(r1.reason).toContain('@ts-ignore');

    const r2 = containsAntiPatterns('// @ts-nocheck\nexport function test() {}');
    expect(r2.isAntiPattern).toBe(true);

    // 2. Linter Suppressions
    const r3 = containsAntiPatterns('/* eslint-disable-next-line @typescript-eslint/no-explicit-any */');
    expect(r3.isAntiPattern).toBe(true);
    expect(r3.reason).toContain('eslint-disable');

    // 3. Empty Catch Blocks
    const r4 = containsAntiPatterns('try { doWork(); } catch (err) {}');
    expect(r4.isAntiPattern).toBe(true);
    expect(r4.reason).toContain('empty catch block');

    // 4. Clean Code
    const rClean = containsAntiPatterns('const cookieStore = await cookies(); return cookieStore.get("token");');
    expect(rClean.isAntiPattern).toBe(false);
  });

  it('should block automatic promotion to verified for workaround code containing anti-patterns', async () => {
    // 1. Create a workaround post-mortem that uses @ts-ignore
    const hackMem = await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: 'Fix TS2322: ignore type error',
      solution_code: '// @ts-ignore\nconst user = response.data;',
      status: 'tentative',
      importance: 3.0
    });

    // Simulate 5 successful task reuses
    for (let i = 0; i < 5; i++) {
      gate.recordVerificationSuccess(hackMem.id);
    }

    const updatedHack = store.getMemoryById(hackMem.id);
    // Verification count increased, but status is PERMANENTLY BLOCKED at tentative!
    expect(updatedHack?.verification_count).toBe(5);
    expect(updatedHack?.status).toBe('tentative');
    expect(updatedHack?.importance).toBe(3.0); // Importance not boosted
    expect(gate.isEligibleForWorkingSet(updatedHack!)).toBe(false);
  });

  it('should smoothly promote clean, high-quality code to verified golden rules', async () => {
    // 1. Create a clean post-mortem
    const cleanMem = await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: 'Fix Prisma client connection pooling',
      solution_code: 'const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });',
      status: 'tentative',
      importance: 3.0
    });

    // First reuse
    const v1 = gate.recordVerificationSuccess(cleanMem.id);
    expect(v1?.verification_count).toBe(1);
    expect(v1?.status).toBe('tentative');

    // Second reuse: Clean code gets promoted!
    const v2 = gate.recordVerificationSuccess(cleanMem.id);
    expect(v2?.verification_count).toBe(2);
    expect(v2?.status).toBe('verified');
    expect(v2?.importance).toBe(4.0); // Boosted
    expect(gate.isEligibleForWorkingSet(v2!)).toBe(true);
  });
});

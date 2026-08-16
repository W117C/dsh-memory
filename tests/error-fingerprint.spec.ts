import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { EpisodicMemoryManager } from '../src/subsystems/episodic.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { extractErrorFingerprint } from '../src/core/error-fingerprint.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Error Fingerprinting & Domain Guard Anti-Overfitting', () => {
  let store: MemoryStore;
  let episodicMgr: EpisodicMemoryManager;
  let retriever: HybridRetriever;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    episodicMgr = new EpisodicMemoryManager(store);
    retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);
  });

  afterEach(() => {
    store.close();
  });

  it('should accurately categorize and extract error fingerprints', () => {
    const fpLocal = extractErrorFingerprint("Error: Cannot find module './utils/logger'");
    expect(fpLocal.errorType).toBe('MISSING_LOCAL_FILE');
    expect(fpLocal.targetSymbol).toBe('./utils/logger');

    const fpPkg = extractErrorFingerprint("Error: Cannot find module 'lodash-es'");
    expect(fpPkg.errorType).toBe('MISSING_PACKAGE');
    expect(fpPkg.targetSymbol).toBe('lodash-es');

    const fpTs = extractErrorFingerprint("error TS2322: Type 'string' is not assignable to type 'number'");
    expect(fpTs.errorType).toBe('TYPE_MISMATCH');
    expect(fpTs.targetSymbol).toBe('TS2322');
  });

  it('should prevent false-positive transfer between missing package and missing local file', async () => {
    // 1. Record Solution A: Missing local file -> create file
    await episodicMgr.recordPostMortem({
      errorSignature: "Error: Cannot find module './components/AuthButton'",
      rootCause: 'Component file was deleted',
      solutionCode: 'Create src/components/AuthButton.tsx with default export'
    });

    // 2. Record Solution B: Missing external NPM package -> pnpm add
    await episodicMgr.recordPostMortem({
      errorSignature: "Error: Cannot find module 'zustand'",
      rootCause: 'Missing npm state management package',
      solutionCode: 'run_command pnpm add zustand'
    });

    // Case 1: Agent encounters missing NPM package 'lodash-es'
    const resultsForPkg = await retriever.retrieve("Cannot find module 'zustand'");
    expect(resultsForPkg.length).toBeGreaterThan(0);
    // Verified that it returns Solution B, and Solution A was BLOCKED by Domain Guard
    expect(resultsForPkg[0].memory.solution_code).toContain('pnpm add zustand');
    expect(resultsForPkg.some(r => r.memory.solution_code.includes('AuthButton'))).toBe(false);

    // Case 2: Agent encounters missing local file './components/AuthButton'
    const resultsForLocal = await retriever.retrieve("Cannot find module './components/AuthButton'");
    expect(resultsForLocal.length).toBeGreaterThan(0);
    expect(resultsForLocal[0].memory.solution_code).toContain('Create src/components/AuthButton.tsx');
    expect(resultsForLocal.some(r => r.memory.solution_code.includes('pnpm add'))).toBe(false);
  });
});

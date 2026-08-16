import { MemoryStore } from '../storage/db.js';
import { MemoryRecord } from '../types/memory.js';

export interface AntiPatternCheckResult {
  isAntiPattern: boolean;
  reason?: string;
}

/**
 * Anti-Pattern Static Sentinel:
 * Scans code snippets for technical debt workarounds, suppressions,
 * and error swallowing that should NEVER be promoted to permanent golden rules.
 */
export function containsAntiPatterns(code: string): AntiPatternCheckResult {
  if (!code) return { isAntiPattern: false };
  const text = code.toLowerCase();

  // 1. TypeScript Suppression Directives
  if (text.includes('@ts-ignore') || text.includes('@ts-nocheck')) {
    return {
      isAntiPattern: true,
      reason: 'Contains TypeScript suppression directives (@ts-ignore / @ts-nocheck)'
    };
  }

  // 2. Linter & Formatter Suppressions
  if (
    text.includes('eslint-disable') ||
    text.includes('prettier-ignore') ||
    text.includes('biome-ignore')
  ) {
    return {
      isAntiPattern: true,
      reason: 'Contains linter suppression comments (eslint-disable / prettier-ignore)'
    };
  }

  // 3. Error Swallowing & Empty Catch Blocks
  if (/catch\s*\([a-zA-Z0-9_]*\)\s*\{\s*\}/i.test(code) || /catch\s*\{\s*\}/i.test(code)) {
    return {
      isAntiPattern: true,
      reason: 'Contains empty catch block swallowing runtime errors'
    };
  }

  // 4. Bypassed / Commented Assertions
  if (/\/\/\s*expect\s*\(/.test(code) || /\/\/\s*assert\s*\(/.test(code)) {
    return {
      isAntiPattern: true,
      reason: 'Contains commented-out test assertions'
    };
  }

  return { isAntiPattern: false };
}

export class VerificationGate {
  constructor(private store: MemoryStore) {}

  public recordVerificationSuccess(memoryId: string): MemoryRecord | null {
    const mem = this.store.getMemoryById(memoryId);
    if (!mem) return null;

    const newCount = (mem.verification_count || 0) + 1;

    // Check for Anti-Patterns before allowing promotion
    const textToCheck = `${mem.solution_code || ''} ${mem.content}`;
    const antiPatternCheck = containsAntiPatterns(textToCheck);

    // Hard Admission Gate: Anti-patterns can NEVER be automatically promoted to verified
    const shouldPromote = !antiPatternCheck.isAntiPattern && newCount >= 2 && mem.status === 'tentative';

    return this.store.updateMemory(memoryId, {
      verification_count: newCount,
      status: shouldPromote ? 'verified' : mem.status,
      importance: antiPatternCheck.isAntiPattern
        ? mem.importance // Do not boost importance for anti-patterns
        : Math.min(5.0, mem.importance + 0.5)
    });
  }

  public recordVerificationFailure(memoryId: string, reason = 'Execution failed during reuse'): MemoryRecord | null {
    const mem = this.store.getMemoryById(memoryId);
    if (!mem) return null;

    // Invalidate immediately to prevent future hallucinations
    return this.store.updateMemory(memoryId, {
      status: 'deprecated',
      invalid_at: Date.now()
    });
  }

  public isEligibleForWorkingSet(memory: MemoryRecord): boolean {
    if (memory.status === 'verified') return true;
    if (memory.tier === 'semantic' && memory.importance >= 4.5) return true;
    return false;
  }
}

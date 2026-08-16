/**
 * Correction extraction — the Claude-Code-auto-memory experience.
 *
 * A "correction" is a user pushback ("不对", "别用 npm", "wrong, use X")
 * followed within a few steps by a visibly different agent behavior. These
 * pairs are the single highest-value memories for self-use quality: they are
 * user-authored (high trust → verified immediately) and they generalize
 * across projects (scope: 'global').
 */
import type { TrajectoryStep } from './trajectory-filter.js';
import { stripReasoningContent } from './trajectory-filter.js';

export interface CorrectionPair {
  /** The user's pushback text (sanitized, bounded). */
  trigger: string;
  /** The agent behavior that followed (the corrected course). */
  correctedBehavior: string;
  /** Step index of the pushback, for ordering / dedup. */
  atStep: number;
}

const CORRECTION_PATTERNS: RegExp[] = [
  // Chinese pushbacks
  /不对|不是这|搞错|错了|别用|不要用|别再|不要这|重新来|重来|我说的是|我的意思是|换个方法|换一种|还是用回|这版不行|不行，/,
  // English pushbacks
  /\bwrong\b|\bnot what i\b|\bno,?\s|\.instead\b|\bi said\b|\bdon'?t use\b|\bstop using\b|\bredo\b|\bregenerate\b|\btry again\b/i
];

/** Weak directive words that alone do NOT count as corrections (already covered by rule extraction). */
const DIRECTIVE_ONLY = /必须|不要|严禁|不要|don'?t|never|must|prefer|always/i;

export function isCorrectionText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 600) return false;
  return CORRECTION_PATTERNS.some((re) => re.test(t));
}

export class CorrectionExtractor {
  /**
   * Scan a sanitized trajectory for pushback → behavior-change pairs.
   * Only USER_INPUT triggers count, and the corrected behavior must be a
   * MODEL/TOOL step that differs from what the model was doing just before
   * the pushback (otherwise "wrong" in passing prose would fire).
   */
  public extract(steps: TrajectoryStep[]): CorrectionPair[] {
    const sanitized = steps
      .map((s) => ({ ...s, content: stripReasoningContent(s.content || '') }))
      .filter((s) => s.content);

    const pairs: CorrectionPair[] = [];

    for (let i = 0; i < sanitized.length; i++) {
      const step = sanitized[i];
      if (step.type !== 'USER_INPUT') continue;

      const text = step.content.trim();
      if (!isCorrectionText(text)) continue;
      // A pure directive ("必须跑测试") is a rule, not a correction.
      if (DIRECTIVE_ONLY.test(text) && !/\b错|不对|wrong|不是这|no,|搞错/i.test(text)) continue;

      // Look forward for the corrected course: first substantive MODEL or
      // TOOL_CALL step within 4 steps.
      for (let j = i + 1; j < Math.min(sanitized.length, i + 5); j++) {
        const next = sanitized[j];
        if (next.type === 'USER_INPUT') break; // user spoke again before any behavior
        if (next.type === 'MODEL' || next.type === 'TOOL_CALL') {
          const behavior = next.content.trim();
          if (!behavior || behavior.length < 8) break;
          pairs.push({
            trigger: text.slice(0, 200),
            correctedBehavior: behavior.slice(0, 300),
            atStep: step.step_index ?? i
          });
          break;
        }
      }
    }

    return this.dedupe(pairs);
  }

  /** Drop near-duplicate pushbacks within one session (same trigger prefix). */
  private dedupe(pairs: CorrectionPair[]): CorrectionPair[] {
    const seen: string[] = [];
    const out: CorrectionPair[] = [];
    for (const p of pairs) {
      const key = p.trigger.slice(0, 40);
      if (seen.some((s) => s === key)) continue;
      seen.push(key);
      out.push(p);
    }
    return out;
  }
}

export function correctionToMemoryInput(pair: CorrectionPair): import('../types/memory.js').MemoryCreateInput {
  const hook = pair.trigger.replace(/\s+/g, ' ').slice(0, 60);
  const slug = hook
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'correction';
  return {
    tier: 'semantic',
    category: 'correction',
    scope: 'global',
    status: 'verified',
    importance: 4.5,
    entity_key: `correction.${slug}`,
    content: `用户纠正：${pair.trigger}\n修正后的行为：${pair.correctedBehavior}`,
    summary: `纠错: ${hook} → ${pair.correctedBehavior.replace(/\s+/g, ' ').slice(0, 80)}`,
    reason: 'correction-extractor'
  };
}

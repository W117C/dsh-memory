/**
 * Native prompt-surface injection over `ctx.systemPrompt`
 * (`@deepseek-ai/dsh-system-prompt`).
 *
 * Two tiers, mapped onto the registry's own two contribution kinds, so the
 * plugin never rewrites an assembled request (LOOP-built requests are
 * deep-frozen by contract; listeners read, never rewrite):
 *
 * - Tier 1 — `systemPrompt.section` named `memory:working-set` at order 90
 *   (just before the 100–199 tool-guidance band). The section text is a
 *   provider over the session-frozen working set, so the system prefix stays
 *   byte-stable for the session lifetime and the provider-server context
 *   cache (DeepSeek-V4 prefix caching) keeps hitting across turns.
 *
 * - Tier 2 — `systemPrompt.context` named `memory:recall` at order 500.
 *   Recall results land in a per-session snapshot buffer and are
 *   materialized as a durable user-role snapshot, so volatile retrieval
 *   content evolves turn by turn without ever invalidating the cached
 *   system prefix.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AssembleContext, PromptSection, PromptContext } from '@deepseek-ai/dsh-system-prompt';
import { WorkingSetBuilder, normalizeForKvCache } from './working-set.js';
import type { ScoredMemory } from '../types/memory.js';

/** Structural face of the registry service (runtime reach via `ctx.get`). */
export interface SystemPromptLike {
  section(section: PromptSection): () => void;
  context(context: PromptContext): () => void;
}

export const MEMORY_SECTION_NAME = 'memory:working-set';
export const MEMORY_SECTION_ORDER = 90;
export const MEMORY_CONTEXT_NAME = 'memory:recall';
export const MEMORY_CONTEXT_ORDER = 500;

export function getSystemPrompt(ctx: Context): SystemPromptLike | undefined {
  const candidate = (ctx as { get?: (name: string) => unknown }).get?.('systemPrompt');
  if (
    candidate &&
    typeof (candidate as SystemPromptLike).section === 'function' &&
    typeof (candidate as SystemPromptLike).context === 'function'
  ) {
    return candidate as SystemPromptLike;
  }
  return undefined;
}

interface SessionInjectionState {
  boundFilePath: string;
  boundGitBranch: string;
  recallLines: string[];
}

export class NativeMemoryInjector {
  private states = new Map<string, SessionInjectionState>();

  constructor(
    private ctx: Context,
    private workingSetBuilder: WorkingSetBuilder,
    private enabled: boolean
  ) {}

  /**
   * Register the Tier 1 section and Tier 2 context on the live registry.
   * Returns the combined disposer (or `undefined` when the surface is absent,
   * e.g. under a headless profile without the system-prompt row).
   */
  public register(): (() => void) | undefined {
    if (!this.enabled) return undefined;
    const systemPrompt = getSystemPrompt(this.ctx);
    if (!systemPrompt) return undefined;

    const disposeSection = systemPrompt.section({
      name: MEMORY_SECTION_NAME,
      order: MEMORY_SECTION_ORDER,
      text: (context: AssembleContext) => this.provideWorkingSetText(context)
    });

    const disposeContext = systemPrompt.context({
      name: MEMORY_CONTEXT_NAME,
      order: MEMORY_CONTEXT_ORDER,
      text: (context: AssembleContext) => this.provideRecallText(context)
    });

    return () => {
      disposeSection();
      disposeContext();
    };
  }

  /** Freeze (or lazily create) the per-session working-set binding. */
  public bindSession(sessionId: string, currentFilePath = '', gitBranch = ''): void {
    if (!this.states.has(sessionId)) {
      this.states.set(sessionId, {
        boundFilePath: currentFilePath,
        boundGitBranch: gitBranch,
        recallLines: []
      });
    }
  }

  public dropSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /**
   * Tier 2 write: record a recall result into the session snapshot buffer.
   * Called by the `memory_recall` tool body right after retrieval.
   */
  public recordRecall(sessionId: string, query: string, results: ScoredMemory[]): void {
    const state = this.states.get(sessionId);
    if (!state) return;

    const lines = [`[memory:recall ${new Date().toISOString()}] ${query}`];
    for (const scored of results) {
      const mem = scored.memory;
      lines.push(
        `- (${mem.status}, ${scored.score.toFixed(2)}) ${mem.error_signature ? `${mem.error_signature}: ` : ''}${mem.solution_code || mem.summary}`
      );
    }
    // Keep the snapshot bounded: newest recalls win, oldest fall off.
    state.recallLines.unshift(...lines);
    state.recallLines = state.recallLines.slice(0, 40);
  }

  /**
   * Tier 1 provider. The returned text is byte-stable per session (frozen at
   * bind time through the WorkingSetBuilder's session cache) — the property
   * the V4 server-side prefix cache needs to keep the system prefix hit.
   */
  private provideWorkingSetText(context: AssembleContext): string {
    const state = this.resolveState(context);
    if (!state) return '';
    const text = this.workingSetBuilder.getOrCreateWorkingSet(
      activeSessionIdOf(context),
      state.boundFilePath,
      state.boundGitBranch
    );
    return normalizeForKvCache(text);
  }

  /** Tier 2 provider over the per-session recall snapshot buffer. */
  private provideRecallText(context: AssembleContext): string {
    const state = this.resolveState(context);
    if (!state || state.recallLines.length === 0) return '';
    return state.recallLines.join('\n');
  }

  private resolveState(context: AssembleContext): SessionInjectionState | undefined {
    // The real AssembleContext carries `scope` (a ScopeKey) and optional
    // plugin-defined fields; accept either a string scope or a sessionId
    // field before falling back to single-session attribution.
    const raw = context as { scope?: unknown; sessionId?: unknown };
    const key = typeof raw.scope === 'string' ? raw.scope : typeof raw.sessionId === 'string' ? raw.sessionId : undefined;
    if (key) {
      const byId = this.states.get(key);
      if (byId) return byId;
    }
    // Single-session fallback: with exactly one live binding, attribute the
    // assembly to it (covers surfaces that do not stamp scope/session ids).
    if (this.states.size === 1) {
      return this.states.values().next().value;
    }
    return undefined;
  }
}

function activeSessionIdOf(context: AssembleContext): string {
  const raw = context as { scope?: unknown; sessionId?: unknown };
  if (typeof raw.scope === 'string') return raw.scope;
  if (typeof raw.sessionId === 'string') return raw.sessionId;
  return '__unscoped__';
}

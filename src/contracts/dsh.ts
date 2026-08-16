/**
 * Host-side contract layer over `@deepseek-ai/cordis` v4.
 *
 * The services typed here (`tools`, session events) ship in dsh packages whose
 * published type trees pull unpublished transitive dependencies
 * (`@deepseek-ai/dsh-type-meta` et al.), so this module re-declares the exact
 * surface this plugin consumes, field-for-field from the published
 * `@deepseek-ai/dsh-tools@0.0.1-rc.1` / `@deepseek-ai/dsh-session@0.0.1-rc.1`
 * declarations. Where a full package IS installable (`dsh-system-prompt`,
 * `dsh-llm`, `dsh-host-webserver`), the plugin imports those types directly and
 * this file stays out of their way.
 *
 * Runtime rule enforced throughout: every dsh capability is OPTIONAL. The
 * plugin reaches it through `ctx.get(name)` and degrades when absent, per the
 * dsh plugin-development skill ("Do not overuse `inject` merely to avoid an
 * `undefined` check").
 */
import type { Context } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Tool registry (`@deepseek-ai/dsh-tools`). Absent outside an agent surface. */
    tools?: DshToolRegistry;
  }

  interface Events {
    /**
     * Creation announcement during session publication. Emit mode.
     * Contract: `dsh-session` `session/created`.
     */
    'session/created'(session: DshSessionSnapshot): void;
    /**
     * Emitted once when an announced session leaves the store. Emit mode.
     * Contract: `dsh-session` `session/disposed`.
     */
    'session/disposed'(session: DshSessionSnapshot): void;
    /**
     * Post-commit, fire-and-forget append feed (the trajectory source for
     * distillation). Emit mode. Contract: `dsh-session` `session/event`.
     */
    'session/event'(session: DshSessionSnapshot, event: DshSessionEvent): void;
  }
}

/** The leaf fields of a live `Session` this plugin reads (internal-live-data rule: never clone the whole object). */
export interface DshSessionSnapshot {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string;
}

/** One appended session-log event; only the classification fields are consumed. */
export interface DshSessionEvent {
  readonly type: string;
  readonly agent?: { id?: string };
  readonly message?: {
    role?: string;
    content?: unknown;
  };
}

/** JSON-Schema node accepted by the tools registry's output declaration. */
export type DshJsonSchemaNode = Record<string, unknown>;

/** One text content block (`ContentBlockMap['text']` from `@deepseek-ai/dsh-llm`). */
export interface DshTextBlock {
  type: 'text';
  text: string;
}

/** Execution identity handed to a tool body (`ToolRunContext`, reduced to the used fields). */
export interface DshToolRunContext {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
}

/**
 * `ToolDefinition` reduced to the mandatory surface
 * (`@deepseek-ai/dsh-tools`): a ToolSchema plus the canonical output
 * declaration and the async body.
 */
export interface DshToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: DshJsonSchemaNode;
    render(args: unknown, value: unknown): DshTextBlock[];
  };
  execute(args: unknown, exec: DshToolRunContext): Promise<unknown>;
}

/** `ToolRegistry.register` — the one method this plugin calls. */
export interface DshToolRegistry {
  register(definition: DshToolDefinition): () => void;
}

/** Narrow `ctx.get('tools')` to the contract face. */
export function getToolRegistry(ctx: Context): DshToolRegistry | undefined {
  const candidate = (ctx as { get?: (name: string) => unknown }).get?.('tools');
  if (candidate && typeof (candidate as DshToolRegistry).register === 'function') {
    return candidate as DshToolRegistry;
  }
  return undefined;
}

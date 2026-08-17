/**
 * Ultra effort grading: the Claude Code effort vocabulary mapped onto the
 * DeepSeek Harness reasoning seam, plus the automatic-orchestration toggle.
 *
 * Pure policy logic only — the Cordis plugin wiring lives in `./index`.
 *
 * @module dsh-ultra/effort
 */

/** Ultra effort levels, in Claude Code ordering (low → ultracode). */
export const ULTRA_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'ultracode'] as const

/** One selectable ultra effort level. */
export type UltraEffortLevel = (typeof ULTRA_EFFORT_LEVELS)[number]

/** Reasoning efforts the DeepSeek adapter publishes (`off` disables thinking). */
export type UltraReasoningEffort = 'off' | 'high' | 'max'

/** Deployment-tunable level → adapter reasoning effort mapping. */
export type UltraEffortMap = Partial<Record<UltraEffortLevel, UltraReasoningEffort>>

/**
 * Default mapping for DeepSeek V4, which distinguishes only `off` / `high` /
 * `max` reasoning effort. `low` disables thinking entirely (cheapest); the
 * mid tiers converge on `high`; the top tiers use `max`. The adapter itself
 * maps these onto `thinking: {type: 'disabled'}` / `thinking: {type: 'enabled',
 * reasoning_effort}` (see llm-deepseek/src/serialize.ts).
 */
export const DEFAULT_ULTRA_EFFORT_MAP: Required<UltraEffortMap> = {
  low: 'off',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  ultracode: 'max',
}

/** Levels that enable automatic orchestration by default. */
export const DEFAULT_AUTO_ORCHESTRATE_LEVELS: readonly UltraEffortLevel[] = ['ultracode']

/** The resolved policy for one effort level. */
export interface UltraEffortPolicy {
  /** The level. */
  readonly level: UltraEffortLevel
  /** The adapter reasoning effort to apply to model requests. */
  readonly reasoningEffort: UltraReasoningEffort
  /** Whether the level enables automatic orchestration (dsh-ultra-orchestrator). */
  readonly autoOrchestrate: boolean
}

/**
 * Narrow a string to an ultra effort level.
 * @param value - the candidate level name.
 * @returns `true` when the value names a valid level.
 */
export function isUltraEffortLevel(value: string): value is UltraEffortLevel {
  return (ULTRA_EFFORT_LEVELS as readonly string[]).includes(value)
}

/**
 * Resolve the policy for one level against a (partial) deployment mapping.
 * @param level - the ultra effort level.
 * @param map - deployment mapping overrides (defaults fill the gaps).
 * @param autoOrchestrateLevels - levels that enable automatic orchestration.
 * @returns the resolved reasoning effort and orchestration toggle.
 */
export function resolveEffortPolicy(
  level: UltraEffortLevel,
  map: UltraEffortMap = {},
  autoOrchestrateLevels: readonly UltraEffortLevel[] = DEFAULT_AUTO_ORCHESTRATE_LEVELS,
): UltraEffortPolicy {
  return {
    level,
    reasoningEffort: map[level] ?? DEFAULT_ULTRA_EFFORT_MAP[level],
    autoOrchestrate: autoOrchestrateLevels.includes(level),
  }
}

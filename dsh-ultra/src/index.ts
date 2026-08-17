/**
 * dsh-ultra effort plugin: the `/effort` command grades reasoning effort and
 * toggles automatic orchestration, persisted through settings.
 *
 * This is a thin semantic layer per ADR-001: it writes the resolved reasoning
 * effort into the default model selection (`ctx.agentDefaultModel`) so the
 * agent loop applies it without any adapter or loop patch, and it records the
 * selected level under its own settings namespace for the orchestration layer
 * (`dsh-ultra-orchestrator`) to consume.
 *
 * @module dsh-ultra
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
// Declaration merges only: these importers make `ctx.commands` and
// `ctx.agentDefaultModel` visible on the Cordis Context.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  DEFAULT_AUTO_ORCHESTRATE_LEVELS,
  DEFAULT_ULTRA_EFFORT_MAP,
  ULTRA_EFFORT_LEVELS,
  isUltraEffortLevel,
  resolveEffortPolicy,
  type UltraEffortLevel,
  type UltraEffortMap,
  type UltraReasoningEffort,
} from './effort.ts'

export const name = 'ultra-effort'
export const inject = ['commands', 'agentDefaultModel']

/** Settings payload recorded under the `ultra-effort` settings namespace. */
export interface UltraEffortSettings {
  /** The currently selected ultra effort level. */
  level: UltraEffortLevel
}

/** Deployment policy for the effort command. */
export interface Config {
  /** Level → adapter reasoning effort mapping (defaults: DeepSeek V4). */
  effortMap?: UltraEffortMap
  /** Levels that enable automatic orchestration. */
  autoOrchestrateLevels?: UltraEffortLevel[]
}

const EFFORT_LEVELS_SCHEMA = z.union(ULTRA_EFFORT_LEVELS.map((level) => z.const(level)))
const REASONING_EFFORT_SCHEMA = z.union([z.const('off'), z.const('high'), z.const('max')])

/** Schemastery configuration for the effort plugin. */
export const Config: z<Config> = z.object({
  effortMap: z
    .object({
      // Key-level defaults make a partial deployment override fill the gaps
      // with the DeepSeek V4 defaults, matching the runtime fallback in
      // resolveEffortPolicy (a full-map requirement would force deployers to
      // restate every tier).
      low: REASONING_EFFORT_SCHEMA.default(DEFAULT_ULTRA_EFFORT_MAP.low),
      medium: REASONING_EFFORT_SCHEMA.default(DEFAULT_ULTRA_EFFORT_MAP.medium),
      high: REASONING_EFFORT_SCHEMA.default(DEFAULT_ULTRA_EFFORT_MAP.high),
      xhigh: REASONING_EFFORT_SCHEMA.default(DEFAULT_ULTRA_EFFORT_MAP.xhigh),
      ultracode: REASONING_EFFORT_SCHEMA.default(DEFAULT_ULTRA_EFFORT_MAP.ultracode),
    })
    .default({ ...DEFAULT_ULTRA_EFFORT_MAP }),
  autoOrchestrateLevels: z.array(EFFORT_LEVELS_SCHEMA).default([...DEFAULT_AUTO_ORCHESTRATE_LEVELS]),
})

const EFFORT_SETTINGS_SCHEMA = z.object({ level: EFFORT_LEVELS_SCHEMA })

/** Apply a reasoning effort to the default model selection, preserving provider/model. */
function applyReasoningEffort(
  agentDefaultModel: Context['agentDefaultModel'],
  effort: UltraReasoningEffort,
): Promise<void> {
  const selection = agentDefaultModel.currentSelection()
  const next: ModelSelection = {
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: ReasoningEffortId(effort),
  }
  return agentDefaultModel.saveSelection(next)
}

/**
 * Mount the effort plugin: install the settings section and register the
 * `/effort` command.
 * @param ctx - the Cordis context.
 * @param config - deployment effort mapping and orchestration levels.
 */
export function apply(ctx: Context, config: Config): void {
  const ultraNamespace = settingsNamespace('ultra-effort')
  const entry: UltraEffortSettings = { level: 'high' }
  let source: () => UltraEffortSettings = () => entry
  installSettingsSection(ctx, ultraNamespace, EFFORT_SETTINGS_SCHEMA, entry, {
    setSource: (next) => {
      source = next
    },
    onChange: () => {},
  })

  ctx.effect(() => ctx.commands.register({
    name: 'effort',
    description: 'Set reasoning effort and orchestration level: low | medium | high | xhigh | ultracode.',
    input: { hint: 'low | medium | high | xhigh | ultracode' },
    handler: async (invocation) => {
      const token = invocation.rawInput.trim().toLowerCase()
      if (token.length === 0) {
        const current = source().level
        const policy = resolveEffortPolicy(current, config.effortMap, config.autoOrchestrateLevels)
        // The level namespace and the model selection are two facts that can
        // drift apart (e.g. a Models-page edit bypassing /effort), so the
        // query surfaces both and flags any mismatch.
        const actual = ctx.agentDefaultModel.currentSelection().reasoningEffort
        const resync = actual !== undefined && actual !== policy.reasoningEffort
        return {
          kind: 'success',
          text: `effort: ${current} → reasoningEffort=${policy.reasoningEffort}, autoOrchestrate=${policy.autoOrchestrate}; current default model resolves reasoningEffort=${actual ?? 'default'}${resync ? ` (mismatch — run /effort ${current} to resync)` : ''}. Set with /effort low | medium | high | xhigh | ultracode.`,
        }
      }
      if (!isUltraEffortLevel(token)) {
        return {
          kind: 'error',
          text: `Unknown effort level "${token}". Choose: ${ULTRA_EFFORT_LEVELS.join(' | ')}.`,
        }
      }
      const policy = resolveEffortPolicy(token, config.effortMap, config.autoOrchestrateLevels)
      // Apply the load-bearing side effect first (the model selection), then
      // record the level for the orchestration layer. If the level write
      // fails the effort is still live, so that failure is surfaced instead
      // of silently dropping either fact.
      await applyReasoningEffort(ctx.agentDefaultModel, policy.reasoningEffort)
      // The degradation note depends on whether a settings provider is actually
      // mounted, not on the (post-save tautological) selection read: with no
      // provider, installSettingsSection never wired a source, so the level
      // write would be silently dropped and only the current process sees the
      // effort.
      const settings = ctx.get('settings')
      if (settings) {
        try {
          await settings.replace(ultraNamespace, { level: token })
        } catch (error) {
          return {
            kind: 'error',
            text: `effort set to ${token} (reasoningEffort=${policy.reasoningEffort}) but recording the level failed: ${String(error)}. Re-run /effort ${token} to persist the level.`,
          }
        }
      }
      return {
        kind: 'success',
        text: `effort set to ${token} (reasoningEffort=${policy.reasoningEffort}, autoOrchestrate=${policy.autoOrchestrate}).${settings ? ' Applies to new sessions.' : ' Note: no settings provider is mounted, so this effort applies only for the current process.'}`,
      }
    },
  }), 'ultra-effort: /effort command')
}

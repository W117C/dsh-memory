import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

interface CommandDefinitionStub {
  name: string
  description: string
  handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }>
}

interface SelectionStub {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * Build a minimal Cordis-shaped harness that drives the real `apply()` wiring:
 * a fake settings provider, a live model-selection stub, and a command
 * registry that captures the registered `/effort` definition.
 */
function makeHarness(withSettings = true) {
  const registered = new Map<string, CommandDefinitionStub>()
  let selection: SelectionStub = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const saveSelection = vi.fn(async (next: SelectionStub) => {
    selection = { ...next }
  })
  const settingsReplace = vi.fn(async () => {})

  const ctx = {
    commands: {
      register: vi.fn((definition: CommandDefinitionStub) => {
        registered.set(definition.name, definition)
        return () => {}
      }),
    },
    agentDefaultModel: {
      currentSelection: () => selection,
      saveSelection,
    },
    settings: withSettings
      ? {
          register: vi.fn(() => ({
            get: () => ({ level: 'high' }),
            watch: () => () => {},
            update: async () => {},
            replace: async () => {},
          })),
          replace: settingsReplace,
        }
      : undefined,
    inject: (deps: string[], fn: (ctx: unknown) => void) => {
      // Cordis runs the callback only when every injected dependency is
      // mounted; mirror that so installSettingsSection's ['settings'] inject
      // no-ops when no settings provider exists.
      if (deps.every((dep) => ctx[dep as keyof typeof ctx] !== undefined)) {
        fn(ctx)
      }
    },
    effect: (fn: () => unknown) => fn(),
    get: (key: string) => (key === 'settings' ? ctx.settings : undefined),
  }

  apply(ctx as never, {})
  return { registered, saveSelection, settingsReplace }
}

function effortCommand(registered: Map<string, CommandDefinitionStub>): CommandDefinitionStub {
  const definition = registered.get('effort')
  expect(definition).toBeDefined()
  return definition!
}

describe('ultra-effort plugin wiring', () => {
  it('registers the /effort command', () => {
    const { registered } = makeHarness()
    expect(effortCommand(registered).name).toBe('effort')
  })

  it('reports the current level on empty input', async () => {
    const { registered } = makeHarness()
    const result = await effortCommand(registered).handler({ rawInput: '' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('effort: high')
  })

  it('rejects an unknown level', async () => {
    const { registered } = makeHarness()
    const result = await effortCommand(registered).handler({ rawInput: 'turbo' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Unknown effort level')
  })

  it('sets the model reasoning effort and records the level', async () => {
    const { registered, saveSelection, settingsReplace } = makeHarness()
    const result = await effortCommand(registered).handler({ rawInput: 'ultracode' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('ultracode')
    expect(result.text).toContain('Applies to new sessions')
    expect(saveSelection).toHaveBeenCalledTimes(1)
    expect(String(saveSelection.mock.calls[0]![0]!.reasoningEffort)).toBe('max')
    expect(settingsReplace).toHaveBeenCalledWith('ultra-effort', { level: 'ultracode' })
  })

  it('treats the level name case-insensitively', async () => {
    const { registered, saveSelection } = makeHarness()
    const result = await effortCommand(registered).handler({ rawInput: 'HIGH' })
    expect(result.kind).toBe('success')
    expect(String(saveSelection.mock.calls[0]![0]!.reasoningEffort)).toBe('high')
  })

  it('surfaces a failure to record the level while keeping the effort live', async () => {
    const { registered, settingsReplace } = makeHarness()
    settingsReplace.mockRejectedValueOnce(new Error('conflict'))
    const result = await effortCommand(registered).handler({ rawInput: 'xhigh' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('effort set to xhigh')
    expect(result.text).toContain('recording the level failed')
  })

  it('notes the current-process-only degradation when no settings provider is mounted', async () => {
    const { registered, saveSelection, settingsReplace } = makeHarness(false)
    const result = await effortCommand(registered).handler({ rawInput: 'high' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('applies only for the current process')
    expect(result.text).not.toContain('Applies to new sessions')
    // The model selection write still happens without a settings provider.
    expect(saveSelection).toHaveBeenCalledTimes(1)
    expect(settingsReplace).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_ORCHESTRATE_LEVELS,
  DEFAULT_ULTRA_EFFORT_MAP,
  ULTRA_EFFORT_LEVELS,
  isUltraEffortLevel,
  resolveEffortPolicy,
} from '../src/effort.ts'

describe('ultra effort grading', () => {
  it('exposes the five levels in Claude Code order', () => {
    expect(ULTRA_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'ultracode'])
  })

  it('maps the default policy onto DeepSeek V4 reasoning efforts', () => {
    expect(resolveEffortPolicy('low').reasoningEffort).toBe('off')
    expect(resolveEffortPolicy('medium').reasoningEffort).toBe('high')
    expect(resolveEffortPolicy('high').reasoningEffort).toBe('high')
    expect(resolveEffortPolicy('xhigh').reasoningEffort).toBe('max')
    expect(resolveEffortPolicy('ultracode').reasoningEffort).toBe('max')
  })

  it('enables automatic orchestration only for ultracode by default', () => {
    for (const level of ULTRA_EFFORT_LEVELS) {
      expect(resolveEffortPolicy(level).autoOrchestrate).toBe(level === 'ultracode')
    }
  })

  it('respects a deployment mapping override', () => {
    const policy = resolveEffortPolicy('medium', { medium: 'max' })
    expect(policy.reasoningEffort).toBe('max')
  })

  it('respects a custom auto-orchestrate level set', () => {
    expect(resolveEffortPolicy('xhigh', {}, ['xhigh', 'ultracode']).autoOrchestrate).toBe(true)
    expect(resolveEffortPolicy('low', {}, ['xhigh', 'ultracode']).autoOrchestrate).toBe(false)
  })

  it('validates level names', () => {
    expect(isUltraEffortLevel('ultracode')).toBe(true)
    expect(isUltraEffortLevel('high')).toBe(true)
    expect(isUltraEffortLevel('turbo')).toBe(false)
    expect(isUltraEffortLevel('')).toBe(false)
  })

  it('keeps the default mapping complete and the orchestration default exact', () => {
    for (const level of ULTRA_EFFORT_LEVELS) {
      expect(DEFAULT_ULTRA_EFFORT_MAP[level]).toBeDefined()
    }
    expect(DEFAULT_AUTO_ORCHESTRATE_LEVELS).toEqual(['ultracode'])
  })
})

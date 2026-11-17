// Effort levels for the effort picker: how much Claude thinks before it answers.

import type { ModelChoice } from './models.ts'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: readonly { value: EffortLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest; for small, simple tasks.' },
  { value: 'medium', label: 'Medium', hint: 'Routine edits and checks.' },
  { value: 'high', label: 'High', hint: 'Thorough; most coding work.' },
  { value: 'xhigh', label: 'Extra high', hint: 'Hard debugging and design.' },
  { value: 'max', label: 'Max', hint: 'Deepest thinking; slowest and most usage.' },
]

export const isEffortLevel = (x: unknown): x is EffortLevel => EFFORT_LEVELS.some(l => l.value === x)

/** A stored or sent effort value, or undefined (Claude Code's default) when it isn't a known level. */
export const cleanEffort = (x: unknown): EffortLevel | undefined => (isEffortLevel(x) ? x : undefined)

export const effortLabel = (level: EffortLevel | undefined): string =>
  EFFORT_LEVELS.find(l => l.value === level)?.label ?? 'Default'

/**
 * The levels a model offers, in order. A model Claude Code says has no effort setting offers none;
 * an unknown model, or a list that doesn't say, offers all of them.
 */
export function effortLevelsFor(model: string | undefined, models: readonly ModelChoice[]): EffortLevel[] {
  const all = EFFORT_LEVELS.map(l => l.value)
  const id = (model ?? '').trim()
  const row = id
    ? models.find(m => m.value === id || m.resolvedModel === id)
    : models.find(m => m.value === 'default')
  if (!row) return all
  if (row.supportsEffort === false) return []
  if (!row.supportedEffortLevels?.length) return all
  return all.filter(l => row.supportedEffortLevels!.includes(l))
}

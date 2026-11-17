import { useState } from 'react'

import { EFFORT_LEVELS, effortLabel, effortLevelsFor, type EffortLevel } from '@shared/effort'
import type { ModelChoice } from '@shared/models'
import { Menu, type MenuItem } from './Menu'

interface Props {
  /** The session's own level; undefined uses Claude Code's default for the model. */
  value: EffortLevel | undefined
  /** The model the session runs or will run (alias or id), to list the levels it accepts. */
  model?: string
  models: readonly ModelChoice[]
  onChange: (effort: EffortLevel | undefined) => void
  /** Text before the level, as in "Effort · High". */
  prefix?: string
  disabled?: boolean
}

/** A chip that shows the effort level and opens a menu to pick another. */
export function EffortPicker({ value, model, models, onChange, prefix = 'Effort', disabled }: Props) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const offered = effortLevelsFor(model, models)
  const items = effortMenuItems(value, model, models, onChange)
  if (!items.length) return null
  const shown = effortLabel(value)
  const note = value && !offered.includes(value) ? ' This model doesn’t offer it, so Claude Code uses the nearest level.' : ''

  return (
    <>
      <button
        type="button"
        className={`chip model-chip effort-chip ${value ? 'on' : ''}`}
        disabled={disabled}
        title={`${value ? `Effort picked for this session: ${shown}.` : 'Uses Claude Code’s default effort for the model.'}${note} Click to change.`}
        aria-label={`Effort: ${shown}. Change effort`}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {prefix && <span className="chip-prefix">{prefix} ·</span>}
        {value ? (
          shown
        ) : (
          // Phones hide the prefix, and "Default" alone doesn't say what it's for.
          <>
            <span className="wide-only">{shown}</span>
            <span className="narrow-only">Effort</span>
          </>
        )}
      </button>
      {at && (
        <Menu
          at={at}
          onClose={() => setAt(null)}
          items={items}
        />
      )}
    </>
  )
}

/**
 * The menu choices for effort: Default plus the levels the model offers. Empty for a model without
 * an effort setting, unless a level is already set and needs a way back to Default.
 */
export function effortMenuItems(
  value: EffortLevel | undefined,
  model: string | undefined,
  models: readonly ModelChoice[],
  onChange: (effort: EffortLevel | undefined) => void,
): MenuItem[] {
  const offered = effortLevelsFor(model, models)
  if (!offered.length && !value) return []
  const levels = EFFORT_LEVELS.filter(l => offered.includes(l.value) || l.value === value)
  return [
    { label: 'Default', hint: 'Claude Code’s default for the model.', checked: !value, onClick: () => onChange(undefined) },
    ...levels.map(l => ({
      label: l.label,
      hint: l.hint,
      checked: value === l.value,
      onClick: () => onChange(l.value),
    })),
  ]
}

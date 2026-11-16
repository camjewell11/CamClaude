import { useState } from 'react'

import { FALLBACK_MODELS, isDefaultChoice, modelLabel, type ModelChoice } from '@shared/models'
import { Menu } from './Menu'

interface Props {
  /** The session's own choice; '' follows the project's model. */
  value: string
  /** The project's model setting; '' is Claude Code's default. */
  projectModel: string
  /** What Claude Code reports the session runs on, when known. */
  activeModel?: string
  models: readonly ModelChoice[]
  onChange: (model: string) => void
  /** Text before the model name, as in "Model · Sonnet". */
  prefix?: string
  disabled?: boolean
}

/** A chip that shows a model and opens a menu to pick another. */
export function ModelPicker({ value, projectModel, activeModel, models, onChange, prefix, disabled }: Props) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const listed = models.length ? models : FALLBACK_MODELS
  const choices = listed.filter(m => !isDefaultChoice(m))
  const claudeDefault = listed.find(isDefaultChoice)?.resolvedModel
  const projectLabel = projectModel
    ? modelLabel(projectModel, choices)
    : claudeDefault
      ? modelLabel(claudeDefault, choices)
      : 'Claude Code default'
  const shown = modelLabel(activeModel || value || projectModel || claudeDefault, choices) || 'Default'
  const asked = value ? `Picked for this session: ${modelLabel(value, choices)}.` : `Follows the project: ${projectLabel}.`

  return (
    <>
      <button
        type="button"
        className={`chip model-chip ${value ? 'on' : ''}`}
        disabled={disabled}
        title={`${activeModel ? `Running ${activeModel}. ` : ''}${asked} Click to change.`}
        aria-label={`Model: ${shown}. Change model`}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {prefix && <span className="chip-prefix">{prefix} ·</span>}
        {shown}
      </button>
      {at && (
        <Menu
          at={at}
          onClose={() => setAt(null)}
          items={[
            { label: `Project default (${projectLabel})`, checked: !value, onClick: () => onChange('') },
            ...choices.map(m => ({
              label: modelLabel(m.value, choices),
              // Aliases (opus, sonnet, ...) track the latest version; pinned older ids stay one line.
              hint: (!m.value.startsWith('claude-') && m.description) || undefined,
              checked: value === m.value,
              onClick: () => onChange(m.value),
            })),
          ]}
        />
      )}
    </>
  )
}

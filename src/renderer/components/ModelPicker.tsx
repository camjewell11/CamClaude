import { useState } from 'react'

import { effortLabel, type EffortLevel } from '@shared/effort'
import { FALLBACK_MODELS, isDefaultChoice, modelLabel, type ModelChoice } from '@shared/models'
import { effortMenuItems } from './EffortPicker'
import { Menu, type MenuItem } from './Menu'

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
  /**
   * On a phone, the effort choices join this menu (the chat header has no room for a second chip,
   * so CSS hides the EffortPicker there). `model` is the model the session runs or will run.
   */
  effort?: {
    value: EffortLevel | undefined
    projectEffort?: EffortLevel
    model?: string
    onChange: (effort: EffortLevel | undefined) => void
  }
}

/** Matches the phone layout in styles.css. */
const narrow = () => window.matchMedia('(max-width: 760px)').matches

/** A chip that shows a model and opens a menu to pick another. */
export function ModelPicker({ value, projectModel, activeModel, models, onChange, prefix, disabled, effort }: Props) {
  const [at, setAt] = useState<{ at: { x: number; y: number }; withEffort: boolean } | null>(null)
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
          setAt({ at: { x: r.left, y: r.bottom + 4 }, withEffort: !!effort && narrow() })
        }}
      >
        {prefix && <span className="chip-prefix">{prefix} ·</span>}
        {shown}
        {(effort?.value ?? effort?.projectEffort) && (
          <span className="narrow-only"> · {effortLabel(effort?.value ?? effort?.projectEffort)}</span>
        )}
      </button>
      {at && (
        <Menu
          at={at.at}
          onClose={() => setAt(null)}
          items={[
            // Effort first: its few choices stay in view above the long model list.
            ...(at.withEffort && effort ? withSection(effortMenuItems(effort.value, effort.model, models, effort.onChange, effort.projectEffort), 'Effort') : []),
            {
              label: `Project default (${projectLabel})`,
              checked: !value,
              onClick: () => onChange(''),
              section: at.withEffort ? 'Model' : undefined,
            },
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

const withSection = (items: MenuItem[], section: string): MenuItem[] =>
  items.map((item, i) => (i === 0 ? { ...item, section } : item))

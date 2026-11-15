import { useState } from 'react'

import type { Settings } from '@shared/types'
import { cam } from '../util'
import { Field, Modal } from './Modal'

const K = 1000

/** Handoff thresholds, cleanup timing, and notifications. */
export function SettingsDialog({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [s, setS] = useState(settings)
  const num = (key: keyof Settings, scale = 1) => ({
    type: 'number',
    min: 0,
    value: Math.round((s[key] as number) / scale),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [key]: Math.max(0, Number(e.target.value) || 0) * scale }),
  })

  const invalid = s.handoffTokens <= 0 || s.hardStopTokens < s.handoffTokens

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          {invalid && <span className="error-line inline">Hard stop must be at or above the handoff size.</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={invalid}
            onClick={() => void cam().updateSettings(s).then(onClose)}
          >
            Save
          </button>
        </>
      }
    >
      <h3>Handoff</h3>
      <p className="field-hint">
        Every request re-sends the whole conversation. Past the handoff size, the session writes a handoff at the end of its turn, a
        fresh session continues from it, and the old one is archived.
      </p>
      <div className="row three">
        <Field label="Warn at (k tokens)">
          <input className="text-input" {...num('warnTokens', K)} />
        </Field>
        <Field label="Hand off at (k tokens)">
          <input className="text-input" {...num('handoffTokens', K)} />
        </Field>
        <Field label="Hard stop at (k tokens)" hint="Mid-turn: tool calls stop so the turn ends.">
          <input className="text-input" {...num('hardStopTokens', K)} />
        </Field>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={s.autoContinue} onChange={e => setS({ ...s, autoContinue: e.target.checked })} />
        The new session starts working right away (off: it waits with the handoff in its composer)
      </label>
      <Field label="Loop guard" hint="Refuse a tool call after this many identical calls returned identical results. 0 turns it off.">
        <input className="text-input narrow" {...num('loopRepeats')} />
      </Field>

      <h3>Cleanup</h3>
      <div className="row two">
        <Field label="Archive idle sessions after (hours)" hint="0 = never. Archived sessions are hidden, not deleted.">
          <input className="text-input" {...num('archiveAfterHours')} />
        </Field>
        <Field label="Stop idle processes after (minutes)" hint="Frees memory; the session resumes on your next message.">
          <input className="text-input" {...num('idleProcessMinutes')} />
        </Field>
      </div>

      <h3>General</h3>
      <label className="toggle">
        <input type="checkbox" checked={s.notify} onChange={e => setS({ ...s, notify: e.target.checked })} />
        Notify me when a session needs input or finishes while CamClaude is in the background
      </label>
      <Field label="New project folders go in">
        <input className="text-input" value={s.projectsRoot} onChange={e => setS({ ...s, projectsRoot: e.target.value })} />
      </Field>
      <Field
        label="Claude Code executable"
        hint="Blank uses the copy bundled with CamClaude, which matches its SDK version. Applies to sessions started after saving."
      >
        <input
          className="text-input"
          value={s.claudeExecutable}
          placeholder="bundled"
          onChange={e => setS({ ...s, claudeExecutable: e.target.value })}
        />
      </Field>
    </Modal>
  )
}

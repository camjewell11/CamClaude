import { useState } from 'react'

import { ADDON_GROUPS, ADDONS, addonById } from '@shared/addons'
import { Modal } from './Modal'

/** The add-on chip in the new-session composer. Nothing is picked until you pick it. */
export function AddonsButton({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={`chip addon-chip ${value.length ? 'on' : ''}`}
        onClick={() => setOpen(true)}
        title={value.length ? addonLabels(value) : 'Add agents or skills to this session only'}
      >
        {value.length ? `Add-ons · ${value.length}` : 'Add-ons'}
      </button>
      {open && <AddonsDialog value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  )
}

export const addonLabels = (ids: readonly string[]) => ids.map(id => addonById(id)?.label ?? id).join(', ')

function AddonsDialog({ value, onChange, onClose }: { value: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const picked = new Set(value)
  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(ADDONS.filter(a => next.has(a.id)).map(a => a.id))
  }
  return (
    <Modal
      title="Add-ons for this session"
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={!value.length} onClick={() => onChange([])}>
            Clear
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p className="addon-intro">
        None is on by default. Each add-on adds its description to every request in this session, and an agent runs
        as a subagent with its own context, so pick only what the task needs. Successors of this session keep them.
      </p>
      {ADDON_GROUPS.map(g => (
        <section key={g.id} className="addon-group">
          <h3>{g.label}</h3>
          {ADDONS.filter(a => a.group === g.id).map(a => (
            <label key={a.id} className={`addon-row ${picked.has(a.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
              <span className="addon-text">
                <span className="addon-name">
                  {a.label}
                  <span className="addon-tag">{a.kind}</span>
                  {a.model === 'opus' && (
                    <span className="addon-tag warn" title="This agent runs on Opus, whatever model the session uses.">
                      Opus
                    </span>
                  )}
                </span>
                <span className="addon-summary">{a.summary}</span>
              </span>
            </label>
          ))}
        </section>
      ))}
    </Modal>
  )
}

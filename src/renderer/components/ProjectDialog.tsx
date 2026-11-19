import { useState } from 'react'

import { EFFORT_LEVELS, cleanEffort, type EffortLevel } from '@shared/effort'
import { permissionModeChoices } from '@shared/permissions'
import type { PermissionModeSetting, Project } from '@shared/types'
import { cam, errorText } from '../util'
import { Field, Modal, splitList } from './Modal'

/** Edits a project's name, secrets, guidance, permissions, model, and effort. */
export function ProjectDialog({
  project,
  allowBypass,
  onClose,
}: {
  project: Project
  allowBypass: boolean
  onClose: () => void
}) {
  const [name, setName] = useState(project.name)
  const [envFiles, setEnvFiles] = useState(project.envFiles.join(', '))
  const [guidance, setGuidance] = useState(project.guidance)
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>(project.permissionMode)
  const [model, setModel] = useState(project.model)
  const [effort, setEffort] = useState<EffortLevel | undefined>(project.effort)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    try {
      await cam().updateProject(project.id, {
        name: name.trim() || project.name,
        envFiles: splitList(envFiles),
        guidance,
        permissionMode,
        model: model.trim(),
        effort: effort ?? '',
      })
      onClose()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Modal
      title={`${project.name} settings`}
      onClose={onClose}
      wide
      footer={
        <>
          {confirmRemove ? (
            <span className="confirm">
              Remove from CamClaude? Files and Claude Code transcripts stay on disk.
              <button className="btn danger" onClick={() => void cam().removeProject(project.id).then(onClose)}>
                Remove
              </button>
              <button className="btn" onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="btn ghost danger-text" onClick={() => setConfirmRemove(true)}>
              Remove project…
            </button>
          )}
          <span className="spacer" />
          {error && <span className="error-line inline">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <Field label="Folder">
        <div className="row">
          <code className="path grow">{project.folder}</code>
          {!cam().isRemote && (
            <button className="btn" onClick={() => void cam().openFolder(project.folder)}>
              Open
            </button>
          )}
        </div>
      </Field>
      <Field label="Name">
        <input className="text-input" value={name} onChange={e => setName(e.target.value)} />
      </Field>
      <Field label="Secrets (.env files)" hint="Comma-separated, relative to the folder. Changes apply to sessions started or resumed after saving.">
        <input className="text-input" value={envFiles} onChange={e => setEnvFiles(e.target.value)} placeholder=".env" />
      </Field>
      <Field label="Guidance" hint="Added to every session's instructions, on top of CLAUDE.md.">
        <textarea className="text-input" rows={6} value={guidance} onChange={e => setGuidance(e.target.value)} />
      </Field>
      <div className="row two">
        <Field label="Permissions">
          <select className="text-input" value={permissionMode} onChange={e => setPermissionMode(e.target.value as PermissionModeSetting)}>
            {permissionModeChoices(allowBypass, project.permissionMode).map(m => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model" hint="Blank uses Claude Code's default.">
          <input className="text-input" value={model} onChange={e => setModel(e.target.value)} placeholder="default" />
        </Field>
      </div>
      <Field label="Effort" hint="For sessions that don't pick their own. Running sessions switch from their next request.">
        <select className="text-input" value={effort ?? ''} onChange={e => setEffort(cleanEffort(e.target.value))}>
          <option value="">Claude Code default</option>
          {EFFORT_LEVELS.map(l => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  )
}

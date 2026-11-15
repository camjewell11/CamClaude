import { useEffect, useMemo, useState } from 'react'

import type { FolderInfo } from '@shared/api'
import type { KnownFolder, PermissionModeSetting, Project, Settings } from '@shared/types'
import { ago, cam, errorText } from '../util'
import { Field, Modal, PERMISSION_MODES, splitList } from './Modal'

interface Props {
  settings: Settings
  projects: Project[]
  onClose: () => void
  onCreated: (p: Project) => void
}

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
const joinPath = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}\\${b}`
const cleanName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()

export function NewProjectDialog({ settings, projects, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [parent, setParent] = useState(settings.projectsRoot)
  const [envFiles, setEnvFiles] = useState('')
  const [envTouched, setEnvTouched] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>('default')
  const [model, setModel] = useState('')
  const [importRecent, setImportRecent] = useState(true)
  const [known, setKnown] = useState<KnownFolder[] | null>(null)
  const [info, setInfo] = useState<FolderInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void cam().knownFolders().then(setKnown)
  }, [])

  const used = useMemo(() => new Set(projects.map(p => p.folder.toLowerCase())), [projects])
  const suggestions = (known ?? []).filter(k => !used.has(k.folder.toLowerCase()) && !/AppData/i.test(k.folder)).slice(0, 12)
  const target = mode === 'new' ? (name.trim() ? joinPath(parent, cleanName(name)) : '') : folder.trim()
  const knownTarget = known?.find(k => k.folder.toLowerCase() === target.toLowerCase())

  // Look at the folder: does it exist, have a CLAUDE.md, have .env files?
  useEffect(() => {
    if (!target) {
      setInfo(null)
      return
    }
    const t = setTimeout(() => {
      void cam()
        .folderInfo(target)
        .then(i => {
          setInfo(i)
          if (!envTouched) setEnvFiles(i.envFiles.join(', '))
        })
    }, 200)
    return () => clearTimeout(t)
  }, [target, envTouched])

  const choose = (path: string) => {
    setFolder(path)
    if (!name.trim()) setName(baseName(path))
  }

  const create = async () => {
    setError('')
    setBusy(true)
    try {
      const p = await cam().createProject({
        name: name.trim() || baseName(target),
        folder: target,
        createFolder: mode === 'new',
        envFiles: splitList(envFiles),
        guidance,
        permissionMode,
        model,
        importRecent: mode === 'existing' && !!knownTarget && importRecent,
      })
      onCreated(p)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const canCreate = !!target && !busy && (mode === 'new' ? !!cleanName(name) && !info?.exists : !!info?.exists)

  return (
    <Modal
      title="New project"
      onClose={onClose}
      wide
      footer={
        <>
          {error && <span className="error-line inline">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canCreate} onClick={() => void create()}>
            Create project
          </button>
        </>
      }
    >
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={mode === 'existing'} className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>
          Existing folder
        </button>
        <button role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
          New folder
        </button>
      </div>

      {mode === 'existing' ? (
        <>
          <Field label="Folder">
            <div className="row">
              <input className="text-input grow" value={folder} onChange={e => choose(e.target.value)} placeholder="C:\path\to\project" />
              {!cam().isRemote && (
                <button
                  className="btn"
                  onClick={async () => {
                    const p = await cam().pickFolder(folder || settings.projectsRoot)
                    if (p) choose(p)
                  }}
                >
                  Browse…
                </button>
              )}
            </div>
          </Field>
          {suggestions.length > 0 && (
            <div className="known">
              <div className="field-label">Folders you've used with Claude Code</div>
              <div className="known-list">
                {suggestions.map(k => (
                  <button
                    key={k.folder}
                    className={`known-item ${k.folder === folder ? 'on' : ''}`}
                    onClick={() => {
                      setFolder(k.folder)
                      setName(baseName(k.folder))
                    }}
                    title={k.folder}
                  >
                    <span className="known-name">{baseName(k.folder)}</span>
                    <span className="known-meta">
                      {k.sessions} session{k.sessions === 1 ? '' : 's'} · {ago(k.lastModified)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {known === null && <div className="field-hint">Looking for folders you've used before…</div>}
        </>
      ) : (
        <Field label="Create in" hint={target ? <>Creates <code>{target}</code></> : undefined}>
          <div className="row">
            <input className="text-input grow" value={parent} onChange={e => setParent(e.target.value)} />
            {!cam().isRemote && (
              <button
                className="btn"
                onClick={async () => {
                  const p = await cam().pickFolder(parent)
                  if (p) setParent(p)
                }}
              >
                Browse…
              </button>
            )}
          </div>
        </Field>
      )}

      <Field label="Name" hint="Also the sidebar group name.">
        <input className="text-input" value={name} onChange={e => setName(e.target.value)} placeholder="My project" />
      </Field>

      {info && target && (
        <div className="folder-status">
          {mode === 'new' && info.exists && <span className="warn">That folder already exists. Use “Existing folder” instead.</span>}
          {mode === 'existing' && !info.exists && <span className="warn">That folder doesn't exist.</span>}
          {info.exists && (
            <span className={info.hasClaudeMd ? 'ok' : 'muted'}>
              {info.hasClaudeMd ? '✓ CLAUDE.md found. Sessions will follow it.' : 'No CLAUDE.md. Add guidance below, or ask Claude to run /init.'}
            </span>
          )}
        </div>
      )}

      <Field
        label="Secrets (.env files)"
        hint="Comma-separated, relative to the folder. Loaded into each session's environment; Claude sees the variable names, not the values."
      >
        <input
          className="text-input"
          value={envFiles}
          onChange={e => {
            setEnvTouched(true)
            setEnvFiles(e.target.value)
          }}
          placeholder=".env"
        />
      </Field>

      <Field label="Guidance" hint="Added to every session's instructions, on top of CLAUDE.md. Good for things you'd otherwise repeat.">
        <textarea className="text-input" rows={4} value={guidance} onChange={e => setGuidance(e.target.value)} placeholder="e.g. Use pnpm. Run tests with `pnpm test` before saying a change is done." />
      </Field>

      <div className="row two">
        <Field label="Permissions">
          <select className="text-input" value={permissionMode} onChange={e => setPermissionMode(e.target.value as PermissionModeSetting)}>
            {PERMISSION_MODES.map(m => (
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

      {mode === 'existing' && knownTarget && (
        <label className="toggle">
          <input type="checkbox" checked={importRecent} onChange={e => setImportRecent(e.target.checked)} />
          Add this folder's sessions from the last 3 days to the sidebar
        </label>
      )}
    </Modal>
  )
}

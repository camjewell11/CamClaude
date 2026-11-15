import { useEffect, useMemo, useState } from 'react'

import type { AppState, Project, RateWindow, SessionView } from '@shared/types'
import type { View } from '../App'
import { ago, cam, clock, indicator, INDICATOR_LABEL, type Indicator } from '../util'
import { ArchiveIcon, ChevronIcon, GearIcon, MoreIcon, PlusIcon } from './Icons'
import { Menu, type MenuItem } from './Menu'

interface Props {
  state: AppState
  view: View
  onSelect: (v: View) => void
  onNewSession: (projectId?: string) => void
  onNewProject: () => void
  onProjectSettings: (id: string) => void
  onSettings: () => void
}

type Filter = 'all' | 'attention' | 'working'

export function StatusDot({ value, title }: { value: Indicator; title?: string }) {
  return <span className={`dot dot-${value}`} title={title ?? INDICATOR_LABEL[value]} aria-label={INDICATOR_LABEL[value]} />
}

export function Sidebar({ state, view, onSelect, onNewSession, onNewProject, onProjectSettings, onSettings }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [showArchived, setShowArchived] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const counts = useMemo(() => {
    const active = state.sessions.filter(s => !s.archived)
    return {
      attention: active.filter(s => s.status === 'needs-input' || s.status === 'error').length,
      working: active.filter(s => s.status === 'running' || s.status === 'handing-off').length,
      unread: active.filter(s => s.unread && s.status === 'idle').length,
    }
  }, [state.sessions])

  // A filter with nothing left in it switches itself off.
  useEffect(() => {
    if ((filter === 'attention' && counts.attention === 0) || (filter === 'working' && counts.working === 0)) setFilter('all')
  }, [filter, counts])

  const visible = (s: SessionView) => {
    if (s.archived && !showArchived) return false
    if (filter === 'attention') return s.status === 'needs-input' || s.status === 'error'
    if (filter === 'working') return s.status === 'running' || s.status === 'handing-off'
    return true
  }

  const selectedId = view.kind === 'session' ? view.id : undefined

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="brand">CamClaude</span>
      </div>

      <div className="sidebar-actions">
        <button className="side-button primary-ish" onClick={() => onNewSession()} title="New session (Ctrl+N)">
          <PlusIcon /> New session
        </button>
        <button className="side-button" onClick={onNewProject} title="New project (Ctrl+Shift+N)">
          <PlusIcon /> New project
        </button>
      </div>

      <div className="glance" role="group" aria-label="Session status">
        <button
          className={`chip chip-attention ${filter === 'attention' ? 'on' : ''}`}
          disabled={counts.attention === 0}
          onClick={() => setFilter(f => (f === 'attention' ? 'all' : 'attention'))}
          title="Sessions waiting on you"
        >
          <StatusDot value="needs-input" /> {counts.attention} need you
        </button>
        <button
          className={`chip chip-working ${filter === 'working' ? 'on' : ''}`}
          disabled={counts.working === 0}
          onClick={() => setFilter(f => (f === 'working' ? 'all' : 'working'))}
          title="Sessions Claude is working in"
        >
          <StatusDot value="running" /> {counts.working} working
        </button>
        {counts.unread > 0 && (
          <span className="chip chip-static" title="Finished while you were elsewhere">
            <StatusDot value="unread" /> {counts.unread} new
          </span>
        )}
      </div>

      <nav className="projects">
        {state.projects.length === 0 && (
          <div className="empty-side">
            No projects yet.
            <button className="link" onClick={onNewProject}>
              Create one
            </button>
          </div>
        )}
        {state.projects.map(p => (
          <ProjectGroup
            key={p.id}
            project={p}
            sessions={state.sessions
              .filter(s => s.projectId === p.id && visible(s))
              .sort((a, b) => Number(a.archived) - Number(b.archived) || b.lastActivity - a.lastActivity)}
            allForProject={state.sessions.filter(s => s.projectId === p.id && !s.archived)}
            filtered={filter !== 'all'}
            selectedId={selectedId}
            now={now}
            onSelect={id => onSelect({ kind: 'session', id })}
            onNewSession={() => onNewSession(p.id)}
            onSettings={() => onProjectSettings(p.id)}
          />
        ))}
      </nav>

      <div className="sidebar-foot">
        <UsageBars windows={state.rateLimits} />
        <div className="foot-row">
          <label className="toggle">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <button className="icon-button" onClick={onSettings} title="Settings" aria-label="Settings">
            <GearIcon />
          </button>
        </div>
      </div>
    </aside>
  )
}

function ProjectGroup(props: {
  project: Project
  sessions: SessionView[]
  allForProject: SessionView[]
  filtered: boolean
  selectedId?: string
  now: number
  onSelect: (id: string) => void
  onNewSession: () => void
  onSettings: () => void
}) {
  const { project, sessions, allForProject, filtered, selectedId, now } = props
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  if (filtered && sessions.length === 0) return null

  const collapsed = project.collapsed && !filtered
  const waiting = allForProject.filter(s => s.status === 'needs-input' || s.status === 'error').length
  const working = allForProject.filter(s => s.status === 'running' || s.status === 'handing-off').length

  const items: MenuItem[] = [
    { label: 'New session', onClick: props.onNewSession },
    { label: 'Project settings…', onClick: props.onSettings },
    { label: 'Open folder', onClick: () => void cam().openFolder(project.folder) },
  ]

  return (
    <section className="project">
      <div
        className="project-head"
        onContextMenu={e => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <button
          className="project-toggle"
          onClick={() => void cam().updateProject(project.id, { collapsed: !project.collapsed })}
          title={project.folder}
        >
          <ChevronIcon className={`chev ${collapsed ? '' : 'open'}`} size={14} />
          <span className="project-name">{project.name}</span>
          {collapsed && waiting > 0 && <StatusDot value="needs-input" title={`${waiting} need your input`} />}
          {collapsed && working > 0 && <StatusDot value="running" title={`${working} working`} />}
        </button>
        <span className="project-tools">
          <button className="icon-button small" onClick={props.onNewSession} title="New session in this project" aria-label="New session">
            <PlusIcon size={14} />
          </button>
          <button
            className="icon-button small"
            onClick={e => setMenu({ x: e.clientX, y: e.clientY })}
            title="Project options"
            aria-label="Project options"
          >
            <MoreIcon size={14} />
          </button>
        </span>
        {menu && <Menu at={menu} items={items} onClose={() => setMenu(null)} />}
      </div>
      {!collapsed && (
        <ul className="session-list">
          {sessions.length === 0 && <li className="empty-project">No sessions</li>}
          {sessions.map(s => (
            <SessionRow key={s.id} s={s} selected={s.id === selectedId} now={now} onSelect={() => props.onSelect(s.id)} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SessionRow({ s, selected, now, onSelect }: { s: SessionView; selected: boolean; now: number; onSelect: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const ind = indicator(s)
  const items: MenuItem[] = s.archived
    ? [
        { label: 'Unarchive', onClick: () => void cam().unarchive(s.id) },
        { label: 'Remove from CamClaude', danger: true, onClick: () => void cam().remove(s.id) },
      ]
    : [
        { label: 'Rename', onClick: () => setRenaming(true) },
        { label: 'Hand off now', onClick: () => void cam().handoffNow(s.id) },
        { label: 'Archive', onClick: () => void cam().archive(s.id) },
        { label: 'Remove from CamClaude', danger: true, onClick: () => void cam().remove(s.id) },
      ]
  return (
    <li>
      <div
        className={`session-row ${selected ? 'selected' : ''} ${s.archived ? 'archived' : ''} ind-${ind}`}
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onSelect()}
        onContextMenu={e => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        title={`${s.title}\n${INDICATOR_LABEL[ind]}${s.archived ? ` · archived (${s.archivedReason ?? 'manual'})` : ''}`}
      >
        {s.archived ? <ArchiveIcon size={12} className="row-archived" /> : <StatusDot value={ind} />}
        {renaming ? (
          <input
            className="rename-input"
            defaultValue={s.title}
            autoFocus
            onClick={e => e.stopPropagation()}
            onFocus={e => e.currentTarget.select()}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.currentTarget.value = s.title
                e.currentTarget.blur()
              }
            }}
            onBlur={e => {
              setRenaming(false)
              if (e.currentTarget.value.trim() && e.currentTarget.value !== s.title) void cam().rename(s.id, e.currentTarget.value)
            }}
          />
        ) : (
          <span className="session-title" onDoubleClick={() => setRenaming(true)}>
            {s.title}
          </span>
        )}
        <span className="session-meta">
          {ind === 'needs-input' ? <span className="badge-attn">!</span> : ago(s.lastActivity, now)}
        </span>
      </div>
      {menu && <Menu at={menu} items={items} onClose={() => setMenu(null)} />}
    </li>
  )
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
}

function UsageBars({ windows }: { windows: RateWindow[] }) {
  const shown = windows.filter(w => WINDOW_NAMES[w.kind]).sort((a, b) => a.kind.localeCompare(b.kind))
  if (shown.length === 0) return <div className="usage-empty">Usage appears after the first reply.</div>
  return (
    <div className="usage">
      {shown.map(w => {
        const pct = Math.max(0, Math.min(100, w.percentUsed))
        const tone = pct >= 90 ? 'over' : pct >= 75 ? 'warn' : 'ok'
        return (
          <div key={w.kind} className="usage-row" title={w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : undefined}>
            <span className="usage-name">{WINDOW_NAMES[w.kind]}</span>
            <span className={`meter tone-${tone}`}>
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="usage-pct">
              {Math.round(pct)}%{w.resetsAt && w.kind === 'five_hour' ? ` · ${clock(w.resetsAt)}` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

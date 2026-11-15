import { useCallback, useEffect, useRef, useState } from 'react'

import type { AppState, ChatItem, ChatUpdate } from '@shared/types'
import { ChatView } from './components/ChatView'
import { HomeView } from './components/HomeView'
import { NewProjectDialog } from './components/NewProjectDialog'
import { ProjectDialog } from './components/ProjectDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { cam } from './util'

export type View = { kind: 'home'; projectId?: string } | { kind: 'session'; id: string }
type Dialog = null | { kind: 'newProject' } | { kind: 'project'; id: string } | { kind: 'settings' }

function merge(chats: Record<string, ChatItem[]>, u: ChatUpdate): Record<string, ChatItem[]> {
  const list = u.reset ? [] : [...(chats[u.sessionId] ?? [])]
  for (const item of u.items) {
    const at = list.findIndex(x => x.id === item.id)
    if (at >= 0) list[at] = item
    else list.push(item)
  }
  return { ...chats, [u.sessionId]: list }
}

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [chats, setChats] = useState<Record<string, ChatItem[]>>({})
  const [dialog, setDialog] = useState<Dialog>(null)
  const loaded = useRef(new Set<string>())
  const lastProject = useRef<string | undefined>(undefined)

  useEffect(() => {
    void cam().getState().then(setState)
    const offs = [
      cam().onState(setState),
      cam().onChat(u => {
        if (loaded.current.has(u.sessionId)) setChats(c => merge(c, u))
      }),
      // A handoff moves you to the successor if you were watching the old session.
      cam().onHandoff(h => setView(v => (v.kind === 'session' && v.id === h.from ? { kind: 'session', id: h.to } : v))),
      cam().onSelect(id => setView({ kind: 'session', id })),
    ]
    return () => offs.forEach(off => off())
  }, [])

  // Load the conversation the first time a session is opened, and tell the app what you're watching.
  const selectedId = view.kind === 'session' ? view.id : null
  useEffect(() => {
    void cam().setFocus(selectedId)
    if (!selectedId || loaded.current.has(selectedId)) return
    void cam()
      .getChat(selectedId)
      .then(items => {
        loaded.current.add(selectedId)
        setChats(c => ({ ...c, [selectedId]: items }))
      })
  }, [selectedId])

  const session = state?.sessions.find(s => s.id === selectedId)
  if (session) lastProject.current = session.projectId
  if (view.kind === 'home' && view.projectId) lastProject.current = view.projectId

  // The open session was removed: fall back to the new-session page.
  useEffect(() => {
    if (state && view.kind === 'session' && !state.sessions.some(s => s.id === view.id)) setView({ kind: 'home' })
  }, [state, view])

  const newSession = useCallback(
    (projectId?: string) => setView({ kind: 'home', projectId: projectId ?? lastProject.current }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        if (e.shiftKey) setDialog({ kind: 'newProject' })
        else newSession()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession])

  if (!state) return <div className="app loading" />

  const project = session ? state.projects.find(p => p.id === session.projectId) : undefined

  return (
    <div className="app">
      <Sidebar
        state={state}
        view={view}
        onSelect={setView}
        onNewSession={newSession}
        onNewProject={() => setDialog({ kind: 'newProject' })}
        onProjectSettings={id => setDialog({ kind: 'project', id })}
        onSettings={() => setDialog({ kind: 'settings' })}
      />
      <main className="main">
        {view.kind === 'session' && session && project ? (
          <ChatView
            key={session.id}
            session={session}
            project={project}
            settings={state.settings}
            items={chats[session.id]}
            allSessions={state.sessions}
            onSelect={setView}
          />
        ) : (
          <HomeView
            state={state}
            projectId={view.kind === 'home' ? (view.projectId ?? lastProject.current) : undefined}
            onPickProject={id => setView({ kind: 'home', projectId: id })}
            onStarted={id => setView({ kind: 'session', id })}
            onNewProject={() => setDialog({ kind: 'newProject' })}
          />
        )}
      </main>

      {dialog?.kind === 'newProject' && (
        <NewProjectDialog
          settings={state.settings}
          projects={state.projects}
          onClose={() => setDialog(null)}
          onCreated={p => {
            setDialog(null)
            setView({ kind: 'home', projectId: p.id })
          }}
        />
      )}
      {dialog?.kind === 'project' && state.projects.some(p => p.id === dialog.id) && (
        <ProjectDialog project={state.projects.find(p => p.id === dialog.id)!} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'settings' && <SettingsDialog settings={state.settings} onClose={() => setDialog(null)} />}
    </div>
  )
}

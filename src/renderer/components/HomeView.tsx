import { useState } from 'react'

import type { AppState } from '@shared/types'
import { cam, errorText } from '../util'
import { Composer } from './Composer'
import { PlusIcon } from './Icons'
import { MenuButton } from './MenuButton'

interface Props {
  state: AppState
  projectId?: string
  onPickProject: (id: string) => void
  onStarted: (sessionId: string) => void
  onNewProject: () => void
  onMenu: () => void
  waiting: number
}

/** The new-session page: pick a project, type the first message. */
export function HomeView({ state, projectId, onPickProject, onStarted, onNewProject, onMenu, waiting }: Props) {
  const [error, setError] = useState('')
  const project = state.projects.find(p => p.id === projectId) ?? state.projects[0]
  const top = (
    <div className="home-drag drag">
      <MenuButton onClick={onMenu} waiting={waiting} />
    </div>
  )

  if (!project) {
    return (
      <div className="home">
        {top}
        <div className="home-inner">
          <h1 className="greeting">Start with a project</h1>
          <p className="home-sub">A project is a folder. Its sessions run there and use its CLAUDE.md, settings, and .env files.</p>
          <button className="btn primary big" onClick={onNewProject}>
            <PlusIcon /> New project
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="home">
      {top}
      <div className="home-inner">
        <h1 className="greeting">What are we working on?</h1>
        <Composer
          key={project.id}
          autoFocus
          placeholder={`New session in ${project.name}…`}
          onSend={async text => {
            setError('')
            try {
              onStarted(await cam().createSession(project.id, text))
            } catch (err) {
              setError(errorText(err))
            }
          }}
          footer={
            <select
              className="project-select"
              value={project.id}
              onChange={e => onPickProject(e.target.value)}
              aria-label="Project"
              title={project.folder}
            >
              {state.projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          }
        />
        {error && <div className="error-line">{error}</div>}
        <p className="home-hint">
          Runs in <code>{project.folder}</code>
          {project.envFiles.length > 0 && <> · loads {project.envFiles.join(', ')}</>}
        </p>
      </div>
    </div>
  )
}

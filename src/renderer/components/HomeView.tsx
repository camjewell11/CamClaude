import { useState } from 'react'

import type { EffortLevel } from '@shared/effort'
import type { AppState } from '@shared/types'
import { cam, errorText } from '../util'
import { AddonsButton } from './AddonsDialog'
import { Composer } from './Composer'
import { EffortPicker } from './EffortPicker'
import { PlusIcon } from './Icons'
import { MenuButton } from './MenuButton'
import { ModelPicker } from './ModelPicker'

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
  // Per session, never remembered: every new session starts with no add-ons.
  const [addons, setAddons] = useState<string[]>([])
  // Also per session: '' follows the project's model.
  const [model, setModel] = useState('')
  // Also per session: undefined uses Claude Code's default effort.
  const [effort, setEffort] = useState<EffortLevel | undefined>(undefined)
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
          onSend={async (text, images) => {
            setError('')
            try {
              const id = await cam().createSession(project.id, text, images, addons, model, effort ?? '')
              setAddons([])
              setModel('')
              setEffort(undefined)
              onStarted(id)
            } catch (err) {
              setError(errorText(err))
            }
          }}
          footer={
            <div className="home-footer">
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
              <ModelPicker prefix="Model" value={model} projectModel={project.model} models={state.models ?? []} onChange={setModel} />
              <EffortPicker value={effort} model={model || project.model} models={state.models ?? []} onChange={setEffort} />
              <AddonsButton value={addons} onChange={setAddons} />
            </div>
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

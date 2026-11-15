// The app's own records: projects, sessions, and settings, in one JSON file under userData.
// Conversation transcripts stay where Claude Code keeps them (~/.claude/projects).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_SETTINGS, type Project, type RateWindow, type SessionRecord, type Settings } from '../shared/types.ts'

interface StoreData {
  version: 1
  projects: Project[]
  sessions: SessionRecord[]
  settings: Settings
  /** The plan's usage windows as last seen, so the sidebar has them right after a restart. */
  rateLimits: RateWindow[]
}

export class Store {
  private data: StoreData
  private readonly file: string
  private timer: NodeJS.Timeout | undefined

  constructor(dir: string, defaultProjectsRoot: string) {
    this.file = join(dir, 'camclaude.json')
    this.data = this.load(defaultProjectsRoot)
  }

  private load(defaultProjectsRoot: string): StoreData {
    let parsed: Partial<StoreData> = {}
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreData>
    } catch {
      // First run, or an unreadable file: start empty. A corrupt file is kept as .bad.
      try {
        renameSync(this.file, `${this.file}.bad`)
      } catch {
        // Nothing to keep.
      }
    }
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
    if (!settings.projectsRoot) settings.projectsRoot = defaultProjectsRoot
    return {
      version: 1,
      projects: parsed.projects ?? [],
      // No Claude Code process survives a restart, so nothing is running or waiting any more.
      sessions: (parsed.sessions ?? []).map(s =>
        s.status === 'running' || s.status === 'needs-input' || s.status === 'handing-off'
          ? { ...s, status: 'idle' as const }
          : s,
      ),
      settings,
      rateLimits: parsed.rateLimits ?? [],
    }
  }

  get rateLimits(): RateWindow[] {
    return this.data.rateLimits
  }
  setRateLimits(windows: RateWindow[]): void {
    this.data.rateLimits = windows
    this.save()
  }

  get projects(): Project[] {
    return this.data.projects
  }
  get sessions(): SessionRecord[] {
    return this.data.sessions
  }
  get settings(): Settings {
    return this.data.settings
  }

  project(id: string): Project | undefined {
    return this.data.projects.find(p => p.id === id)
  }
  session(id: string): SessionRecord | undefined {
    return this.data.sessions.find(s => s.id === id)
  }

  addProject(p: Project): void {
    this.data.projects.push(p)
    this.save()
  }
  updateProject(id: string, patch: Partial<Project>): Project | undefined {
    const p = this.project(id)
    if (!p) return undefined
    Object.assign(p, patch, { id })
    this.save()
    return p
  }
  /** Removes the project and its session records from the app. Transcripts on disk stay. */
  removeProject(id: string): void {
    this.data.projects = this.data.projects.filter(p => p.id !== id)
    this.data.sessions = this.data.sessions.filter(s => s.projectId !== id)
    this.save()
  }

  addSession(s: SessionRecord): void {
    this.data.sessions.push(s)
    this.save()
  }
  updateSession(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const s = this.session(id)
    if (!s) return undefined
    Object.assign(s, patch, { id })
    this.save()
    return s
  }
  removeSession(id: string): void {
    this.data.sessions = this.data.sessions.filter(s => s.id !== id)
    this.save()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    Object.assign(this.data.settings, patch)
    this.save()
    return this.data.settings
  }

  /** Writes soon; many updates in a row become one write. */
  save(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 250)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
}

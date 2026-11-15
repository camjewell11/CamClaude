import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import type { CamApi, FolderInfo } from '../shared/api.ts'
import type { AppState, NewProjectInput, PendingResponse, Project, Settings } from '../shared/types.ts'
import { SessionManager } from './sessions.ts'
import { Store } from './store.ts'

const here = dirname(fileURLToPath(import.meta.url))

// CAMCLAUDE_DATA_DIR runs the app against a separate data folder (development and testing).
if (process.env.CAMCLAUDE_DATA_DIR) app.setPath('userData', resolve(process.env.CAMCLAUDE_DATA_DIR))

if (!app.requestSingleInstanceLock()) app.quit()

const userData = app.getPath('userData')
const logDir = join(userData, 'logs')
mkdirSync(logDir, { recursive: true })
const logFile = join(logDir, 'main.log')
const log = (line: string) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never break the app.
  }
}

const store = new Store(userData, '')
const sessions = new SessionManager(store, join(userData, 'handoffs'), log)
let win: BrowserWindow | null = null

const TITLEBAR = { light: { color: '#f5f4ef', symbolColor: '#3d3929' }, dark: { color: '#1f1e1d', symbolColor: '#e8e6dc' } }
const titlebarColors = () => (nativeTheme.shouldUseDarkColors ? TITLEBAR.dark : TITLEBAR.light)

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 500,
    show: false,
    title: 'CamClaude',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titlebarColors(), height: 40 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.on('focus', () => {
    win?.flashFrame(false)
    sessions.setFocus(currentFocus, true) // marks the open session read
    win?.webContents.send('cam:state', state())
  })
  win.on('blur', () => sessions.setFocus(currentFocus, false))

  // Links in messages open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))

  if (process.env.CAMCLAUDE_SCREENSHOT) void screenshotAndQuit(process.env.CAMCLAUDE_SCREENSHOT)
}

/**
 * Development aid: capture the window to a PNG, then quit. CAMCLAUDE_SCREENSHOT_JS runs in the
 * page first (it can use window.cam), and CAMCLAUDE_SCREENSHOT_WAIT_MS waits after it.
 */
async function screenshotAndQuit(path: string): Promise<void> {
  const w = win!
  await new Promise<void>(r => w.webContents.once('did-finish-load', () => r()))
  await new Promise(r => setTimeout(r, 1500))
  const js = process.env.CAMCLAUDE_SCREENSHOT_JS
  if (js) {
    await w.webContents.executeJavaScript(js)
    await new Promise(r => setTimeout(r, Number(process.env.CAMCLAUDE_SCREENSHOT_WAIT_MS ?? 1500)))
  }
  const image = await w.webContents.capturePage()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, image.toPNG())
  app.quit()
}

nativeTheme.on('updated', () => win?.setTitleBarOverlay({ ...titlebarColors(), height: 40 }))

const state = (): AppState => ({
  projects: store.projects,
  sessions: sessions.views(),
  settings: store.settings,
  rateLimits: sessions.rateWindows(),
})

let currentFocus: string | null = null

sessions.on('state', () => {
  win?.webContents.send('cam:state', state())
  const waiting = store.sessions.filter(s => s.status === 'needs-input').length
  win?.setTitle(waiting ? `(${waiting}) CamClaude` : 'CamClaude')
})
sessions.on('chat', u => win?.webContents.send('cam:chat', u))
sessions.on('handoff', h => win?.webContents.send('cam:handoff', h))
sessions.on('attention', a => {
  if (!store.settings.notify || win?.isFocused()) return
  if (a.kind === 'needs-input') win?.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: a.kind === 'needs-input' ? `Needs your input · ${a.title}` : a.kind === 'error' ? `Stopped · ${a.title}` : a.title,
    body: a.body,
    silent: a.kind === 'finished',
  })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('cam:select', a.sessionId)
  })
  n.show()
})

// ---- IPC ------------------------------------------------------------------------------------

type Handlers = { [K in keyof CamApi as CamApi[K] extends (...a: never[]) => Promise<unknown> ? K : never]: CamApi[K] }

const slugName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()

async function createProject(input: NewProjectInput): Promise<Project> {
  const name = input.name.trim()
  if (!name) throw new Error('A project needs a name.')
  const folder = resolve(input.folder.trim())
  if (!isAbsolute(folder)) throw new Error('Choose a folder for the project.')
  if (store.projects.some(p => resolve(p.folder).toLowerCase() === folder.toLowerCase())) {
    throw new Error('A project already uses that folder.')
  }
  if (input.createFolder) await mkdir(folder, { recursive: true })
  else if (!existsSync(folder)) throw new Error(`The folder ${folder} doesn't exist.`)

  const envFiles = input.envFiles.map(f => f.trim()).filter(Boolean)
  const project: Project = {
    id: randomUUID(),
    name,
    folder,
    envFiles,
    guidance: input.guidance,
    permissionMode: input.permissionMode,
    model: input.model.trim(),
    createdAt: Date.now(),
    collapsed: false,
  }
  store.addProject(project)
  if (input.importRecent) await sessions.importRecent(project)
  win?.webContents.send('cam:state', state())
  return project
}

function folderInfo(path: string): FolderInfo {
  const folder = path.trim()
  if (!folder || !existsSync(folder)) return { exists: false, hasClaudeMd: false, envFiles: [] }
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch {
    // Unreadable folder.
  }
  return {
    exists: true,
    hasClaudeMd: names.includes('CLAUDE.md') || existsSync(join(folder, '.claude', 'CLAUDE.md')),
    envFiles: names.filter(n => n === '.env' || (n.startsWith('.env.') && !n.endsWith('.example'))).sort(),
  }
}

const handlers: Handlers = {
  getState: async () => state(),
  getChat: id => sessions.getChat(id),
  createProject,
  updateProject: async (id, patch) => {
    store.updateProject(id, patch)
    win?.webContents.send('cam:state', state())
  },
  removeProject: async id => {
    for (const s of store.sessions.filter(x => x.projectId === id)) sessions.stop(s.id)
    store.removeProject(id)
    win?.webContents.send('cam:state', state())
  },
  pickFolder: async defaultPath => {
    const r = await dialog.showOpenDialog(win!, {
      defaultPath: defaultPath || store.settings.projectsRoot || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  openFolder: async path => {
    await shell.openPath(path)
  },
  knownFolders: () => sessions.knownFolders(),
  folderInfo: async path => folderInfo(path),
  createSession: async (projectId, prompt) => sessions.createSession(projectId, prompt).id,
  send: (id, text) => sessions.send(id, text),
  interrupt: id => sessions.interrupt(id),
  respond: async (id, requestId, response: PendingResponse) => sessions.respond(id, requestId, response),
  archive: async id => sessions.archive(id, 'manual'),
  unarchive: async id => sessions.unarchive(id),
  rename: async (id, title) => sessions.rename(id, title),
  remove: async id => sessions.remove(id),
  handoffNow: async id => sessions.handoffNow(id),
  stopProcess: async id => sessions.stop(id),
  setFocus: async id => {
    currentFocus = id
    sessions.setFocus(id, !!win?.isFocused())
  },
  updateSettings: async (patch: Partial<Settings>) => {
    const s = store.updateSettings(patch)
    win?.webContents.send('cam:state', state())
    return s
  },
}

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`cam:${name}`, async (_e, ...args: unknown[]) => {
    try {
      return await (fn as (...a: unknown[]) => Promise<unknown>)(...args)
    } catch (err) {
      log(`ipc ${name} failed: ${err instanceof Error ? err.stack : String(err)}`)
      throw err
    }
  })
}

/** First run: suggest the folder most existing projects live in as the place for new ones. */
async function defaultProjectsRoot(): Promise<void> {
  if (store.settings.projectsRoot) return
  const known = await sessions.knownFolders()
  const counts = new Map<string, number>()
  for (const k of known) {
    if (k.folder.includes('AppData')) continue // scratch and temp sessions
    const parent = dirname(k.folder)
    counts.set(parent, (counts.get(parent) ?? 0) + k.sessions)
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  store.updateSettings({ projectsRoot: best ?? join(app.getPath('documents'), 'Projects') })
  win?.webContents.send('cam:state', state())
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(() => {
  app.setAppUserModelId('com.camjewell.camclaude')
  createWindow()
  sessions.startJanitor()
  void defaultProjectsRoot()
  log(`started; data in ${userData}; ${basename(process.execPath)}`)
})

app.on('before-quit', () => {
  sessions.stopAll()
  store.flush()
})

app.on('window-all-closed', () => {
  app.quit()
})

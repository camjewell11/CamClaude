import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import type { CamApi, FolderInfo, InvokeChannel } from '../shared/api.ts'
import { cleanEffort } from '../shared/effort.ts'
import type { AppState, NewProjectInput, PendingResponse, Project, Settings } from '../shared/types.ts'
import { AddonStore } from './addons.ts'
import { parseConnectLink, saveClientLink } from './clientLink.ts'
import { lanAddresses, newToken, RemoteServer, tailscaleAddresses } from './remote.ts'
import { screenshotAndQuit } from './screenshot.ts'
import { SessionManager } from './sessions.ts'
import { Store } from './store.ts'
import { claudeProjectsDir, summarize, UsageLedger, weekStartDay } from './usage.ts'

const here = dirname(fileURLToPath(import.meta.url))
const rendererDir = join(here, '../renderer')

// index.ts already applied CAMCLAUDE_DATA_DIR.
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
const sessions = new SessionManager(store, join(userData, 'handoffs'), log, new AddonStore(join(userData, 'addons'), log))
const usage = new UsageLedger(join(userData, 'usage.json'), claudeProjectsDir(), log)
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const DESKTOP = 'desktop'
let desktopSession: string | null = null

const iconPath = () => join(rendererDir, 'icon.png')

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
    icon: existsSync(iconPath()) ? iconPath() : undefined,
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
    sessions.setFocus(DESKTOP, desktopSession) // marks the open session read
    send('state', state())
  })
  win.on('blur', () => sessions.setFocus(DESKTOP, null))
  win.on('hide', () => sessions.setFocus(DESKTOP, null))

  // With remote access on, closing hides to the tray so phones stay connected.
  win.on('close', e => {
    if (quitting || !store.settings.remoteEnabled) return
    e.preventDefault()
    win?.hide()
    if (!store.get('trayHintShown')) {
      store.set('trayHintShown', true)
      if (Notification.isSupported()) {
        new Notification({
          title: 'CamClaude is still running',
          body: 'Remote access is on, so it stays in the tray. Right-click the tray icon to quit.',
        }).show()
      }
    }
  })

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
  else void win.loadFile(join(rendererDir, 'index.html'))

  if (process.env.CAMCLAUDE_SCREENSHOT) {
    void screenshotAndQuit(win, process.env.CAMCLAUDE_SCREENSHOT, () => {
      quitting = true
      app.quit()
    })
  }
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** The tray icon exists while remote access is on. */
function syncTray(): void {
  if (!store.settings.remoteEnabled) {
    tray?.destroy()
    tray = null
    return
  }
  if (tray || !existsSync(iconPath())) return
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }))
  tray.setToolTip('CamClaude (remote access on)')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open CamClaude', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', showWindow)
}

nativeTheme.on('updated', () => win?.setTitleBarOverlay({ ...titlebarColors(), height: 40 }))

const state = (): AppState => ({
  projects: store.projects,
  sessions: sessions.views(),
  settings: store.settings,
  rateLimits: sessions.rateWindows(),
  models: sessions.models(),
  usage: summarize(usage.sessions, store.sessions, weekStartDay(sessions.rateWindows()), usage.scanning),
})

/** Pushes state at most every half second while the startup scan counts old transcripts. */
let usagePushTimer: NodeJS.Timeout | undefined
function usageChanged(): void {
  if (usagePushTimer) return
  usagePushTimer = setTimeout(() => {
    usagePushTimer = undefined
    send('state', state())
  }, 500)
}

/** Counts every known session's transcripts once, most recent first; turn ends keep it current. */
async function startUsage(): Promise<void> {
  usage.prune(new Set(store.sessions.map(s => s.id)))
  const ids = store.sessions
    .filter(s => s.hasTranscript)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map(s => s.id)
  await usage.scanAll(ids, usageChanged)
}

// ---- remote access ----------------------------------------------------------------------------

const remote = new RemoteServer({
  staticDir: rendererDir,
  invoke: (viewer, method, args) => dispatch(viewer, method, args),
  onDisconnect: viewer => sessions.setFocus(viewer, null),
  log,
})

/** Sends an event to the desktop window and every connected phone. */
function send(event: 'state' | 'chat' | 'handoff' | 'select', payload: unknown): void {
  win?.webContents.send(`cam:${event}`, payload)
  remote.broadcast(event, payload)
}

async function applyRemote(): Promise<void> {
  if (store.settings.remoteEnabled && !store.settings.remoteToken) store.updateSettings({ remoteToken: newToken() })
  await remote.apply(store.settings)
  syncTray()
}

sessions.on('state', () => send('state', state()))
sessions.on('turnEnd', id => {
  usage.scan(id).then(
    counted => counted && usageChanged(),
    err => log(`usage scan of ${id} failed: ${String(err)}`),
  )
})
sessions.on('chat', u => send('chat', u))
sessions.on('handoff', h => send('handoff', h))
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
    showWindow()
    win?.webContents.send('cam:select', a.sessionId)
  })
  n.show()
})

// ---- API --------------------------------------------------------------------------------------

type Handlers = { [K in keyof CamApi as CamApi[K] extends (...a: never[]) => Promise<unknown> ? K : never]: CamApi[K] }

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
  send('state', state())
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

const REMOTE_KEYS: (keyof Settings)[] = ['remoteEnabled', 'remotePort', 'remoteScope', 'remoteToken']

const handlers: Handlers = {
  getState: async () => state(),
  getChat: id => sessions.getChat(id),
  createProject,
  updateProject: async (id, patch) => {
    store.updateProject(id, patch)
    send('state', state())
  },
  removeProject: async id => {
    for (const s of store.sessions.filter(x => x.projectId === id)) sessions.stop(s.id)
    store.removeProject(id)
    send('state', state())
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
  createSession: async (projectId, prompt, images, addons, model, effort) =>
    sessions.createSession(
      projectId,
      prompt,
      {
        addons: Array.isArray(addons) ? addons : [],
        model: typeof model === 'string' ? model : undefined,
        effort: cleanEffort(effort),
      },
      images ?? [],
    ).id,
  setModel: (id, model) => sessions.setModel(id, typeof model === 'string' ? model : ''),
  setEffort: (id, effort) => sessions.setEffort(id, cleanEffort(effort)),
  send: (id, text, images) => sessions.send(id, text, images ?? []),
  interrupt: id => sessions.interrupt(id),
  respond: async (id, requestId, response: PendingResponse) => sessions.respond(id, requestId, response),
  archive: async id => sessions.archive(id, 'manual'),
  unarchive: async id => sessions.unarchive(id),
  rename: async (id, title) => sessions.rename(id, title),
  remove: async id => sessions.remove(id),
  handoffNow: async id => sessions.handoffNow(id),
  stopProcess: async id => sessions.stop(id),
  setFocus: async id => {
    desktopSession = id
    sessions.setFocus(DESKTOP, win?.isFocused() ? id : null)
  },
  updateSettings: async (patch: Partial<Settings>) => {
    const before = { ...store.settings }
    const s = store.updateSettings(patch)
    if (REMOTE_KEYS.some(k => before[k] !== s[k])) await applyRemote()
    send('state', state())
    return s
  },
  remoteInfo: () => remote.info(),
  regenerateRemoteToken: async () => {
    store.updateSettings({ remoteToken: newToken() })
    await applyRemote()
    send('state', state())
    return remote.info()
  },
  connectToPc: async text => {
    const parsed = parseConnectLink(String(text))
    if ('error' in parsed) throw new Error(parsed.error)
    const hostname = new URL(parsed.link).hostname
    if (['localhost', '127.0.0.1', ...tailscaleAddresses(), ...lanAddresses()].includes(hostname)) {
      throw new Error("That's this PC's own link. Paste the link from the other PC.")
    }
    if (sessions.views().some(s => s.status === 'running' || s.status === 'handing-off' || s.status === 'needs-input')) {
      throw new Error('A session on this PC is still working. Wait for it to finish, then connect.')
    }
    let res: Response
    try {
      res = await fetch(parsed.link, { redirect: 'manual', signal: AbortSignal.timeout(6000) })
    } catch {
      throw new Error(
        `Couldn't reach ${parsed.host}. Check that Tailscale is connected on both PCs and that remote access is on in CamClaude there.`,
      )
    }
    if (res.status === 401) throw new Error('The other PC rejected the link. Copy a fresh one from its Settings.')
    if (res.status !== 302) throw new Error(`${parsed.host} answered, but not as CamClaude (HTTP ${res.status}).`)
    saveClientLink(userData, parsed.link)
    log(`switching to client mode for ${parsed.host}`)
    // Let the reply reach the window before it closes.
    setTimeout(() => {
      quitting = true
      app.relaunch()
      app.quit()
    }, 300)
  },
}

/** Runs an API call for a viewer: the desktop window, or a phone over the network. */
async function dispatch(viewer: string, method: InvokeChannel, args: unknown[]): Promise<unknown> {
  if (method === 'setFocus' && viewer !== DESKTOP) {
    sessions.setFocus(viewer, (args[0] as string | null) ?? null)
    return undefined
  }
  const fn = handlers[method] as (...a: unknown[]) => Promise<unknown>
  try {
    return await fn(...args)
  } catch (err) {
    log(`${viewer} ${method} failed: ${err instanceof Error ? err.stack : String(err)}`)
    throw err
  }
}

for (const name of Object.keys(handlers) as InvokeChannel[]) {
  ipcMain.handle(`cam:${name}`, (_e, ...args: unknown[]) => dispatch(DESKTOP, name, args))
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
  send('state', state())
}

app.on('second-instance', showWindow)

app.whenReady().then(() => {
  app.setAppUserModelId('com.camjewell.camclaude')
  createWindow()
  sessions.startJanitor()
  void defaultProjectsRoot()
  void applyRemote()
  setTimeout(() => void startUsage(), 2000) // after the window is up
  log(`started; data in ${userData}; ${basename(process.execPath)}`)
})

app.on('before-quit', () => {
  quitting = true
  sessions.stopAll()
  void remote.stop()
  store.flush()
  usage.flush()
})

app.on('window-all-closed', () => {
  app.quit()
})

// Client mode: a window onto another PC's CamClaude. That PC serves the UI and runs every
// session; this install keeps no projects or sessions of its own while connected.

import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { clearClientLink } from './clientLink.ts'
import { screenshotAndQuit } from './screenshot.ts'

const here = dirname(fileURLToPath(import.meta.url))
const iconPath = join(here, '../renderer/icon.png')
const TITLEBAR = { light: { color: '#f5f4ef', symbolColor: '#3d3929' }, dark: { color: '#1f1e1d', symbolColor: '#e8e6dc' } }
const titlebarColors = () => (nativeTheme.shouldUseDarkColors ? TITLEBAR.dark : TITLEBAR.light)
const RETRY_MS = 10_000

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** The page shown when the other PC can't be reached or turned the link down. */
function offlinePage(title: string, body: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>CamClaude</title><style>
  :root { color-scheme: light dark; --bg: #faf9f5; --fg: #3d3929; --muted: #6b6a63; --line: #dedcd1; --accent: #c96442; }
  @media (prefers-color-scheme: dark) { :root { --bg: #262624; --fg: #e8e6dc; --muted: #a3a29b; --line: #3e3e38; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  .bar { height: 40px; -webkit-app-region: drag; }
  main { max-width: 520px; margin: 12vh auto 0; padding: 0 24px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 20px; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; margin-right: 8px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  </style></head><body><div class="bar"></div><main>
  <h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>
  <button class="primary" onclick="camClient.retry()">Try again</button>
  <button onclick="if (confirm('Use CamClaude on this PC instead? You can connect again from Settings.')) camClient.disconnect()">Use this PC instead</button>
  </main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export function runClient(link: string): void {
  const userData = app.getPath('userData')
  const origin = new URL(link).origin
  const host = new URL(link).host
  const logDir = join(userData, 'logs')
  mkdirSync(logDir, { recursive: true })
  const log = (line: string) => {
    try {
      appendFileSync(join(logDir, 'main.log'), `${new Date().toISOString()} client: ${line}\n`)
    } catch {
      // Logging must never break the app.
    }
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let win: BrowserWindow | null = null
  let retryTimer: NodeJS.Timeout | undefined

  const load = () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    void win?.loadURL(link).catch(() => undefined) // failures arrive as did-fail-load
  }

  const offline = (title: string, body: string, retry: boolean) => {
    if (!win) return
    void win.loadURL(offlinePage(title, body)).catch(() => undefined)
    if (retry) retryTimer = setTimeout(load, RETRY_MS)
  }

  function createWindow(): void {
    const w = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 500,
      show: false,
      title: 'CamClaude',
      icon: existsSync(iconPath) ? iconPath : undefined,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...titlebarColors(), height: 40 },
      webPreferences: {
        preload: join(here, '../preload/client.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    win = w
    w.once('ready-to-show', () => w.show())
    w.on('closed', () => {
      win = null
    })

    // Only the other PC's CamClaude opens in the window; every other link goes to the browser.
    const inside = (url: string) => url.startsWith(`${origin}/`) || url.startsWith('data:')
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    w.webContents.on('will-navigate', (e, url) => {
      if (inside(url)) return
      e.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    })

    w.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || url.startsWith('data:')) return // -3: replaced by a newer load
      log(`can't load ${host}: ${description} (${code})`)
      offline(
        `Can't reach ${host}`,
        'CamClaude runs its sessions on that PC. Check that the PC is on, that Tailscale is connected on both PCs, and ' +
          'that remote access is on in its CamClaude Settings. Trying again every 10 seconds.',
        true,
      )
    })
    w.webContents.on('did-navigate', (_e, url, status) => {
      if (status === 401 && url.startsWith(origin)) {
        log(`${host} rejected the link`)
        offline(
          `${host} turned down this PC`,
          'Its connect link changed, for example after "Sign out all devices". Choose "Use this PC instead", then ' +
            'connect again from Settings with the new link.',
          false,
        )
      }
    })

    if (process.env.CAMCLAUDE_SCREENSHOT) void screenshotAndQuit(w, process.env.CAMCLAUDE_SCREENSHOT, () => app.quit())
    load()
  }

  ipcMain.handle('client:retry', () => load())
  ipcMain.handle('client:disconnect', () => {
    clearClientLink(userData)
    log(`disconnected from ${host}`)
    app.relaunch()
    app.quit()
  })

  nativeTheme.on('updated', () => win?.setTitleBarOverlay({ ...titlebarColors(), height: 40 }))
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.camjewell.camclaude')
    createWindow()
    log(`started; showing ${host}`)
  })
}

// Serves the CamClaude UI to other devices (a phone) and bridges its calls over a WebSocket.
// Anyone who can use this can run commands on this PC through Claude, so: off by default, a
// 256-bit token in the connect link, an HttpOnly SameSite=Strict cookie after that, an Origin
// check on the socket, and by default it listens only on Tailscale addresses and localhost.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'

import QRCode from 'qrcode'
import { WebSocket, WebSocketServer } from 'ws'

import { DESKTOP_ONLY, INVOKE_CHANNELS, type InvokeChannel, type WireToClient, type WireToServer } from '../shared/api.ts'
import type { RemoteInfo, Settings } from '../shared/types.ts'

type RemoteSettings = Pick<Settings, 'remoteEnabled' | 'remotePort' | 'remoteScope' | 'remoteToken'>

export interface RemoteDeps {
  /** The built renderer (out/renderer). */
  staticDir: string
  invoke: (viewer: string, method: InvokeChannel, args: unknown[]) => Promise<unknown>
  onDisconnect: (viewer: string) => void
  log: (line: string) => void
}

const COOKIE = 'camclaude_token'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}
const CHANNELS = new Set<string>(INVOKE_CHANNELS)
const BLOCKED = new Set<string>(DESKTOP_ONLY)

export const newToken = () => randomBytes(32).toString('base64url')

/** This PC's Tailscale addresses (100.64.0.0/10). */
export function tailscaleAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const [p, q] = a.address.split('.').map(Number)
      if (p === 100 && q >= 64 && q <= 127) out.push(a.address)
    }
  }
  return out
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address)
    }
  }
  return out
}

function readCookie(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return ''
}

export class RemoteServer {
  private servers: Server[] = []
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  private readonly clients = new Map<WebSocket, { viewer: string; alive: boolean }>()
  private settings: RemoteSettings | null = null
  private error: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private readonly deps: RemoteDeps

  constructor(deps: RemoteDeps) {
    this.deps = deps
    this.wss.on('connection', ws => this.onConnection(ws))
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Starts, restarts, or stops the server to match the settings. */
  async apply(s: RemoteSettings): Promise<void> {
    await this.stop()
    this.settings = { ...s }
    this.error = undefined
    if (!s.remoteEnabled || !s.remoteToken) return

    const tailscale = tailscaleAddresses()
    const hosts = s.remoteScope === 'all' ? ['0.0.0.0'] : [...tailscale, '127.0.0.1']
    if (s.remoteScope === 'tailscale' && tailscale.length === 0) {
      this.error =
        "Tailscale isn't connected on this PC, so only this PC can connect. Install Tailscale and sign in " +
        'on both devices, or choose “Any network” to allow your Wi-Fi.'
    }
    for (const host of hosts) {
      const server = createServer((req, res) => void this.onRequest(req, res))
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
      try {
        await new Promise<void>((ok, fail) => {
          server.once('error', fail)
          server.listen(s.remotePort, host, () => {
            server.off('error', fail)
            ok()
          })
        })
        this.servers.push(server)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        this.error =
          code === 'EADDRINUSE'
            ? `Port ${s.remotePort} is already in use. Choose another port.`
            : `Couldn't listen on ${host}:${s.remotePort}: ${String(err)}`
        this.deps.log(`remote: ${this.error}`)
      }
    }
    this.heartbeat = setInterval(() => this.ping(), 30_000)
    if (this.servers.length) this.deps.log(`remote: listening on ${hosts.join(', ')} port ${s.remotePort}`)
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const ws of this.clients.keys()) ws.close(1001, 'Server stopped')
    this.clients.clear()
    await Promise.all(
      this.servers.map(
        s =>
          new Promise<void>(r => {
            s.closeAllConnections()
            s.close(() => r())
          }),
      ),
    )
    this.servers = []
  }

  async info(): Promise<RemoteInfo> {
    const s = this.settings
    const hasTailscale = tailscaleAddresses().length > 0
    if (!s?.remoteEnabled || this.servers.length === 0) {
      return { running: false, urls: [], error: this.error, hasTailscale, clients: 0 }
    }
    const hosts = s.remoteScope === 'all' ? [...new Set([...tailscaleAddresses(), ...lanAddresses()])] : tailscaleAddresses()
    if (hosts.length === 0) hosts.push('localhost')
    const urls = hosts.map(h => `http://${h}:${s.remotePort}/?t=${encodeURIComponent(s.remoteToken)}`)
    let qr: string | undefined
    // A localhost link is no use on a phone, so it gets no QR code.
    if (hosts[0] !== 'localhost') {
      try {
        qr = await QRCode.toDataURL(urls[0], { margin: 1, width: 220, errorCorrectionLevel: 'M' })
      } catch {
        // The links still work without the picture.
      }
    }
    return { running: true, urls, qr, error: this.error, hasTailscale, clients: this.clients.size }
  }

  broadcast(event: 'state' | 'chat' | 'handoff' | 'select', payload: unknown): void {
    if (this.clients.size === 0) return
    const data = JSON.stringify({ event, payload } satisfies WireToClient)
    for (const ws of this.clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }

  // ---- auth --------------------------------------------------------------------------------

  private tokenOk(candidate: string): boolean {
    const real = this.settings?.remoteToken ?? ''
    if (!real || !candidate) return false
    const a = Buffer.from(candidate)
    const b = Buffer.from(real)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private authed(req: IncomingMessage): boolean {
    return this.tokenOk(readCookie(req, COOKIE))
  }

  // ---- HTTP --------------------------------------------------------------------------------

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer') // the token travels in the link
    res.setHeader('X-Frame-Options', 'DENY')
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.plain(res, 405, 'Method not allowed')

    const url = new URL(req.url ?? '/', 'http://x')
    const t = url.searchParams.get('t')

    // The connect link: trade the token for a cookie, then drop it from the address bar.
    if (url.pathname === '/' && t !== null) {
      if (!this.tokenOk(t)) return this.denied(res)
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      )
      res.writeHead(302, { Location: '/' })
      res.end()
      return
    }
    // Home-screen apps (iOS) keep their own cookies, so the manifest starts at the connect link.
    if (url.pathname === '/manifest.webmanifest') {
      if (!t || !this.tokenOk(t)) return this.plain(res, 404, 'Not found')
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' })
      res.end(
        JSON.stringify({
          name: 'CamClaude',
          short_name: 'CamClaude',
          start_url: `/?t=${encodeURIComponent(t)}`,
          display: 'standalone',
          background_color: '#262624',
          theme_color: '#1f1e1d',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        }),
      )
      return
    }
    if (url.pathname === '/icon.svg') return this.file(res, 'icon.svg')
    if (!this.authed(req)) return this.denied(res)
    if (url.pathname === '/' || url.pathname === '/index.html') return this.index(res)
    return this.file(res, decodeURIComponent(url.pathname.slice(1)))
  }

  private async index(res: ServerResponse): Promise<void> {
    try {
      const html = await readFile(join(this.deps.staticDir, 'index.html'), 'utf8')
      const token = encodeURIComponent(this.settings?.remoteToken ?? '')
      const head = [
        `<link rel="manifest" href="/manifest.webmanifest?t=${token}" />`,
        '<link rel="icon" href="/icon.svg" />',
        '<link rel="apple-touch-icon" href="/icon.svg" />',
        '<meta name="theme-color" content="#1f1e1d" />',
        '<meta name="apple-mobile-web-app-capable" content="yes" />',
        '<meta name="mobile-web-app-capable" content="yes" />',
        '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
      ].join('\n    ')
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' })
      res.end(html.replace('</head>', `    ${head}\n  </head>`))
    } catch {
      this.plain(res, 503, 'The CamClaude UI is not built. Run `npm run build` on the PC, then reload.')
    }
  }

  private async file(res: ServerResponse, rel: string): Promise<void> {
    const root = resolve(this.deps.staticDir)
    const path = resolve(root, rel)
    if (path !== root && !path.startsWith(root + sep)) return this.plain(res, 404, 'Not found')
    try {
      const body = await readFile(path)
      const immutable = rel.startsWith('assets/') // hashed file names
      res.writeHead(200, {
        'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      res.end(body)
    } catch {
      this.plain(res, 404, 'Not found')
    }
  }

  private plain(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(text)
  }

  private denied(res: ServerResponse): void {
    res.writeHead(401, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' })
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>CamClaude</title><body style="font:16px system-ui;padding:24px;background:#262624;color:#e8e6dc">' +
        '<h2 style="font-weight:600">Not connected</h2><p>Open the link from CamClaude on your PC ' +
        '(Settings, Remote access), or scan its QR code. If the link stopped working, it was regenerated.</p>',
    )
  }

  // ---- WebSocket ---------------------------------------------------------------------------

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x')
    const origin = req.headers.origin
    const sameOrigin = !!origin && !!req.headers.host && new URL(origin).host === req.headers.host
    if (url.pathname !== '/ws' || !this.authed(req) || !sameOrigin) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req))
  }

  private onConnection(ws: WebSocket): void {
    const viewer = `remote:${randomUUID()}`
    this.clients.set(ws, { viewer, alive: true })
    this.deps.log(`remote: ${viewer} connected (${this.clients.size} now)`)
    ws.on('pong', () => {
      const c = this.clients.get(ws)
      if (c) c.alive = true
    })
    ws.on('message', data => void this.onMessage(ws, viewer, data.toString()))
    ws.on('close', () => {
      this.clients.delete(ws)
      this.deps.onDisconnect(viewer)
    })
    ws.on('error', err => this.deps.log(`remote: socket error ${String(err)}`))
  }

  private async onMessage(ws: WebSocket, viewer: string, raw: string): Promise<void> {
    let msg: WireToServer
    try {
      msg = JSON.parse(raw) as WireToServer
    } catch {
      return
    }
    const reply = (r: WireToClient) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(r))
    if (typeof msg.id !== 'number' || !CHANNELS.has(msg.method) || BLOCKED.has(msg.method) || !Array.isArray(msg.args)) {
      reply({ id: msg.id, error: `Not available remotely: ${String(msg.method)}` })
      return
    }
    try {
      reply({ id: msg.id, result: await this.deps.invoke(viewer, msg.method, msg.args) })
    } catch (err) {
      reply({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Drops phones that went away without closing (sleep, lost signal). */
  private ping(): void {
    for (const [ws, c] of this.clients) {
      if (!c.alive) {
        ws.terminate()
        continue
      }
      c.alive = false
      ws.ping()
    }
  }
}

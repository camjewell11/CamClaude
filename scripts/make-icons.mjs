// Renders src/renderer/public/icon.svg to the PNGs Windows needs (tray, window, installer).
// Run with Electron: npm run icons
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'src/renderer/public/icon.svg'), 'utf8')
const SIZE = 512

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true })
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise(r => setTimeout(r, 300))
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })).resize({ width: SIZE, height: SIZE }).toPNG()
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build/icon.png'), png) // electron-builder makes the .ico from this
  writeFileSync(join(root, 'src/renderer/public/icon.png'), png) // window and tray icon
  console.log(`wrote build/icon.png and src/renderer/public/icon.png (${png.length} bytes)`)
  app.quit()
})

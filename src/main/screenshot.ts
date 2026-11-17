import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

/**
 * Development aid: capture the window to a PNG, then quit. CAMCLAUDE_SCREENSHOT_JS runs in the
 * page first (it can use window.cam), and CAMCLAUDE_SCREENSHOT_WAIT_MS waits after it.
 * CAMCLAUDE_SCREENSHOT_SIZE=<width>x<height> sets the page size first, for example 390x844.
 * CAMCLAUDE_SCREENSHOT_DELAY_MS waits after the page loads (default 1500).
 */
export async function screenshotAndQuit(w: BrowserWindow, path: string, quit: () => void): Promise<void> {
  await new Promise<void>(r => w.webContents.once('did-finish-load', () => r()))
  const size = /^(\d+)x(\d+)$/.exec(process.env.CAMCLAUDE_SCREENSHOT_SIZE ?? '')
  if (size) {
    w.setMinimumSize(1, 1)
    w.setContentSize(Number(size[1]), Number(size[2]))
  }
  await new Promise(r => setTimeout(r, Number(process.env.CAMCLAUDE_SCREENSHOT_DELAY_MS ?? 1500)))
  const js = process.env.CAMCLAUDE_SCREENSHOT_JS
  if (js) {
    await w.webContents.executeJavaScript(js)
    await new Promise(r => setTimeout(r, Number(process.env.CAMCLAUDE_SCREENSHOT_WAIT_MS ?? 1500)))
  }
  const image = await w.webContents.capturePage()
  writeFileSync(path, image.toPNG())
  quit()
}

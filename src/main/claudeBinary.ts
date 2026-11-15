// Where the Claude Code binary is. The SDK ships it in a per-platform package and finds it
// with require.resolve, which inside a packaged app points into app.asar, where nothing can
// run. electron-builder unpacks it next to the archive, so point there instead.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

export function claudeBinary(override: string): string | undefined {
  if (override.trim()) return override.trim()
  const require = createRequire(import.meta.url)
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates =
    process.platform === 'linux'
      ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
      : [`${process.platform}-${process.arch}`]
  for (const c of candidates) {
    try {
      const path = require.resolve(`@anthropic-ai/claude-agent-sdk-${c}/${exe}`)
      const unpacked = path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
      if (existsSync(unpacked)) return unpacked
      if (existsSync(path)) return path
    } catch {
      // Not installed for this platform; try the next.
    }
  }
  return undefined // let the SDK look for itself
}

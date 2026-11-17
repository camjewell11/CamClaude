// Entry point: run the full app (host.ts), or, when this install is set to connect to another
// PC, only a window onto that PC's CamClaude (client.ts).

import { app } from 'electron'
import { resolve } from 'node:path'

import { readClientLink } from './clientLink.ts'

// CAMCLAUDE_DATA_DIR runs the app against a separate data folder (development and testing).
if (process.env.CAMCLAUDE_DATA_DIR) app.setPath('userData', resolve(process.env.CAMCLAUDE_DATA_DIR))

const link = readClientLink(app.getPath('userData'))
if (link) {
  const { runClient } = await import('./client.ts')
  runClient(link)
} else {
  await import('./host.ts')
}

# CamClaude

Electron + React + TypeScript desktop front end for Claude Code, built on the Claude Agent SDK.
See README.md for features and layout.

## Commands

- `npm run dev`: run with hot reload
- `npm run typecheck`, `npm test`: run both before saying a change is done
- `npm run smoke`: end to end against real Claude (spends a little usage); run it after changing
  `sessions.ts`, `guard.ts`, or the SDK version
- `npm run addons:check -- <empty dir>`: downloads and builds every add-on into that folder and
  lists the agents and skills Claude Code loads from them, with no model call; run it after changing
  `src/shared/addons.ts` or `src/main/addons.ts`
- `npm run dist`: Windows installer in `dist/`

## Gotchas

- VS Code terminals set `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node and
  crash. `npm run dev`, `npm start` and `npm run icons` clear it (scripts/run.mjs); clear it
  yourself before running `npx electron .` or `dist\win-unpacked\CamClaude.exe` from such a terminal.
- Every UI call goes through `CamApi` (src/shared/api.ts): IPC in the desktop window, a WebSocket
  for phones (src/renderer/remoteApi.ts → src/main/remote.ts → `dispatch` in index.ts). A new call
  needs its name in `INVOKE_CHANNELS`, and `DESKTOP_ONLY` if it only makes sense at the PC.
  Events reach both through `send()` in index.ts, never `win.webContents.send` directly.
- The phone server serves the built renderer (`out/renderer`), so in `npm run dev` it shows the
  last `npm run build`, not the live dev server.
- Write test JSON for the store without a BOM (PowerShell 5.1's `Set-Content -Encoding utf8` adds
  one); the store strips it now, but other tools may not.
- `npm run icons` regenerates build/icon.png and src/renderer/public/icon.png from icon.svg.
- `CAMCLAUDE_DATA_DIR=<dir>` runs the app against a separate data folder. Use it for testing, never
  the real `%APPDATA%\camclaude`. `CAMCLAUDE_SCREENSHOT=<png>` (with optional
  `CAMCLAUDE_SCREENSHOT_JS`, `CAMCLAUDE_SCREENSHOT_WAIT_MS`, and
  `CAMCLAUDE_SCREENSHOT_SIZE=390x844` for the phone layout) captures the window and quits.
- The main process is ESM, because the SDK is ESM-only; the preload must stay CommonJS (`index.cjs`),
  because the renderer is sandboxed.
- Files under `src/main` that tests import must run under `node --experimental-strip-types`:
  import with `.ts` extensions, and use no parameter properties, enums, or namespaces.
- The SDK is pinned to an exact version. Its bundled `claude.exe` must stay unpacked from the asar
  (`asarUnpack` in package.json; `src/main/claudeBinary.ts` points at it).
- The handoff needs real growth (`MIN_GROWTH` in guard.ts), not just size; a fresh session already
  re-sends ~40k tokens. Removing that check makes successors hand off in a loop.

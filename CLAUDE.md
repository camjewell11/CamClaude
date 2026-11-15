# CamClaude

Electron + React + TypeScript desktop front end for Claude Code, built on the Claude Agent SDK.
See README.md for features and layout.

## Commands

- `npm run dev`: run with hot reload
- `npm run typecheck`, `npm test`: run both before saying a change is done
- `npm run smoke`: end to end against real Claude (spends a little usage); run it after changing
  `sessions.ts`, `guard.ts`, or the SDK version
- `npm run dist`: Windows installer in `dist/`

## Gotchas

- VS Code terminals set `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node and
  crash. `npm run dev` and `npm start` clear it (scripts/electron-vite.mjs); clear it yourself
  before running `npx electron .` or `dist\win-unpacked\CamClaude.exe` from such a terminal.
- `CAMCLAUDE_DATA_DIR=<dir>` runs the app against a separate data folder. Use it for testing, never
  the real `%APPDATA%\camclaude`. `CAMCLAUDE_SCREENSHOT=<png>` (with optional
  `CAMCLAUDE_SCREENSHOT_JS` and `CAMCLAUDE_SCREENSHOT_WAIT_MS`) captures the window and quits.
- The main process is ESM, because the SDK is ESM-only; the preload must stay CommonJS (`index.cjs`),
  because the renderer is sandboxed.
- Files under `src/main` that tests import must run under `node --experimental-strip-types`:
  import with `.ts` extensions, and use no parameter properties, enums, or namespaces.
- The SDK is pinned to an exact version. Its bundled `claude.exe` must stay unpacked from the asar
  (`asarUnpack` in package.json; `src/main/claudeBinary.ts` points at it).
- The handoff needs real growth (`MIN_GROWTH` in guard.ts), not just size; a fresh session already
  re-sends ~40k tokens. Removing that check makes successors hand off in a loop.

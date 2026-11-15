// Runs a command (electron-vite, electron) with ELECTRON_RUN_AS_NODE cleared. VS Code sets that
// variable in its terminals, and with it set Electron starts as plain Node and crashes.
// Usage: node scripts/run.mjs <command> [args...]
import { spawn } from 'node:child_process'

delete process.env.ELECTRON_RUN_AS_NODE
const [command, ...args] = process.argv.slice(2)
const child = spawn('npx', [command, ...args], { stdio: 'inherit', shell: true })
child.on('exit', code => process.exit(code ?? 0))

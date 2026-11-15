// Runs electron-vite with ELECTRON_RUN_AS_NODE cleared. VS Code sets that variable in its
// terminals, and with it set Electron starts as plain Node and the app crashes on launch.
import { spawn } from 'node:child_process'

delete process.env.ELECTRON_RUN_AS_NODE
const child = spawn('npx', ['electron-vite', ...process.argv.slice(2)], { stdio: 'inherit', shell: true })
child.on('exit', code => process.exit(code ?? 0))

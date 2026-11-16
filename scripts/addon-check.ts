// Downloads and builds every add-on into a temp folder, then asks Claude Code (no model call)
// which agents, skills, and plugins it loaded. Usage: node --experimental-strip-types scripts/addon-check.ts <dir>
import { query } from '@anthropic-ai/claude-agent-sdk'
import { AddonStore } from '../src/main/addons.ts'
import { claudeBinary } from '../src/main/claudeBinary.ts'
import { ADDONS } from '../src/shared/addons.ts'

const dir = process.argv[2]
if (!dir) throw new Error('pass a folder')
const store = new AddonStore(dir, l => console.log('log:', l))
const t0 = Date.now()
const { paths, errors } = await store.prepare(ADDONS.map(a => a.id))
console.log(`prepared ${paths.length} in ${Date.now() - t0} ms; errors: ${errors.length ? errors.join('; ') : 'none'}`)

async function* never() { await new Promise(() => undefined) }
const q = query({
  prompt: never() as AsyncIterable<never>,
  options: {
    cwd: dir,
    settingSources: [],
    plugins: paths.map(path => ({ type: 'local' as const, path })),
    pathToClaudeCodeExecutable: claudeBinary(''),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  },
})
const init = await q.initializationResult()
const agents = (await q.supportedAgents()).map(a => a.name)
const skillish = (await q.supportedCommands()).map(c => c.name).filter(n => /react-project|brainstorm|taste|design-taste/.test(n))
console.log('agents from add-ons:', agents.filter(a => a.includes(':')).join(', '))
console.log('skills/commands from add-ons:', skillish.join(', '))
const ie = init as unknown as Record<string, unknown>
console.log('init keys:', Object.keys(ie).join(', '))
q.close()
process.exit(0)

// End-to-end smoke test of SessionManager outside Electron, with real Claude calls (about four
// small requests): one turn in a throwaway project, a manual handoff, and a check that the
// successor does not hand off again. Run: npm run smoke [-- <scratch dir>]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const root = new URL('../src/main/', import.meta.url).href
const { Store } = await import(root + 'store.ts')
const { SessionManager } = await import(root + 'sessions.ts')

const base = process.argv[2] ?? join(tmpdir(), `camclaude-smoke-${Date.now()}`)
const data = join(base, 'data')
const work = join(base, 'work')
mkdirSync(data, { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(work, '.env'), 'SMOKE_TOKEN=secret-value-123\n')

const store = new Store(data, base)
store.updateSettings({ handoffTokens: 1000, hardStopTokens: 1_000_000, autoContinue: true })
const project = {
  id: randomUUID(), name: 'Smoke', folder: work, envFiles: ['.env'], guidance: 'Keep replies to one short sentence.',
  permissionMode: 'default', model: '', createdAt: Date.now(), collapsed: false,
}
store.addProject(project)

const logs: string[] = []
const mgr = new SessionManager(store, join(data, 'handoffs'), (l: string) => logs.push(l))
const seen: string[] = []
mgr.on('state', () => {
  for (const s of mgr.views()) {
    const line = `${s.id.slice(0, 8)} gen${s.generation} ${s.status}${s.archived ? ' archived:' + s.archivedReason : ''} tok=${s.lastRequestTokens} pending=${s.pending.length}`
    if (seen.at(-1) !== line) seen.push(line)
    // Deny any permission prompt so the test can't hang.
    for (const p of s.pending) mgr.respond(s.id, p.requestId, p.kind === 'question' ? { kind: 'cancel' } : { kind: 'permission', decision: 'deny', message: 'smoke test' })
  }
})
mgr.on('handoff', (h: { from: string; to: string }) => seen.push(`HANDOFF ${h.from.slice(0, 8)} -> ${h.to.slice(0, 8)}`))

const first = mgr.createSession(project.id, 'Reply with exactly the word: pong. Also tell me which environment variable names you were told about.')

// Wait for the first turn, then hand off by hand (the growth rule stops an automatic one here).
while (!(store.session(first.id).status === 'idle' && store.session(first.id).lastRequestTokens > 0)) await new Promise(r => setTimeout(r, 500))
seen.push('MANUAL handoffNow')
mgr.handoffNow(first.id)

const deadline = Date.now() + 240_000
const done = () => {
  const s = store.sessions
  const succ = s.find((x: { generation: number }) => x.generation === 2)
  return succ && succ.status === 'idle' && succ.hasTranscript && (succ.lastRequestTokens > 0)
}
while (!done() && Date.now() < deadline) await new Promise(r => setTimeout(r, 1000))

console.log('--- state transitions')
console.log(seen.join('\n'))
for (const s of store.sessions) {
  console.log(`--- chat for ${s.id.slice(0, 8)} (gen ${s.generation}, "${s.title}")`)
  for (const i of await mgr.getChat(s.id)) console.log(`[${i.kind}] ${(('text' in i ? i.text : i.kind === 'tool' ? i.name + ' ' + i.summary : '') as string).slice(0, 300).replace(/\n/g, ' ⏎ ')}`)
}
console.log('--- rate limits', JSON.stringify(mgr.rateWindows()))
console.log('--- first session record', JSON.stringify(store.session(first.id)))
console.log('--- stderr/log lines', logs.length, logs.slice(-5).join('\n'))
mgr.stopAll()
store.flush()
const cascaded = store.sessions.some((x: { generation: number }) => x.generation > 2)
console.log(!done() ? 'SMOKE TIMEOUT' : cascaded ? 'SMOKE FAIL: the successor handed off again' : 'SMOKE OK')
process.exit(done() && !cascaded ? 0 : 1)

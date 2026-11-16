// End-to-end smoke test of SessionManager outside Electron, with real Claude calls (about six
// small requests): one turn in a throwaway project (with a photo attached), a manual handoff, and a
// check that the successor does not hand off again. The first session picks one add-on
// (sql-specialist), which the successor must inherit. Run: npm run smoke [-- <scratch dir>]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const root = new URL('../src/main/', import.meta.url).href
const { Store } = await import(root + 'store.ts')
const { SessionManager } = await import(root + 'sessions.ts')
const { AddonStore } = await import(root + 'addons.ts')

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
const mgr = new SessionManager(store, join(data, 'handoffs'), (l: string) => logs.push(l), new AddonStore(join(data, 'addons'), (l: string) => logs.push(l)))
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

// A 16x16 solid red PNG, to check that an attached image reaches Claude.
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4oKBAEmIY1TCqYfhqAABLfxAQeNDhBQAAAABJRU5ErkJggg=='
const first = mgr.createSession(
  project.id,
  'Reply with exactly the word: pong. Also tell me which environment variable names you were told about, and the color of the attached image in one word. Finally, answer yes or no: is an agent type named sql-specialist:sql-specialist available to you?',
  { addons: ['sql-specialist'] },
  [{ mediaType: 'image/png', data: RED_PNG }],
)

// Wait for the first turn, then hand off by hand (the growth rule stops an automatic one here).
while (!(store.session(first.id).status === 'idle' && store.session(first.id).lastRequestTokens > 0)) await new Promise(r => setTimeout(r, 500))

// Two prompts in quick succession: Claude Code might merge the second into the running turn, so it
// gets no result of its own. The session must still go idle (session_state_changed 'idle').
seen.push('TWO QUICK PROMPTS')
void mgr.send(first.id, 'Use the Glob tool to list *.env files here, then reply with one word: listed.')
// Send the second as soon as the Glob call shows up, while the turn is still running.
const toolBy = Date.now() + 60_000
while (!(await mgr.getChat(first.id)).some((i: { kind: string }) => i.kind === 'tool') && Date.now() < toolBy) await new Promise(r => setTimeout(r, 50))
void mgr.send(first.id, 'Also reply with the word: second.')
const idleBy = Date.now() + 120_000
await new Promise(r => setTimeout(r, 1000))
while (store.session(first.id).status !== 'idle' && Date.now() < idleBy) await new Promise(r => setTimeout(r, 500))
const settledAfterQuickPrompts = store.session(first.id).status === 'idle'
const merged = logs.some(l => l.includes('merged into earlier turns'))
console.log(`--- idle after two quick prompts: ${settledAfterQuickPrompts} (second prompt merged: ${merged})`)

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
// Handoffs must not pile up: the predecessor is archived, and only the successor stays visible.
const firstRec = store.session(first.id)
const visible = store.sessions.filter((x: { archived: boolean }) => !x.archived).length
const firstChat = await mgr.getChat(first.id)
const sawImage = firstChat.some((i: { kind: string; images?: string[] }) => i.kind === 'user' && i.images?.length === 1) &&
  firstChat.some((i: { kind: string; text?: string }) => i.kind === 'assistant' && /red/i.test(i.text ?? ''))
console.log(`--- image attached and described as red: ${sawImage}`)
const succRec = store.sessions.find((x: { generation: number }) => x.generation === 2)
const addonWarnings = [...firstChat, ...(succRec ? await mgr.getChat(succRec.id) : [])]
  .filter((i: { kind: string; text?: string }) => i.kind === 'notice' && /add-on|didn't load/i.test(i.text ?? '') && !/Downloading/.test(i.text ?? ''))
const sawAddon = firstChat.some((i: { kind: string; text?: string }) => i.kind === 'assistant' && /\byes\b/i.test(i.text ?? ''))
const addonOk = sawAddon && !addonWarnings.length && JSON.stringify(succRec?.addons) === JSON.stringify(['sql-specialist'])
console.log(`--- add-on: agent seen ${sawAddon}, warnings ${addonWarnings.length}, successor addons ${JSON.stringify(succRec?.addons)}`)
const piledUp = !(firstRec.archived && firstRec.archivedReason === 'handoff' && firstRec.successorId) || visible !== 1
console.log(`--- visible sessions after handoff: ${visible}, first archived: ${firstRec.archived} (${firstRec.archivedReason})`)
const verdict = !settledAfterQuickPrompts
  ? 'SMOKE FAIL: the session stayed busy after two quick prompts'
  : !done()
  ? 'SMOKE TIMEOUT'
  : cascaded
    ? 'SMOKE FAIL: the successor handed off again'
    : piledUp
      ? 'SMOKE FAIL: the handed-off session was not archived'
      : !sawImage
        ? 'SMOKE FAIL: the attached image did not reach Claude'
        : !addonOk
          ? 'SMOKE FAIL: the add-on did not load or was not inherited'
          : 'SMOKE OK'
console.log(verdict)
process.exit(verdict === 'SMOKE OK' ? 0 : 1)

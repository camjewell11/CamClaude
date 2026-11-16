import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseEnv } from './envfiles.ts'
import {
  isHandoffText,
  isOverLimit,
  isQuotaGuardStop,
  LoopTracker,
  pickHandoff,
  requestSize,
  successorTitle,
  toolResultTexts,
} from './guard.ts'
import { ChatLog, userContent } from './chatlog.ts'
import { groupToolRuns, toolNameSummary } from '../shared/toolGroups.ts'
import { ADDONS, ADDON_SOURCES, addonById, cleanAddonIds } from '../shared/addons.ts'
import { pluginDirName, pluginManifest, sourceDirName } from './addons.ts'
import { cleanModelChoices, modelLabel } from '../shared/models.ts'
import {
  addEntry,
  completeLines,
  emptySessionUsage,
  emptyTotals,
  parseUsageLine,
  priceFor,
  summarize,
  usageTotals,
  UsageLedger,
  weekStartDay,
} from './usage.ts'

test('parseEnv handles comments, export, quotes and multi-line values', () => {
  const env = parseEnv(
    [
      '# comment',
      'export A=1',
      'B = two words # trailing',
      'C="quoted # not a comment"',
      "D='single'",
      'E="line1\\nline2"',
      'F="multi',
      'line"',
      'not a line',
      'G=',
    ].join('\n'),
  )
  assert.deepEqual(env, {
    A: '1',
    B: 'two words',
    C: 'quoted # not a comment',
    D: 'single',
    E: 'line1\nline2',
    F: 'multi\nline',
    G: '',
  })
})

test('requestSize sums every input token', () => {
  assert.equal(requestSize({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }), 115)
  assert.equal(requestSize(undefined), 0)
})

test('LoopTracker refuses after N identical call/result pairs', () => {
  const t = new LoopTracker(3)
  for (let i = 0; i < 3; i++) {
    assert.equal(t.before('main', `id${i}`, 'Bash', { command: 'ls' }), undefined)
    t.after(`id${i}`, 'same output')
  }
  assert.match(t.before('main', 'id3', 'Bash', { command: 'ls' }) ?? '', /refused/)
  // A different result resets the count.
  const u = new LoopTracker(2)
  u.before('main', 'a', 'Bash', { command: 'ls' })
  u.after('a', 'one')
  u.before('main', 'b', 'Bash', { command: 'ls' })
  u.after('b', 'two')
  assert.equal(u.before('main', 'c', 'Bash', { command: 'ls' }), undefined)
  // Key order in the input does not matter.
  const v = new LoopTracker(1)
  v.before('main', 'x', 'Read', { a: 1, b: 2 })
  v.after('x', 'r')
  assert.ok(v.before('main', 'y', 'Read', { b: 2, a: 1 }))
})

test('isOverLimit needs both the size and real growth', () => {
  assert.equal(isOverLimit(160_000, 40_000, 150_000), true)
  assert.equal(isOverLimit(140_000, 40_000, 150_000), false)
  // A successor that starts big must grow before it can hand off again.
  assert.equal(isOverLimit(45_000, 41_000, 1_000), false)
  assert.equal(isOverLimit(72_000, 41_000, 1_000), true)
})

test('successorTitle numbers the chain', () => {
  assert.equal(successorTitle('Fix login', 2), 'Fix login · 2')
  assert.equal(successorTitle('Fix login · 2', 3), 'Fix login · 3')
})

test('ChatLog pairs tool results with their calls and hides internal lines', () => {
  const log = new ChatLog()
  log.apply('user', 'u1', { role: 'user', content: 'Please list files' })
  log.apply('assistant', 'a1', {
    content: [
      { type: 'text', text: 'Sure.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
    ],
  })
  log.apply('user', 'u2', { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false }] })
  log.apply('user', 'u3', { content: '<command-name>/clear</command-name>' })
  assert.deepEqual(
    log.items.map(i => i.kind),
    ['user', 'assistant', 'tool'],
  )
  const tool = log.items[2]
  assert.ok(tool.kind === 'tool' && tool.result === 'a.txt' && tool.summary === 'ls -la')
})

test("ChatLog files Claude Code's image note under the tool call that returned the image", () => {
  const log = new ChatLog()
  log.apply('assistant', 'a1', {
    content: [{ type: 'tool_use', id: 'toolu_img', name: 'Read', input: { file_path: 'C:\\shot.png' } }],
  })
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
  log.apply('user', 'u1', { content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [image] }] })
  const note = '[Image: original 1280x4427, displayed at 745x2576. Multiply coordinates by 1.72 to map to original image.]'
  log.apply('user', 'u2', { role: 'user', content: note })
  log.apply('user', 'u2', { role: 'user', content: note }) // a repeat must not add it twice
  assert.deepEqual(log.items.map(i => i.kind), ['tool'])
  const tool = log.items[0]
  assert.ok(tool.kind === 'tool' && tool.result === `[image]\n${note}`)

  // Ordinary text that mentions an image is still the person's message.
  log.apply('user', 'u3', { role: 'user', content: '[Image: my screenshot] what is wrong here?' })
  assert.equal(log.items.at(-1)?.kind, 'user')
})

test('userContent puts images before the text and rejects bad ones', () => {
  assert.equal(userContent('hi'), 'hi')
  const blocks = userContent('look', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }])
  assert.ok(Array.isArray(blocks))
  assert.deepEqual(blocks.map(b => b.type), ['image', 'text'])
  assert.throws(() => userContent('', [{ mediaType: 'image/heic' as 'image/png', data: 'AAAA' }]))
  assert.throws(() => userContent('', [{ mediaType: 'image/png', data: 'not base64!' }]))

  const log = new ChatLog()
  log.apply('user', 'u1', { role: 'user', content: userContent('', [{ mediaType: 'image/jpeg', data: 'AAAA' }]) })
  const item = log.items[0]
  assert.ok(item?.kind === 'user' && item.images?.[0] === 'data:image/jpeg;base64,AAAA')
})

// quota-guard's notices, built from parts so that reading this file doesn't stop a CamClaude
// session (isQuotaGuardStop used to match any tool result that quoted them).
const QG = 'quota-guard' + ': '
const HALT = QG + 'tool calls are ' + 'halted for the rest of this turn because the session is over its size limit.'
const DROP = 'Prompt dropped by a hook: ' + QG + 'this session ' + 're-sends 159k tokens with every request.'

test('pickHandoff skips hook notices and takes a reply with a Next step section', () => {
  const real = '## Task\n\nFix it.\n\n## Next step\n\nRun the tests.'
  assert.equal(isHandoffText(DROP), false)
  assert.equal(isHandoffText(real), true)
  assert.equal(isHandoffText('### Next steps\n1. Go'), true)
  assert.equal(isHandoffText('The next step is to run it.'), false)
  assert.equal(pickHandoff([DROP, real]), real)
  assert.equal(pickHandoff([DROP, '']), undefined)
})

test('isQuotaGuardStop spots a halt in tool results and a dropped prompt', () => {
  const content = [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: `<tool_use_error>${HALT}</tool_use_error>` }] },
    { type: 'text', text: HALT },
  ]
  assert.deepEqual(toolResultTexts(content), ['ok', `<tool_use_error>${HALT}</tool_use_error>`])
  assert.deepEqual(toolResultTexts(content, { errorsOnly: true }), [`<tool_use_error>${HALT}</tool_use_error>`])
  assert.deepEqual(toolResultTexts('a prompt'), [])
  assert.equal(toolResultTexts(content, { errorsOnly: true }).some(isQuotaGuardStop), true)
  assert.equal(isQuotaGuardStop(DROP), true)
  assert.equal(isQuotaGuardStop(QG + '87% of your five-hour limit is used.'), false)
  assert.equal(isQuotaGuardStop('Tests passed.'), false)
})

test('isQuotaGuardStop ignores files and output that only quote the notice', () => {
  // A Read of a doc that quotes the halt: a successful result, with the phrase mid-file.
  const read = `40\tSome notes.\n43\tquota-guard prints "${HALT}" when it halts.\n`
  const content = [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: read }] }]
  assert.deepEqual(toolResultTexts(content, { errorsOnly: true }), [])
  assert.equal(isQuotaGuardStop(read), false)
  // A failed command whose output quotes the phrase later on doesn't count either.
  assert.equal(isQuotaGuardStop(`Exit code 1\nsrc/a.ts:3: ${HALT}`), false)
  // An assistant reply that explains the notice mid-sentence isn't a dropped prompt.
  assert.equal(isQuotaGuardStop(`When the session is too big, quota-guard prints a notice like this one: ${DROP}`), false)
})

test('groupToolRuns folds adjacent tool calls and keeps lone ones as cards', () => {
  const tool = (id: string, name: string) => ({ kind: 'tool' as const, id, name, summary: '', input: {} })
  const text = (id: string) => ({ kind: 'assistant' as const, id, text: 'hi' })
  const out = groupToolRuns([tool('a', 'Bash'), tool('b', 'Bash'), tool('c', 'Read'), text('t'), tool('d', 'Edit')])
  assert.deepEqual(
    out.map(e => (e.kind === 'tools' ? `group:${e.id}:${e.tools.length}` : `item:${e.item.id}`)),
    ['group:a:3', 'item:t', 'item:d'],
  )
  const first = out[0]
  assert.ok(first.kind === 'tools')
  assert.equal(toolNameSummary(first.tools), 'Bash ×2, Read')
  assert.deepEqual(groupToolRuns([]), [])
})

test('cleanAddonIds keeps known ids once, in catalog order', () => {
  assert.deepEqual(cleanAddonIds(undefined), [])
  assert.deepEqual(cleanAddonIds([]), [])
  assert.deepEqual(
    cleanAddonIds(['taste-skill', 'nope', 'react-specialist', 42, 'taste-skill', null]),
    ['react-specialist', 'taste-skill'],
  )
})

test('add-on catalog ids are unique and every entry has a source', () => {
  const ids = ADDONS.map(a => a.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length, 14)
  for (const a of ADDONS) {
    assert.ok(ADDON_SOURCES[a.source], a.id)
    assert.match(a.id, /^[a-z0-9-]+$/)
    if (a.kind === 'agent') assert.match(a.path, /.md$/, a.id)
  }
})

test('pluginManifest and folder names carry the add-on id and pinned commit', () => {
  const def = addonById('code-reviewer')
  assert.ok(def)
  const commit8 = ADDON_SOURCES[def.source].commit.slice(0, 8)
  assert.equal(pluginDirName(def), `code-reviewer-${commit8}`)
  assert.equal(sourceDirName('fullstack-dev'), `fullstack-dev-${commit8}`)
  const manifest = JSON.parse(pluginManifest(def))
  assert.equal(manifest.name, 'code-reviewer')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.repository, 'https://github.com/runxgalee/fullstack-dev')
  assert.ok(manifest.description.includes(commit8))
})

test('modelLabel shortens model ids and aliases', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
  assert.equal(modelLabel('claude-fable-5-2'), 'Fable 5.2')
  assert.equal(modelLabel('claude-opus-4-20250514'), 'Opus 4')
  assert.equal(modelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5')
  assert.equal(modelLabel('sonnet'), 'Sonnet')
  assert.equal(modelLabel('opus[1m]'), 'Opus (1M)')
  assert.equal(modelLabel('claude-opus-5-5[1m]'), 'Opus 5.5 (1M)')
  assert.equal(modelLabel('some-other-model'), 'some-other-model')
  assert.equal(modelLabel(''), '')
  assert.equal(modelLabel(undefined), '')
  // A listed alias uses Claude Code's display name, without its note.
  const listed = [{ value: 'opus', displayName: 'Opus 5.5 (1M context)', description: '' }]
  assert.equal(modelLabel('opus', listed), 'Opus 5.5')
})

test('cleanModelChoices keeps well-formed rows only', () => {
  assert.deepEqual(cleanModelChoices(undefined), [])
  assert.deepEqual(
    cleanModelChoices([
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Fast', supportsEffort: true },
      { value: '' },
      null,
      { value: 'haiku' },
    ]),
    [
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Fast' },
      { value: 'haiku', displayName: 'haiku', description: '' },
    ],
  )
})

test('priceFor picks the specific version before its family', () => {
  assert.deepEqual(priceFor('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 })
  assert.deepEqual(priceFor('claude-opus-4-8'), { input: 5, output: 25, cacheRead: 0.5 })
  assert.deepEqual(priceFor('claude-opus-4-1-20250805'), { input: 15, output: 75, cacheRead: 1.5 })
  assert.deepEqual(priceFor('claude-sonnet-5-5'), { input: 2, output: 10, cacheRead: 0.1 })
  assert.deepEqual(priceFor('claude-sonnet-5'), { input: 2, output: 10, cacheRead: 0.2 })
  assert.deepEqual(priceFor('claude-fable-5-2'), { input: 8, output: 40, cacheRead: 0.2 })
  assert.deepEqual(priceFor('claude-haiku-5-5'), { input: 0.1, output: 0.5, cacheRead: 0.01 })
  assert.equal(priceFor('gpt-5'), undefined)
})

test('usageTotals prices cache writes by their lifetime', () => {
  const t = usageTotals('claude-opus-5-5', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 3_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 2_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  })
  // 4 + 20 + 0.2 + 2 × 4 × 1.25 + 1 × 4 × 2
  assert.equal(t.costUsd.toFixed(4), '42.2000')
  assert.equal(t.cacheWrite, 3_000_000)
  // Without a breakdown, every write counts as 5-minute.
  assert.equal(usageTotals('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000 }).costUsd, 5)
  assert.equal(usageTotals('unknown', { output_tokens: 10 }).costUsd, 0)
})

test('parseUsageLine reads assistant lines only', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-16T10:00:00.000Z',
    message: { id: 'msg_011Ch6m3ZeYk5WATuBApy98Q', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 7 } },
  })
  const e = parseUsageLine(line)
  assert.equal(e?.id, 'msg_011Ch6m3ZeYk5WATuBApy98Q')
  assert.equal(e?.at, Date.parse('2026-11-16T10:00:00.000Z'))
  assert.equal(e?.totals.output, 7)
  assert.equal(parseUsageLine(JSON.stringify({ type: 'user', message: { content: '"type":"assistant"' } })), undefined)
  assert.equal(parseUsageLine('{"type":"assistant", broken'), undefined)
  assert.equal(
    parseUsageLine(JSON.stringify({ type: 'assistant', message: { id: 'x', model: '<synthetic>', usage: {} } })),
    undefined,
  )
})

test('completeLines keeps a half-written last line for the next read', () => {
  const r = completeLines(Buffer.from('a\nb\npartial'))
  assert.deepEqual(r.lines, ['a', 'b'])
  assert.equal(r.used, 4)
  assert.deepEqual(completeLines(Buffer.from('no newline')), { lines: [], used: 0 })
  // A multi-byte character split across reads stays whole: the cut is always at a newline.
  const buf = Buffer.from('é\nü')
  assert.equal(buf.subarray(completeLines(buf).used).toString(), 'ü')
})

test('addEntry counts each message id once, including far-apart repeats', () => {
  const s = emptySessionUsage()
  const seen = new Set<string>()
  const at = new Date(2026, 10, 16, 12).getTime()
  const e = (id: string, output: number) => ({ id, at, totals: { ...emptyTotals(), output, costUsd: output } })
  assert.equal(addEntry(s, seen, e('msg_aaaaaaaaaaaaaaaaaaaaaaa1', 3)), true)
  assert.equal(addEntry(s, seen, e('msg_aaaaaaaaaaaaaaaaaaaaaaa2', 4)), true)
  assert.equal(addEntry(s, seen, e('msg_aaaaaaaaaaaaaaaaaaaaaaa1', 3)), false)
  assert.equal(s.total.output, 7)
  assert.equal(s.days['2026-11-16'].costUsd, 7)
  // The saved ids rebuild the set after a restart.
  assert.equal(addEntry(s, new Set(s.ids), e('msg_aaaaaaaaaaaaaaaaaaaaaaa2', 4)), false)
})

test('summarize splits the week and sums sessions into projects', () => {
  const now = new Date(2026, 10, 16, 12).getTime()
  const day = 86_400_000
  const s1 = emptySessionUsage()
  const s2 = emptySessionUsage()
  const seen = new Set<string>()
  addEntry(s1, seen, { id: 'old', at: now - 20 * day, totals: { ...emptyTotals(), costUsd: 10 } })
  addEntry(s1, seen, { id: 'new', at: now, totals: { ...emptyTotals(), costUsd: 1 } })
  addEntry(s2, new Set(), { id: 'other', at: now - day, totals: { ...emptyTotals(), costUsd: 2 } })
  const start = weekStartDay([], now)
  assert.equal(start, '2026-11-10')
  const sum = summarize({ a: s1, b: s2 }, [
    { id: 'a', projectId: 'p' },
    { id: 'b', projectId: 'p' },
    { id: 'c', projectId: 'q' },
  ], start, false)
  assert.equal(sum.sessions.a.total.costUsd, 11)
  assert.equal(sum.sessions.a.week.costUsd, 1)
  assert.equal(sum.projects.p.total.costUsd, 13)
  assert.equal(sum.projects.p.week.costUsd, 3)
  assert.equal(sum.projects.q.total.costUsd, 0)
  assert.equal(sum.all.week.costUsd, 3)
  // The weekly limit window, when known, sets the start.
  assert.equal(weekStartDay([{ kind: 'seven_day', percentUsed: 10, resetsAt: now + 2 * day }], now), '2026-11-11')
})

test('UsageLedger reads only new lines, finds subagents, and survives a restart', async () => {
  const { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'camclaude-usage-'))
  try {
    const projects = join(root, 'projects')
    const dir = join(projects, 'c--Work')
    mkdirSync(join(dir, 'sid', 'subagents'), { recursive: true })
    const line = (id: string, output: number) =>
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-16T10:00:00Z', message: { id, model: 'claude-opus-5-5', usage: { output_tokens: output } } }) + '\n'
    const main = join(dir, 'sid.jsonl')
    writeFileSync(main, line('msg_000000000001', 10) + line('msg_000000000001', 10) + '{"type":"user"}\n')
    writeFileSync(join(dir, 'sid', 'subagents', 'agent-a.jsonl'), line('msg_000000000002', 5))
    const file = join(root, 'usage.json')
    const ledger = new UsageLedger(file, projects)
    assert.equal(await ledger.scan('sid'), true)
    assert.equal(ledger.sessions.sid.total.output, 15)
    // A half-written line waits; once complete, it counts once.
    const half = line('msg_000000000003', 1)
    appendFileSync(main, half.slice(0, 20))
    assert.equal(await ledger.scan('sid'), false)
    appendFileSync(main, half.slice(20) + line('msg_000000000001', 10))
    assert.equal(await ledger.scan('sid'), true)
    assert.equal(ledger.sessions.sid.total.output, 16)
    ledger.save()
    ledger.flush()
    const again = new UsageLedger(file, projects)
    assert.equal(again.sessions.sid.total.output, 16)
    appendFileSync(main, line('msg_000000000004', 4))
    assert.equal(await again.scan('sid'), true)
    assert.equal(again.sessions.sid.total.output, 20)
    assert.equal(await again.scan('missing'), false)
    again.flush() // no write left pending after the folder is gone
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

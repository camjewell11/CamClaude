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

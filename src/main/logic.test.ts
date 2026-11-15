import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseEnv } from './envfiles.ts'
import { isOverLimit, LoopTracker, requestSize, successorTitle } from './guard.ts'
import { ChatLog } from './chatlog.ts'

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

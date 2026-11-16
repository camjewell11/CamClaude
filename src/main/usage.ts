// Token use and its API list-price cost, counted from Claude Code's transcripts.
//
// The SDK's result totals run per query() process, and a resumed session starts from the total
// its transcript saved, so adding results up counts tokens twice. Transcripts are the one source
// that covers both past sessions and live ones. Each assistant reply is written as several lines
// that share a message id, and some transcripts replay their whole history, so every session
// keeps the ids it has counted. That set lives here, in its own file, not in camclaude.json.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, open, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { RateWindow, UsageRow, UsageSummary, UsageTotals } from '../shared/types.ts'

// ---- prices ------------------------------------------------------------------------------------

/** USD per million tokens. Cache writes cost 1.25 × input (5-minute) or 2 × input (1-hour). */
export interface Price {
  input: number
  output: number
  cacheRead: number
}

const p = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead })

/** First match wins, so a specific version comes before its family's older rows. */
const PRICES: { match: RegExp; price: Price }[] = [
  { match: /(fable|mythos)-5-2/, price: p(8, 40, 0.2) },
  { match: /fable|mythos/, price: p(10, 50, 1) },
  { match: /opus-5-5/, price: p(4, 20, 0.2) },
  { match: /opus-(5|4-[5-9])/, price: p(5, 25, 0.5) },
  { match: /opus/, price: p(15, 75, 1.5) },
  { match: /sonnet-5-5/, price: p(2, 10, 0.1) },
  { match: /sonnet-5/, price: p(2, 10, 0.2) },
  { match: /sonnet/, price: p(3, 15, 0.3) },
  { match: /haiku-5-5/, price: p(0.1, 0.5, 0.01) },
  { match: /haiku-4-5/, price: p(1, 5, 0.1) },
  { match: /haiku/, price: p(0.8, 4, 0.08) },
]

/** The price row for a model id, or undefined for ids outside the known families. */
export function priceFor(model: string): Price | undefined {
  const id = model.toLowerCase()
  return PRICES.find(r => r.match.test(id))?.price
}

// ---- totals ------------------------------------------------------------------------------------

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 })

export function addTotals(into: UsageTotals, add: UsageTotals): UsageTotals {
  into.input += add.input
  into.output += add.output
  into.cacheRead += add.cacheRead
  into.cacheWrite += add.cacheWrite
  into.costUsd += add.costUsd
  return into
}

/** `message.usage` as Claude Code writes it in a transcript. */
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function usageTotals(model: string, u: RawUsage): UsageTotals {
  const input = n(u.input_tokens)
  const output = n(u.output_tokens)
  const cacheRead = n(u.cache_read_input_tokens)
  const cacheWrite = n(u.cache_creation_input_tokens)
  const hour = Math.min(cacheWrite, n(u.cache_creation?.ephemeral_1h_input_tokens))
  const fiveMin = cacheWrite - hour // without a breakdown, every write counts as 5-minute
  const price = priceFor(model)
  const costUsd = price
    ? (input * price.input + output * price.output + cacheRead * price.cacheRead + fiveMin * price.input * 1.25 + hour * price.input * 2) /
      1_000_000
    : 0
  return { input, output, cacheRead, cacheWrite, costUsd }
}

// ---- transcript lines --------------------------------------------------------------------------

export interface UsageEntry {
  /** Message id; several lines of one reply share it. */
  id: string
  /** ms since epoch; 0 when the line has no timestamp. */
  at: number
  totals: UsageTotals
}

/** The usage an assistant line carries, or undefined for any other line. */
export function parseUsageLine(line: string): UsageEntry | undefined {
  if (!line.includes('"type":"assistant"')) return undefined // skip JSON.parse for most lines
  let o: { type?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } }
  try {
    o = JSON.parse(line)
  } catch {
    return undefined
  }
  const m = o?.message
  if (o?.type !== 'assistant' || !m || typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') return undefined
  const model = typeof m.model === 'string' ? m.model : ''
  if (model === '<synthetic>') return undefined // Claude Code's own placeholder replies
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) || 0 : 0
  return { id: m.id, at, totals: usageTotals(model, m.usage as RawUsage) }
}

/** Local calendar day, YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const two = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/**
 * Splits a chunk of a file into complete lines. `used` is the byte count up to and including the
 * last newline; the rest is a line still being written and waits for the next read.
 */
export function completeLines(buf: Buffer): { lines: string[]; used: number } {
  const last = buf.lastIndexOf(10)
  if (last < 0) return { lines: [], used: 0 }
  return { lines: buf.toString('utf8', 0, last).split('\n'), used: last + 1 }
}

// ---- per-session ledger ------------------------------------------------------------------------

export interface SessionUsage {
  total: UsageTotals
  days: Record<string, UsageTotals>
  /** Transcript path → bytes already read. */
  files: Record<string, number>
  /** Keys of the message ids already counted (see `idKey`). */
  ids: string[]
}

export const emptySessionUsage = (): SessionUsage => ({ total: emptyTotals(), days: {}, files: {}, ids: [] })

/** Message ids end in 24 random characters; the last 12 are plenty within one session. */
export const idKey = (id: string) => id.slice(-12)

/** Counts an entry unless its message was counted already. Returns whether it counted. */
export function addEntry(s: SessionUsage, seen: Set<string>, e: UsageEntry, now = Date.now()): boolean {
  const key = idKey(e.id)
  if (seen.has(key)) return false
  seen.add(key)
  s.ids.push(key)
  addTotals(s.total, e.totals)
  const day = localDay(e.at || now)
  addTotals((s.days[day] ??= emptyTotals()), e.totals)
  return true
}

/** The first day counted as "this week": the weekly limit window's start, else 7 days back. */
export function weekStartDay(rateLimits: readonly RateWindow[], now = Date.now()): string {
  const weekly = rateLimits.find(w => w.kind === 'seven_day')
  const week = 7 * 86_400_000
  if (weekly?.resetsAt && weekly.resetsAt > now && weekly.resetsAt - now <= week) return localDay(weekly.resetsAt - week)
  return localDay(now - 6 * 86_400_000)
}

export function usageRow(s: SessionUsage | undefined, weekStart: string): UsageRow {
  const row = { total: emptyTotals(), week: emptyTotals() }
  if (!s) return row
  addTotals(row.total, s.total)
  for (const [day, t] of Object.entries(s.days)) if (day >= weekStart) addTotals(row.week, t)
  return row
}

function addRow(into: UsageRow, add: UsageRow): void {
  addTotals(into.total, add.total)
  addTotals(into.week, add.week)
}

/** Sums sessions into their projects and into one row for everything. */
export function summarize(
  ledger: Readonly<Record<string, SessionUsage>>,
  sessions: readonly { id: string; projectId: string }[],
  weekStart: string,
  scanning: boolean,
): UsageSummary {
  const out: UsageSummary = {
    projects: {},
    sessions: {},
    all: { total: emptyTotals(), week: emptyTotals() },
    weekStart,
    scanning,
  }
  for (const s of sessions) {
    const row = usageRow(ledger[s.id], weekStart)
    out.sessions[s.id] = row
    addRow((out.projects[s.projectId] ??= { total: emptyTotals(), week: emptyTotals() }), row)
    addRow(out.all, row)
  }
  return out
}

// ---- reading transcripts -----------------------------------------------------------------------

const CHUNK = 4 * 1024 * 1024

/** Reads a file from `offset`, calls `onLine` for each complete line, and returns the new offset. */
async function readNewLines(path: string, offset: number, onLine: (line: string) => void): Promise<number> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    // A shorter file was rewritten; read it again. Counted ids keep that from double counting.
    let pos = size < offset ? 0 : offset
    let carry = Buffer.alloc(0)
    const chunk = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - pos)))
    while (pos < size) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const { lines, used } = completeLines(buf)
      for (const line of lines) onLine(line)
      carry = Buffer.from(buf.subarray(used)) // a copy: `chunk` is reused
    }
    return pos - carry.length
  } finally {
    await fh.close()
  }
}

export const claudeProjectsDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

interface LedgerFile {
  version: 1
  sessions: Record<string, SessionUsage>
}

/** Keeps each session's counted usage in `file`, and reads only what transcripts added since. */
export class UsageLedger {
  private data: Record<string, SessionUsage> = {}
  private readonly seen = new Map<string, Set<string>>()
  /** Session id → the folder under `root` that holds its transcript. */
  private readonly dirs = new Map<string, string>()
  private indexedAt = 0
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly file: string
  private readonly root: string
  private readonly log: (line: string) => void
  scanning = false

  constructor(file: string, root: string, log: (line: string) => void = () => {}) {
    this.file = file
    this.root = root
    this.log = log
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerFile>
      if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') this.data = parsed.sessions
    } catch {
      // First run, or unreadable: rebuild from the transcripts.
    }
  }

  get sessions(): Readonly<Record<string, SessionUsage>> {
    return this.data
  }

  /** Drops sessions the app no longer has. */
  prune(keep: ReadonlySet<string>): void {
    let dropped = false
    for (const id of Object.keys(this.data)) {
      if (keep.has(id)) continue
      delete this.data[id]
      this.seen.delete(id)
      dropped = true
    }
    if (dropped) this.save()
  }

  /** Reads what the session's transcripts added since the last scan. Scans run one at a time. */
  scan(id: string): Promise<boolean> {
    const run = this.queue.then(() => this.scanNow(id))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Scans each session in turn; `onChange` runs after each one that counted something new. */
  async scanAll(ids: readonly string[], onChange: () => void): Promise<void> {
    this.scanning = true
    try {
      for (const id of ids) {
        try {
          if (await this.scan(id)) onChange()
        } catch (err) {
          this.log(`usage scan of ${id} failed: ${String(err)}`)
        }
      }
    } finally {
      this.scanning = false
      onChange()
    }
  }

  private async scanNow(id: string): Promise<boolean> {
    const dir = await this.findDir(id)
    if (!dir) return false
    const files = [join(dir, `${id}.jsonl`)]
    try {
      const sub = join(dir, id, 'subagents')
      for (const f of await readdir(sub)) if (f.endsWith('.jsonl')) files.push(join(sub, f))
    } catch {
      // No subagents.
    }
    const s = (this.data[id] ??= emptySessionUsage())
    let seen = this.seen.get(id)
    if (!seen) {
      seen = new Set(s.ids)
      this.seen.set(id, seen)
    }
    let counted = false
    for (const path of files) {
      const key = path.slice(this.root.length + 1) // relative, so the ledger survives a moved home folder
      const before = s.files[key] ?? 0
      let after: number
      try {
        after = await readNewLines(path, before, line => {
          const e = parseUsageLine(line)
          if (e && addEntry(s, seen, e)) counted = true
        })
      } catch {
        continue // gone, or locked for a moment; the next scan tries again
      }
      if (after !== before) {
        s.files[key] = after
        this.save()
      }
    }
    return counted
  }

  /** The folder holding `<id>.jsonl`. Folder names vary (C-- and c--), so this looks, not builds. */
  private async findDir(id: string): Promise<string | undefined> {
    const known = this.dirs.get(id)
    if (known) return known
    // A miss rebuilds the index, at most every 10 seconds; a new transcript appears after a turn.
    if (Date.now() - this.indexedAt < 10_000) return undefined
    this.indexedAt = Date.now()
    let names: string[] = []
    try {
      names = await readdir(this.root)
    } catch {
      return undefined
    }
    for (const name of names) {
      try {
        for (const f of await readdir(join(this.root, name))) {
          if (f.endsWith('.jsonl')) this.dirs.set(f.slice(0, -'.jsonl'.length), join(this.root, name))
        }
      } catch {
        // Not a folder.
      }
    }
    return this.dirs.get(id)
  }

  /** Writes soon; a scan's many updates become one write. */
  save(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.write()
    }, 2000)
  }

  private async write(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, sessions: this.data } satisfies LedgerFile))
      await rename(tmp, this.file)
    } catch (err) {
      this.log(`usage ledger write failed: ${String(err)}`)
    }
  }

  /** Writes now, synchronously, for app quit. */
  flush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, sessions: this.data } satisfies LedgerFile))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (err) {
      this.log(`usage ledger write failed: ${String(err)}`)
    }
  }
}

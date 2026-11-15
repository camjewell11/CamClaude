// Usage guards, ported from quota-guard (github.com/camjewell11/quota-guard), which adapted
// clauditor's guards (github.com/IyadhKhalfallah/clauditor, MIT). Here the app itself is the
// conductor, so crossing the size limit triggers a handoff instead of a block.

export interface UsageLike {
  input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** What a request re-sent: every input token, cached or not. */
export const requestSize = (u: UsageLike | undefined | null): number =>
  u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0

export const kTokens = (n: number) => `${Math.round(n / 1000)}k`

/**
 * How much a session must grow past its own first request before it may hand off. A fresh
 * session already re-sends ~40k tokens of system prompt and tool definitions, and a successor
 * starts with its handoff on top; without this, a low threshold would hand off every new
 * session straight away, in a loop.
 */
export const MIN_GROWTH = 30_000

export function isOverLimit(last: number, baseline: number, limit: number): boolean {
  return last >= limit && last - baseline >= MIN_GROWTH
}

/**
 * Refuses a tool call once the same call has returned the same result `limit` times in a row.
 * Tracks each loop (the main thread, or a subagent) separately.
 */
export class LoopTracker {
  private readonly tracks = new Map<string, { input: string; pair: string; count: number }>()
  private readonly inFlight = new Map<string, { loop: string; input: string }>()

  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  /** Returns a refusal message, or undefined to let the call run. */
  before(loop: string, toolUseId: string, toolName: string, input: unknown): string | undefined {
    if (this.limit <= 0) return undefined
    const key = fingerprint(toolName, input)
    const t = this.tracks.get(loop)
    if (t && t.input === key && t.count >= this.limit) {
      return (
        `CamClaude refused this ${toolName} call: the same call returned the same result ` +
        `${t.count} times in a row. Stop repeating it. Try a different approach, or tell the ` +
        `user what is blocking you.`
      )
    }
    this.inFlight.set(toolUseId, { loop, input: key })
    return undefined
  }

  after(toolUseId: string, response: unknown): void {
    const call = this.inFlight.get(toolUseId)
    if (!call) return
    this.inFlight.delete(toolUseId)
    const pair = `${call.input}\u0000${stableStringify(response)}`
    const t = this.tracks.get(call.loop)
    if (t && t.pair === pair) t.count += 1
    else this.tracks.set(call.loop, { input: call.input, pair, count: 1 })
  }

  /** A new prompt from the person starts every count over. */
  reset(): void {
    this.tracks.clear()
    this.inFlight.clear()
  }
}

const fingerprint = (toolName: string, input: unknown) => `${toolName}:${stableStringify(input)}`

function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v, (_k, val) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : val,
    )
  } catch {
    return String(v)
  }
}

/** Tools a session may still use while writing its handoff: reading only. */
export const HANDOFF_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])

export function handoffRequest(tokens: number): string {
  return [
    tokens > 0
      ? `[CamClaude] This session has reached its size limit: each request re-sends ${kTokens(tokens)} tokens.`
      : `[CamClaude] This session has reached a handoff point, at the user's request.`,
    `It will continue in a fresh session that starts from your handoff. Don't start new work and`,
    `don't edit files. You may use Read, Grep and Glob to check details.`,
    ``,
    `Reply with only the handoff document in Markdown, for a new session that knows nothing about`,
    `this conversation, with these sections:`,
    ``,
    `## Task — the goal, in the user's words where possible`,
    `## Done — what's finished, with file paths`,
    `## In progress — anything half-done: exact file paths and what state each is in`,
    `## Decisions and constraints — choices made, and what the user asked for or ruled out`,
    `## Next step — the very next concrete action`,
    ``,
    `Keep it under 700 words.`,
  ].join('\n')
}

/**
 * Whether a reply is a handoff: it has the "Next step" section that handoffRequest asks for. A
 * hook's notice (quota-guard drops prompts over its size limit) or a reply to another prompt
 * doesn't, and must not become a successor's starting point.
 */
export const isHandoffText = (text: string): boolean => /^#{1,4}\s*next\s+steps?\b/im.test(text)

/**
 * Whether text is quota-guard stopping the session for size: it halted tool calls for the rest of
 * the turn, or dropped a prompt. quota-guard loads in CamClaude sessions too, and its limit can be
 * lower than this app's handoff limit; without this, a halted session sits idle with no handoff.
 */
export const isQuotaGuardStop = (text: string): boolean =>
  /quota-guard: (tool calls are halted\b|this session re-sends \d+k tokens)/.test(text)

/** The text of every tool_result block in a user message's content. */
export function toolResultTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content as { type?: unknown; content?: unknown }[]) {
    if (block?.type !== 'tool_result') continue
    if (typeof block.content === 'string') out.push(block.content)
    else if (Array.isArray(block.content)) {
      for (const part of block.content as { type?: unknown; text?: unknown }[]) {
        if (part?.type === 'text' && typeof part.text === 'string') out.push(part.text)
      }
    }
  }
  return out
}

/** The first candidate that is a handoff. */
export const pickHandoff = (candidates: readonly string[]): string | undefined =>
  candidates.find(t => isHandoffText(t))

export function successorPrompt(handoff: string, predecessorTitle: string, handoffPath: string): string {
  return [
    `[CamClaude] You're continuing work from the session "${predecessorTitle}", which reached its`,
    `size limit. Its handoff follows (also saved at ${handoffPath}). Check the files it names before`,
    `changing anything, don't redo finished work, and carry on from "Next step".`,
    ``,
    `---`,
    ``,
    handoff.trim(),
  ].join('\n')
}

export const HARD_STOP_MESSAGE = (tokens: number) =>
  `CamClaude stopped this tool call: each request in this session now re-sends ${kTokens(tokens)} ` +
  `tokens, past the size limit. Don't call more tools. End your turn now with one or two ` +
  `sentences on where things stand; the app will write a handoff and continue in a fresh session.`

export const HANDOFF_TOOL_MESSAGE =
  'CamClaude: while writing the handoff only Read, Grep and Glob work. Reply with the handoff document.'

/** The successor's title: "Fix login" becomes "Fix login · 2", then "Fix login · 3". */
export function successorTitle(title: string, generation: number): string {
  const base = title.replace(/\s·\s\d+$/, '')
  return `${base} · ${generation}`
}

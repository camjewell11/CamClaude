// Turns Claude API messages (live from the SDK, or from a saved transcript) into chat items.

import type { ChatItem } from '../shared/types.ts'

type Block = { type: string; [k: string]: unknown }
type ApiMessage = { role?: string; content?: string | Block[] }

const HANDOFF_PREFIX = "[CamClaude] You're continuing"
const HANDOFF_REQUEST_PREFIX = '[CamClaude] This session has reached'

/** Lines Claude Code writes into transcripts for its own bookkeeping, not typed by anyone. */
const isInternalText = (t: string) =>
  /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|system-reminder)>/.test(t) ||
  t.startsWith('Caveat: The messages below were generated')

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const pick =
    str(i.command) ||
    str(i.file_path) ||
    str(i.notebook_path) ||
    str(i.pattern) ||
    str(i.url) ||
    str(i.query) ||
    str(i.description) ||
    str(i.prompt) ||
    str(Object.values(i).find(v => typeof v === 'string'))
  if (name === 'TodoWrite') return 'Update the task list'
  const oneLine = pick.replace(/\s+/g, ' ').trim()
  return oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => {
        const block = b as Block
        if (block.type === 'text') return str(block.text)
        if (block.type === 'image') return '[image]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

const MAX_RESULT = 20_000

export class ChatLog {
  readonly items: ChatItem[] = []
  private readonly index = new Map<string, number>()

  private upsert(item: ChatItem, changed: Map<string, ChatItem>) {
    const at = this.index.get(item.id)
    if (at === undefined) {
      this.index.set(item.id, this.items.length)
      this.items.push(item)
    } else {
      this.items[at] = item
    }
    changed.set(item.id, item)
  }

  get(id: string): ChatItem | undefined {
    const at = this.index.get(id)
    return at === undefined ? undefined : this.items[at]
  }

  add(item: ChatItem): ChatItem[] {
    const changed = new Map<string, ChatItem>()
    this.upsert(item, changed)
    return [...changed.values()]
  }

  /**
   * Applies one main-thread message. `uuid` makes item ids stable across a live view and a
   * later reload of the same transcript. Returns the items that changed.
   */
  apply(type: string, uuid: string, message: unknown): ChatItem[] {
    const changed = new Map<string, ChatItem>()
    const m = (message ?? {}) as ApiMessage
    const content = m.content

    if (type === 'assistant') {
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
      blocks.forEach((b, n) => {
        if (b.type === 'text' && str(b.text).trim()) {
          this.upsert({ kind: 'assistant', id: `${uuid}:${n}`, text: str(b.text) }, changed)
        } else if (b.type === 'tool_use') {
          const id = str(b.id) || `${uuid}:${n}`
          const prev = this.get(id)
          this.upsert(
            {
              kind: 'tool',
              id,
              name: str(b.name),
              summary: toolSummary(str(b.name), b.input),
              input: b.input,
              result: prev?.kind === 'tool' ? prev.result : undefined,
              isError: prev?.kind === 'tool' ? prev.isError : undefined,
            },
            changed,
          )
        }
      })
    } else if (type === 'user') {
      if (typeof content === 'string') {
        this.userText(uuid, content, changed)
      } else if (Array.isArray(content)) {
        const texts: string[] = []
        for (const b of content) {
          if (b.type === 'tool_result') {
            const id = str(b.tool_use_id)
            const prev = this.get(id)
            let text = resultText(b.content)
            if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters)`
            const base =
              prev?.kind === 'tool'
                ? prev
                : ({ kind: 'tool', id, name: 'Tool', summary: '', input: undefined } as const)
            this.upsert({ ...base, result: text, isError: b.is_error === true }, changed)
          } else if (b.type === 'text') {
            texts.push(str(b.text))
          }
        }
        if (texts.length) this.userText(uuid, texts.join('\n'), changed)
      }
    }
    return [...changed.values()]
  }

  private userText(uuid: string, text: string, changed: Map<string, ChatItem>) {
    if (!text.trim() || isInternalText(text)) return
    if (text.startsWith(HANDOFF_REQUEST_PREFIX)) {
      this.upsert({ kind: 'notice', id: uuid, tone: 'info', text: 'Size limit reached. Writing a handoff for a fresh session.' }, changed)
      return
    }
    this.upsert({ kind: 'user', id: uuid, text, isHandoff: text.startsWith(HANDOFF_PREFIX) }, changed)
  }
}

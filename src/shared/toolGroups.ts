// Folds runs of adjacent tool calls into one collapsible group for the chat view.
// Pure and type-only imports, so the main-process tests can run it under strip-types.

import type { ChatItem } from './types'

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>

export type ChatEntry =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'tools'; id: string; tools: ToolItem[] }

/**
 * Groups two or more consecutive tool calls. Any other item (user, assistant, notice) ends a run.
 * A group's id is its first call's id, so it keeps its open state while later calls join it.
 */
export function groupToolRuns(items: ChatItem[]): ChatEntry[] {
  const out: ChatEntry[] = []
  let run: ToolItem[] = []
  const flush = () => {
    if (run.length === 1) out.push({ kind: 'item', item: run[0] })
    else if (run.length > 1) out.push({ kind: 'tools', id: run[0].id, tools: run })
    run = []
  }
  for (const item of items) {
    if (item.kind === 'tool') run.push(item)
    else {
      flush()
      out.push({ kind: 'item', item })
    }
  }
  flush()
  return out
}

/** "Bash ×8, Read, Edit": tool names in first-seen order, with a count when one repeats. */
export function toolNameSummary(tools: ToolItem[]): string {
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
}

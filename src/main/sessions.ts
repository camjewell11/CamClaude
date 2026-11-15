// Runs Claude Code sessions through the Agent SDK. Each live session is one streaming query()
// (one Claude Code process). This class is the "conductor": it tracks status, answers
// permission prompts through the UI, applies the usage guards, and hands a session off to a
// fresh successor when it grows past the size limit.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  archiveSession as sdkArchiveSession,
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AskQuestion,
  ChatItem,
  ChatUpdate,
  KnownFolder,
  PendingRequest,
  PendingResponse,
  Project,
  RateWindow,
  SessionRecord,
  SessionStatus,
  SessionView,
} from '../shared/types.ts'
import { ChatLog, toolSummary } from './chatlog.ts'
import { claudeBinary } from './claudeBinary.ts'
import { loadEnvFiles } from './envfiles.ts'
import {
  HANDOFF_TOOL_MESSAGE,
  HANDOFF_TOOLS,
  HARD_STOP_MESSAGE,
  LoopTracker,
  handoffRequest,
  isOverLimit,
  kTokens,
  requestSize,
  successorPrompt,
  successorTitle,
} from './guard.ts'
import type { Store } from './store.ts'

const CLIENT_APP = 'camclaude/0.1.0'

/** The prompts an SDK consumer streams into a session, as an async iterable that stays open. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(m: SDKUserMessage): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: m, done: false })
    else this.items.push(m)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters) w({ value: undefined, done: true })
    this.waiters = []
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(r => this.waiters.push(r))
      },
    }
  }
}

type Phase = 'normal' | 'stopping' | 'writing-handoff'

interface Live {
  q: Query
  input: InputQueue
  pending: Map<string, { req: PendingRequest; resolve: (r: PendingResponse) => void }>
  loops: LoopTracker
  phase: Phase
  /** Prompts sent whose turn has not finished yet. */
  turnsQueued: number
  lastAssistantText: string
}

export interface Attention {
  sessionId: string
  kind: 'needs-input' | 'finished' | 'handoff' | 'error'
  title: string
  body: string
}

export interface SessionManagerEvents {
  state: []
  chat: [ChatUpdate]
  handoff: [{ from: string; to: string }]
  attention: [Attention]
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly live = new Map<string, Live>()
  private readonly chats = new Map<string, ChatLog>()
  private rateLimits = new Map<string, RateWindow>()
  private focused: { sessionId: string | null; windowFocused: boolean } = { sessionId: null, windowFocused: true }
  private stateTimer: NodeJS.Timeout | undefined
  private janitor: NodeJS.Timeout | undefined

  private readonly store: Store
  private readonly handoffDir: string
  private readonly log: (line: string) => void

  constructor(store: Store, handoffDir: string, log: (line: string) => void) {
    super()
    this.store = store
    this.handoffDir = handoffDir
    this.log = log
    for (const w of store.rateLimits) this.rateLimits.set(w.kind, w)
  }

  // ---- state for the UI -------------------------------------------------------------------

  views(): SessionView[] {
    return this.store.sessions.map(s => {
      const live = this.live.get(s.id)
      return { ...s, isLive: !!live, pending: live ? [...live.pending.values()].map(p => p.req) : [] }
    })
  }

  rateWindows(): RateWindow[] {
    return [...this.rateLimits.values()]
  }

  private saveRateLimits(): void {
    this.store.setRateLimits(this.rateWindows())
    this.changed()
  }

  /** Coalesces state pushes to the UI. */
  private changed(): void {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined
      this.emit('state')
    }, 50)
  }

  private patch(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const s = this.store.updateSession(id, patch)
    this.changed()
    return s
  }

  private setStatus(id: string, status: SessionStatus): void {
    const s = this.store.session(id)
    if (s && s.status !== status) this.patch(id, { status })
  }

  private isWatching(id: string): boolean {
    return this.focused.windowFocused && this.focused.sessionId === id
  }

  setFocus(sessionId: string | null, windowFocused: boolean): void {
    this.focused = { sessionId, windowFocused }
    if (sessionId && windowFocused) {
      const s = this.store.session(sessionId)
      if (s?.unread) this.patch(sessionId, { unread: false })
    }
  }

  // ---- chat ---------------------------------------------------------------------------------

  private chat(id: string): ChatLog {
    let log = this.chats.get(id)
    if (!log) {
      log = new ChatLog()
      this.chats.set(id, log)
    }
    return log
  }

  private emitChat(sessionId: string, items: ChatItem[]): void {
    if (items.length) this.emit('chat', { sessionId, items })
  }

  private notice(id: string, text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    this.emitChat(id, this.chat(id).add({ kind: 'notice', id: `notice:${randomUUID()}`, text, tone }))
  }

  /** The session's messages: live ones, or loaded from Claude Code's transcript the first time. */
  async getChat(id: string): Promise<ChatItem[]> {
    const existing = this.chats.get(id)
    if (existing) return existing.items
    const rec = this.store.session(id)
    const log = this.chat(id)
    if (rec?.hasTranscript) {
      const project = this.store.project(rec.projectId)
      try {
        const messages = await getSessionMessages(id, { dir: project?.folder })
        for (const m of messages) {
          if (m.parent_tool_use_id) continue
          log.apply(m.type, m.uuid, m.message)
        }
      } catch (err) {
        log.add({ kind: 'notice', id: 'load-error', tone: 'error', text: `Could not load this conversation: ${String(err)}` })
      }
    }
    return log.items
  }

  // ---- session lifecycle -------------------------------------------------------------------

  createSession(
    projectId: string,
    prompt?: string,
    extra: Partial<Pick<SessionRecord, 'title' | 'predecessorId' | 'generation' | 'draft'>> = {},
  ): SessionRecord {
    const project = this.store.project(projectId)
    if (!project) throw new Error('Unknown project')
    const now = Date.now()
    const rec: SessionRecord = {
      id: randomUUID(),
      projectId,
      title: extra.title ?? (prompt ? titleFrom(prompt) : 'New session'),
      createdAt: now,
      lastActivity: now,
      status: 'idle',
      unread: false,
      hasTranscript: false,
      archived: false,
      lastRequestTokens: 0,
      peakRequestTokens: 0,
      generation: extra.generation ?? 1,
      predecessorId: extra.predecessorId,
      draft: extra.draft,
    }
    this.store.addSession(rec)
    this.chats.set(rec.id, new ChatLog())
    this.changed()
    if (prompt) void this.send(rec.id, prompt)
    return rec
  }

  async send(id: string, text: string): Promise<void> {
    const rec = this.store.session(id)
    if (!rec) throw new Error('Unknown session')
    if (!text.trim()) return

    const patch: Partial<SessionRecord> = { lastActivity: Date.now(), unread: false, draft: undefined, error: undefined }
    if (rec.archived) Object.assign(patch, { archived: false, archivedReason: undefined })
    if (rec.title === 'New session') patch.title = titleFrom(text)
    this.patch(id, patch)

    await this.getChat(id) // load history first so the new message lands after it
    const uuid = randomUUID()
    this.emitChat(id, this.chat(id).apply('user', uuid, { role: 'user', content: text }))

    const live = await this.ensureLive(id)
    if (!live) return
    live.loops.reset()
    live.turnsQueued += 1
    this.setStatus(id, live.phase === 'writing-handoff' ? 'handing-off' : 'running')
    live.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage['uuid'],
    })
  }

  async interrupt(id: string): Promise<void> {
    const live = this.live.get(id)
    if (!live) return
    for (const p of live.pending.values()) p.resolve({ kind: 'cancel' })
    try {
      await live.q.interrupt()
    } catch (err) {
      this.log(`interrupt ${id}: ${String(err)}`)
    }
  }

  respond(id: string, requestId: string, response: PendingResponse): void {
    this.live.get(id)?.pending.get(requestId)?.resolve(response)
  }

  /** Ends the session's Claude Code process. The conversation stays and resumes on the next message. */
  stop(id: string): void {
    const live = this.live.get(id)
    if (!live) return
    this.live.delete(id)
    for (const p of live.pending.values()) p.resolve({ kind: 'cancel' })
    live.input.close()
    try {
      live.q.close()
    } catch {
      // Already gone.
    }
    const rec = this.store.session(id)
    if (rec && rec.status !== 'error') this.patch(id, { status: 'idle' })
    this.changed()
  }

  archive(id: string, reason: SessionRecord['archivedReason'] = 'manual'): void {
    this.stop(id)
    this.patch(id, { archived: true, archivedReason: reason, unread: false })
    const rec = this.store.session(id)
    const project = rec && this.store.project(rec.projectId)
    // Keep Claude Code's own session list tidy too (claude --resume, other apps).
    if (rec?.hasTranscript) {
      sdkArchiveSession(id, { dir: project?.folder }).catch(err => this.log(`sdk archive ${id}: ${String(err)}`))
    }
  }

  unarchive(id: string): void {
    this.patch(id, { archived: false, archivedReason: undefined, lastActivity: Date.now() })
  }

  rename(id: string, title: string): void {
    if (title.trim()) this.patch(id, { title: title.trim() })
  }

  /** Removes the session from the app. Claude Code's transcript stays on disk. */
  remove(id: string): void {
    this.stop(id)
    this.chats.delete(id)
    this.store.removeSession(id)
    this.changed()
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id)
    if (this.janitor) clearInterval(this.janitor)
  }

  // ---- starting a Claude Code process ------------------------------------------------------

  private async ensureLive(id: string): Promise<Live | undefined> {
    const existing = this.live.get(id)
    if (existing) return existing
    const rec = this.store.session(id)
    const project = rec && this.store.project(rec.projectId)
    if (!rec || !project) return undefined

    const env = await loadEnvFiles(project.folder, project.envFiles)
    if (env.missing.length) this.notice(id, `Couldn't read ${env.missing.join(', ')}; continuing without it.`, 'warn')

    const live: Live = {
      q: undefined as unknown as Query,
      input: new InputQueue(),
      pending: new Map(),
      loops: new LoopTracker(this.store.settings.loopRepeats),
      phase: 'normal',
      turnsQueued: 0,
      lastAssistantText: '',
    }

    const options: Options = {
      cwd: project.folder,
      ...(rec.hasTranscript ? { resume: rec.id } : { sessionId: rec.id }),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...env.vars, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
      // Loads ~/.claude settings, the project's .claude/settings*.json, and CLAUDE.md files.
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(project, Object.keys(env.vars)) },
      permissionMode: project.permissionMode,
      allowDangerouslySkipPermissions: project.permissionMode === 'bypassPermissions',
      model: project.model || undefined,
      pathToClaudeCodeExecutable: claudeBinary(this.store.settings.claudeExecutable),
      canUseTool: this.canUseTool(id, live),
      hooks: {
        PreToolUse: [{ hooks: [this.preToolUse(id, live)] }],
        PostToolUse: [{ hooks: [this.postToolUse(live)] }],
      },
      stderr: data => this.log(`[${id.slice(0, 8)}] ${data.trimEnd()}`),
    }

    live.q = query({ prompt: live.input, options })
    this.live.set(id, live)
    this.changed()
    void this.consume(id, live)
    return live
  }

  private async consume(id: string, live: Live): Promise<void> {
    try {
      for await (const msg of live.q) await this.onMessage(id, live, msg)
    } catch (err) {
      if (this.live.get(id) === live) {
        const text = String(err instanceof Error ? err.message : err)
        this.log(`session ${id} ended with error: ${text}`)
        this.patch(id, { status: 'error', error: text })
        this.notice(id, `Claude Code stopped: ${text}`, 'error')
        this.emit('attention', { sessionId: id, kind: 'error', title: this.titleOf(id), body: text })
      }
    } finally {
      if (this.live.get(id) === live) {
        this.live.delete(id)
        const rec = this.store.session(id)
        if (rec && rec.status !== 'error') this.patch(id, { status: 'idle' })
        this.changed()
      }
    }
  }

  private async onMessage(id: string, live: Live, msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          if (!this.store.session(id)?.hasTranscript) this.patch(id, { hasTranscript: true })
        } else if (msg.subtype === 'compact_boundary') {
          this.notice(id, 'Claude Code compacted the conversation.')
        } else if (msg.subtype === 'session_state_changed') {
          // A state the SDK reports; prompts this app holds open take precedence.
          if (live.pending.size === 0 && msg.state === 'running') {
            this.setStatus(id, live.phase === 'writing-handoff' ? 'handing-off' : 'running')
          }
        }
        return
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) return // subagent traffic: not shown, not counted
        const size = requestSize((msg.message as { usage?: Parameters<typeof requestSize>[0] }).usage)
        const rec = this.store.session(id)
        if (rec && size > 0 && size !== rec.lastRequestTokens) {
          this.patch(id, {
            lastRequestTokens: size,
            peakRequestTokens: Math.max(rec.peakRequestTokens, size),
            baselineTokens: rec.baselineTokens || size,
          })
        }
        const items = this.chat(id).apply('assistant', msg.uuid, msg.message)
        const text = items.filter(i => i.kind === 'assistant').map(i => (i as { text: string }).text)
        if (text.length) live.lastAssistantText = text.join('\n\n')
        this.emitChat(id, items)
        if (msg.error) this.notice(id, assistantErrorText(msg.error), 'error')
        return
      }
      case 'user': {
        if (msg.parent_tool_use_id) return
        // Tool results; the person's own prompts were added when sent (same uuid, so no duplicate).
        this.emitChat(id, this.chat(id).apply('user', msg.uuid ?? randomUUID(), msg.message))
        return
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        if (info.rateLimitType && typeof info.utilization === 'number') {
          this.rateLimits.set(info.rateLimitType, {
            kind: info.rateLimitType,
            percentUsed: info.utilization <= 1 ? info.utilization * 100 : info.utilization,
            resetsAt: info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : undefined,
            status: info.status,
          })
          this.saveRateLimits()
        }
        return
      }
      case 'result': {
        await this.onTurnEnd(id, live, msg)
        return
      }
      default:
        return
    }
  }

  private async onTurnEnd(id: string, live: Live, msg: Extract<SDKMessage, { type: 'result' }>): Promise<void> {
    live.turnsQueued = Math.max(0, live.turnsQueued - 1)
    const settings = this.store.settings
    const rec = this.store.session(id)
    if (!rec) return

    if (msg.subtype !== 'success') {
      const errors = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : ''
      this.notice(id, `The turn ended early (${msg.subtype.replace(/_/g, ' ')})${errors ? `: ${errors}` : ''}.`, 'error')
    }

    if (live.phase === 'writing-handoff') {
      const text = msg.subtype === 'success' && msg.result.trim() ? msg.result : live.lastAssistantText
      await this.completeHandoff(id, live, text)
      return
    }

    this.patch(id, { lastActivity: Date.now() })
    if (live.turnsQueued > 0) return // another prompt is already waiting its turn

    this.setStatus(id, 'idle')
    void this.refreshUsage(live)
    const overSize = isOverLimit(rec.lastRequestTokens, rec.baselineTokens ?? 0, settings.handoffTokens)
    if ((live.phase === 'stopping' || overSize) && !rec.archived) {
      this.startHandoff(id, live)
      return
    }
    if (!this.isWatching(id)) {
      this.patch(id, { unread: true })
      this.emit('attention', {
        sessionId: id,
        kind: 'finished',
        title: this.titleOf(id),
        body: firstLine(live.lastAssistantText) || 'Finished.',
      })
    }
  }

  // ---- plan usage --------------------------------------------------------------------------

  private usageCheckedAt = 0

  /**
   * Reads the plan's 5-hour and weekly windows, at most every two minutes. rate_limit_event
   * messages only arrive near a limit, so this is what keeps the sidebar bars current. The SDK
   * marks this call experimental; if it disappears, the bars fall back to those events.
   */
  private async refreshUsage(live: Live): Promise<void> {
    const now = Date.now()
    if (now - this.usageCheckedAt < 120_000) return
    this.usageCheckedAt = now
    type Win = { utilization: number | null; resets_at: string | null } | null | undefined
    type UsageFn = (o: { skipBehaviors: boolean }) => Promise<{ rate_limits?: Record<string, Win> | null }>
    const fn = (live.q as unknown as Record<string, UsageFn | undefined>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof fn !== 'function') return
    try {
      const r = await fn.call(live.q, { skipBehaviors: true })
      for (const [kind, w] of Object.entries(r.rate_limits ?? {})) {
        if (!w || typeof w.utilization !== 'number') continue
        this.rateLimits.set(kind, {
          kind,
          percentUsed: w.utilization,
          resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined,
        })
      }
      this.saveRateLimits()
    } catch (err) {
      this.log(`usage check failed: ${String(err)}`)
    }
  }

  // ---- handoff -----------------------------------------------------------------------------

  /** Asks the session for a handoff now, whatever its size. */
  handoffNow(id: string): void {
    const live = this.live.get(id)
    const rec = this.store.session(id)
    if (!rec || rec.archived) return
    if (live && (live.turnsQueued > 0 || live.pending.size > 0)) {
      live.phase = 'stopping' // hand off when the current turn ends
      this.notice(id, 'Will hand off when this turn ends.')
      return
    }
    void this.ensureLive(id).then(l => l && this.startHandoff(id, l))
  }

  private startHandoff(id: string, live: Live): void {
    const rec = this.store.session(id)
    if (!rec) return
    live.phase = 'writing-handoff'
    live.lastAssistantText = ''
    live.turnsQueued += 1
    this.setStatus(id, 'handing-off')
    const isOver = isOverLimit(rec.lastRequestTokens, rec.baselineTokens ?? 0, this.store.settings.handoffTokens)
    this.notice(
      id,
      isOver
        ? `Each request now re-sends ${kTokens(rec.lastRequestTokens)} tokens. Writing a handoff so a fresh session can continue.`
        : 'Writing a handoff so a fresh session can continue.',
    )
    live.input.push({
      type: 'user',
      message: { role: 'user', content: handoffRequest(isOver ? rec.lastRequestTokens : 0) },
      parent_tool_use_id: null,
    })
  }

  private async completeHandoff(id: string, live: Live, handoff: string): Promise<void> {
    const rec = this.store.session(id)
    const project = rec && this.store.project(rec.projectId)
    if (!rec || !project) return
    live.phase = 'normal'

    if (!handoff.trim()) {
      this.patch(id, { status: 'error', error: 'The handoff came back empty.' })
      this.notice(id, 'The handoff came back empty. Send a message to retry, or use Hand off now.', 'error')
      return
    }

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
    const dir = join(this.handoffDir, slug(project.name))
    const path = join(dir, `${stamp}-${id.slice(0, 8)}.md`)
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path, `<!-- ${project.name} · ${rec.title} · session ${id} -->\n\n${handoff.trim()}\n`)
    } catch (err) {
      this.log(`handoff write failed: ${String(err)}`)
    }

    const prompt = successorPrompt(handoff, rec.title, path)
    const auto = this.store.settings.autoContinue
    const successor = this.createSession(project.id, auto ? prompt : undefined, {
      title: successorTitle(rec.title, rec.generation + 1),
      predecessorId: id,
      generation: rec.generation + 1,
      draft: auto ? undefined : prompt,
    })
    this.notice(id, `Handed off to “${successor.title}”. This session is archived.`)
    this.patch(id, { successorId: successor.id, status: 'idle' })
    this.archive(id, 'handoff')
    this.emit('handoff', { from: id, to: successor.id })
    this.emit('attention', {
      sessionId: successor.id,
      kind: 'handoff',
      title: successor.title,
      body: auto ? 'Continuing in a fresh session.' : 'Handoff ready. Review it and press Send to continue.',
    })
  }

  // ---- permissions and guards --------------------------------------------------------------

  private waitFor(id: string, live: Live, req: PendingRequest, signal: AbortSignal): Promise<PendingResponse> {
    return new Promise(resolve => {
      const done = (r: PendingResponse) => {
        if (!live.pending.delete(req.requestId)) return
        signal.removeEventListener('abort', onAbort)
        if (live.pending.size === 0) {
          this.setStatus(id, live.phase === 'writing-handoff' ? 'handing-off' : 'running')
        }
        this.changed()
        resolve(r)
      }
      const onAbort = () => done({ kind: 'cancel' })
      signal.addEventListener('abort', onAbort)
      live.pending.set(req.requestId, { req, resolve: done })
      this.setStatus(id, 'needs-input')
      if (!this.isWatching(id)) this.patch(id, { unread: true })
      this.emit('attention', {
        sessionId: id,
        kind: 'needs-input',
        title: this.titleOf(id),
        body: req.kind === 'question' ? req.questions[0]?.question ?? 'Claude has a question.' : req.title,
      })
      this.changed()
    })
  }

  private canUseTool(id: string, live: Live): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      if (live.phase === 'writing-handoff' && HANDOFF_TOOLS.has(toolName)) {
        return { behavior: 'allow', updatedInput: input }
      }
      const requestId = randomUUID()

      if (toolName === 'AskUserQuestion') {
        const questions = ((input as { questions?: AskQuestion[] }).questions ?? []).map(q => ({
          question: q.question,
          header: q.header,
          multiSelect: !!q.multiSelect,
          options: q.options ?? [],
        }))
        const r = await this.waitFor(id, live, { kind: 'question', requestId, questions }, opts.signal)
        if (r.kind !== 'question') return { behavior: 'deny', message: 'The user dismissed the question.', interrupt: true }
        return { behavior: 'allow', updatedInput: { ...input, answers: r.answers } }
      }

      const req: PendingRequest = {
        kind: 'permission',
        requestId,
        toolName,
        title: opts.title ?? `Claude wants to use ${toolName}`,
        detail: permissionDetail(toolName, input),
        canAlwaysAllow: !!opts.suggestions?.length,
      }
      const r = await this.waitFor(id, live, req, opts.signal)
      if (r.kind === 'permission' && r.decision === 'allow') return { behavior: 'allow', updatedInput: input }
      if (r.kind === 'permission' && r.decision === 'always') {
        return { behavior: 'allow', updatedInput: input, updatedPermissions: opts.suggestions }
      }
      if (r.kind === 'permission') {
        return { behavior: 'deny', message: r.message?.trim() || 'The user declined this tool call.' }
      }
      return { behavior: 'deny', message: 'The user stopped this request.', interrupt: true }
    }
  }

  private preToolUse(id: string, live: Live): HookCallback {
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
    })
    return async input => {
      if (input.hook_event_name !== 'PreToolUse') return {}
      const isMain = !input.agent_id
      const rec = this.store.session(id)

      if (live.phase === 'writing-handoff') {
        return HANDOFF_TOOLS.has(input.tool_name) ? {} : deny(HANDOFF_TOOL_MESSAGE)
      }
      if (
        isMain &&
        rec &&
        live.phase === 'normal' &&
        isOverLimit(rec.lastRequestTokens, rec.baselineTokens ?? 0, this.store.settings.hardStopTokens)
      ) {
        live.phase = 'stopping'
        this.notice(id, `Past ${kTokens(this.store.settings.hardStopTokens)} tokens per request. Ending this turn so the session can hand off.`, 'warn')
      }
      if (isMain && live.phase === 'stopping') return deny(HARD_STOP_MESSAGE(rec?.lastRequestTokens ?? 0))

      const refusal = live.loops.before(input.agent_id ?? 'main', input.tool_use_id, input.tool_name, input.tool_input)
      if (refusal) {
        this.notice(id, `Refused a repeated ${input.tool_name} call.`, 'warn')
        return deny(refusal)
      }
      return {}
    }
  }

  private postToolUse(live: Live): HookCallback {
    return async input => {
      if (input.hook_event_name === 'PostToolUse') live.loops.after(input.tool_use_id, input.tool_response)
      return {}
    }
  }

  // ---- housekeeping ------------------------------------------------------------------------

  /** Every minute: stop idle processes, and archive sessions inactive past the limit. */
  startJanitor(): void {
    const sweep = () => {
      const now = Date.now()
      const { idleProcessMinutes, archiveAfterHours } = this.store.settings
      for (const [id, live] of this.live) {
        const rec = this.store.session(id)
        const isBusy = live.turnsQueued > 0 || live.pending.size > 0 || live.phase !== 'normal'
        if (!isBusy && rec && idleProcessMinutes > 0 && now - rec.lastActivity > idleProcessMinutes * 60_000) {
          this.log(`stopping idle process for ${id}`)
          this.stop(id)
        }
      }
      if (archiveAfterHours > 0) {
        for (const rec of this.store.sessions) {
          if (rec.archived || this.live.has(rec.id) || rec.status === 'needs-input') continue
          if (now - rec.lastActivity > archiveAfterHours * 3_600_000) this.archive(rec.id, 'inactive')
        }
      }
    }
    sweep()
    this.janitor = setInterval(sweep, 60_000)
  }

  // ---- Claude Code history -----------------------------------------------------------------

  /** Folders that already have Claude Code sessions, for the new-project picker. */
  async knownFolders(): Promise<KnownFolder[]> {
    try {
      const all = await listSessions()
      const byFolder = new Map<string, KnownFolder>()
      for (const s of all) {
        if (!s.cwd) continue
        const k = byFolder.get(s.cwd) ?? { folder: s.cwd, sessions: 0, lastModified: 0 }
        k.sessions += 1
        k.lastModified = Math.max(k.lastModified, s.lastModified)
        byFolder.set(s.cwd, k)
      }
      return [...byFolder.values()].sort((a, b) => b.lastModified - a.lastModified)
    } catch (err) {
      this.log(`listSessions failed: ${String(err)}`)
      return []
    }
  }

  /** Adds the project folder's recent, unarchived Claude Code sessions to the app. */
  async importRecent(project: Project, withinHours = 72, max = 10): Promise<number> {
    try {
      const known = new Set(this.store.sessions.map(s => s.id))
      const cutoff = Date.now() - withinHours * 3_600_000
      const found = (await listSessions({ dir: project.folder }))
        .filter(s => !s.archived && s.lastModified >= cutoff && !known.has(s.sessionId))
        .sort((a, b) => b.lastModified - a.lastModified)
        .slice(0, max)
      for (const s of found) {
        this.store.addSession({
          id: s.sessionId,
          projectId: project.id,
          title: titleFrom(s.customTitle || s.summary || s.firstPrompt || 'Imported session'),
          createdAt: s.createdAt ?? s.lastModified,
          lastActivity: s.lastModified,
          status: 'idle',
          unread: false,
          hasTranscript: true,
          archived: false,
          lastRequestTokens: 0,
          peakRequestTokens: 0,
          generation: 1,
        })
      }
      this.changed()
      return found.length
    } catch (err) {
      this.log(`import failed: ${String(err)}`)
      return 0
    }
  }

  private titleOf(id: string): string {
    return this.store.session(id)?.title ?? 'Session'
  }
}

// ---- helpers -------------------------------------------------------------------------------

function titleFrom(text: string): string {
  const line = text.replace(/^\[CamClaude\][^\n]*\n?/, '').split(/\r?\n/).find(l => l.trim()) ?? text
  const t = line.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || 'New session'
}

const firstLine = (text: string) => {
  const l = text.split(/\r?\n/).find(x => x.trim())?.trim() ?? ''
  return l.length > 120 ? `${l.slice(0, 119)}…` : l
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'

function systemAppend(project: Project, envNames: string[]): string {
  const parts: string[] = []
  if (project.guidance.trim()) {
    parts.push(`# Project guidance (${project.name})\n\n${project.guidance.trim()}`)
  }
  if (envNames.length) {
    parts.push(
      `# Environment\n\nThese environment variables are set for this session from the project's .env ` +
        `files: ${envNames.join(', ')}. Use them by reference (for example $NAME in a shell command). ` +
        `Never print, echo, log, or write their values.`,
    )
  }
  return parts.join('\n\n')
}

function permissionDetail(toolName: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command
  const path = String(input.file_path ?? '')
  const clip = (s: unknown, lines = 30) => {
    const all = String(s ?? '').split(/\r?\n/)
    return all.slice(0, lines).join('\n') + (all.length > lines ? `\n… ${all.length - lines} more lines` : '')
  }
  if (toolName === 'Write') return `${path}\n\n${clip(input.content)}`
  if (toolName === 'Edit') {
    const mark = (s: unknown, sign: string) => clip(s, 15).split('\n').map(l => `${sign} ${l}`).join('\n')
    return `${path}\n\n${mark(input.old_string, '-')}\n${mark(input.new_string, '+')}`
  }
  if (toolName === 'MultiEdit' || toolName === 'NotebookEdit') return path
  const summary = toolSummary(toolName, input)
  if (summary) return summary
  const json = JSON.stringify(input, null, 2)
  return json.length > 1500 ? `${json.slice(0, 1500)}…` : json
}

function assistantErrorText(code: string): string {
  switch (code) {
    case 'authentication_failed':
      return 'Claude Code is not signed in. Run `claude` in a terminal and sign in, then try again.'
    case 'rate_limit':
      return 'Usage limit reached. Wait for the limit to reset, then try again.'
    case 'overloaded':
      return 'Claude is overloaded right now. Try again shortly.'
    case 'max_output_tokens':
      return 'The reply hit the output length limit.'
    default:
      return `Claude reported an error: ${code.replace(/_/g, ' ')}.`
  }
}

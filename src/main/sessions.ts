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
  ImageAttachment,
  KnownFolder,
  PendingRequest,
  PendingResponse,
  Project,
  RateWindow,
  SessionRecord,
  SessionStatus,
  SessionView,
} from '../shared/types.ts'
import { ChatLog, toolSummary, userContent } from './chatlog.ts'
import { claudeBinary } from './claudeBinary.ts'
import { loadEnvFiles } from './envfiles.ts'
import {
  HANDOFF_TOOL_MESSAGE,
  HANDOFF_TOOLS,
  HARD_STOP_MESSAGE,
  type StopReason,
  LoopTracker,
  handoffRequest,
  pickHandoff,
  isOverLimit,
  isQuotaGuardStop,
  kTokens,
  requestSize,
  successorPrompt,
  successorTitle,
  toolResultTexts,
} from './guard.ts'
import type { Store } from './store.ts'
import type { AddonStore } from './addons.ts'
import { addonById, cleanAddonIds } from '../shared/addons.ts'
import { cleanModelChoices, type ModelChoice } from '../shared/models.ts'
import { effectivePermissionMode } from '../shared/permissions.ts'
import { cleanEffort, type EffortLevel } from '../shared/effort.ts'

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
  /** Why phase is 'stopping'; read only in that phase. */
  stopReason?: StopReason
  /** Prompts sent whose turn has not finished yet. */
  turnsQueued: number
  lastAssistantText: string
  /** The SDK's own view of the session, from session_state_changed. */
  sdkState?: 'idle' | 'running' | 'requires_action'
  /** When this app last pushed a prompt, so a stale 'idle' doesn't settle it. */
  lastPushAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  /** Handoff requests sent since the last completed handoff. */
  handoffAttempts: number
}

/** How long 'idle' must hold before prompts without a result count as finished. */
const IDLE_SETTLE_MS = 1500

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
  /** A turn ended, so the session's transcript has new replies to count. */
  turnEnd: [string]
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly live = new Map<string, Live>()
  private readonly chats = new Map<string, ChatLog>()
  private rateLimits = new Map<string, RateWindow>()
  /** Per viewer (the desktop window, each phone): the session it shows while on screen. */
  private readonly watchers = new Map<string, string>()
  private stateTimer: NodeJS.Timeout | undefined
  private janitor: NodeJS.Timeout | undefined

  private readonly store: Store
  private readonly handoffDir: string
  private readonly log: (line: string) => void
  private readonly addons?: AddonStore

  constructor(store: Store, handoffDir: string, log: (line: string) => void, addons?: AddonStore) {
    super()
    this.store = store
    this.handoffDir = handoffDir
    this.log = log
    this.addons = addons
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
    for (const watched of this.watchers.values()) if (watched === id) return true
    return false
  }

  /** `sessionId` is what this viewer shows on screen, or null when it's hidden or elsewhere. */
  setFocus(viewer: string, sessionId: string | null): void {
    if (!sessionId) {
      this.watchers.delete(viewer)
      return
    }
    this.watchers.set(viewer, sessionId)
    const s = this.store.session(sessionId)
    if (s?.unread) this.patch(sessionId, { unread: false })
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
    extra: Partial<Pick<SessionRecord, 'title' | 'predecessorId' | 'generation' | 'draft' | 'addons' | 'model' | 'effort'>> = {},
    images: readonly ImageAttachment[] = [],
  ): SessionRecord {
    userContent(prompt ?? '', images) // reject a bad image before the session exists
    const project = this.store.project(projectId)
    if (!project) throw new Error('Unknown project')
    const now = Date.now()
    const addons = cleanAddonIds(extra.addons)
    const model = typeof extra.model === 'string' ? extra.model.trim() : ''
    const effort = cleanEffort(extra.effort)
    const rec: SessionRecord = {
      id: randomUUID(),
      projectId,
      title: extra.title ?? (prompt?.trim() ? titleFrom(prompt) : images.length ? 'Photo' : 'New session'),
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
      ...(addons.length ? { addons } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }
    this.store.addSession(rec)
    this.chats.set(rec.id, new ChatLog())
    this.changed()
    if (prompt?.trim() || images.length) void this.send(rec.id, prompt ?? '', images)
    return rec
  }

  async send(id: string, text: string, images: readonly ImageAttachment[] = []): Promise<void> {
    const rec = this.store.session(id)
    if (!rec) throw new Error('Unknown session')
    if (!text.trim() && !images.length) return
    const content = userContent(text, images)

    const patch: Partial<SessionRecord> = { lastActivity: Date.now(), unread: false, draft: undefined, error: undefined }
    if (rec.archived) Object.assign(patch, { archived: false, archivedReason: undefined })
    if (rec.title === 'New session' && text.trim()) patch.title = titleFrom(text)
    this.patch(id, patch)

    await this.getChat(id) // load history first so the new message lands after it
    const uuid = randomUUID()
    this.emitChat(id, this.chat(id).apply('user', uuid, { role: 'user', content }))

    const live = await this.ensureLive(id)
    if (!live) return
    live.loops.reset()
    live.turnsQueued += 1
    live.lastPushAt = Date.now()
    this.setStatus(id, live.phase === 'writing-handoff' ? 'handing-off' : 'running')
    live.input.push({
      type: 'user',
      message: { role: 'user', content: content as SDKUserMessage['message']['content'] },
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

  /**
   * Picks the session's model; '' goes back to the project's model. A running Claude Code process
   * switches from its next request on; otherwise the choice applies when the session next starts.
   */
  async setModel(id: string, model: string): Promise<void> {
    const rec = this.store.session(id)
    const project = rec && this.store.project(rec.projectId)
    if (!rec || !project) throw new Error('Unknown session')
    const chosen = model.trim()
    const effective = chosen || project.model || undefined
    const live = this.live.get(id)
    if (live) await live.q.setModel(effective)
    // The resolved id, when the list knows it, so the header changes before the next reply.
    const row = effective ? this.store.models.find(m => m.value === effective) : undefined
    this.patch(id, { model: chosen || undefined, activeModel: row?.resolvedModel ?? effective })
  }

  /**
   * Picks the session's effort level; undefined goes back to Claude Code's default. A running
   * process switches from its next request on; otherwise the level applies when the session starts.
   */
  async setEffort(id: string, effort: EffortLevel | undefined): Promise<void> {
    const rec = this.store.session(id)
    if (!rec) throw new Error('Unknown session')
    const live = this.live.get(id)
    // null clears the session's level, so Claude Code falls back to the model's default.
    if (live) await live.q.applyFlagSettings({ effortLevel: effort ?? null })
    this.patch(id, { effort })
  }

  models(): ModelChoice[] {
    return this.store.models
  }

  private modelsChecked = false

  /** Asks Claude Code once per app run which models it offers, for the model picker. */
  private async refreshModels(live: Live): Promise<void> {
    if (this.modelsChecked) return
    this.modelsChecked = true
    try {
      const rows = cleanModelChoices(await live.q.supportedModels())
      if (rows.length) {
        this.store.setModels(rows)
        this.changed()
      }
    } catch (err) {
      this.modelsChecked = false
      this.log(`model list failed: ${String(err)}`)
    }
  }

  /** Records the model Claude Code reports, which can differ from the one asked for (a fallback). */
  private noteModel(id: string, model: unknown): void {
    if (typeof model !== 'string' || !model || model.startsWith('<')) return // '<synthetic>' replies
    if (this.store.session(id)?.activeModel !== model) this.patch(id, { activeModel: model })
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

  /** Plugin folders for the session's add-ons. A failure is a notice; the session starts without it. */
  private async addonPlugins(id: string, ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return []
    if (!this.addons) {
      this.notice(id, 'Add-ons are unavailable here; starting without them.', 'warn')
      return []
    }
    if (this.addons.needsDownload(ids)) this.notice(id, 'Downloading add-ons for their first use…')
    const { paths, errors } = await this.addons.prepare(ids)
    if (errors.length) this.notice(id, `Couldn't load some add-ons; continuing without them. ${errors.join('; ')}`, 'warn')
    return paths
  }

  /** Warns when Claude Code didn't load an add-on the session asked for. */
  private checkAddonsLoaded(
    id: string,
    plugins: readonly { name: string }[],
    errors: readonly { plugin: string; message: string }[],
  ): void {
    const wanted = this.store.session(id)?.addons ?? []
    if (!wanted.length) return
    const loaded = new Set(plugins.map(p => p.name))
    const missing = wanted.filter(a => !loaded.has(a)).map(a => addonById(a)?.label ?? a)
    const own = errors.filter(e => wanted.includes(e.plugin)).map(e => `${e.plugin}: ${e.message}`)
    if (missing.length || own.length) {
      this.notice(id, `Claude Code didn't load ${missing.join(', ') || 'every add-on'}.${own.length ? ` ${own.join('; ')}` : ''}`, 'warn')
    }
  }

  private async ensureLive(id: string): Promise<Live | undefined> {
    const existing = this.live.get(id)
    if (existing) return existing
    const rec = this.store.session(id)
    const project = rec && this.store.project(rec.projectId)
    if (!rec || !project) return undefined

    const env = await loadEnvFiles(project.folder, project.envFiles)
    if (env.missing.length) this.notice(id, `Couldn't read ${env.missing.join(', ')}; continuing without it.`, 'warn')
    const plugins = await this.addonPlugins(id, rec.addons ?? [])
    const mode = effectivePermissionMode(project.permissionMode, this.store.settings.allowBypassPermissions)
    if (mode !== project.permissionMode) {
      this.notice(id, 'Bypass permissions mode is off in Settings, so this session asks before edits and commands.', 'warn')
    }

    const live: Live = {
      q: undefined as unknown as Query,
      input: new InputQueue(),
      pending: new Map(),
      loops: new LoopTracker(this.store.settings.loopRepeats),
      phase: 'normal',
      turnsQueued: 0,
      lastAssistantText: '',
      lastPushAt: 0,
      handoffAttempts: 0,
    }

    const options: Options = {
      cwd: project.folder,
      ...(rec.hasTranscript ? { resume: rec.id } : { sessionId: rec.id }),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        ...env.vars,
        CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
        // session_state_changed messages, which tell this app when a turn is really over.
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      },
      // Loads ~/.claude settings, the project's .claude/settings*.json, and CLAUDE.md files.
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(project, Object.keys(env.vars)) },
      permissionMode: mode,
      allowDangerouslySkipPermissions: mode === 'bypassPermissions',
      model: rec.model || project.model || undefined,
      ...(rec.effort ? { effort: rec.effort } : {}),
      // Only the add-ons this session opted in to; the user's own plugins load from settings as usual.
      ...(plugins.length ? { plugins: plugins.map(path => ({ type: 'local' as const, path })) } : {}),
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
          this.checkAddonsLoaded(id, msg.plugins ?? [], msg.plugin_errors ?? [])
          this.noteModel(id, msg.model)
          void this.refreshModels(live)
        } else if (msg.subtype === 'compact_boundary') {
          this.notice(id, 'Claude Code compacted the conversation.')
        } else if (msg.subtype === 'session_state_changed') {
          live.sdkState = msg.state
          // A state the SDK reports; prompts this app holds open take precedence.
          if (live.pending.size === 0 && msg.state === 'running') {
            this.setStatus(id, live.phase === 'writing-handoff' ? 'handing-off' : 'running')
          }
          if (msg.state === 'idle') this.checkIdle(id, live)
        }
        return
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) return // subagent traffic: not shown, not counted
        const size = requestSize((msg.message as { usage?: Parameters<typeof requestSize>[0] }).usage)
        this.noteModel(id, (msg.message as { model?: unknown }).model)
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
        if (toolResultTexts(msg.message.content, { errorsOnly: true }).some(isQuotaGuardStop)) this.onQuotaGuardStop(id, live)
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
    const rec = this.store.session(id)
    if (!rec) return
    this.emit('turnEnd', id)

    if (msg.subtype !== 'success') {
      const errors = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : ''
      this.notice(id, `The turn ended early (${msg.subtype.replace(/_/g, ' ')})${errors ? `: ${errors}` : ''}.`, 'error')
    }

    if (live.phase === 'writing-handoff') {
      const resultText = msg.subtype === 'success' ? msg.result : ''
      // A hook that drops the request (quota-guard does, over its size limit) still ends with a
      // result, whose text is the hook's notice. Only a reply shaped like a handoff counts.
      const handoff = pickHandoff([resultText, live.lastAssistantText])
      if (handoff) await this.completeHandoff(id, live, handoff)
      else if (live.turnsQueued === 0) this.handoffMissing(id, live, resultText)
      // Otherwise this result was another turn's, and the request is still waiting.
      return
    }

    if (msg.subtype === 'success' && isQuotaGuardStop(msg.result)) this.onQuotaGuardStop(id, live)
    this.patch(id, { lastActivity: Date.now() })
    if (live.turnsQueued > 0) return // another prompt is already waiting its turn
    this.onSettled(id, live)
  }

  /**
   * quota-guard halted tool calls or dropped a prompt for size. Its limit can sit below this
   * app's handoff limit, so hand off when the turn ends instead of leaving the session stuck.
   */
  private onQuotaGuardStop(id: string, live: Live): void {
    if (live.phase !== 'normal' || this.store.session(id)?.archived) return
    live.phase = 'stopping'
    live.stopReason = 'quota-guard'
    this.log(`[${id.slice(0, 8)}] quota-guard stopped the session; handing off at turn end`)
    this.notice(id, 'quota-guard stopped this session for size. Handing off when this turn ends.', 'warn')
  }

  /**
   * Claude Code merges a prompt sent mid-turn into that turn, so the prompt gets no result of its
   * own and turnsQueued stays above 0 after everything is done. 'idle' is the SDK's authoritative
   * turn-over signal. It must hold for a moment, so that a prompt pushed just before it isn't
   * counted as finished.
   */
  private checkIdle(id: string, live: Live): void {
    if (live.turnsQueued === 0) return
    const idleAt = Date.now()
    clearTimeout(live.idleTimer)
    live.idleTimer = setTimeout(() => {
      if (this.live.get(id) !== live || live.sdkState !== 'idle') return
      if (live.turnsQueued === 0 || live.pending.size > 0 || live.lastPushAt > idleAt) return
      this.log(`[${id.slice(0, 8)}] idle with ${live.turnsQueued} prompt(s) merged into earlier turns`)
      live.turnsQueued = 0
      if (live.phase === 'writing-handoff') {
        const handoff = pickHandoff([live.lastAssistantText])
        if (handoff) void this.completeHandoff(id, live, handoff)
        else this.handoffMissing(id, live, '')
        return
      }
      this.patch(id, { lastActivity: Date.now() })
      this.onSettled(id, live)
    }, IDLE_SETTLE_MS)
  }

  /** The turn ended without a handoff in it: a hook dropped the request, or Claude answered something else. */
  private handoffMissing(id: string, live: Live, resultText: string): void {
    this.log(`[${id.slice(0, 8)}] reply had no handoff (attempt ${live.handoffAttempts}): ${firstLine(resultText) || 'empty'}`)
    if (live.handoffAttempts < 2) {
      this.notice(id, 'The reply had no handoff in it. Asking again.', 'warn')
      this.startHandoff(id, live)
      return
    }
    if (live.lastAssistantText.trim()) {
      // Claude wrote something, just not in the requested shape. Better than stopping here.
      void this.completeHandoff(id, live, live.lastAssistantText)
      return
    }
    live.phase = 'normal'
    live.handoffAttempts = 0
    this.patch(id, { status: 'error', error: 'No handoff came back.' })
    this.notice(
      id,
      `No handoff came back${resultText.trim() ? ` (${firstLine(resultText)})` : ''}. Send a message to retry, or use Hand off now.`,
      'error',
    )
  }

  /** Every prompt sent has finished: go idle, and hand off if the session has grown too large. */
  private onSettled(id: string, live: Live): void {
    const settings = this.store.settings
    const rec = this.store.session(id)
    if (!rec) return
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
      live.stopReason = 'user'
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
    live.handoffAttempts += 1
    live.lastPushAt = Date.now()
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
    live.handoffAttempts = 0

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
      addons: rec.addons,
      model: rec.model,
      effort: rec.effort,
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
        live.stopReason = 'size'
        this.notice(id, `Past ${kTokens(this.store.settings.hardStopTokens)} tokens per request. Ending this turn so the session can hand off.`, 'warn')
      }
      if (isMain && live.phase === 'stopping') return deny(HARD_STOP_MESSAGE(live.stopReason ?? 'size', rec?.lastRequestTokens ?? 0))

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

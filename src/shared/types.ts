// Types shared by the main process (which drives Claude Code) and the renderer (the UI).

import type { EffortLevel } from './effort.ts'
import type { ModelChoice } from './models.ts'

export type PermissionModeSetting = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'

export interface Project {
  id: string
  name: string
  /** Absolute path. Sessions run here and load its CLAUDE.md and .claude/settings*.json. */
  folder: string
  /** .env files loaded into each session's environment; relative to `folder` or absolute. */
  envFiles: string[]
  /** Extra guidance appended to Claude Code's system prompt for every session in this project. */
  guidance: string
  permissionMode: PermissionModeSetting
  /** Model override; empty uses Claude Code's default. */
  model: string
  /** Effort for sessions that don't pick their own; unset uses Claude Code's default. */
  effort?: EffortLevel
  createdAt: number
  collapsed: boolean
}

/**
 * idle: waiting for you. running: Claude is working. needs-input: a permission prompt or a
 * question is waiting. handing-off: writing a handoff before a successor takes over.
 */
export type SessionStatus = 'idle' | 'running' | 'needs-input' | 'handing-off' | 'error'

export type ArchiveReason = 'handoff' | 'inactive' | 'manual'

export interface SessionRecord {
  /** Claude Code's session UUID; set by the app when the session starts, so it is known up front. */
  id: string
  projectId: string
  title: string
  createdAt: number
  lastActivity: number
  status: SessionStatus
  /** A turn finished, or input is needed, while you were looking elsewhere. */
  unread: boolean
  /** True once Claude Code has written a transcript, so the next start resumes it. */
  hasTranscript: boolean
  archived: boolean
  archivedReason?: ArchiveReason
  predecessorId?: string
  successorId?: string
  /** Tokens the latest main-thread request re-sent (input + cache read + cache write). */
  lastRequestTokens: number
  peakRequestTokens: number
  /** Size of the first request this app saw; a handoff needs real growth past it. */
  baselineTokens?: number
  /** Number of the session in its handoff chain: 1 for the first, 2 for its successor, ... */
  generation: number
  /** Add-on ids (src/shared/addons.ts) this session loads; successors inherit them. */
  addons?: string[]
  /** Model picked for this session (alias or id); unset uses the project's model. Successors inherit it. */
  model?: string
  /** The model id Claude Code last reported for this session's replies. */
  activeModel?: string
  /** Effort level picked for this session; unset uses Claude Code's default. Successors inherit it. */
  effort?: EffortLevel
  /** Text waiting in the composer, e.g. a handoff when auto-continue is off. */
  draft?: string
  error?: string
}

export interface Settings {
  /** Show the token meter in warning colors from here. */
  warnTokens: number
  /** At the end of a turn past this size, write a handoff and continue in a new session. */
  handoffTokens: number
  /** Past this size mid-turn, deny further tool calls so the turn ends and the handoff runs. */
  hardStopTokens: number
  /** Refuse a tool call after this many identical calls in a row returned identical results. 0 = off. */
  loopRepeats: number
  /** Archive idle sessions with no activity for this many hours. 0 = never. */
  archiveAfterHours: number
  /** Stop a session's Claude Code process after this many idle minutes; it resumes on the next message. */
  idleProcessMinutes: number
  /** Successor sessions start working on the handoff right away. */
  autoContinue: boolean
  /** Desktop notifications when a session needs input or finishes while the window is unfocused. */
  notify: boolean
  /** Folder new project folders are created in by default. */
  projectsRoot: string
  /** Claude Code executable to run; empty uses the one bundled with the Agent SDK. */
  claudeExecutable: string
  /** Projects may use bypass permissions mode. Off: they start in default mode instead. */
  allowBypassPermissions: boolean
  /** Serve the UI to other devices (phone) over the network. */
  remoteEnabled: boolean
  remotePort: number
  /** 'tailscale': only this PC's Tailscale addresses (and localhost). 'all': every network, Wi-Fi included. */
  remoteScope: 'tailscale' | 'all'
  /** Secret in the connect link; regenerating it signs every device out. */
  remoteToken: string
}

export interface RemoteInfo {
  running: boolean
  /** Connect links, token included: open one on the phone, or scan its QR code. */
  urls: string[]
  /** QR code (data: URL) for the first link. */
  qr?: string
  error?: string
  hasTailscale: boolean
  clients: number
}

export interface RateWindow {
  kind: string
  /** 0-100 */
  percentUsed: number
  /** ms since epoch */
  resetsAt?: number
  status?: string
}

/** A photo or screenshot sent with a message: base64 data without the `data:` prefix. */
export interface ImageAttachment {
  mediaType: ImageMediaType
  data: string
}
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
/** Claude accepts up to 5 MB per image; this counts the base64 text, to be safe. */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024
export const MAX_IMAGES = 10

export type ChatItem =
  | { kind: 'user'; id: string; text: string; isHandoff?: boolean; /** data: URLs */ images?: string[] }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      summary: string
      input: unknown
      result?: string
      isError?: boolean
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warn' | 'error' }

export interface AskOption {
  label: string
  description: string
  preview?: string
}

export interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: AskOption[]
}

export type PendingRequest =
  | {
      kind: 'permission'
      requestId: string
      toolName: string
      title: string
      detail: string
      canAlwaysAllow: boolean
    }
  | { kind: 'question'; requestId: string; questions: AskQuestion[] }

export type PendingResponse =
  | { kind: 'permission'; decision: 'allow' | 'always' | 'deny'; message?: string }
  | { kind: 'question'; answers: Record<string, string> }
  | { kind: 'cancel' }

/** A session as the UI sees it: the stored record plus live-only state. */
export interface SessionView extends SessionRecord {
  isLive: boolean
  pending: PendingRequest[]
}

/** Tokens and their API list-price cost; not what a subscription bills. */
export interface UsageTotals {
  /** Uncached input tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export interface UsageRow {
  total: UsageTotals
  /** Since `UsageSummary.weekStart`. */
  week: UsageTotals
}

/** Token use counted from Claude Code's transcripts, for the sessions this app knows. */
export interface UsageSummary {
  projects: Record<string, UsageRow>
  sessions: Record<string, UsageRow>
  /** Every project together. */
  all: UsageRow
  /** First local day (YYYY-MM-DD) counted in `week`: the weekly limit window's start, or 7 days back. */
  weekStart: string
  /** True while the startup scan is still reading transcripts. */
  scanning: boolean
}

export interface AppState {
  projects: Project[]
  sessions: SessionView[]
  settings: Settings
  rateLimits: RateWindow[]
  /** The models Claude Code offers, as it last listed them; empty until a session has started. */
  models: ModelChoice[]
  usage: UsageSummary
}

export interface NewProjectInput {
  name: string
  folder: string
  createFolder: boolean
  envFiles: string[]
  guidance: string
  permissionMode: PermissionModeSetting
  model: string
  importRecent: boolean
}

export interface KnownFolder {
  folder: string
  sessions: number
  lastModified: number
}

export interface ChatUpdate {
  sessionId: string
  items: ChatItem[]
  /** Replace the whole list instead of merging by id. */
  reset?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  warnTokens: 100_000,
  handoffTokens: 150_000,
  hardStopTokens: 190_000,
  loopRepeats: 3,
  archiveAfterHours: 24,
  idleProcessMinutes: 10,
  autoContinue: true,
  notify: true,
  projectsRoot: '',
  claudeExecutable: '',
  allowBypassPermissions: false,
  remoteEnabled: false,
  remotePort: 8765,
  remoteScope: 'tailscale',
  remoteToken: '',
}

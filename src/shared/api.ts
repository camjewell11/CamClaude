// The bridge the preload exposes to the renderer as `window.cam`.

import type {
  AppState,
  ChatItem,
  ChatUpdate,
  ImageAttachment,
  KnownFolder,
  NewProjectInput,
  PendingResponse,
  Project,
  RemoteInfo,
  Settings,
} from './types.ts'
import type { EffortLevel } from './effort.ts'

export interface FolderInfo {
  exists: boolean
  hasClaudeMd: boolean
  envFiles: string[]
}

export interface CamApi {
  getState(): Promise<AppState>
  getChat(sessionId: string): Promise<ChatItem[]>

  createProject(input: NewProjectInput): Promise<Project>
  /** effort: '' goes back to Claude Code's default (undefined would vanish over the WebSocket). */
  updateProject(id: string, patch: Partial<Omit<Project, 'effort'>> & { effort?: EffortLevel | '' }): Promise<void>
  removeProject(id: string): Promise<void>
  pickFolder(defaultPath?: string): Promise<string | null>
  openFolder(path: string): Promise<void>
  knownFolders(): Promise<KnownFolder[]>
  folderInfo(path: string): Promise<FolderInfo>

  /**
   * addons: ids from src/shared/addons.ts that this session (and its successors) load.
   * model: an alias or id for this session (and its successors); empty uses the project's model.
   * effort: an effort level for this session (and its successors); empty uses Claude Code's default.
   */
  createSession(
    projectId: string,
    prompt?: string,
    images?: ImageAttachment[],
    addons?: string[],
    model?: string,
    effort?: string,
  ): Promise<string>
  /** Switches the session's model; '' goes back to the project's model. */
  setModel(sessionId: string, model: string): Promise<void>
  /** Switches the session's effort level; '' goes back to Claude Code's default. */
  setEffort(sessionId: string, effort: string): Promise<void>
  send(sessionId: string, text: string, images?: ImageAttachment[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  respond(sessionId: string, requestId: string, response: PendingResponse): Promise<void>
  archive(sessionId: string): Promise<void>
  unarchive(sessionId: string): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  remove(sessionId: string): Promise<void>
  handoffNow(sessionId: string): Promise<void>
  stopProcess(sessionId: string): Promise<void>
  setFocus(sessionId: string | null): Promise<void>

  updateSettings(patch: Partial<Settings>): Promise<Settings>
  remoteInfo(): Promise<RemoteInfo>
  regenerateRemoteToken(): Promise<RemoteInfo>
  /**
   * Desktop only: checks another PC's connect link, saves it, and restarts this install as a
   * window onto that PC. Its own sessions stop running here.
   */
  connectToPc(link: string): Promise<void>

  onState(cb: (s: AppState) => void): () => void
  onChat(cb: (u: ChatUpdate) => void): () => void
  onHandoff(cb: (h: { from: string; to: string }) => void): () => void
  /** A notification was clicked: show this session. */
  onSelect(cb: (sessionId: string) => void): () => void

  /** True in a browser on another device; false in the desktop window. */
  isRemote: boolean
  /** Remote only: the link to the PC dropped (false) or came back (true). */
  onConnection?(cb: (connected: boolean) => void): () => void
}

/** Calls that only make sense at the PC; a remote client can't make them. */
export const DESKTOP_ONLY: readonly (keyof CamApi)[] = ['pickFolder', 'openFolder', 'connectToPc']

/** What the preload gives a window that shows another PC's CamClaude (client mode). */
export interface CamClientBridge {
  /** Forget the other PC and restart as a full CamClaude on this PC. */
  disconnect(): Promise<void>
  /** Try to load the other PC's CamClaude again. */
  retry(): Promise<void>
}

/** Invoke channels, named after the CamApi methods they serve. */
export const INVOKE_CHANNELS = [
  'getState',
  'getChat',
  'createProject',
  'updateProject',
  'removeProject',
  'pickFolder',
  'openFolder',
  'knownFolders',
  'folderInfo',
  'createSession',
  'setModel',
  'setEffort',
  'send',
  'interrupt',
  'respond',
  'archive',
  'unarchive',
  'rename',
  'remove',
  'handoffNow',
  'stopProcess',
  'setFocus',
  'updateSettings',
  'remoteInfo',
  'regenerateRemoteToken',
  'connectToPc',
] as const satisfies readonly (keyof CamApi)[]

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

/** WebSocket messages between a remote client and the PC. */
export type WireToServer = { id: number; method: InvokeChannel; args: unknown[] }
export type WireToClient =
  | { id: number; result?: unknown; error?: string }
  | { event: 'state' | 'chat' | 'handoff' | 'select'; payload: unknown }

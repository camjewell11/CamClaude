// The bridge the preload exposes to the renderer as `window.cam`.

import type {
  AppState,
  ChatItem,
  ChatUpdate,
  KnownFolder,
  NewProjectInput,
  PendingResponse,
  Project,
  RemoteInfo,
  Settings,
} from './types.ts'

export interface FolderInfo {
  exists: boolean
  hasClaudeMd: boolean
  envFiles: string[]
}

export interface CamApi {
  getState(): Promise<AppState>
  getChat(sessionId: string): Promise<ChatItem[]>

  createProject(input: NewProjectInput): Promise<Project>
  updateProject(id: string, patch: Partial<Project>): Promise<void>
  removeProject(id: string): Promise<void>
  pickFolder(defaultPath?: string): Promise<string | null>
  openFolder(path: string): Promise<void>
  knownFolders(): Promise<KnownFolder[]>
  folderInfo(path: string): Promise<FolderInfo>

  createSession(projectId: string, prompt?: string): Promise<string>
  send(sessionId: string, text: string): Promise<void>
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
export const DESKTOP_ONLY: readonly (keyof CamApi)[] = ['pickFolder', 'openFolder']

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
] as const satisfies readonly (keyof CamApi)[]

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

/** WebSocket messages between a remote client and the PC. */
export type WireToServer = { id: number; method: InvokeChannel; args: unknown[] }
export type WireToClient =
  | { id: number; result?: unknown; error?: string }
  | { event: 'state' | 'chat' | 'handoff' | 'select'; payload: unknown }

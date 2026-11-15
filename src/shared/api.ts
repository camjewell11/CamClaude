// The bridge the preload exposes to the renderer as `window.cam`.

import type {
  AppState,
  ChatItem,
  ChatUpdate,
  KnownFolder,
  NewProjectInput,
  PendingResponse,
  Project,
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

  onState(cb: (s: AppState) => void): () => void
  onChat(cb: (u: ChatUpdate) => void): () => void
  onHandoff(cb: (h: { from: string; to: string }) => void): () => void
  /** A notification was clicked: show this session. */
  onSelect(cb: (sessionId: string) => void): () => void
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
] as const satisfies readonly (keyof CamApi)[]

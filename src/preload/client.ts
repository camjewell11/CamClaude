// Client mode preload: the other PC's CamClaude page talks to that PC over its own WebSocket
// (remoteApi.ts), so this only adds the two things that concern this install.

import { contextBridge, ipcRenderer } from 'electron'

import type { CamClientBridge } from '../shared/api.ts'

const bridge: CamClientBridge = {
  disconnect: () => ipcRenderer.invoke('client:disconnect'),
  retry: () => ipcRenderer.invoke('client:retry'),
}

contextBridge.exposeInMainWorld('camClient', bridge)

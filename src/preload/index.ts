import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { INVOKE_CHANNELS, type CamApi } from '../shared/api.ts'

const listen =
  <T>(channel: string) =>
  (cb: (value: T) => void) => {
    const handler = (_e: IpcRendererEvent, value: T) => cb(value)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }

const invokers = Object.fromEntries(
  INVOKE_CHANNELS.map(name => [name, (...args: unknown[]) => ipcRenderer.invoke(`cam:${name}`, ...args)]),
)

const api = {
  ...invokers,
  onState: listen('cam:state'),
  onChat: listen('cam:chat'),
  onHandoff: listen('cam:handoff'),
  onSelect: listen('cam:select'),
} as CamApi

contextBridge.exposeInMainWorld('cam', api)

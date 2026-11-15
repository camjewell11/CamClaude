// window.cam for a browser on another device: the same API, carried over a WebSocket to the PC.
// The cookie set by the connect link authenticates the socket.

import { INVOKE_CHANNELS, type CamApi, type WireToClient, type WireToServer } from '@shared/api'

type Listener = (value: never) => void

export function createRemoteApi(): CamApi {
  let ws: WebSocket | null = null
  let nextId = 1
  let delay = 500
  let connected = false
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const queue: string[] = []
  const listeners: Record<string, Set<Listener>> = {
    state: new Set(),
    chat: new Set(),
    handoff: new Set(),
    select: new Set(),
    connection: new Set(),
  }

  const emit = (event: string, value: unknown) => {
    for (const cb of listeners[event] ?? []) (cb as (v: unknown) => void)(value)
  }

  const setConnected = (value: boolean) => {
    if (connected === value) return
    connected = value
    emit('connection', value)
  }

  function connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const socket = new WebSocket(url)
    ws = socket
    socket.onopen = () => {
      delay = 500
      setConnected(true)
      while (queue.length) socket.send(queue.shift()!)
      // Anything may have changed while away: refresh the whole state.
      void call('getState', []).then(s => emit('state', s))
    }
    socket.onmessage = e => {
      const msg = JSON.parse(String(e.data)) as WireToClient
      if ('event' in msg) {
        emit(msg.event, msg.payload)
        return
      }
      const pending = calls.get(msg.id)
      if (!pending) return
      calls.delete(msg.id)
      if (msg.error !== undefined) pending.reject(new Error(msg.error))
      else pending.resolve(msg.result)
    }
    socket.onclose = () => {
      if (ws !== socket) return
      setConnected(false)
      for (const p of calls.values()) p.reject(new Error('Lost the connection to the PC.'))
      calls.clear()
      setTimeout(connect, delay)
      delay = Math.min(delay * 2, 10_000)
    }
  }

  function call(method: WireToServer['method'], args: unknown[]): Promise<unknown> {
    const id = nextId++
    const data = JSON.stringify({ id, method, args } satisfies WireToServer)
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject })
      if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      else queue.push(data)
    })
  }

  const on = (event: string) => (cb: Listener) => {
    listeners[event].add(cb)
    return () => {
      listeners[event].delete(cb)
    }
  }

  // Coming back to the tab (phone unlocked): reconnect at once instead of waiting out the backoff.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ws && ws.readyState === WebSocket.CLOSED) {
      delay = 500
      connect()
    }
  })

  connect()

  const invokers: Record<string, unknown> = Object.fromEntries(
    INVOKE_CHANNELS.map(name => [name, (...args: unknown[]) => call(name, args)]),
  )
  return {
    ...invokers,
    pickFolder: async () => null,
    openFolder: async () => undefined,
    onState: on('state'),
    onChat: on('chat'),
    onHandoff: on('handoff'),
    onSelect: on('select'),
    onConnection: on('connection'),
    isRemote: true,
  } as unknown as CamApi
}

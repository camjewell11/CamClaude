import type { CamApi } from '@shared/api'
import type { SessionStatus, SessionView, Settings } from '@shared/types'

declare global {
  interface Window {
    cam: CamApi
  }
}

export const cam = () => window.cam

export const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d` : new Date(ms).toLocaleDateString()
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** What the sidebar dot shows: live status first, then "finished while you were away". */
export type Indicator = SessionStatus | 'unread'

export function indicator(s: SessionView): Indicator {
  if (s.status === 'idle' && s.unread) return 'unread'
  return s.status
}

export const INDICATOR_LABEL: Record<Indicator, string> = {
  idle: 'Idle',
  running: 'Working',
  'needs-input': 'Needs your input',
  'handing-off': 'Handing off',
  error: 'Stopped with an error',
  unread: 'Finished',
}

export function sizeTone(tokens: number, s: Settings): 'ok' | 'warn' | 'over' {
  if (tokens >= s.handoffTokens) return 'over'
  if (tokens >= s.warnTokens) return 'warn'
  return 'ok'
}

export const errorText = (err: unknown) =>
  String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

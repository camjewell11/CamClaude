import type { CamApi } from '@shared/api'
import type { SessionStatus, SessionView, Settings, UsageTotals } from '@shared/types'

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

/** A cost in USD, short: $0.42, $15, $1.2k. */
export function money(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  if (usd < 1000) return `$${Math.round(usd)}`
  return `$${(usd / 1000).toFixed(1)}k`
}

/** A token count, short: 950, 45k, 12.3M, 1.2B. */
export function tokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

/** Every token a total covers: uncached input, output, cache reads, and cache writes. */
export const allTokens = (t: UsageTotals) => t.input + t.output + t.cacheRead + t.cacheWrite

/** The breakdown, one item per line, for a tooltip. */
export const usageDetail = (t: UsageTotals) =>
  [
    `Input: ${tokenCount(t.input)}`,
    `Output: ${tokenCount(t.output)}`,
    `Cache read: ${tokenCount(t.cacheRead)}`,
    `Cache write: ${tokenCount(t.cacheWrite)}`,
  ].join('\n')

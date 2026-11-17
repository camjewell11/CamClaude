// Client mode: this install shows another PC's CamClaude instead of running sessions itself.
// The choice lives in client.json under userData, holding the connect link from the other PC.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'client.json'

/**
 * Checks a pasted connect link (the one in Settings, Remote access, on the other PC) and returns
 * it in a normal form, or a reason it can't be used.
 */
export function parseConnectLink(text: string): { link: string; host: string } | { error: string } {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return { error: 'Paste the whole link, starting with http://.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'The link must start with http:// or https://.' }
  const token = url.searchParams.get('t')
  if (!token) return { error: 'The link has no access token. Copy it with the Copy button on the other PC.' }
  return { link: `${url.origin}/?t=${encodeURIComponent(token)}`, host: url.host }
}

/** The saved connect link, or null when this install runs its own sessions. */
export function readClientLink(userData: string): string | null {
  const path = join(userData, FILE)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as { link?: unknown }
    const parsed = typeof data.link === 'string' ? parseConnectLink(data.link) : null
    return parsed && 'link' in parsed ? parsed.link : null
  } catch {
    return null
  }
}

export function saveClientLink(userData: string, link: string): void {
  writeFileSync(join(userData, FILE), JSON.stringify({ link }, null, 2))
}

export function clearClientLink(userData: string): void {
  rmSync(join(userData, FILE), { force: true })
}

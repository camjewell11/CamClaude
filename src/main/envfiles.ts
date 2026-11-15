// Loads a project's .env files into a session's environment.

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** Parses dotenv text: KEY=value, optional `export `, quotes, and # comments. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2]
    const quote = value[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      // A quoted value can span lines until the closing quote.
      let body = value.slice(1)
      while (!hasClosingQuote(body, quote) && i + 1 < lines.length) {
        body += '\n' + lines[++i]
      }
      const end = closingQuoteIndex(body, quote)
      value = end >= 0 ? body.slice(0, end) : body
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"')
    } else {
      // Unquoted: an inline comment starts at " #".
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash)
      value = value.trim()
    }
    out[key] = value
  }
  return out
}

function closingQuoteIndex(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && quote === '"') {
      i++
      continue
    }
    if (body[i] === quote) return i
  }
  return -1
}

const hasClosingQuote = (body: string, quote: string) => closingQuoteIndex(body, quote) >= 0

export interface LoadedEnv {
  vars: Record<string, string>
  /** Files that were listed but could not be read. */
  missing: string[]
}

/** Reads each file in order; later files override earlier ones. */
export async function loadEnvFiles(folder: string, files: string[]): Promise<LoadedEnv> {
  const vars: Record<string, string> = {}
  const missing: string[] = []
  for (const f of files) {
    const path = isAbsolute(f) ? f : join(folder, f)
    try {
      Object.assign(vars, parseEnv(await readFile(path, 'utf8')))
    } catch {
      missing.push(f)
    }
  }
  return { vars, missing }
}

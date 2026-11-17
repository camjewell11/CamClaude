// Model names for the UI: the choices Claude Code offers, and short labels for model ids.

/** One model Claude Code can run, as its `supportedModels()` lists it. */
export interface ModelChoice {
  /** What to pass to Claude Code: an alias such as 'opus', or a full id. */
  value: string
  /** The full id the alias stands for, when Claude Code says. */
  resolvedModel?: string
  displayName: string
  description: string
  /** False when the model has no effort setting; unset when Claude Code didn't say. */
  supportsEffort?: boolean
  /** The effort levels the model accepts, when Claude Code lists them. */
  supportedEffortLevels?: string[]
}

/** Used until a session has started and Claude Code has listed its own models. */
export const FALLBACK_MODELS: readonly ModelChoice[] = [
  { value: 'opus', displayName: 'Opus', description: 'For hard debugging and design.' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'For routine edits, checks, and config changes.' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest; for small, simple tasks.' },
]

/** Claude Code's own 'default' row; the UI has its own "Project default" entry instead. */
export const isDefaultChoice = (m: ModelChoice) => m.value === 'default'

/**
 * A short name for a model id or alias: 'claude-opus-5-5' → 'Opus 5.5', 'sonnet' → 'Sonnet',
 * 'claude-sonnet-4-5-20250929' → 'Sonnet 4.5', 'opus[1m]' → 'Opus (1M)'. Unknown shapes come back as given.
 */
export function modelLabel(id: string | undefined, choices: readonly ModelChoice[] = []): string {
  const raw = (id ?? '').trim()
  if (!raw) return ''
  const exact = choices.find(c => !isDefaultChoice(c) && c.value === raw)
  if (exact) return shortName(exact.displayName)
  const ctx = /\[(\d+[km])\]$/i.exec(raw)
  const base = raw.replace(/\[[^\]]*\]$/, '')
  const suffix = ctx ? ` (${ctx[1].toUpperCase()})` : ''
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base)
  if (m) {
    const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
    const version = m[2] ? (m[3] ? `${m[2]}.${m[3]}` : m[2]) : ''
    return `${family}${version ? ` ${version}` : ''}${suffix}`
  }
  // Older ids put the version first: claude-3-5-sonnet-20241022.
  const old = /^claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(base)
  if (old) {
    const family = old[3][0].toUpperCase() + old[3].slice(1).toLowerCase()
    return `${family} ${old[1]}${old[2] ? `.${old[2]}` : ''}${suffix}`
  }
  return raw
}

/** Claude Code's display names can carry a note, as in "Opus 5.5 (1M context)"; keep it short. */
function shortName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim() || name
}

/** Turns what `supportedModels()` returned into choices, dropping malformed rows. */
export function cleanModelChoices(rows: unknown): ModelChoice[] {
  if (!Array.isArray(rows)) return []
  const out: ModelChoice[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const { value, resolvedModel, displayName, description, supportsEffort, supportedEffortLevels } = r as Record<string, unknown>
    if (typeof value !== 'string' || !value.trim()) continue
    const levels = Array.isArray(supportedEffortLevels) ? supportedEffortLevels.filter(l => typeof l === 'string') : []
    out.push({
      value,
      ...(typeof resolvedModel === 'string' && resolvedModel ? { resolvedModel } : {}),
      displayName: typeof displayName === 'string' && displayName ? displayName : value,
      description: typeof description === 'string' ? description : '',
      ...(typeof supportsEffort === 'boolean' ? { supportsEffort } : {}),
      ...(levels.length ? { supportedEffortLevels: levels } : {}),
    })
  }
  return out
}

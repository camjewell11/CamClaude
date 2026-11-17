// Permission modes a project can pick, and the Settings switch that gates bypass mode.

import type { PermissionModeSetting } from './types.ts'

export interface PermissionModeChoice {
  value: PermissionModeSetting
  label: string
}

export const PERMISSION_MODES: PermissionModeChoice[] = [
  { value: 'default', label: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept file edits, ask for commands' },
  { value: 'auto', label: 'Auto (Claude Code classifier decides)' },
  { value: 'plan', label: 'Plan only (no changes)' },
  { value: 'bypassPermissions', label: 'Never ask (bypass permissions)' },
]

/** The mode a session starts in: bypass falls back to asking while Settings doesn't allow it. */
export function effectivePermissionMode(mode: PermissionModeSetting, allowBypass: boolean): PermissionModeSetting {
  return mode === 'bypassPermissions' && !allowBypass ? 'default' : mode
}

/**
 * The modes a project dialog offers. Bypass appears only while Settings allows it, or when the
 * project already uses it (marked, so the dialog doesn't silently change the saved value).
 */
export function permissionModeChoices(allowBypass: boolean, current?: PermissionModeSetting): PermissionModeChoice[] {
  if (allowBypass) return PERMISSION_MODES
  return PERMISSION_MODES.flatMap(m => {
    if (m.value !== 'bypassPermissions') return [m]
    if (current !== 'bypassPermissions') return []
    return [{ ...m, label: 'Never ask (off in Settings: asks instead)' }]
  })
}

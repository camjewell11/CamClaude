import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import type { PermissionModeSetting } from '@shared/types'

export function Modal({ title, onClose, children, footer, wide }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export const PERMISSION_MODES: { value: PermissionModeSetting; label: string }[] = [
  { value: 'default', label: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept file edits, ask for commands' },
  { value: 'auto', label: 'Auto (Claude Code classifier decides)' },
  { value: 'plan', label: 'Plan only (no changes)' },
  { value: 'bypassPermissions', label: 'Never ask (bypass permissions)' },
]

export const splitList = (s: string) =>
  s
    .split(/[,\n]/)
    .map(x => x.trim())
    .filter(Boolean)

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { useSheetDismiss } from '../touch'

export function Modal({ title, onClose, children, footer, wide }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) {
  const sheet = useRef<HTMLDivElement>(null)
  useSheetDismiss(sheet, onClose) // on a phone, drag the sheet down to close it
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} ref={sheet} role="dialog" aria-modal="true" aria-label={title}>
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

export const splitList = (s: string) =>
  s
    .split(/[,\n]/)
    .map(x => x.trim())
    .filter(Boolean)

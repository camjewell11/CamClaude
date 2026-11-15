import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

/** A small context menu at a screen point; closes on outside click, Escape, or a choice. */
export function Menu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.min(at.x, window.innerWidth - r.width - 8),
      y: Math.min(at.y, window.innerHeight - r.height - 8),
    })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [at])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map(item => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          disabled={item.disabled}
          onClick={() => {
            onClose()
            item.onClick()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

import { useEffect, useRef, useState } from 'react'

import { SendIcon, StopIcon } from './Icons'

interface Props {
  onSend: (text: string) => void | Promise<void>
  onStop?: () => void
  busy?: boolean
  disabled?: boolean
  placeholder?: string
  initial?: string
  autoFocus?: boolean
  footer?: React.ReactNode
}

/** The message box: Enter sends, Shift+Enter adds a line. */
export function Composer({ onSend, onStop, busy, disabled, placeholder, initial, autoFocus, footer }: Props) {
  const [text, setText] = useState(initial ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (initial) setText(initial)
  }, [initial])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [text])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const submit = async () => {
    const t = text.trim()
    if (!t || disabled) return
    setText('')
    await onSend(t)
  }

  return (
    <div className={`composer ${disabled ? 'disabled' : ''}`}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder ?? 'Reply to Claude…'}
        disabled={disabled}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape' && busy && onStop) onStop()
        }}
      />
      <div className="composer-bar">
        <div className="composer-footer">{footer}</div>
        {busy && onStop && (
          <button className="round-button stop" onClick={onStop} title="Stop (Esc)" aria-label="Stop">
            <StopIcon size={14} />
          </button>
        )}
        <button
          className="round-button send"
          onClick={() => void submit()}
          disabled={!text.trim() || disabled}
          title={busy ? 'Queue this message' : 'Send (Enter)'}
          aria-label="Send"
        >
          <SendIcon size={16} />
        </button>
      </div>
    </div>
  )
}

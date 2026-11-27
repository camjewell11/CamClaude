import { useEffect, useRef, useState } from 'react'

import { MAX_IMAGES, type ImageAttachment } from '@shared/types'
import { isImageFile, prepareImage, type Attached } from '../images'

import { isTouch } from '../touch'
import { ImageIcon, SendIcon, StopIcon } from './Icons'

interface Props {
  onSend: (text: string, images: ImageAttachment[]) => void | Promise<void>
  onStop?: () => void
  busy?: boolean
  disabled?: boolean
  placeholder?: string
  initial?: string
  autoFocus?: boolean
  footer?: React.ReactNode
  /** A predicted next prompt: ghost text that Tab accepts, or a chip to tap on touch screens. */
  suggestion?: string
}

/**
 * The message box: Enter sends, Shift+Enter adds a line. On a phone, Enter adds a line and only the
 * send button sends, and the box doesn't take focus by itself (that would open the keyboard).
 * Photos come from the image button, a paste, or a drop.
 */
export function Composer({ onSend, onStop, busy, disabled, placeholder, initial, autoFocus, footer, suggestion }: Props) {
  const [text, setText] = useState(initial ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const [touch] = useState(isTouch)
  const [images, setImages] = useState<Attached[]>([])
  const [preparing, setPreparing] = useState(0)
  const [imageError, setImageError] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

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
    if (autoFocus && !touch) ref.current?.focus()
  }, [autoFocus, touch])

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files].filter(isImageFile)
    if (!list.length) return
    setImageError('')
    const room = MAX_IMAGES - images.length - preparing
    if (list.length > room) setImageError(`You can attach up to ${MAX_IMAGES} images to one message.`)
    const take = list.slice(0, Math.max(0, room))
    setPreparing(n => n + take.length)
    for (const f of take) {
      try {
        const img = await prepareImage(f)
        setImages(xs => [...xs, img])
      } catch (err) {
        setImageError(err instanceof Error ? err.message : String(err))
      } finally {
        setPreparing(n => n - 1)
      }
    }
  }

  const removeImage = (i: number) => {
    setImages(xs => {
      URL.revokeObjectURL(xs[i].url)
      return xs.filter((_, n) => n !== i)
    })
  }

  const canSend = (!!text.trim() || images.length > 0) && preparing === 0 && !disabled
  const suggested = !disabled && !text && images.length === 0 ? suggestion : undefined

  const acceptSuggestion = () => {
    if (!suggested) return
    setText(suggested)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus({ preventScroll: true })
      el.setSelectionRange(suggested.length, suggested.length)
    })
  }

  const submit = async () => {
    if (!canSend) return
    const t = text.trim()
    const sent = images.map(({ mediaType, data }) => ({ mediaType, data }))
    for (const img of images) URL.revokeObjectURL(img.url)
    setText('')
    setImages([])
    setImageError('')
    await onSend(t, sent)
  }

  return (
    <div
      className={`composer ${disabled ? 'disabled' : ''} ${dragging ? 'dragging' : ''}`}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={e => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
      onDrop={e => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        void addFiles(e.dataTransfer.files)
      }}
    >
      {(images.length > 0 || preparing > 0) && (
        <div className="composer-images">
          {images.map((img, i) => (
            <div className="thumb" key={img.url}>
              <img src={img.url} alt={`Attached image ${i + 1}`} />
              <button className="thumb-remove" onClick={() => removeImage(i)} title="Remove" aria-label={`Remove image ${i + 1}`}>
                ×
              </button>
            </div>
          ))}
          {Array.from({ length: preparing }, (_, i) => (
            <div className="thumb loading" key={`p${i}`} aria-label="Preparing image" />
          ))}
        </div>
      )}
      {imageError && <div className="error-line inline">{imageError}</div>}
      {suggested && touch && (
        <button className="suggestion-chip" onClick={acceptSuggestion} aria-label={`Use suggestion: ${suggested}`}>
          <span className="suggestion-label">Suggested</span>
          {suggested}
        </button>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={suggested && !touch ? suggested : (placeholder ?? 'Reply to Claude…')}
        disabled={disabled}
        enterKeyHint={touch ? 'enter' : 'send'}
        onChange={e => setText(e.target.value)}
        onPaste={e => {
          const files = [...e.clipboardData.files].filter(isImageFile)
          if (!files.length) return
          e.preventDefault()
          void addFiles(files)
        }}
        onKeyDown={e => {
          if (e.key === 'Tab' && !e.shiftKey && suggested && !touch) {
            e.preventDefault()
            acceptSuggestion()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape' && busy && onStop) onStop()
        }}
      />
      <div className="composer-bar">
        <input
          ref={picker}
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          hidden
          onChange={e => {
            const files = e.target.files ? [...e.target.files] : []
            e.target.value = '' // so picking the same photo again still fires
            void addFiles(files)
          }}
        />
        <button
          className="round-button attach"
          onClick={() => picker.current?.click()}
          disabled={disabled}
          title="Add photos"
          aria-label="Add photos"
        >
          <ImageIcon size={18} />
        </button>
        <div className="composer-footer">
          {footer}
          {suggested && !touch && <span className="suggestion-hint"><kbd>Tab</kbd> to use the suggestion</span>}
        </div>
        {busy && onStop && (
          <button className="round-button stop" onClick={onStop} title="Stop (Esc)" aria-label="Stop">
            <StopIcon size={14} />
          </button>
        )}
        <button
          className="round-button send"
          onClick={() => void submit()}
          disabled={!canSend}
          title={busy ? 'Queue this message' : 'Send (Enter)'}
          aria-label="Send"
        >
          <SendIcon size={16} />
        </button>
      </div>
    </div>
  )
}

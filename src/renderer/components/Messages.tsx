import { memo, useState } from 'react'
import Markdown from 'react-markdown'
import { createPortal } from 'react-dom'
import remarkGfm from 'remark-gfm'

import type { ChatItem } from '@shared/types'
import { useBackToClose } from '../touch'
import { ChevronIcon, HandoffIcon, NoteIcon, ToolIcon } from './Icons'

const mdComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>,
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="codeblock">
      <button
        className="copy"
        onClick={e => {
          const text = (e.currentTarget.nextElementSibling as HTMLElement | null)?.innerText ?? ''
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {text}
    </Markdown>
  )
})

export const Message = memo(function Message({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      if (item.isHandoff) return <HandoffMessage text={item.text} />
      return (
        <div className="msg-user">
          {item.images && <UserImages images={item.images} />}
          {item.text}
        </div>
      )
    case 'assistant':
      return (
        <div className="msg-assistant prose">
          <MarkdownText text={item.text} />
        </div>
      )
    case 'tool':
      return <ToolRow item={item} />
    case 'notice':
      return (
        <div className={`msg-notice tone-${item.tone}`}>
          <NoteIcon size={14} />
          <span>{item.text}</span>
        </div>
      )
  }
})

function HandoffMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const body = text.split(/\n---\n/).slice(1).join('\n---\n') || text
  return (
    <div className="msg-handoff">
      <button className="handoff-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <HandoffIcon size={14} />
        <span>Continuing from a handoff</span>
        <ChevronIcon size={14} className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="prose handoff-body">
          <MarkdownText text={body} />
        </div>
      )}
    </div>
  )
}

function ToolRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const pending = item.result === undefined
  return (
    <div className={`msg-tool ${item.isError ? 'is-error' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <ToolIcon size={13} />
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{item.summary}</span>
        {pending ? <span className="tool-spinner" aria-label="Running" /> : <ChevronIcon size={13} className={`chev ${open ? 'open' : ''}`} />}
      </button>
      {open && (
        <div className="tool-body">
          {item.input !== undefined && (
            <>
              <div className="tool-label">Input</div>
              <pre>{typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2)}</pre>
            </>
          )}
          {item.result !== undefined && (
            <>
              <div className="tool-label">{item.isError ? 'Error' : 'Result'}</div>
              <pre>{item.result || '(no output)'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Photos sent with a message. Tap one to see it full screen; tap again, or go back, to close. */
function UserImages({ images }: { images: string[] }) {
  const [open, setOpen] = useState<string | null>(null)
  useBackToClose(open !== null, () => setOpen(null))
  return (
    <div className="msg-images">
      {images.map((src, i) => (
        <button key={i} className="msg-image" onClick={() => setOpen(src)} aria-label={`View image ${i + 1}`}>
          <img src={src} alt="" loading="lazy" />
        </button>
      ))}
      {open &&
        createPortal(
          <div className="lightbox" onClick={() => setOpen(null)} role="dialog" aria-label="Image">
            <img src={open} alt="" />
          </div>,
          document.body,
        )}
    </div>
  )
}

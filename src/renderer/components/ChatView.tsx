import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ChatItem, ImageAttachment, Project, SessionView, Settings } from '@shared/types'
import type { View } from '../App'
import { cam, errorText, indicator, INDICATOR_LABEL, kTokens, sizeTone } from '../util'
import { Composer } from './Composer'
import { ArchiveIcon, FolderIcon, HandoffIcon, MoreIcon } from './Icons'
import { Menu } from './Menu'
import { MenuButton } from './MenuButton'
import { Message } from './Messages'
import { PendingCard } from './PendingCard'
import { StatusDot } from './Sidebar'

interface Props {
  session: SessionView
  project: Project
  settings: Settings
  items: ChatItem[] | undefined
  allSessions: SessionView[]
  onSelect: (v: View) => void
  onMenu: () => void
  waiting: number
}

export function ChatView({ session, project, settings, items, allSessions, onSelect, onMenu, waiting }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [error, setError] = useState('')

  const busy = session.status === 'running' || session.status === 'handing-off' || session.status === 'needs-input'
  const ind = indicator(session)
  const successor = session.successorId ? allSessions.find(s => s.id === session.successorId) : undefined
  const predecessor = session.predecessorId ? allSessions.find(s => s.id === session.predecessorId) : undefined

  // Stay at the bottom while new messages arrive, unless you scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items, session.pending.length])

  useEffect(() => setError(''), [session.id])

  const tokens = session.lastRequestTokens
  const tone = sizeTone(tokens, settings)
  const pct = Math.min(100, (tokens / settings.handoffTokens) * 100)

  const send = async (text: string, images: ImageAttachment[]) => {
    setError('')
    pinned.current = true
    try {
      await cam().send(session.id, text, images)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className="chat">
      <header className="chat-head drag">
        <div className="chat-title no-drag">
          <MenuButton onClick={onMenu} waiting={waiting} />
          <StatusDot value={ind} />
          <span className="title-text" title={session.title}>
            {session.title}
          </span>
          <span className="title-project" title={project.folder}>
            {project.name}
          </span>
        </div>
        <div className="chat-tools no-drag">
          <span className={`status-label s-${ind}`}>{INDICATOR_LABEL[ind]}</span>
          {tokens > 0 && (
            <span
              className={`size-meter tone-${tone}`}
              title={`Each request re-sends ${kTokens(tokens)} tokens. Hands off at ${kTokens(settings.handoffTokens)}.`}
            >
              <span className="meter">
                <span style={{ width: `${pct}%` }} />
              </span>
              {kTokens(tokens)}
            </span>
          )}
          <button
            className="icon-button"
            title="Session options"
            aria-label="Session options"
            onClick={e => setMenu({ x: e.clientX, y: e.clientY })}
          >
            <MoreIcon />
          </button>
          {menu && (
            <Menu
              at={menu}
              onClose={() => setMenu(null)}
              items={[
                { label: 'Hand off now', disabled: session.archived, onClick: () => void cam().handoffNow(session.id) },
                session.archived
                  ? { label: 'Unarchive', onClick: () => void cam().unarchive(session.id) }
                  : { label: 'Archive', onClick: () => void cam().archive(session.id) },
                ...(cam().isRemote ? [] : [{ label: 'Open project folder', onClick: () => void cam().openFolder(project.folder) }]),
                { label: 'Stop Claude Code process', disabled: !session.isLive, onClick: () => void cam().stopProcess(session.id) },
              ]}
            />
          )}
        </div>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={e => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="column">
          {predecessor && (
            <button className="chain-link" onClick={() => onSelect({ kind: 'session', id: predecessor.id })}>
              <HandoffIcon size={14} /> Continued from “{predecessor.title}”
            </button>
          )}
          {items === undefined && <div className="loading-msgs">Loading…</div>}
          {items?.length === 0 && !busy && (
            <div className="empty-chat">
              <FolderIcon size={18} /> {project.folder}
            </div>
          )}
          {items?.map(item => <Message key={item.id} item={item} />)}
          {session.status === 'running' && session.pending.length === 0 && <div className="thinking" aria-label="Claude is working" />}
          {successor && (
            <button className="chain-link next" onClick={() => onSelect({ kind: 'session', id: successor.id })}>
              <HandoffIcon size={14} /> Handed off to “{successor.title}”. Open it
            </button>
          )}
        </div>
      </div>

      <div className="bottom">
        <div className="column">
          {session.pending.map(req => (
            <PendingCard key={req.requestId} req={req} onRespond={r => void cam().respond(session.id, req.requestId, r)} />
          ))}
          {session.archived && !successor && (
            <div className="archived-note">
              <ArchiveIcon size={14} /> Archived{session.archivedReason === 'inactive' ? ' after inactivity' : ''}. Sending a message brings
              it back.
            </div>
          )}
          {error && <div className="error-line">{error}</div>}
          <Composer
            key={session.id}
            initial={session.draft}
            autoFocus
            busy={busy}
            onSend={send}
            onStop={() => void cam().interrupt(session.id)}
            placeholder={successor ? 'This session was handed off. Messages here continue the old session.' : undefined}
          />
        </div>
      </div>
    </div>
  )
}

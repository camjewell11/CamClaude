import { useState } from 'react'

import type { PendingRequest, PendingResponse } from '@shared/types'
import { MarkdownText } from './Messages'

interface Props {
  req: PendingRequest
  onRespond: (r: PendingResponse) => void
}

/** A permission prompt or a question from Claude, shown above the composer. */
export function PendingCard({ req, onRespond }: Props) {
  return req.kind === 'permission' ? <PermissionCard req={req} onRespond={onRespond} /> : <QuestionCard req={req} onRespond={onRespond} />
}

function PermissionCard({ req, onRespond }: { req: Extract<PendingRequest, { kind: 'permission' }>; onRespond: Props['onRespond'] }) {
  const [denying, setDenying] = useState(false)
  const [why, setWhy] = useState('')
  return (
    <div className="pending-card" role="alertdialog" aria-label={req.title}>
      <div className="pending-title">{req.title}</div>
      {req.detail && <pre className="pending-detail">{req.detail}</pre>}
      {denying ? (
        <div className="pending-actions">
          <input
            className="text-input grow"
            autoFocus
            placeholder="Tell Claude what to do instead (optional)"
            value={why}
            onChange={e => setWhy(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onRespond({ kind: 'permission', decision: 'deny', message: why })}
          />
          <button className="btn" onClick={() => setDenying(false)}>
            Back
          </button>
          <button className="btn danger" onClick={() => onRespond({ kind: 'permission', decision: 'deny', message: why })}>
            Deny
          </button>
        </div>
      ) : (
        <div className="pending-actions">
          <button className="btn primary" autoFocus onClick={() => onRespond({ kind: 'permission', decision: 'allow' })}>
            Allow once
          </button>
          {req.canAlwaysAllow && (
            <button className="btn" onClick={() => onRespond({ kind: 'permission', decision: 'always' })}>
              Always allow
            </button>
          )}
          <button className="btn" onClick={() => setDenying(true)}>
            Deny…
          </button>
        </div>
      )}
    </div>
  )
}

function QuestionCard({ req, onRespond }: { req: Extract<PendingRequest, { kind: 'question' }>; onRespond: Props['onRespond'] }) {
  // Per question: chosen labels, and free text for "Other".
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const toggle = (q: string, label: string, multi: boolean) =>
    setPicked(p => {
      const cur = p[q] ?? []
      const next = multi ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : [label]
      return { ...p, [q]: next }
    })

  const answerFor = (q: string) => {
    const parts = [...(picked[q] ?? [])]
    if (other[q]?.trim()) parts.push(other[q].trim())
    return parts.join(', ')
  }
  const complete = req.questions.every(q => answerFor(q.question))

  return (
    <div className="pending-card" role="dialog" aria-label="Claude has a question">
      {req.questions.map(q => (
        <fieldset key={q.question} className="question">
          <legend>
            {q.header && <span className="q-chip">{q.header}</span>}
            {q.question}
          </legend>
          <div className="options">
            {q.options.map(o => {
              const on = (picked[q.question] ?? []).includes(o.label)
              return (
                <button
                  key={o.label}
                  className={`option ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(q.question, o.label, q.multiSelect)}
                >
                  <span className="option-label">{o.label}</span>
                  {o.description && <span className="option-desc">{o.description}</span>}
                  {on && o.preview && (
                    <span className="option-preview">
                      <MarkdownText text={o.preview} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <input
            className="text-input"
            placeholder="Other…"
            value={other[q.question] ?? ''}
            onChange={e => {
              const v = e.target.value
              setOther(o => ({ ...o, [q.question]: v }))
              if (!q.multiSelect && v) setPicked(p => ({ ...p, [q.question]: [] }))
            }}
          />
        </fieldset>
      ))}
      <div className="pending-actions">
        <button
          className="btn primary"
          disabled={!complete}
          onClick={() =>
            onRespond({
              kind: 'question',
              answers: Object.fromEntries(req.questions.map(q => [q.question, answerFor(q.question)])),
            })
          }
        >
          Submit
        </button>
        <button className="btn" onClick={() => onRespond({ kind: 'cancel' })}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

import { useState } from 'react'

import type { AppState, UsageRow } from '@shared/types'
import type { View } from '../App'
import { allTokens, money, tokenCount, usageDetail } from '../util'
import { ArchiveIcon, ChevronIcon } from './Icons'
import { MenuButton } from './MenuButton'

interface Props {
  state: AppState
  onSelect: (v: View) => void
  onMenu: () => void
  waiting: number
}

const dayLabel = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Token use and its API list-price cost per project, counted from Claude Code's transcripts. */
export function UsageView({ state, onSelect, onMenu, waiting }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const usage = state.usage
  const weekly = state.rateLimits.find(w => w.kind === 'seven_day')
  const since = dayLabel(usage.weekStart)
  const weekCost = usage.all.week.costUsd
  /** The project's part of the weekly limit's percent used, split by this week's cost. */
  const share = (row: UsageRow) =>
    weekly && weekCost > 0 ? `≈${Math.round((row.week.costUsd / weekCost) * weekly.percentUsed)}%` : '–'

  const projects = state.projects
    .map(p => ({ p, row: usage.projects[p.id] }))
    .filter(x => x.row)
    .sort((a, b) => b.row.total.costUsd - a.row.total.costUsd)

  return (
    <div className="home usage-view">
      <div className="home-drag drag">
        <MenuButton onClick={onMenu} waiting={waiting} />
      </div>
      <div className="usage-inner">
        <h1 className="usage-title">Usage</h1>
        <p className="usage-note">
          Cost is the API list-price equivalent of the tokens used, not what your subscription bills. CamClaude
          counts it from Claude Code&apos;s transcripts, so sessions started outside CamClaude aren&apos;t included.
          {usage.scanning && ' Reading transcripts…'}
        </p>

        <div className="usage-tiles">
          <div className="usage-tile" title={usageDetail(usage.all.total)}>
            <span className="tile-label">All time</span>
            <span className="tile-value">{money(usage.all.total.costUsd)}</span>
            <span className="tile-sub">{tokenCount(allTokens(usage.all.total))} tokens</span>
          </div>
          <div className="usage-tile" title={usageDetail(usage.all.week)}>
            <span className="tile-label">Since {since}</span>
            <span className="tile-value">{money(usage.all.week.costUsd)}</span>
            <span className="tile-sub">{tokenCount(allTokens(usage.all.week))} tokens</span>
          </div>
          <div className="usage-tile">
            <span className="tile-label">Weekly limit</span>
            <span className="tile-value">{weekly ? `${Math.round(weekly.percentUsed)}%` : '–'}</span>
            <span className="tile-sub">
              {weekly?.resetsAt ? `Resets ${new Date(weekly.resetsAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : 'Appears after a reply'}
            </span>
          </div>
        </div>

        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">All time</th>
              <th scope="col">Since {since}</th>
              <th scope="col" title="This week's share of the weekly limit, estimated from each project's cost">
                Weekly limit (est.)
              </th>
            </tr>
          </thead>
          {projects.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={4} className="usage-none">
                  No usage yet.
                </td>
              </tr>
            </tbody>
          )}
          {projects.map(({ p, row }) => {
            const isOpen = !!open[p.id]
            const sessions = state.sessions
              .filter(s => s.projectId === p.id)
              .map(s => ({ s, r: usage.sessions[s.id] }))
              .filter(x => x.r && allTokens(x.r.total) > 0)
              .sort((a, b) => b.r.total.costUsd - a.r.total.costUsd)
            return (
              <tbody key={p.id}>
                <tr className="usage-project">
                  <th scope="row">
                    <button
                      className="usage-expand"
                      onClick={() => setOpen(o => ({ ...o, [p.id]: !o[p.id] }))}
                      aria-expanded={isOpen}
                      disabled={sessions.length === 0}
                    >
                      <ChevronIcon className={`chev ${isOpen ? 'open' : ''}`} size={14} />
                      <span>{p.name}</span>
                      <span className="usage-count">
                        {sessions.length} session{sessions.length === 1 ? '' : 's'}
                      </span>
                    </button>
                  </th>
                  <Cell row={row} which="total" />
                  <Cell row={row} which="week" />
                  <td className="num">{share(row)}</td>
                </tr>
                {isOpen &&
                  sessions.map(({ s, r }) => (
                    <tr key={s.id} className="usage-session">
                      <th scope="row">
                        <button className="usage-session-link" onClick={() => onSelect({ kind: 'session', id: s.id })} title={s.title}>
                          {s.archived ? <ArchiveIcon size={12} className="row-archived" /> : <span className="usage-icon-gap" />}
                          <span>{s.title}</span>
                        </button>
                      </th>
                      <Cell row={r} which="total" />
                      <Cell row={r} which="week" />
                      <td className="num">{share(r)}</td>
                    </tr>
                  ))}
              </tbody>
            )
          })}
        </table>
        <p className="usage-note usage-share-note">
          The weekly limit column splits the limit&apos;s percent used by each project&apos;s cost since {since}. Sessions
          outside CamClaude also count toward the limit, so these shares can be too high.
        </p>
      </div>
    </div>
  )
}

function Cell({ row, which }: { row: UsageRow; which: 'total' | 'week' }) {
  const t = row[which]
  return (
    <td className="num" title={usageDetail(t)}>
      <span>{money(t.costUsd)}</span>
      <span className="usage-tokens">{tokenCount(allTokens(t))}</span>
    </td>
  )
}

import { useCallback, useEffect, useState } from 'react'

import type { RemoteInfo, Settings } from '@shared/types'
import { cam, errorText } from '../util'
import { Field, Modal } from './Modal'

/** Turns the phone server on and off and shows how to connect. Changes apply immediately. */
function RemoteSection({ settings }: { settings: Settings }) {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [port, setPort] = useState(String(settings.remotePort))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const refresh = useCallback(() => void cam().remoteInfo().then(setInfo).catch(() => undefined), [])
  useEffect(refresh, [refresh, settings.remoteEnabled, settings.remoteScope, settings.remotePort, settings.remoteToken])

  if (cam().isRemote) {
    const client = window.camClient
    if (!client) return <p className="field-hint">You're connected from another device. Manage remote access on the PC.</p>
    return (
      <div className="remote">
        <p className="field-hint">
          This window shows CamClaude on {location.host}. Sessions run on that PC, with its files and its Claude Code. Manage
          remote access there.
        </p>
        <button
          className="btn self-start"
          onClick={() => {
            if (confirm('Disconnect and use CamClaude on this PC instead? You can connect again from Settings.')) {
              void client.disconnect()
            }
          }}
        >
          Disconnect and use this PC
        </button>
      </div>
    )
  }

  const apply = async (patch: Partial<Settings>) => {
    setBusy(true)
    setError('')
    try {
      await cam().updateSettings(patch)
      refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="remote">
      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.remoteEnabled}
          disabled={busy}
          onChange={e => void apply({ remoteEnabled: e.target.checked })}
        />
        Allow access from my phone and other devices
      </label>
      <p className="field-hint">
        Anyone with the link can run commands on this PC through Claude. Keep it private. While this is on, closing the
        window keeps CamClaude running in the tray.
      </p>

      {settings.remoteEnabled && (
        <>
          <div className="row two">
            <Field label="Reachable over">
              <select
                className="text-input"
                value={settings.remoteScope}
                disabled={busy}
                onChange={e => void apply({ remoteScope: e.target.value as Settings['remoteScope'] })}
              >
                <option value="tailscale">Tailscale only (recommended)</option>
                <option value="all">Any network, home Wi-Fi included</option>
              </select>
            </Field>
            <Field label="Port">
              <input
                className="text-input"
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={e => setPort(e.target.value)}
                onBlur={() => {
                  const n = Number(port)
                  if (n >= 1024 && n <= 65535 && n !== settings.remotePort) void apply({ remotePort: n })
                  else setPort(String(settings.remotePort))
                }}
              />
            </Field>
          </div>

          {info?.error && <div className="remote-warn">{info.error}</div>}
          {settings.remoteScope === 'tailscale' && info && !info.hasTailscale && (
            <p className="field-hint">
              Get Tailscale free at tailscale.com: install it on this PC and on your phone, and sign in to the same account
              on both. Then reopen this dialog.
            </p>
          )}

          {info?.running && info.urls.length > 0 && (
            <div className="remote-connect">
              {info.qr && <img className="qr" src={info.qr} alt="QR code for the connect link" width={168} height={168} />}
              <div className="remote-links">
                <span className="field-label">
                  {info.qr
                    ? "Scan with your phone's camera, or open a link on it."
                    : 'Only this PC can open this link until Tailscale is connected.'}
                  {info.clients > 0 && ` ${info.clients} device${info.clients === 1 ? '' : 's'} connected.`}
                </span>
                {info.urls.map(u => (
                  <div key={u} className="row">
                    <code className="path grow" title={u}>
                      {u.replace(/\?t=.*/, '?t=…')}
                    </code>
                    <button
                      className="btn"
                      onClick={() =>
                        void navigator.clipboard.writeText(u).then(() => {
                          setCopied(u)
                          setTimeout(() => setCopied(''), 1200)
                        })
                      }
                    >
                      {copied === u ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ))}
                <span className="field-hint">
                  On the phone, use “Add to Home Screen” to open it like an app.
                </span>
                <button
                  className="btn ghost danger-text self-start"
                  disabled={busy}
                  onClick={() => void cam().regenerateRemoteToken().then(setInfo)}
                >
                  Sign out all devices (new link)
                </button>
              </div>
            </div>
          )}
          {error && <div className="error-line">{error}</div>}
        </>
      )}
    </div>
  )
}

/** Turns this install into a window onto another PC's CamClaude. */
function ConnectSection() {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connect = async () => {
    setBusy(true)
    setError('')
    try {
      await cam().connectToPc(link)
      // CamClaude restarts as a window onto the other PC.
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="remote">
      <p className="field-hint">
        Use CamClaude on another PC from here, with that PC's projects, sessions, and files. On the other PC, turn on remote
        access and copy its link. Both PCs need Tailscale. CamClaude restarts. This PC's own projects and sessions are kept for when
        you disconnect.
      </p>
      <div className="row">
        <input
          className="text-input grow"
          placeholder="http://100.x.x.x:8765/?t=…"
          value={link}
          disabled={busy}
          onChange={e => setLink(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && link.trim() && void connect()}
        />
        <button className="btn" disabled={busy || !link.trim()} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {error && <div className="error-line">{error}</div>}
    </div>
  )
}

const K = 1000

/** Handoff thresholds, cleanup timing, and notifications. */
export function SettingsDialog({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [s, setS] = useState(settings)
  const num = (key: keyof Settings, scale = 1) => ({
    type: 'number',
    min: 0,
    value: Math.round((s[key] as number) / scale),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [key]: Math.max(0, Number(e.target.value) || 0) * scale }),
  })

  const invalid = s.handoffTokens <= 0 || s.hardStopTokens < s.handoffTokens

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          {invalid && <span className="error-line inline">Hard stop must be at or above the handoff size.</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={invalid}
            onClick={() => {
              // Remote access settings apply on their own (below); don't overwrite them here.
              const { remoteEnabled, remotePort, remoteScope, remoteToken, ...rest } = s
              void [remoteEnabled, remotePort, remoteScope, remoteToken]
              void cam().updateSettings(rest).then(onClose)
            }}
          >
            Save
          </button>
        </>
      }
    >
      <h3>Handoff</h3>
      <p className="field-hint">
        Every request re-sends the whole conversation. Past the handoff size, the session writes a handoff at the end of its turn, a
        fresh session continues from it, and the old one is archived.
      </p>
      <div className="row three">
        <Field label="Warn at (k tokens)">
          <input className="text-input" {...num('warnTokens', K)} />
        </Field>
        <Field label="Hand off at (k tokens)">
          <input className="text-input" {...num('handoffTokens', K)} />
        </Field>
        <Field label="Hard stop at (k tokens)" hint="Mid-turn: tool calls stop so the turn ends.">
          <input className="text-input" {...num('hardStopTokens', K)} />
        </Field>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={s.autoContinue} onChange={e => setS({ ...s, autoContinue: e.target.checked })} />
        The new session starts working right away (off: it waits with the handoff in its composer)
      </label>
      <Field label="Loop guard" hint="Refuse a tool call after this many identical calls returned identical results. 0 turns it off.">
        <input className="text-input narrow" {...num('loopRepeats')} />
      </Field>

      <h3>Cleanup</h3>
      <div className="row two">
        <Field label="Archive idle sessions after (hours)" hint="0 = never. Archived sessions are hidden, not deleted.">
          <input className="text-input" {...num('archiveAfterHours')} />
        </Field>
        <Field label="Stop idle processes after (minutes)" hint="Frees memory; the session resumes on your next message.">
          <input className="text-input" {...num('idleProcessMinutes')} />
        </Field>
      </div>

      <h3>Remote access</h3>
      <RemoteSection settings={settings} />

      {!cam().isRemote && (
        <>
          <h3>Connect to another PC</h3>
          <ConnectSection />
        </>
      )}

      <h3>General</h3>
      <label className="toggle">
        <input type="checkbox" checked={s.notify} onChange={e => setS({ ...s, notify: e.target.checked })} />
        Notify me when a session needs input or finishes while CamClaude is in the background
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={s.allowBypassPermissions}
          onChange={e => setS({ ...s, allowBypassPermissions: e.target.checked })}
        />
        Allow bypass permissions mode
      </label>
      <p className="field-hint">
        Lets a project pick “Never ask (bypass permissions)”, which runs every tool without asking. While this is off, those
        projects ask before edits and commands. Applies to sessions started after saving.
      </p>
      <Field label="New project folders go in">
        <input className="text-input" value={s.projectsRoot} onChange={e => setS({ ...s, projectsRoot: e.target.value })} />
      </Field>
      <Field
        label="Claude Code executable"
        hint="Blank uses the copy bundled with CamClaude, which matches its SDK version. Applies to sessions started after saving."
      >
        <input
          className="text-input"
          value={s.claudeExecutable}
          placeholder="bundled"
          onChange={e => setS({ ...s, claudeExecutable: e.target.value })}
        />
      </Field>
    </Modal>
  )
}

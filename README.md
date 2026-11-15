# CamClaude

A lightweight desktop app for Claude Code, laid out like the Claude desktop app, built for
running several sessions across projects without watching them all the time.

- **Sessions grouped by project.** A project is a folder. The sidebar groups sessions under their
  project, newest first.
- **Projects know their guidance and secrets.** Every session in a project runs in its folder and
  loads its `CLAUDE.md` and `.claude/settings*.json`, plus guidance you set in the app. The
  project's `.env` files are loaded into the session's environment. Claude is told the variable
  names and never the values.
- **New projects from the sidebar.** Point at an existing folder (the app lists folders you've
  already used with Claude Code, and can bring in their recent sessions) or create a new one.
- **Status at a glance.** Each session shows a dot: working (pulsing), needs your input (amber `!`),
  finished while you were away (blue), handing off (purple), or error (red). Chips at the top count
  sessions that need you and sessions working; click one to filter. Background notifications are
  optional, and the window title shows how many sessions are waiting on you.
- **Automatic handoff.** Every request re-sends the whole conversation. Once a session passes the
  handoff size (default 150k tokens per request) and has grown at least 30k past its own start, the
  app asks it for a handoff when its turn ends, starts a fresh session from that handoff, and archives
  the old one. If you were watching the old session, the view follows to the new one. Past the hard
  stop (default 190k), tool calls are refused mid-turn so the turn ends and the handoff can run.
- **Auto-archive.** Handed-off sessions are archived right away, and idle sessions after 24 hours
  (configurable). Archiving hides a session. It doesn't delete it, and sending a message brings it
  back. Idle Claude Code processes stop after 10 minutes and resume on your next message.
- **Usage guards from quota-guard.** The app refuses a tool call that keeps returning the same
  result (the loop guard), and the sidebar shows your plan's 5-hour and weekly usage.

## Use it from your phone

CamClaude can serve the same UI to your phone's browser. Sessions still run on the PC, so the PC
must be on with CamClaude running. While remote access is on, closing the window keeps CamClaude
in the system tray.

1. Install [Tailscale](https://tailscale.com) (free) on the PC and the phone, and sign in to the
   same account on both. This gives the phone a private connection to the PC from anywhere,
   without exposing anything to the internet.
2. In CamClaude, open Settings → Remote access and turn on **Allow access from my phone**.
   Windows may ask whether to allow CamClaude through the firewall; allow it on private networks.
3. Scan the QR code with the phone's camera. The page opens and remembers the phone.
4. Optional: in the phone's browser, use **Add to Home Screen** to open it like an app.

**Sign out all devices** issues a new link and disconnects everything that used the old one.
**Any network** also listens on your home Wi-Fi, so the phone can connect at home without
Tailscale; only use that on a network you trust.

Security: the link carries a 256-bit token, which the phone trades for an HttpOnly cookie. The
socket checks the cookie and the page's origin. Anyone with the link can run commands on your PC
through Claude, so treat it like a password. The connection is plain HTTP; Tailscale encrypts it
on the way, but on "Any network" without Tailscale, it travels unencrypted over your Wi-Fi.

## How it works

CamClaude is an Electron app. Its main process drives Claude Code through the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk): each live
session is one streaming `query()`, which is one Claude Code process, signed in with your
existing Claude Code login. The app acts as the conductor: it answers permission prompts through
the UI, measures each request's size, and runs the handoff itself. No conductor session, mod, or
script is needed.

| Path | What it does |
| --- | --- |
| `src/main/sessions.ts` | Session lifecycle, status, permission prompts, guards, handoff, cleanup |
| `src/main/guard.ts` | Size and loop guards and the handoff prompts (ported from quota-guard) |
| `src/main/chatlog.ts` | Turns SDK and transcript messages into chat items |
| `src/main/envfiles.ts` | `.env` parsing |
| `src/main/store.ts` | The app's own records (`%APPDATA%\camclaude\camclaude.json`) |
| `src/main/remote.ts` | The phone server: static UI, token login, WebSocket bridge |
| `src/renderer/` | The React UI, used by the desktop window and phone browsers alike |
| `src/renderer/remoteApi.ts` | The UI's API over a WebSocket, used in a phone's browser |

Conversations stay where Claude Code keeps them (`~/.claude/projects`), so `claude --resume`
still sees them. Handoff documents are saved under `%APPDATA%\camclaude\handoffs\<project>\`.

## Run it

```sh
npm install
npm run dev        # development, with hot reload
npm run dist       # typecheck, test, and build the Windows installer into dist/
```

You need Claude Code signed in on this machine (run `claude` once and log in). CamClaude uses the
Claude Code binary bundled with the Agent SDK, so the version always matches. To use another one,
set it in Settings.

Checks:

```sh
npm run typecheck
npm test           # unit tests for the guards, .env parsing, and chat conversion
npm run smoke      # end to end with real Claude calls (~4 small requests): a turn and a handoff
```

## Limitations

- **It's a Claude Code front end, not the full desktop app.** It has no claude.ai chat history,
  Projects, artifacts, connectors, computer use, or browser.
- **Subscription login is for personal use.** Driving your own Claude Code login through the
  Agent SDK is fine on your own machine. Anthropic doesn't allow distributing a third-party app
  that signs people in with claude.ai accounts, so don't publish builds for others to sign in with.
  An API-key mode would be needed for that.
- **The installer is large** (about 240 MB to download, about 700 MB installed), mostly the bundled
  Claude Code binary.
- **Handoff quality depends on the handoff.** The successor knows only what the handoff says, plus
  the files and CLAUDE.md it reads. The prompt asks for task, done, in progress, decisions, and next
  step. Check the first few handoffs, and switch off "start working right away" in Settings if you
  want to review each one before the successor runs.
- **Secrets reach the session's environment.** Claude doesn't see the values, but any command it
  runs can read them. Use project permissions that make you approve commands if that matters.
- **Usage bars use an experimental SDK call.** If a future SDK removes it, the bars update only
  from rate-limit events near a limit.
- **Subagent work isn't shown** in the conversation. Only the main thread is.
- **No phone notifications.** The phone sees status changes while the page is open, but nothing
  alerts it when the page is closed or the phone is locked; that would need web push over HTTPS.
  On the phone, you also can't browse for folders or open them in Explorer; type paths instead.
- **Windows first.** The code is cross-platform, but only the Windows build has been tested.

## Credits

The guards are ported from [quota-guard](https://github.com/camjewell11/quota-guard), which
adapted [clauditor](https://github.com/IyadhKhalfallah/clauditor) (MIT, by Iyadh Khalfallah). The
handoff flow replaces [claude-auto-handoff](https://github.com/camjewell11/claude-auto-handoff).

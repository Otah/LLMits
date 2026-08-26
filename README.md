# LLMits – AI Tools Limits

*LLM + limits.* A tiny, no-build dashboard that shows the Claude Code and Codex
usage limits available on the machine it runs on.

[![CI](https://github.com/Otah/LLMits/actions/workflows/ci.yml/badge.svg)](https://github.com/Otah/LLMits/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

It reads the credentials the CLIs already store locally, asks each provider for
your current rate-limit windows, and renders them as meter bars. If only one of
the two services is available on a machine, the UI shows only that section.

## Features

- **Claude Code limits** — 5-hour session window, 7-day weekly window, and
  extra usage credits when enabled on the account.
- **Codex limits** — every rate-limit window reported by the local Codex CLI
  (currently its 5-hour and 7-day windows).
- **Installable PWA** — icon set, web manifest, and a service worker with an
  offline shell fallback.
- **Push notifications** — optional browser notifications when a limit crosses
  70% / 90% / 100%, and again when the window resets.
- **Light / dark theme** — cycles between automatic (system preference), light,
  and dark; manual choices are remembered in `localStorage`.
- **Polite by default** — responses are cached and failures are backed off so
  the dashboard doesn't make Anthropic's rate limiting worse (see
  [Caching and rate-limit backoff](#caching-and-rate-limit-backoff)).

## Requirements

- **Node 18 or newer** — the server uses the built-in `fetch` and
  `AbortSignal.timeout`. `.nvmrc` pins 22; CI also exercises 18 and 20.
- **Claude Code, logged in on the same machine** — for the Claude section.
- **Codex CLI, logged in and on `PATH`** — optional, for the Codex section.

Linux and macOS are both supported. Nothing is required beyond the two npm
dependencies (`express`, `web-push`).

## Quick start

```bash
npm install
npm run dev
```

The server listens on port `3600`. Open <http://localhost:3600> and the
dashboard polls for usage every 30 seconds.

## Where credentials come from

Claude Code stores the same credential blob in a different place on each
platform:

| Platform | Location |
| --- | --- |
| Linux | plaintext `~/.claude/.credentials.json` |
| macOS | the login Keychain, service `Claude Code-credentials` |

The server tries the file first and falls back to
`security find-generic-password -s 'Claude Code-credentials' -w` when the file
is missing on macOS. The first Keychain read may raise a one-time *"security
wants to use your confidential information"* prompt — click **Always Allow** to
stop it recurring.

Codex usage is read over JSON-RPC from `codex app-server --stdio`, so it needs
the Codex CLI on `PATH` rather than a credentials file.

Credentials are only ever read, never written or logged.

## Configuration

| Setting | Where | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | environment variable | `3600` | Port the server listens on. |
| `CACHE_TTL_MS` | constant in `server.js` | 3 minutes | How long a successful upstream response is reused, and the background refresh cadence. |
| `ERROR_BACKOFF_MS` | constant in `server.js` | 60 seconds | How long to wait after a failed upstream request before retrying. |

## HTTP endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | The dashboard (static files from `public/`). |
| `GET` | `/api/usage` | Claude usage, proxied from `https://api.anthropic.com/api/oauth/usage`. |
| `GET` | `/api/codex/usage` | Codex rate-limit windows, via the local Codex app-server. |
| `GET` | `/api/vapid-public-key` | VAPID public key, used by the browser to subscribe to push. |
| `POST` | `/api/subscribe` | Register a push subscription. |
| `POST` | `/api/unsubscribe` | Remove a push subscription. |

There is **no authentication** on the endpoints or the UI — usage percentages
aren't considered secret, and the intended audience is `localhost`. Add auth
yourself if you run this somewhere less trusted.

## Push notifications

Click **Enable notifications** in the footer to subscribe. The server then
notifies every subscriber when a metric crosses a threshold:

| Threshold | Severity |
| --- | --- |
| 70% | Heads up |
| 90% | Warning |
| 100% | Critical — limit reached |

Notifications explain what the number means in practice: whether Claude falls
back to extra usage credits, whether those credits are nearly gone, or whether
work will stop until the window resets. A reset notification is sent when a
window rolls over, but only if a warning or critical notification was sent for
that window first.

Two things worth knowing:

- Browsers only allow service workers and push on a **secure context** — HTTPS,
  or `localhost`. Over plain HTTP to a LAN address, the dashboard still works
  but notifications will not.
- The VAPID contact address is hard-coded in `server.js`
  (`webpush.setVapidDetails`). Change it to your own address if you fork this.

Push state lives in three files next to `server.js`, all generated at runtime
and all git-ignored:

- `vapid-keys.json` — created on first start if absent. **This is a keypair;
  don't commit or share it.** Deleting it invalidates existing subscriptions.
- `subscriptions.json` — the registered browser endpoints.
- `notify-state.json` — which thresholds have already fired, so restarts don't
  re-notify.

## Caching and rate-limit backoff

Anthropic's `/api/oauth/usage` endpoint rate-limits fairly aggressively (see
[anthropics/claude-code#30930](https://github.com/anthropics/claude-code/issues/30930),
[#31021](https://github.com/anthropics/claude-code/issues/31021),
[#31637](https://github.com/anthropics/claude-code/issues/31637)) and can get
stuck returning `429` for a while. To avoid making that worse, the server:

- Caches the last successful response for `CACHE_TTL_MS` and serves it to all
  clients instead of re-fetching on every request.
- Backs off for `ERROR_BACKOFF_MS` after a failed upstream request, so repeated
  polling during an outage doesn't keep hammering the endpoint.
- Refreshes in the background on a fixed cadence, independent of whether any
  browser is open — this keeps the cache warm and lets notification thresholds
  fire even with the dashboard closed.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| *"Could not read Claude Code credentials"* | Claude Code isn't logged in on this machine, or the Keychain read was denied. Run `claude login`, and allow the Keychain prompt on macOS. |
| A persistent `429` that never clears | Known upstream issue. The documented workaround is re-authenticating: `claude logout && claude login`. |
| *"Codex CLI was not found on the server"* | The `codex` binary isn't on the `PATH` of the process running the server. The Claude section still works without it. |
| Codex section shows an error but Claude works | Codex isn't logged in, or `codex app-server` returned no rate-limit data yet. |
| Notification button does nothing | Not a secure context (see above), or notifications are blocked for the origin in browser settings. |
| The UI looks stale after an update | The service worker is network-first, so a reload should pick it up; a hard reload clears the cached shell. |

## Project layout

```
server.js                    Express server, API proxy, notification logic
public/index.html            The entire no-build dashboard (HTML/CSS/JS)
public/sw.js                 Service worker: offline shell, push handling
public/manifest.webmanifest  PWA manifest
public/icons/                Icon set (favicon, apple-touch, maskable)
.github/workflows/ci.yml     Install, syntax check, boot smoke test
```

## Contributing

See [AGENTS.md](AGENTS.md) for repository conventions. The short version: keep
it simple — plain Node, plain HTML/CSS/JS, and existing dependencies over new
build tooling. There is no automated test suite, so exercise the affected
endpoint or UI path manually, and run `npm run check` before opening a PR.

## License

[MIT](LICENSE) © Ota Hauptmann and contributors

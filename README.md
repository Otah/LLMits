# claude-stats

A tiny dashboard that shows locally available Claude Code and Codex usage
limits in a browser. If only one service is available on a machine, the UI only
shows that section.

Works on Linux and macOS. Claude Code stores the same credential blob in a
different place on each: a plaintext `~/.claude/.credentials.json` on Linux,
the login Keychain on macOS. The server tries the file first and falls back to
`security find-generic-password -s 'Claude Code-credentials' -w` when the file
is missing on macOS. The first Keychain read may raise a one-time "security
wants to use your confidential information" prompt — click Always Allow to
stop it recurring.

## How it works

- `server.js` — a small Express server. On each request to `/api/usage` it
  reads the OAuth access token from Claude Code's credentials (file or
  Keychain, see above) and calls
  `https://api.anthropic.com/api/oauth/usage`, passing the response straight
  through to the browser. `/api/codex/usage` calls the local Codex app-server
  JSON-RPC API through `codex app-server --stdio` and returns the Codex weekly
  rate-limit bucket when Codex is logged in.
- `public/index.html` — a static, no-build dashboard that polls the usage
  endpoints every 30s and renders available sections as meter bars. It follows
  the system light/dark preference by default; the icon button in the footer
  overrides that and remembers the choice in `localStorage`.
- No auth on the endpoint or the UI — usage percentages aren't considered
  secret. Add auth yourself if you run this somewhere less trusted.

### Caching / rate-limit backoff

Anthropic's `/api/oauth/usage` endpoint rate-limits fairly aggressively (see
[anthropics/claude-code#30930](https://github.com/anthropics/claude-code/issues/30930),
[#31021](https://github.com/anthropics/claude-code/issues/31021),
[#31637](https://github.com/anthropics/claude-code/issues/31637)) and can get
stuck returning `429` for a while. To avoid making that worse, the server:

- Caches the last successful response for 3 minutes (`CACHE_TTL_MS`) and
  serves it to all clients instead of re-fetching on every request.
- Backs off for 60 seconds (`ERROR_BACKOFF_MS`) after a failed upstream
  request before trying again, so repeated polling during an outage doesn't
  keep hammering the endpoint.

If you hit a persistent `429` that doesn't clear on its own, the known
workaround is re-authenticating: `claude logout && claude login`.

## Running it

```bash
npm install
npm run dev   # starts on :3600 by default, override with PORT=
```

Requires Node 18+ (uses the built-in `fetch`).

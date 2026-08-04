# claude-stats

A tiny dashboard that shows your Claude Code subscription usage (5-hour
session limit, 7-day weekly limit, and extra usage credits) in a browser.

> **Linux only, for now.** Credentials are read from
> `~/.claude/.credentials.json`, the path used by Claude Code on Linux. On
> macOS, Claude Code instead stores the OAuth token in the system Keychain
> (`security find-generic-password -s 'Claude Code-credentials'`), which this
> app does not read. Porting to macOS just means swapping the file read in
> `server.js` for a Keychain lookup — everything else (the API call, the
> UI) is platform-agnostic.

## How it works

- `server.js` — a small Express server. On each request to `/api/usage` it
  reads the OAuth access token from `~/.claude/.credentials.json` and calls
  `https://api.anthropic.com/api/oauth/usage`, passing the response straight
  through to the browser.
- `public/index.html` — a static, no-build dashboard that polls `/api/usage`
  every 30s and renders it as a few meter bars.
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

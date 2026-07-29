const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3600;
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE_TTL_MS = 3 * 60 * 1000;
const ERROR_BACKOFF_MS = 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

let cache = null; // { status, body, fetchedAt } — last successful (2xx) response
let lastError = null; // { status, body, attemptedAt } — most recent failed upstream attempt

app.get('/api/usage', async (req, res) => {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    res.status(cache.status).type('application/json').send(cache.body);
    return;
  }

  // Don't hammer a failing/rate-limited upstream just because clients keep polling.
  if (lastError && Date.now() - lastError.attemptedAt < ERROR_BACKOFF_MS) {
    res.status(lastError.status).type('application/json').send(lastError.body);
    return;
  }

  let accessToken;
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    accessToken = JSON.parse(raw).claudeAiOauth.accessToken;
  } catch (err) {
    res.status(500).json({ error: 'Could not read Claude Code credentials on the server.' });
    return;
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5000),
    });
    const body = await upstream.text();

    if (upstream.ok) {
      cache = { status: upstream.status, body, fetchedAt: Date.now() };
      lastError = null;
    } else {
      lastError = { status: upstream.status, body, attemptedAt: Date.now() };
      if (cache) {
        // Upstream failing (e.g. rate limited) — keep serving the last good snapshot.
        res.status(cache.status).type('application/json').send(cache.body);
        return;
      }
    }

    res.status(upstream.status).type('application/json').send(body);
  } catch (err) {
    const body = JSON.stringify({ error: 'Upstream request to Anthropic API failed.' });
    lastError = { status: 502, body, attemptedAt: Date.now() };
    if (cache) {
      res.status(cache.status).type('application/json').send(cache.body);
      return;
    }
    res.status(502).type('application/json').send(body);
  }
});

app.listen(PORT, () => {
  console.log(`claude-stats listening on :${PORT}`);
});

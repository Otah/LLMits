const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3600;
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/usage', async (req, res) => {
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
    res.status(upstream.status).type('application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request to Anthropic API failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`claude-stats listening on :${PORT}`);
});

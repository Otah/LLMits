const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const webpush = require('web-push');

const PORT = process.env.PORT || 3600;
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE_TTL_MS = 3 * 60 * 1000;
const ERROR_BACKOFF_MS = 60 * 1000;

const VAPID_PATH = path.join(__dirname, 'vapid-keys.json');
const SUBSCRIPTIONS_PATH = path.join(__dirname, 'subscriptions.json');
const NOTIFY_STATE_PATH = path.join(__dirname, 'notify-state.json');

const THRESHOLDS = [
  { percent: 70, severity: 'info' },
  { percent: 90, severity: 'warning' },
  { percent: 100, severity: 'critical' },
];

const METRIC_LABELS = {
  session: '5-hour session limit',
  weekly: '7-day weekly limit',
  extra_usage: 'Extra usage credits',
  codex_weekly: 'Codex weekly limit',
};

const SEVERITY_LABELS = {
  info: 'Heads up',
  warning: 'Warning',
  critical: 'Critical — limit reached',
};

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let vapidKeys = loadJSON(VAPID_PATH, null);
if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  saveJSON(VAPID_PATH, vapidKeys);
}
webpush.setVapidDetails('mailto:ota@haup.cz', vapidKeys.publicKey, vapidKeys.privateKey);

let subscriptions = loadJSON(SUBSCRIPTIONS_PATH, []);
function saveSubscriptions() {
  saveJSON(SUBSCRIPTIONS_PATH, subscriptions);
}

let notifyState = loadJSON(NOTIFY_STATE_PATH, {});
function saveNotifyState() {
  saveJSON(NOTIFY_STATE_PATH, notifyState);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let cache = null; // { status, body, fetchedAt } — last successful (2xx) response
let lastError = null; // { status, body, attemptedAt } — most recent failed upstream attempt
let codexCache = null; // { status, body, fetchedAt } — last successful Codex response
let codexLastError = null; // { status, body, attemptedAt } — most recent failed Codex attempt

function extractPercents(data) {
  const limitsByKind = Object.fromEntries((data.limits || []).map((l) => [l.kind, l]));
  const session = data.five_hour?.utilization ?? limitsByKind.session?.percent ?? null;
  const weekly = data.seven_day?.utilization ?? limitsByKind.weekly_all?.percent ?? null;
  const extraUsage = data.extra_usage?.is_enabled ? data.extra_usage.utilization ?? null : null;
  return { session, weekly, extra_usage: extraUsage };
}

function summarizeUsageState(data, percents = extractPercents(data)) {
  const creditsEnabled = data.extra_usage?.is_enabled === true;
  const creditsPercent = percents.extra_usage;
  const sessionDepleted = percents.session != null && percents.session >= 100;
  const weeklyDepleted = percents.weekly != null && percents.weekly >= 100;
  const baseLimitDepleted = sessionDepleted || weeklyDepleted;
  const creditsDepleted = creditsEnabled && creditsPercent != null && creditsPercent >= 100;
  const creditsNearlyDepleted = creditsEnabled && creditsPercent != null && creditsPercent >= 90;

  return {
    creditsEnabled,
    creditsPercent,
    sessionDepleted,
    weeklyDepleted,
    baseLimitDepleted,
    creditsDepleted,
    creditsNearlyDepleted,
  };
}

function usageEffectText(data, metric, percent, percents) {
  const state = summarizeUsageState(data, percents);
  const metricDepleted = percent >= 100;
  const baseLimitEvent = metric === 'session' || metric === 'weekly';

  if (state.baseLimitDepleted && state.creditsDepleted) {
    return 'Limits and credits depleted. Claude may stop working; ask an admin for more credits.';
  }

  if (baseLimitEvent && metricDepleted) {
    if (state.creditsEnabled) {
      if (state.creditsNearlyDepleted) {
        return 'Now using extra usage credits, but credits are nearly depleted.';
      }
      return 'Now using extra usage credits.';
    }
    return 'No extra usage credits are enabled; wait for reset or ask an admin.';
  }

  if (metric === 'extra_usage' && state.creditsDepleted) {
    return 'Claude can continue on included limits, but may stop if the 5-hour or weekly limit is reached.';
  }

  if (metric === 'extra_usage' && state.baseLimitDepleted && state.creditsNearlyDepleted) {
    return 'Currently using extra usage credits; Claude may stop when they run out.';
  }

  return '';
}

function resetEffectText(data, metric, percents) {
  if (metric !== 'session' && metric !== 'weekly') return '';

  const state = summarizeUsageState(data, percents);
  if (state.baseLimitDepleted) {
    return 'Another included limit is still depleted.';
  }
  if (state.creditsDepleted) {
    return 'Claude should work again on included usage.';
  }
  return '';
}

function appendSentence(body, sentence) {
  return sentence ? `${body} ${sentence}` : body;
}

async function sendNotificationToAll(payload) {
  if (subscriptions.length === 0) return;
  const body = JSON.stringify(payload);
  const stillValid = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, body);
      stillValid.push(sub);
    } catch (err) {
      if (err.statusCode !== 404 && err.statusCode !== 410) {
        console.error('push send failed:', err.statusCode, err.message);
        stillValid.push(sub);
      }
      // 404/410 means the subscription is gone — drop it silently.
    }
  }
  if (stillValid.length !== subscriptions.length) {
    subscriptions = stillValid;
    saveSubscriptions();
  }
}

function evaluateThresholds(data) {
  const percents = extractPercents(data);
  evaluateMetricThresholds(data, percents);
}

function evaluateMetricThresholds(data, percents) {
  let changed = false;

  for (const [metric, percent] of Object.entries(percents)) {
    if (percent == null) continue;
    const state = notifyState[metric] || (notifyState[metric] = {
      lastPercent: null,
      notifiedTiers: [],
      lastNotifiedSeverity: null,
    });

    if (state.lastPercent !== null && percent < state.lastPercent) {
      // The window reset (usage only ever climbs within a cycle).
      if (state.lastNotifiedSeverity === 'warning' || state.lastNotifiedSeverity === 'critical') {
        const body = appendSentence(
          `Back down to ${percent.toFixed(0)}%.`,
          resetEffectText(data, metric, percents)
        );
        sendNotificationToAll({
          title: `${METRIC_LABELS[metric]} reset`,
          body,
          tag: `${metric}-reset`,
        });
      }
      state.notifiedTiers = [];
      state.lastNotifiedSeverity = null;
      changed = true;
    }

    let crossed = null;
    for (const tier of THRESHOLDS) {
      if (percent >= tier.percent && !state.notifiedTiers.includes(tier.percent)) {
        crossed = tier;
      }
    }
    if (crossed) {
      const body = appendSentence(
        `${SEVERITY_LABELS[crossed.severity]} — now at ${percent.toFixed(0)}%.`,
        usageEffectText(data, metric, percent, percents)
      );
      sendNotificationToAll({
        title: METRIC_LABELS[metric],
        body,
        tag: `${metric}-${crossed.severity}`,
      });
      for (const tier of THRESHOLDS) {
        if (tier.percent <= crossed.percent && !state.notifiedTiers.includes(tier.percent)) {
          state.notifiedTiers.push(tier.percent);
        }
      }
      state.lastNotifiedSeverity = crossed.severity;
      changed = true;
    }

    if (state.lastPercent !== percent) {
      state.lastPercent = percent;
      changed = true;
    }
  }

  if (changed) saveNotifyState();
}

function evaluateCodexThresholds(data) {
  const percent = data.codex?.utilization ?? null;
  if (percent == null) return;
  evaluateMetricThresholds(data, { codex_weekly: percent });
}

async function refreshCache() {
  let accessToken;
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    accessToken = JSON.parse(raw).claudeAiOauth.accessToken;
  } catch (err) {
    lastError = {
      status: 500,
      body: JSON.stringify({ error: 'Could not read Claude Code credentials on the server.' }),
      attemptedAt: Date.now(),
    };
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
      try {
        evaluateThresholds(JSON.parse(body));
      } catch (err) {
        console.error('threshold evaluation failed:', err.message);
      }
    } else {
      lastError = { status: upstream.status, body, attemptedAt: Date.now() };
    }
  } catch (err) {
    lastError = {
      status: 502,
      body: JSON.stringify({ error: 'Upstream request to Anthropic API failed.' }),
      attemptedAt: Date.now(),
    };
  }
}

function codexRpcRateLimits() {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('Codex app-server timed out.'));
    }, 10000);

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(result);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.on('error', (err) => finish(err));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(stderr.trim() || `Codex app-server exited with code ${code}.`));
      }
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          continue;
        }

        if (msg.id === 0) {
          if (msg.error) {
            finish(new Error(msg.error.message || 'Codex initialize failed.'));
          } else {
            send({ method: 'account/rateLimits/read', id: 1 });
          }
        }

        if (msg.id === 1) {
          if (msg.error) {
            finish(new Error(msg.error.message || 'Codex rate limit request failed.'));
          } else {
            finish(null, msg.result);
          }
        }
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: { name: 'claude-stats', version: '1.0.0' },
        capabilities: {},
      },
    });
  });
}

function codexLimitToUsage(result) {
  const limit = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
  if (!limit?.primary) {
    throw new Error('Codex rate limit data was not available.');
  }

  const resetsAt = limit.primary.resetsAt
    ? new Date(limit.primary.resetsAt * 1000).toISOString()
    : null;
  const percent = limit.primary.usedPercent ?? 0;
  const severity = percent >= 95 ? 'critical' : percent >= 85 ? 'serious' : percent >= 70 ? 'warning' : 'normal';

  return {
    limits: [
      {
        kind: 'codex_weekly',
        percent,
        severity,
        resets_at: resetsAt,
        window_minutes: limit.primary.windowDurationMins,
        limit_id: limit.limitId,
        limit_name: limit.limitName,
      },
    ],
    codex: {
      utilization: percent,
      resets_at: resetsAt,
      window_duration_mins: limit.primary.windowDurationMins,
      plan_type: limit.planType ?? null,
      credits: limit.credits ?? null,
      rate_limit_reached_type: limit.rateLimitReachedType ?? null,
      reset_credits: result.rateLimitResetCredits ?? null,
    },
  };
}

async function refreshCodexCache() {
  try {
    const usage = codexLimitToUsage(await codexRpcRateLimits());
    const body = JSON.stringify(usage);
    codexCache = { status: 200, body, fetchedAt: Date.now() };
    codexLastError = null;
    try {
      evaluateCodexThresholds(usage);
    } catch (err) {
      console.error('codex threshold evaluation failed:', err.message);
    }
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 502;
    codexLastError = {
      status,
      body: JSON.stringify({ error: err.code === 'ENOENT' ? 'Codex CLI was not found on the server.' : err.message }),
      attemptedAt: Date.now(),
    };
  }
}

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

  await refreshCache();

  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    res.status(cache.status).type('application/json').send(cache.body);
  } else {
    res.status(lastError.status).type('application/json').send(lastError.body);
  }
});

app.get('/api/codex/usage', async (req, res) => {
  if (codexCache && Date.now() - codexCache.fetchedAt < CACHE_TTL_MS) {
    res.status(codexCache.status).type('application/json').send(codexCache.body);
    return;
  }

  if (codexLastError && Date.now() - codexLastError.attemptedAt < ERROR_BACKOFF_MS) {
    res.status(codexLastError.status).type('application/json').send(codexLastError.body);
    return;
  }

  await refreshCodexCache();

  if (codexCache && Date.now() - codexCache.fetchedAt < CACHE_TTL_MS) {
    res.status(codexCache.status).type('application/json').send(codexCache.body);
  } else {
    res.status(codexLastError.status).type('application/json').send(codexLastError.body);
  }
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    res.status(400).json({ error: 'Invalid push subscription.' });
    return;
  }
  if (!subscriptions.some((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
    saveSubscriptions();
  }
  res.status(201).json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  const before = subscriptions.length;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  if (subscriptions.length !== before) saveSubscriptions();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`claude-stats listening on :${PORT}`);
});

// Keep the cache warm and evaluate notification thresholds on a fixed cadence,
// independent of whether any client is actively polling /api/usage.
setInterval(() => {
  refreshCache().catch((err) => console.error('background refresh failed:', err.message));
  refreshCodexCache().catch((err) => console.error('background codex refresh failed:', err.message));
}, CACHE_TTL_MS);
refreshCache().catch((err) => console.error('initial refresh failed:', err.message));
refreshCodexCache().catch((err) => console.error('initial codex refresh failed:', err.message));

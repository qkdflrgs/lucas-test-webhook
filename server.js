// CHeKT Monitoring Dashboard - Express backend
// Role: (1) keep the API key on the server and proxy the CHeKT API,
//       (2) serve the static dashboard from public/.

import { readFileSync, existsSync, writeFile, rename } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import * as api from './lib/chekt.js';

// --- .env loader (no external dependency) ---
const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env: ignore and use process env only
  }
}
loadEnv();

const app = express();
// Accept any payload a webhook might send. JSON is the CHeKT format; the text
// fallback keeps non-JSON deliveries from being silently dropped.
app.use(express.json({ limit: '5mb', type: ['application/json', '+json'] }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ limit: '5mb', type: ['text/*', 'application/xml', '+xml'] }));

const PORT = process.env.PORT || 3000;

// --- Config status ---
app.get('/api/config', (req, res) => {
  res.json({ configured: api.isConfigured(), apiBase: api.apiBase() });
});

// -----------------------------------------------------------------------------
// Webhook receiving + live push (Server-Sent Events)
//
// Instead of persisting deliveries, we normalize each CHeKT webhook and push it
// to connected dashboards over SSE. The browser then APPLIES the change to its
// live state (arming badge, camera status, activity feed) — no page reload.
//
// CHeKT wire format (see @chekt/webhook):
//   { event_id, event_type, status, endpoint_url, api_version,
//     payload: { data: {...}, triggered_by: {...} } }
// -----------------------------------------------------------------------------
const RECENT_MAX = 50;
const recentEvents = [];        // last N normalized events (for new clients)
const sseClients = new Set();   // open SSE responses
let eventCounter = 0;

function normalizeWebhook(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* keep as string */ }
  }
  const env = body && typeof body === 'object' ? body : {};
  const data = env.payload?.data || env.data || env;

  return {
    id: ++eventCounter,
    received_at: new Date().toISOString(),
    event_type: env.event_type || 'webhook',
    status: env.status,
    site_id: data.site_id,
    site_name: data.site_name,
    account_number: data.account_number,
    // arming
    arming_status: data.arming_status,
    arming_action: data.arming_action,
    partitions: data.partitions,
    // device / camera network
    device_id: data.device_id,
    device_name: data.device_name,
    is_online: data.is_online,
    // event / alarm
    event_id: data.event_id,
    zone_number: data.zone_number,
    event_time: data.event_time,
    triggered_by: env.payload?.triggered_by,
    raw: env,
  };
}

function broadcast(ev) {
  recentEvents.unshift(ev);
  if (recentEvents.length > RECENT_MAX) recentEvents.length = RECENT_MAX;
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { /* client gone; cleaned up on close */ }
  }
}

// SSE stream the dashboard subscribes to.
app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`retry: 3000\n`);
  res.write(`data: ${JSON.stringify({ event_type: '_connected' })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// Recent events for initial hydration / polling fallback.
app.get('/api/events/recent', (req, res) => {
  res.json({ events: recentEvents, clients: sseClients.size });
});

// -----------------------------------------------------------------------------
// Request Inspector (carried over from the original lucas-test-webhook)
//
// Alongside the live SSE dashboard, every webhook is recorded to a ring buffer
// and persisted to DATA_FILE so deliveries survive restarts and can be reviewed
// as raw payloads at /_inspect.
// -----------------------------------------------------------------------------
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 100);
const DATA_FILE = process.env.DATA_FILE
  ? resolve(process.env.DATA_FILE)
  : join(__dirname, 'data.json');

let history = [];
let recordCounter = 0;

// Load previously captured requests on startup.
try {
  if (existsSync(DATA_FILE)) {
    const saved = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(saved.requests)) history = saved.requests.slice(0, MAX_HISTORY);
    recordCounter = Number(saved.total) || history.reduce((m, r) => Math.max(m, r.id || 0), 0);
    console.log(`[inspector] loaded ${history.length} saved request(s) from ${DATA_FILE}`);
  }
} catch (err) {
  console.error(`[inspector] could not read ${DATA_FILE}:`, err.message);
}

// Atomic, non-overlapping persistence: write to a temp file then rename.
let writing = false;
let dirty = false;
function saveHistory() {
  if (writing) { dirty = true; return; }
  writing = true;
  dirty = false;
  const payload = JSON.stringify({ total: recordCounter, requests: history }, null, 2);
  const tmp = DATA_FILE + '.tmp';
  writeFile(tmp, payload, (err) => {
    if (err) { console.error('[inspector] write failed:', err.message); writing = false; return; }
    rename(tmp, DATA_FILE, (rErr) => {
      if (rErr) console.error('[inspector] save failed:', rErr.message);
      writing = false;
      if (dirty) saveHistory(); // flush changes that arrived mid-write
    });
  });
}

function recordRequest(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.length ? body.toString('utf8') : undefined;
  if (body && typeof body === 'object' && Object.keys(body).length === 0) body = undefined;

  const entry = {
    id: ++recordCounter,
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    headers: req.headers,
    query: Object.keys(req.query).length ? req.query : undefined,
    body,
  };
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  saveHistory();
  return entry;
}

// Inspector viewer routes (prefixed with /_ so they never collide with webhooks).
app.get('/_inspect/data', (_req, res) => {
  res.json({ count: history.length, total: recordCounter, requests: history });
});
app.post('/_inspect/clear', (_req, res) => {
  history.length = 0;
  saveHistory();
  res.json({ ok: true });
});
app.get(['/_inspect', '/_inspect/'], (_req, res) => {
  res.type('html').send(INSPECTOR_HTML);
});

// Webhook entry point. Point your CHeKT dealer webhook endpoint here.
// Accepts POST to /webhook or any /webhook/* subpath.
app.post(['/webhook', '/webhook/*'], (req, res) => {
  const ev = normalizeWebhook(req);
  broadcast(ev);              // push to live dashboard (SSE)
  const rec = recordRequest(req); // persist raw payload for /_inspect
  console.log(`[webhook] #${ev.id} ${ev.event_type}` +
    (ev.status ? `/${ev.status}` : '') +
    ` site=${ev.site_id ?? ev.account_number ?? '?'} → ${sseClients.size} client(s)` +
    ` (inspector #${rec.id})`);
  res.status(200).json({ received: true, id: ev.id });
});

// --- Shared route wrapper: async handler error handling ---
const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req, res);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({
      error: { message: e.message, code: e.code, detail: e.body?.error?.detail },
    });
  }
};

// --- Sites ---
app.get('/api/sites', wrap((req) => api.getSites(req.query.search, req.query.limit)));

// --- Arming (site system) ---
app.get('/api/sites/:id/arming', wrap((req) => api.getArming(req.params.id)));
app.post('/api/sites/:id/arming/arm', wrap((req) => api.armSite(req.params.id, req.body?.user)));
app.post('/api/sites/:id/arming/disarm', wrap((req) => api.disarmSite(req.params.id, req.body?.user)));

// --- Partition Arming ---
app.get('/api/sites/:id/partition-arming', wrap((req) => api.getPartitionArming(req.params.id)));
app.post('/api/sites/:id/partition-arming/arm',
  wrap((req) => api.armPartitions(req.params.id, req.body?.partition_ids, req.body?.user)));
app.post('/api/sites/:id/partition-arming/disarm',
  wrap((req) => api.disarmPartitions(req.params.id, req.body?.partition_ids, req.body?.user)));

// --- Contacts ---
app.get('/api/sites/:id/contacts', wrap((req) => api.getContacts(req.params.id)));
app.post('/api/sites/:id/contacts', wrap((req) => api.createContact(req.params.id, req.body)));
app.put('/api/sites/:id/contacts/:cid', wrap((req) => api.updateContact(req.params.id, req.params.cid, req.body)));
app.delete('/api/sites/:id/contacts/:cid', wrap((req) => api.deleteContact(req.params.id, req.params.cid)));
app.post('/api/sites/:id/contacts/:cid/validation', wrap((req) => api.validateContact(req.params.id, req.params.cid)));

// --- Cameras / Zones / Audio ---
app.get('/api/sites/:id/cameras', wrap((req) => api.getCameras(req.params.id)));
app.get('/api/sites/:id/zones', wrap((req) => api.getZones(req.params.id)));
app.get('/api/sites/:id/audio-devices', wrap((req) => api.getAudioDevices(req.params.id)));

// --- Activity Logs ---
app.get('/api/activity-logs/categories', wrap(() => api.getActivityCategories()));
app.post('/api/activity-logs/search', wrap((req) => api.searchActivityLogs(req.body)));

// --- Event Video URLs ---
app.post('/api/events-video-urls', wrap((req) => api.getEventVideoUrls(req.body?.event_ids)));

// --- Static frontend ---
app.use(express.static(join(__dirname, 'public')));

app.listen(PORT, () => {
  const mode = api.isConfigured() ? `LIVE (${api.apiBase()})` : 'Not configured (no API key)';
  console.log(`\n  CHeKT Monitoring Dashboard`);
  console.log(`  ▶  Dashboard : http://localhost:${PORT}`);
  console.log(`  ▶  Webhook   : POST http://localhost:${PORT}/webhook`);
  console.log(`  ▶  Inspector : http://localhost:${PORT}/_inspect`);
  console.log(`  ▶  Mode      : ${mode}\n`);
});

// -----------------------------------------------------------------------------
// Inspector viewer page (self-contained, polls /_inspect/data)
// -----------------------------------------------------------------------------
const INSPECTOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webhook Inspector</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 16px;
    border-bottom: 1px solid #8884; position: sticky; top: 0; background: Canvas; }
  h1 { font-size: 15px; margin: 0; }
  .muted { opacity: .6; }
  button { font: inherit; padding: 4px 10px; cursor: pointer; }
  main { padding: 16px; display: grid; gap: 12px; }
  .card { border: 1px solid #8884; border-radius: 6px; overflow: hidden; }
  .card > .top { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px;
    background: #8881; flex-wrap: wrap; }
  .method { font-weight: 700; padding: 1px 8px; border-radius: 4px; background: #4a90d922; }
  .path { font-weight: 600; }
  pre { margin: 0; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap;
    word-break: break-word; border-top: 1px solid #8883; }
  .label { padding: 6px 12px 0; font-size: 12px; opacity: .6; }
  .empty { opacity: .5; padding: 40px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Webhook Inspector</h1>
  <span class="muted" id="stat"></span>
  <span style="flex:1"></span>
  <label class="muted"><input type="checkbox" id="auto" checked> auto-refresh</label>
  <button onclick="load()">Refresh</button>
  <button onclick="clearAll()">Clear</button>
</header>
<main id="list"><div class="empty">Waiting for requests…</div></main>
<script>
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function fmt(v) {
  if (v == null) return '';
  if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
  return JSON.stringify(v, null, 2);
}
function render(data) {
  document.getElementById('stat').textContent = data.count + ' shown · ' + data.total + ' total';
  const list = document.getElementById('list');
  if (!data.requests.length) { list.innerHTML = '<div class="empty">Waiting for requests…</div>'; return; }
  list.innerHTML = data.requests.map(r => \`
    <div class="card">
      <div class="top">
        <span class="method">\${esc(r.method)}</span>
        <span class="path">\${esc(r.path)}</span>
        <span class="muted">\${esc(r.time)}</span>
        <span class="muted">\${esc(r.ip || '')}</span>
      </div>
      \${r.query ? '<div class="label">query</div><pre>'+esc(fmt(r.query))+'</pre>' : ''}
      \${r.body !== undefined ? '<div class="label">body</div><pre>'+esc(fmt(r.body))+'</pre>' : '<div class="label muted" style="padding-bottom:8px">(no body)</div>'}
      <div class="label">headers</div><pre>\${esc(fmt(r.headers))}</pre>
    </div>\`).join('');
}
async function load() {
  try { const r = await fetch('/_inspect/data'); render(await r.json()); } catch (e) {}
}
async function clearAll() {
  await fetch('/_inspect/clear', { method: 'POST' }); load();
}
load();
setInterval(() => { if (document.getElementById('auto').checked) load(); }, 2000);
</script>
</body>
</html>`;

// CHeKT Monitoring Dashboard - Express backend
// Role: (1) keep the API key on the server and proxy the CHeKT API,
//       (2) serve the static dashboard from public/.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

// Webhook entry point. Point your CHeKT dealer webhook endpoint here.
// Accepts POST to /webhook or any /webhook/* subpath.
app.post(['/webhook', '/webhook/*'], (req, res) => {
  const ev = normalizeWebhook(req);
  broadcast(ev);
  console.log(`[webhook] #${ev.id} ${ev.event_type}` +
    (ev.status ? `/${ev.status}` : '') +
    ` site=${ev.site_id ?? ev.account_number ?? '?'} → ${sseClients.size} client(s)`);
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
  console.log(`  ▶  Mode      : ${mode}\n`);
});

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
// Keep the most recent N requests in memory for the viewer.
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 100);
// Captured requests are persisted here so they survive restarts.
const DATA_FILE = path.resolve(process.env.DATA_FILE || 'data.json');

// -----------------------------------------------------------------------------
// Body parsing
// We want to accept ANY payload a webhook might send: JSON, form-encoded,
// plain text, or arbitrary bytes. Each parser only runs for its content-type,
// and the raw fallback captures everything else so nothing is silently dropped.
// -----------------------------------------------------------------------------
app.use(express.json({ limit: '5mb', type: ['application/json', '+json'] }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ limit: '5mb', type: ['text/*', 'application/xml', '+xml'] }));
app.use(express.raw({ limit: '5mb', type: () => true })); // fallback: Buffer

// In-memory ring buffer of captured requests, backed by DATA_FILE.
let history = [];
let counter = 0;

// Load previously captured requests on startup.
try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(saved.requests)) history = saved.requests.slice(0, MAX_HISTORY);
    counter = Number(saved.total) || history.reduce((m, r) => Math.max(m, r.id || 0), 0);
    console.log(`Loaded ${history.length} saved request(s) from ${DATA_FILE}`);
  }
} catch (err) {
  console.error(`Could not read ${DATA_FILE}:`, err.message);
}

// Atomic, non-overlapping persistence: write to a temp file then rename.
// `dirty`/`writing` collapse bursts of requests into the minimum number of writes.
let writing = false;
let dirty = false;
function save() {
  if (writing) { dirty = true; return; }
  writing = true;
  dirty = false;
  const payload = JSON.stringify({ total: counter, requests: history }, null, 2);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFile(tmp, payload, (err) => {
    if (err) {
      console.error(`Failed to write ${DATA_FILE}:`, err.message);
      writing = false;
      return;
    }
    fs.rename(tmp, DATA_FILE, (renameErr) => {
      if (renameErr) console.error(`Failed to save ${DATA_FILE}:`, renameErr.message);
      writing = false;
      if (dirty) save(); // flush changes that arrived mid-write
    });
  });
}

function record(req) {
  let body = req.body;
  // express.raw() leaves a Buffer; show it as a string (best effort).
  if (Buffer.isBuffer(body)) {
    body = body.length ? body.toString('utf8') : undefined;
  }
  if (body && typeof body === 'object' && Object.keys(body).length === 0) {
    body = undefined;
  }

  const entry = {
    id: ++counter,
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
  save();
  return entry;
}

// -----------------------------------------------------------------------------
// Viewer routes (prefixed with /_ so they never collide with webhook paths)
// -----------------------------------------------------------------------------
app.get('/_health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), captured: counter });
});

app.get('/_inspect/data', (_req, res) => {
  res.json({ count: history.length, total: counter, requests: history });
});

app.post('/_inspect/clear', (_req, res) => {
  history.length = 0;
  save();
  res.json({ ok: true });
});

app.get(['/_inspect', '/_inspect/'], (_req, res) => {
  res.type('html').send(VIEWER_HTML);
});

// -----------------------------------------------------------------------------
// Catch-all: every other request is a webhook to capture.
// -----------------------------------------------------------------------------
app.all(/.*/, (req, res) => {
  const entry = record(req);
  console.log(
    `\n[${entry.time}] ${entry.method} ${entry.path} from ${entry.ip}`
  );
  if (entry.query) console.log('  query:', JSON.stringify(entry.query));
  if (entry.body !== undefined) {
    console.log('  body: ', typeof entry.body === 'string'
      ? entry.body
      : JSON.stringify(entry.body, null, 2));
  }
  res.status(200).json({ received: true, id: entry.id, time: entry.time });
});

app.listen(PORT, () => {
  console.log(`Webhook tester listening on :${PORT}`);
  console.log(`  Send webhooks to any path, e.g. POST http://<host>:${PORT}/webhook`);
  console.log(`  View captured requests at   http://<host>:${PORT}/_inspect`);
});

// -----------------------------------------------------------------------------
// Viewer page (self-contained, polls /_inspect/data)
// -----------------------------------------------------------------------------
const VIEWER_HTML = `<!doctype html>
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
  document.getElementById('stat').textContent =
    data.count + ' shown · ' + data.total + ' total';
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

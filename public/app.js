// CHeKT Monitoring Dashboard - frontend logic
// All CHeKT API calls go through the backend (/api/*). The API key lives on the server only.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const state = {
  sites: [],
  filtered: [],
  selected: null,
  categories: [],
  logCursor: null,
  cameras: [],
  zones: [],
  contacts: [],
  editingContactId: null,
  feedCount: 0,
};

// ---- API helper ----
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---- Utils ----
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---- Init ----
async function init() {
  bindEvents();
  await loadConfig();
  await Promise.all([loadCategories(), loadSites()]);
}

async function loadConfig() {
  try {
    const cfg = await api('/config');
    const badge = $('#mode-badge');
    if (cfg.configured) {
      badge.textContent = `LIVE · ${cfg.apiBase.replace('https://', '')}`;
      badge.className = 'badge live';
    } else {
      badge.textContent = 'API key not set';
      badge.className = 'badge mock';
    }
  } catch {
    $('#mode-badge').textContent = 'Server unreachable';
  }
}

async function loadCategories() {
  try {
    state.categories = await api('/activity-logs/categories');
    const sel = $('#log-category');
    for (const c of state.categories) {
      const o = el('option', null, c.name);
      o.value = c.id;
      sel.appendChild(o);
    }
  } catch { /* ignore category load failure */ }
}

async function loadSites() {
  const list = $('#site-list');
  list.innerHTML = '<li class="muted small" style="padding:10px">Loading…</li>';
  try {
    const sites = await api('/sites?limit=500');
    state.sites = Array.isArray(sites) ? sites : [];
    applySiteFilter();
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('li', 'muted small', 'Failed to load sites: ' + e.message));
  }
}

function applySiteFilter() {
  const q = $('#site-search').value.trim().toLowerCase();
  state.filtered = state.sites.filter((s) =>
    !q ||
    String(s.site_name || '').toLowerCase().includes(q) ||
    String(s.address || '').toLowerCase().includes(q) ||
    String(s.account_number || '').toLowerCase().includes(q)
  );
  renderSiteList();
}

function renderSiteList() {
  const list = $('#site-list');
  $('#site-count').textContent = state.filtered.length;
  list.innerHTML = '';
  if (!state.filtered.length) {
    list.appendChild(el('li', 'muted small', 'No sites found.'));
    return;
  }
  for (const s of state.filtered) {
    const li = el('li', 'site-item');
    if (state.selected && state.selected.site_id === s.site_id) li.classList.add('active');
    li.appendChild(el('div', 'name', s.site_name || `Site ${s.site_id}`));
    li.appendChild(el('div', 'addr', s.address || 'No address'));
    const tags = el('div', 'tags');
    if (s.is_partition_enabled) tags.appendChild(el('span', 'tag part', 'Partition'));
    if (!s.is_activated) tags.appendChild(el('span', 'tag inactive', 'Inactive'));
    tags.appendChild(el('span', 'tag', `#${s.account_number ?? s.site_id}`));
    li.appendChild(tags);
    li.onclick = () => selectSite(s);
    list.appendChild(li);
  }
}

// ---- Site selection ----
async function selectSite(site) {
  state.selected = site;
  state.logCursor = null;
  renderSiteList();
  $('#empty-state').classList.add('hidden');
  $('#detail').classList.remove('hidden');

  $('#site-name').textContent = site.site_name || `Site ${site.site_id}`;
  $('#site-meta').textContent =
    `${site.address || 'No address'} · Account #${site.account_number ?? '—'} · Dealer ${site.dealer_name || '—'}`;

  // Load each section in parallel (each handles its own failure)
  loadArming(site);
  loadCamerasAndZones(site);
  loadContacts(site);
  loadLogs(site, true);
}

// ---- Arming state ----
async function loadArming(site) {
  const badge = $('#arming-badge');
  const updated = $('#arming-updated');
  const partBlock = $('#partition-block');

  if (site.is_partition_enabled) {
    // Partition system
    badge.textContent = 'Partitioned';
    badge.className = 'arming-badge';
    updated.textContent = '';
    $('#arm-btn').classList.add('hidden');
    $('#disarm-btn').classList.add('hidden');
    partBlock.classList.remove('hidden');
    try {
      const data = await api(`/sites/${site.site_id}/partition-arming`);
      renderPartitions(site, data);
    } catch (e) {
      $('#partition-list').innerHTML = '';
      $('#partition-list').appendChild(el('div', 'muted small', 'Failed to load partitions: ' + e.message));
    }
    return;
  }

  // Site system
  partBlock.classList.add('hidden');
  $('#arm-btn').classList.remove('hidden');
  $('#disarm-btn').classList.remove('hidden');
  badge.textContent = 'Checking…';
  badge.className = 'arming-badge';
  try {
    const data = await api(`/sites/${site.site_id}/arming`);
    const st = data.arming_status || 'unknown';
    badge.textContent = st === 'armed' ? 'Armed' : st === 'disarmed' ? 'Disarmed' : st;
    badge.className = 'arming-badge ' + st;
    updated.textContent = data.arming_updated_at ? `Updated ${fmtTime(data.arming_updated_at)}` : '';
  } catch (e) {
    badge.textContent = 'Query failed';
    badge.className = 'arming-badge';
    updated.textContent = e.message;
  }
}

function renderPartitions(site, data) {
  const wrap = $('#partition-list');
  wrap.innerHTML = '';
  // Defensively handle response shape: a partitions array or { partitions: [...] }
  const parts = Array.isArray(data) ? data : (data.partitions || data.data || []);
  const nameOf = (id) => (site.partitions || []).find((p) => p.partition_id === id)?.partition_name;
  if (!parts.length) {
    wrap.appendChild(el('div', 'muted small', 'No partition information.'));
    return;
  }
  for (const p of parts) {
    const pid = p.partition_id ?? p.id;
    const st = p.arming_status || 'unknown';
    const row = el('div', 'partition-row');
    const left = el('div');
    left.appendChild(el('span', 'p-name', p.partition_name || nameOf(pid) || `Partition ${p.partition_number ?? pid}`));
    const badge = el('span', 'arming-badge ' + st, st === 'armed' ? ' Armed' : st === 'disarmed' ? ' Disarmed' : st);
    badge.style.marginLeft = '10px';
    left.appendChild(badge);
    row.appendChild(left);
    const actions = el('div', 'p-actions');
    const armBtn = el('button', 'btn btn-danger', 'Arm');
    const disBtn = el('button', 'btn btn-primary', 'Disarm');
    armBtn.onclick = () => doPartitionAction(site, pid, 'arm');
    disBtn.onclick = () => doPartitionAction(site, pid, 'disarm');
    actions.append(armBtn, disBtn);
    row.appendChild(actions);
    wrap.appendChild(row);
  }
}

async function doPartitionAction(site, partitionId, action) {
  if (!confirm(`${action === 'arm' ? 'Arm' : 'Disarm'} partition ${partitionId}?`)) return;
  try {
    await api(`/sites/${site.site_id}/partition-arming/${action}`, {
      method: 'POST',
      body: { partition_ids: [partitionId], user: 'dashboard' },
    });
    toast('Command sent', 'ok');
    setTimeout(() => loadArming(site), 800);
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
}

async function doArm(action) {
  const site = state.selected;
  if (!site) return;
  if (!confirm(`${action === 'arm' ? 'Arm' : 'Disarm'} site "${site.site_name}"?`)) return;
  try {
    await api(`/sites/${site.site_id}/arming/${action}`, { method: 'POST', body: { user: 'dashboard' } });
    toast('Command sent', 'ok');
    setTimeout(() => loadArming(site), 800);
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
}

// ---- Cameras & zones ----
async function loadCamerasAndZones(site) {
  const grid = $('#camera-grid');
  grid.innerHTML = '<div class="muted small">Loading…</div>';
  let cameras = [];
  let zones = [];
  try {
    [cameras, zones] = await Promise.all([
      api(`/sites/${site.site_id}/cameras`).catch(() => []),
      api(`/sites/${site.site_id}/zones`).catch(() => []),
    ]);
  } catch { /* noop */ }

  state.cameras = Array.isArray(cameras) ? cameras : [];
  state.zones = Array.isArray(zones) ? zones : [];
  renderCameras();
}

function renderCameras(flashDeviceId) {
  const cameras = state.cameras || [];
  const zones = state.zones || [];
  const grid = $('#camera-grid');

  const online = cameras.filter((c) => c.status === 'online').length;
  $('#kpi-cameras').textContent = cameras.length;
  $('#kpi-online').textContent = online;
  $('#kpi-offline').textContent = cameras.length - online;
  const zoneSet = new Set();
  zones.forEach((z) => (z.zone_numbers || []).forEach((n) => zoneSet.add(n)));
  $('#kpi-zones').textContent = zoneSet.size;
  $('#camera-count').textContent = cameras.length;

  grid.innerHTML = '';
  if (!cameras.length) {
    grid.appendChild(el('div', 'muted small', 'No cameras.'));
    return;
  }
  for (const c of cameras) {
    const card = el('div', 'cam');
    card.dataset.deviceId = c.device_id;
    if (flashDeviceId && String(flashDeviceId) === String(c.device_id)) card.classList.add('flash');
    const thumb = el('div', 'cam-thumb');
    if (c.status === 'online' && c.mjpeg_url) {
      const img = el('img');
      img.alt = c.name || '';
      img.loading = 'lazy';
      img.src = c.mjpeg_url;
      img.onerror = () => { thumb.innerHTML = '<span class="placeholder">📷</span>'; };
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el('span', 'placeholder', '📷'));
    }
    card.appendChild(thumb);
    const body = el('div', 'cam-body');
    body.appendChild(el('div', 'cam-name', c.name || `Camera ${c.device_id}`));
    const meta = el('div', 'cam-meta');
    meta.appendChild(el('span', 'dot ' + (c.status === 'online' ? 'online' : 'offline')));
    meta.appendChild(el('span', 'cam-status', c.status === 'online' ? 'Online' : 'Offline'));
    body.appendChild(meta);
    if (c.zone_numbers && c.zone_numbers.length) {
      body.appendChild(el('div', 'cam-zones', 'Zones: ' + c.zone_numbers.join(', ')));
    }
    card.appendChild(body);
    grid.appendChild(card);
  }
}

// ---- Contacts ----
async function loadContacts(site) {
  const body = $('#contact-body');
  body.innerHTML = '<tr><td colspan="7" class="muted small">Loading…</td></tr>';
  try {
    const contacts = await api(`/sites/${site.site_id}/contacts`);
    state.contacts = Array.isArray(contacts) ? contacts : [];
  } catch (e) {
    state.contacts = [];
    body.innerHTML = `<tr><td colspan="7" class="muted small">Failed to load contacts: ${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  renderContacts();
}

function validationInfo(c) {
  // Real API returns sms_validation; docs show last_validation — handle both.
  const v = c.sms_validation || c.last_validation || {};
  const status = v.status ?? v.sms_validation_status;
  if (status === 1) return { cls: 'ok', text: 'Validated' };
  if (v.requested_at || v.sms_validation_requested_at) return { cls: 'pending', text: 'Pending' };
  return { cls: '', text: 'Not sent' };
}

function contactName(c) {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || `Contact ${c.contact_id}`;
}

function renderContacts() {
  const contacts = state.contacts || [];
  const body = $('#contact-body');
  $('#contact-count').textContent = contacts.length;
  $('#contact-empty').classList.toggle('hidden', contacts.length > 0);
  body.innerHTML = '';
  for (const c of contacts) {
    const tr = el('tr');
    tr.appendChild(el('td', null, contactName(c)));
    tr.appendChild(el('td', null, c.title || '—'));
    tr.appendChild(el('td', null, c.phone_number || '—'));
    tr.appendChild(el('td', null, c.email_address || '—'));

    const alarmTd = el('td');
    const tags = el('div', 'alarm-tags');
    tags.appendChild(el('span', 'atag ' + (c.sms_alarm_enabled ? 'on' : ''), 'SMS'));
    tags.appendChild(el('span', 'atag ' + (c.email_alarm_enabled ? 'on' : ''), 'Email'));
    alarmTd.appendChild(tags);
    tr.appendChild(alarmTd);

    const valTd = el('td');
    const vi = validationInfo(c);
    valTd.appendChild(el('span', 'val-pill ' + vi.cls, vi.text));
    tr.appendChild(valTd);

    const actTd = el('td');
    const acts = el('div', 'contact-actions');
    const valBtn = el('button', 'icon-btn', 'Validate');
    valBtn.title = 'Send SMS validation';
    valBtn.onclick = () => validateContact(c);
    const editBtn = el('button', 'icon-btn', 'Edit');
    editBtn.onclick = () => openContactForm(c);
    const delBtn = el('button', 'icon-btn danger', 'Delete');
    delBtn.onclick = () => deleteContact(c);
    acts.append(valBtn, editBtn, delBtn);
    actTd.appendChild(acts);
    tr.appendChild(actTd);

    body.appendChild(tr);
  }
}

function openContactForm(contact) {
  const form = $('#contact-form');
  form.reset();
  $('#contact-form-err').classList.add('hidden');
  state.editingContactId = contact ? contact.contact_id : null;
  $('#contact-modal-title').textContent = contact ? 'Edit contact' : 'Add contact';

  // external_contact_id is required only on create.
  const ecidInput = form.elements.external_contact_id;
  ecidInput.disabled = !!contact;
  $('#ecid-req').classList.toggle('hidden', !!contact);

  if (contact) {
    form.elements.first_name.value = contact.first_name || '';
    form.elements.last_name.value = contact.last_name || '';
    form.elements.external_contact_id.value = contact.external_contact_id || '';
    form.elements.title.value = contact.title || '';
    form.elements.phone_number.value = contact.phone_number || '';
    form.elements.slot_number.value = contact.slot_number || '';
    form.elements.email_address.value = contact.email_address || '';
    form.elements.sms_alarm_enabled.checked = !!contact.sms_alarm_enabled;
    form.elements.email_alarm_enabled.checked = !!contact.email_alarm_enabled;
  }
  $('#contact-modal').classList.remove('hidden');
}

function closeContactForm() {
  $('#contact-modal').classList.add('hidden');
}

async function submitContact(e) {
  e.preventDefault();
  const site = state.selected;
  if (!site) return;
  const form = $('#contact-form');
  const errEl = $('#contact-form-err');
  errEl.classList.add('hidden');

  const f = form.elements;
  const editing = state.editingContactId != null;

  // Build payload. On update, omit external_contact_id (immutable identifier).
  const payload = {
    first_name: f.first_name.value.trim(),
    last_name: f.last_name.value.trim(),
    title: f.title.value.trim(),
    slot_number: f.slot_number.value.trim(),
    email_address: f.email_address.value.trim(),
    phone_number: f.phone_number.value.trim(),
    sms_alarm_enabled: f.sms_alarm_enabled.checked ? 1 : 0,
    email_alarm_enabled: f.email_alarm_enabled.checked ? 1 : 0,
  };
  if (!editing) payload.external_contact_id = f.external_contact_id.value.trim();

  const saveBtn = $('#contact-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    if (editing) {
      await api(`/sites/${site.site_id}/contacts/${state.editingContactId}`, { method: 'PUT', body: payload });
    } else {
      await api(`/sites/${site.site_id}/contacts`, { method: 'POST', body: payload });
    }
    closeContactForm();
    toast(editing ? 'Contact updated' : 'Contact created', 'ok');
    loadContacts(site);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function deleteContact(contact) {
  const site = state.selected;
  if (!confirm(`Delete contact "${contactName(contact)}"?`)) return;
  try {
    await api(`/sites/${site.site_id}/contacts/${contact.contact_id}`, { method: 'DELETE' });
    toast('Contact deleted', 'ok');
    loadContacts(site);
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
}

async function validateContact(contact) {
  const site = state.selected;
  if (!contact.phone_number) { toast('No phone number to validate', 'err'); return; }
  if (!confirm(`Send an SMS validation message to ${contact.phone_number}?`)) return;
  try {
    await api(`/sites/${site.site_id}/contacts/${contact.contact_id}/validation`, { method: 'POST' });
    toast('Validation message sent', 'ok');
    setTimeout(() => loadContacts(site), 800);
  } catch (e) {
    toast('Validation failed: ' + e.message, 'err');
  }
}

// ---- Activity log ----
function rangeToStart(days) {
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 3600 * 1000);
  return { start_time: start.toISOString(), end_time: now.toISOString() };
}

async function loadLogs(site, reset) {
  const body = $('#log-body');
  const moreBtn = $('#log-more');
  const emptyEl = $('#log-empty');
  if (reset) {
    body.innerHTML = '';
    state.logCursor = null;
    emptyEl.classList.add('hidden');
  }

  const days = parseInt($('#log-range').value, 10) || 7;
  const catId = $('#log-category').value;
  const { start_time, end_time } = rangeToStart(days);
  const payload = {
    start_time, end_time,
    site_id: site.site_id,
    limit: 25,
    sort_by: 'event_time',
    sort_order: 'desc',
  };
  if (catId) payload.category_id = parseInt(catId, 10);
  if (state.logCursor) payload.cursor = state.logCursor;

  moreBtn.textContent = 'Loading…';
  moreBtn.disabled = true;
  try {
    const res = await api('/activity-logs/search', { method: 'POST', body: payload });
    const rows = res.data || [];
    if (reset && !rows.length) {
      emptyEl.classList.remove('hidden');
    }
    for (const r of rows) body.appendChild(renderLogRow(r));
    state.logCursor = res.page?.cursor || null;
    moreBtn.classList.toggle('hidden', !res.page?.has_more);
  } catch (e) {
    if (reset) { emptyEl.textContent = 'Failed to load logs: ' + e.message; emptyEl.classList.remove('hidden'); }
    else toast('Failed to load logs: ' + e.message, 'err');
  } finally {
    moreBtn.textContent = 'Load more';
    moreBtn.disabled = false;
  }
}

function categoryName(id) {
  return state.categories.find((c) => c.id === id)?.name || (id ?? '—');
}

// Categories whose events carry recorded video/snapshots.
// (Video event / Playback / Edge Playback / Timelapse)
const VIDEO_CATEGORY_IDS = new Set([20007, 20003, 20022, 20002]);

// Whether a row can have a playable recording. Numeric event_id is required by
// the video endpoint; a null category_id marks a live webhook row (event_video /
// alarm_event) that we already know is video-bearing.
function rowHasVideo(r) {
  if (r.event_id == null || !Number.isInteger(Number(r.event_id))) return false;
  return r.category_id == null || VIDEO_CATEGORY_IDS.has(r.category_id);
}

function renderLogRow(r) {
  const tr = el('tr');
  tr.appendChild(el('td', null, fmtTime(r.event_time)));
  tr.appendChild(el('td', null, categoryName(r.category_id)));
  tr.appendChild(el('td', null, r.trigger || '—'));
  const stTd = el('td');
  if (r.status) {
    stTd.appendChild(el('span', 'status-pill ' + r.status, r.status));
  } else stTd.textContent = '—';
  tr.appendChild(stTd);
  tr.appendChild(el('td', null, r.zone_number != null ? String(r.zone_number) : '—'));
  tr.appendChild(el('td', null, r.device_name || r.device_id || '—'));
  const vidTd = el('td');
  if (rowHasVideo(r)) {
    const b = el('button', 'link-btn', '▶ View');
    b.onclick = () => openVideo(r.event_id);
    vidTd.appendChild(b);
  } else vidTd.textContent = '—';
  tr.appendChild(vidTd);
  return tr;
}

// ---- Event video ----
// Response shape (POST /ext/v1/events-video-urls):
//   { events: [{ event_id, mp4|null, thumbnail|null, snapshots: [url,...] }], expires_in }
async function openVideo(eventId) {
  const modal = $('#video-modal');
  const mbody = $('#modal-body');
  modal.classList.remove('hidden');
  mbody.innerHTML = '<p class="muted">Requesting video URL…</p>';

  // The endpoint requires integer event_ids.
  const numId = Number(eventId);
  if (!Number.isInteger(numId) || numId < 1) {
    mbody.innerHTML = `<p class="muted">This event has no numeric ID (<code>${escapeHtml(String(eventId))}</code>), ` +
      'so a video URL cannot be requested.</p>';
    return;
  }

  try {
    const res = await api('/events-video-urls', { method: 'POST', body: { event_ids: [numId] } });
    const ev = (res.events || []).find((e) => String(e.event_id) === String(numId)) || (res.events || [])[0];

    mbody.innerHTML = '';
    if (!ev || (!ev.mp4 && !ev.thumbnail && !(ev.snapshots || []).length)) {
      mbody.innerHTML = '<p class="muted">No video or snapshot is available for this event yet.</p>';
      return;
    }

    // Primary stage: MP4 video (poster = thumbnail) if present, else the thumbnail/first snapshot.
    const stage = el('div', 'v-stage');
    if (ev.mp4) {
      const v = document.createElement('video');
      v.controls = true;
      v.autoplay = true;
      v.muted = true; // required for reliable autoplay after an async fetch; user can unmute
      v.playsInline = true;
      v.preload = 'auto';
      if (ev.thumbnail) v.poster = ev.thumbnail;
      v.src = ev.mp4;
      stage.appendChild(v);
      v.play().catch(() => { /* autoplay blocked; controls remain */ });
    } else {
      const img = el('img', 'v-main');
      img.src = ev.thumbnail || ev.snapshots[0];
      stage.appendChild(img);
    }
    mbody.appendChild(stage);

    // Snapshot strip — click to view full; if there's no MP4, clicking swaps the stage image.
    const snaps = ev.snapshots || [];
    if (snaps.length) {
      mbody.appendChild(el('div', 'label muted', `Snapshots (${snaps.length})`));
      const strip = el('div', 'v-strip');
      snaps.forEach((url) => {
        const t = el('img', 'v-thumb');
        t.src = url;
        t.loading = 'lazy';
        t.onclick = () => {
          if (!ev.mp4) { stage.querySelector('img').src = url; }
          else { window.open(url, '_blank', 'noopener'); }
        };
        strip.appendChild(t);
      });
      mbody.appendChild(strip);
    }

    if (res.expires_in) {
      mbody.appendChild(el('div', 'label muted small',
        `Signed URLs expire in ${Math.round(res.expires_in / 60)} min.`));
    }
  } catch (e) {
    mbody.innerHTML = '<p class="muted">Failed to load video: ' + escapeHtml(e.message) + '</p>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =============================================================================
// Live webhook stream (SSE) — receives CHeKT webhooks relayed by the backend
// and APPLIES each change to the dashboard in place (no reload).
// =============================================================================
function connectStream() {
  const es = new EventSource('/api/events/stream');
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false); // EventSource auto-reconnects
  es.onmessage = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (ev.event_type === '_connected') { setLive(true); return; }
    handleWebhook(ev);
  };
}

function setLive(on) {
  $('#live-dot').className = 'live-dot ' + (on ? 'on' : 'off');
  $('#live-text').textContent = on ? 'Live' : 'Live: reconnecting…';
}

function eventLabel(ev) {
  const t = (ev.event_type || 'event').replace(/_/g, ' ');
  return ev.status ? `${t} · ${ev.status}` : t;
}

function siteMatches(ev) {
  const s = state.selected;
  if (!s) return false;
  return (ev.site_id != null && String(ev.site_id) === String(s.site_id)) ||
    (ev.account_number != null && String(ev.account_number) === String(s.account_number));
}

// Entry point for every received webhook.
function handleWebhook(ev) {
  addToFeed(ev);
  bumpFeedCount();

  const notable = ['alarm_event', 'arming_status', 'partition_arming_status', 'camera_network', 'bridge_network']
    .includes(ev.event_type);
  if (notable) {
    const where = ev.site_name || ev.site_id || '';
    toast(`📡 ${eventLabel(ev)}${where ? ' — ' + where : ''}`,
      ev.status === 'armed' || ev.event_type === 'alarm_event' ? 'err' : 'ok');
  }

  // Apply the change to whatever the user is currently looking at.
  if (!siteMatches(ev)) return;
  applyToSelectedSite(ev);
}

function applyToSelectedSite(ev) {
  const site = state.selected;

  // 1) Arming state (site system)
  if (ev.event_type === 'arming_status' && ev.arming_status) {
    if (!site.is_partition_enabled) {
      const st = ev.arming_status;
      const badge = $('#arming-badge');
      badge.textContent = st === 'armed' ? 'Armed' : st === 'disarmed' ? 'Disarmed' : st;
      badge.className = 'arming-badge ' + st + ' flash';
      $('#arming-updated').textContent = 'Updated ' + fmtTime(ev.event_time || ev.received_at);
    } else {
      loadArming(site); // partition site: refetch authoritative state
    }
  }

  // 2) Partition arming — refetch to reflect all partitions accurately
  if (ev.event_type === 'partition_arming_status') {
    loadArming(site);
  }

  // 3) Camera / bridge network up-down → mutate camera status in place
  if ((ev.event_type === 'camera_network' || ev.event_type === 'bridge_network') && ev.device_id != null) {
    const cam = (state.cameras || []).find((c) => String(c.device_id) === String(ev.device_id));
    if (cam) {
      cam.status = ev.is_online ? 'online' : 'offline';
      renderCameras(ev.device_id);
    }
  }

  // 4) Anything log-worthy → prepend a live row to the activity table
  if (['alarm_event', 'arming_status', 'partition_arming_status', 'camera_network', 'event_video']
      .includes(ev.event_type)) {
    prependLiveLogRow(ev);
  }
}

function prependLiveLogRow(ev) {
  const body = $('#log-body');
  $('#log-empty').classList.add('hidden');
  const row = renderLogRow({
    event_time: ev.event_time || ev.received_at,
    category_id: null,
    trigger: ev.device_name || ev.event_type,
    status: ev.status || (ev.is_online === 0 ? 'disconnected' : ev.is_online === 1 ? 'connected' : ''),
    zone_number: ev.zone_number,
    device_name: ev.device_name,
    device_id: ev.device_id,
    event_id: ev.event_id,
  });
  // Show the webhook event type in the Category column instead of a lookup miss.
  row.children[1].textContent = eventLabel(ev);
  row.classList.add('flash');
  body.prepend(row);
}

// ---- Feed drawer ----
function addToFeed(ev) {
  const list = $('#feed-list');
  const empty = list.querySelector('.feed-empty');
  if (empty) empty.remove();

  const item = el('div', 'feed-item new');
  const top = el('div', 'fi-top');
  top.appendChild(el('span', 'fi-type', (ev.event_type || 'event').replace(/_/g, ' ')));
  if (ev.status) top.appendChild(el('span', 'fi-status ' + ev.status, ev.status));
  top.appendChild(el('span', 'fi-time', fmtTime(ev.received_at)));
  item.appendChild(top);

  const bits = [];
  if (ev.site_name || ev.site_id) bits.push('site ' + (ev.site_name || ev.site_id));
  if (ev.device_name || ev.device_id) bits.push('device ' + (ev.device_name || ev.device_id));
  if (ev.zone_number != null) bits.push('zone ' + ev.zone_number);
  if (ev.triggered_by?.email) bits.push('by ' + ev.triggered_by.email);
  if (bits.length) item.appendChild(el('div', 'fi-desc', bits.join(' · ')));

  const raw = el('details', 'fi-raw');
  raw.appendChild(el('summary', null, 'raw payload'));
  const pre = el('pre');
  pre.textContent = JSON.stringify(ev.raw ?? ev, null, 2);
  raw.appendChild(pre);
  item.appendChild(raw);

  list.prepend(item);
  setTimeout(() => item.classList.remove('new'), 1500);
  while (list.children.length > 50) list.lastElementChild.remove();
}

function bumpFeedCount() {
  state.feedCount += 1;
  const c = $('#feed-count');
  c.textContent = state.feedCount;
  c.classList.remove('zero');
}

function openFeed() {
  $('#feed-drawer').classList.remove('hidden');
  state.feedCount = 0;
  const c = $('#feed-count');
  c.textContent = '0';
  c.classList.add('zero');
}

// ---- Event bindings ----
function bindEvents() {
  $('#site-search').addEventListener('input', applySiteFilter);
  $('#refresh-btn').addEventListener('click', () => {
    loadSites();
    if (state.selected) selectSite(state.selected);
  });
  $('#arm-btn').addEventListener('click', () => doArm('arm'));
  $('#disarm-btn').addEventListener('click', () => doArm('disarm'));
  $('#log-category').addEventListener('change', () => state.selected && loadLogs(state.selected, true));
  $('#log-range').addEventListener('change', () => state.selected && loadLogs(state.selected, true));
  $('#log-more').addEventListener('click', () => state.selected && loadLogs(state.selected, false));
  $('#modal-close').addEventListener('click', () => $('#video-modal').classList.add('hidden'));
  $('#video-modal').addEventListener('click', (e) => {
    if (e.target.id === 'video-modal') $('#video-modal').classList.add('hidden');
  });
  $('#contact-add').addEventListener('click', () => openContactForm(null));
  $('#contact-form').addEventListener('submit', submitContact);
  $('#contact-cancel').addEventListener('click', closeContactForm);
  $('#contact-modal-close').addEventListener('click', closeContactForm);
  $('#contact-modal').addEventListener('click', (e) => {
    if (e.target.id === 'contact-modal') closeContactForm();
  });
  $('#feed-btn').addEventListener('click', openFeed);
  $('#feed-close').addEventListener('click', () => $('#feed-drawer').classList.add('hidden'));
  $('#feed-clear').addEventListener('click', () => {
    $('#feed-list').innerHTML = '<div class="feed-empty muted">Waiting for webhooks…<br><span class="small">POST events to <code>/webhook</code></span></div>';
  });
}

init();
connectStream();

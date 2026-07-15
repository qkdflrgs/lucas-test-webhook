// CHeKT Public API client
// Thin wrapper around https://public-apidoc-chekt.web.app/
// The Bearer API key is used server-side only and never exposed to the frontend.

// Read values at runtime. (This module is imported before server.js loads .env,
// so capturing them in module-level constants would grab empty values.)
const apiKey = () => process.env.CHEKT_API_KEY || '';
export const apiBase = () =>
  (process.env.CHEKT_API_BASE || 'https://api.chekt.com').replace(/\/$/, '');

export function isConfigured() {
  return apiKey().length > 0;
}

/**
 * Shared CHeKT API request function.
 * @param {string} path  - e.g. '/ext/v1/sites'
 * @param {object} opts  - { method, query, body }
 */
export async function chekt(path, { method = 'GET', query, body } = {}) {
  const key = apiKey();
  if (!key) {
    const err = new Error('CHEKT_API_KEY is not set. Check your .env file.');
    err.status = 500;
    err.code = 'NO_API_KEY';
    throw err;
  }

  const url = new URL(apiBase() + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  const headers = { Authorization: `Bearer ${key}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const err = new Error(`CHeKT API connection failed: ${e.message}`);
    err.status = 502;
    throw err;
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = new Error(
      (data && data.error && data.error.message) || `CHeKT API error (HTTP ${res.status})`
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ---- Per-resource helpers ----

export const getSites = (search, limit) =>
  chekt('/ext/v1/sites', { query: { search, limit } });

export const getArming = (siteId) =>
  chekt(`/ext/v1/sites/${siteId}/arming`);

export const armSite = (siteId, user) =>
  chekt(`/ext/v1/sites/${siteId}/arming/actions/arm`, { method: 'POST', body: { user } });

export const disarmSite = (siteId, user) =>
  chekt(`/ext/v1/sites/${siteId}/arming/actions/disarm`, { method: 'POST', body: { user } });

export const getPartitionArming = (siteId) =>
  chekt(`/ext/v1/sites/${siteId}/partition-arming`);

export const armPartitions = (siteId, partitionIds, user) =>
  chekt(`/ext/v1/sites/${siteId}/partition-arming/actions/arm`, {
    method: 'POST',
    body: { partition_ids: partitionIds, user },
  });

export const disarmPartitions = (siteId, partitionIds, user) =>
  chekt(`/ext/v1/sites/${siteId}/partition-arming/actions/disarm`, {
    method: 'POST',
    body: { partition_ids: partitionIds, user },
  });

// Contacts
export const getContacts = (siteId) =>
  chekt(`/ext/v1/sites/${siteId}/contacts`);

export const createContact = (siteId, contact) =>
  chekt(`/ext/v1/sites/${siteId}/contacts`, { method: 'POST', body: contact });

export const updateContact = (siteId, contactId, changes) =>
  chekt(`/ext/v1/sites/${siteId}/contacts/${contactId}`, { method: 'PUT', body: changes });

export const deleteContact = (siteId, contactId) =>
  chekt(`/ext/v1/sites/${siteId}/contacts/${contactId}`, { method: 'DELETE' });

export const validateContact = (siteId, contactId) =>
  chekt(`/ext/v1/sites/${siteId}/contacts/${contactId}/validation`, { method: 'POST' });

export const getCameras = (siteId) =>
  chekt(`/ext/v1/sites/${siteId}/cameras`);

export const getZones = (siteId) =>
  chekt(`/ext/v1/sites/${siteId}/zones`);

export const getAudioDevices = (siteId) =>
  chekt(`/ext/v1/sites/${siteId}/audio-devices`);

export const searchActivityLogs = (payload) =>
  chekt('/ext/v1/activity-logs/search', { method: 'POST', body: payload });

export const getActivityCategories = () =>
  chekt('/ext/v1/activity-logs/categories');

export const getEventVideoUrls = (eventIds) =>
  chekt('/ext/v1/events-video-urls', { method: 'POST', body: { event_ids: eventIds } });

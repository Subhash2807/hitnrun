'use strict';

/**
 * Source-cURL syncing.
 *
 * The problem this solves: you grab a fresh cURL out of browser DevTools, and a
 * few hours later its session headers expire. Rather than re-pasting headers
 * into every request by hand, an environment holds one "source cURL" and every
 * request can be re-pointed at it.
 *
 * Sync semantics (chosen deliberately — see README):
 *   headers — the request's headers are REPLACED by the source's set, except
 *             Content-Type / Content-Length, which the request keeps when it
 *             has a body so JSON payloads don't break.
 *   url     — the origin (scheme + host + port) is replaced by the source's.
 *             Path, query params, path variables, method and body are untouched.
 *   auth    — if the source carries an Authorization header, the request's own
 *             auth is set to None so the two can't emit conflicting headers.
 *
 * Scope is always the caller's choice (one request, or a folder/collection), so
 * rewriting the origin unconditionally is safe: you decide what gets touched.
 */

const { parseCurl } = require('./curl');

/** Headers that belong to the request's own body, not to the session. */
const BODY_HEADERS = new Set(['content-type', 'content-length']);

/** Split a URL into scheme://authority and everything after it. */
function splitUrl(url) {
  const match = String(url || '').match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/);
  if (!match) return null;
  return { scheme: match[1], authority: match[2], rest: match[3] || '' };
}

/** "https://www.google.com:8443" for a URL, or null if it has no parseable origin. */
function originOf(url) {
  const parts = splitUrl(url);
  return parts ? parts.scheme + parts.authority : null;
}

/**
 * Turn a pasted cURL command into a stored source.
 *
 * parseCurl lifts `Authorization: Bearer x` out into an auth object; for a
 * source we want it back as a plain header, since that is what gets copied onto
 * requests.
 */
function parseSource(curlText) {
  const parsed = parseCurl(curlText);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const request = parsed.request;
  const headers = (request.headers || [])
    .filter((h) => h.key)
    .map((h) => ({ key: h.key, value: h.value ?? '' }));

  const auth = request.auth || {};
  if (auth.type === 'bearer' && auth.token) {
    headers.push({ key: 'Authorization', value: `Bearer ${auth.token}` });
  } else if (auth.type === 'basic') {
    const raw = `${auth.username ?? ''}:${auth.password ?? ''}`;
    headers.push({ key: 'Authorization', value: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` });
  }

  const origin = originOf(request.url);
  if (!origin) return { ok: false, error: 'Could not read a host from that cURL command' };

  return {
    ok: true,
    source: {
      curl: String(curlText).trim(),
      headers,
      origin,
      method: request.method,
      capturedAt: Date.now(),
    },
  };
}

/**
 * Compute what a request should look like after syncing.
 * Pure — returns a patch, applies nothing.
 */
function buildPatch(request, source) {
  const patch = {};

  const hasBody = !!(request.body && request.body.mode && request.body.mode !== 'none');
  const sourceKeys = new Set(source.headers.map((h) => h.key.toLowerCase()));

  const headers = source.headers.map((h) => ({
    key: h.key,
    value: h.value ?? '',
    description: '',
    enabled: true,
  }));

  // A request with a body keeps its own Content-Type / Content-Length: the
  // browser's source request almost never has the right one for our payload.
  if (hasBody) {
    for (const own of request.headers || []) {
      if (own.enabled === false || !own.key) continue;
      const key = own.key.toLowerCase();
      if (!BODY_HEADERS.has(key)) continue;

      const existing = headers.findIndex((h) => h.key.toLowerCase() === key);
      const kept = { key: own.key, value: own.value ?? '', description: own.description || '', enabled: true };
      if (existing === -1) headers.unshift(kept);
      else headers[existing] = kept;
    }
  }
  patch.headers = headers;

  // Swap the origin, keep everything after it. A URL built on a variable
  // (`{{base}}/v2/orders`) has no parseable origin, so it is left alone.
  const parts = splitUrl(request.url);
  if (parts && source.origin) patch.url = source.origin + parts.rest;

  // Two Authorization headers would be ambiguous — the source wins.
  if (sourceKeys.has('authorization') && request.auth && request.auth.type !== 'none') {
    patch.auth = { type: 'none' };
  }

  return patch;
}

const normalizeHeaders = (rows) =>
  (rows || [])
    .filter((r) => r.enabled !== false && r.key)
    .map((r) => [r.key.toLowerCase().trim(), String(r.value ?? '').trim()])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));

/**
 * Is this request currently in sync with the source?
 * Returns { state, changes } where state is one of:
 *   no-source | exempt | synced | drifted
 */
function syncState(request, source) {
  if (request?.settings?.syncExempt) return { state: 'exempt', changes: [] };
  if (!source || !Array.isArray(source.headers) || !source.headers.length) {
    return { state: 'no-source', changes: [] };
  }

  const patch = buildPatch(request, source);
  const changes = [];

  if (JSON.stringify(normalizeHeaders(request.headers)) !== JSON.stringify(normalizeHeaders(patch.headers))) {
    changes.push('headers');
  }
  if (patch.url && patch.url !== request.url) changes.push('host');
  if (patch.auth && request.auth && request.auth.type !== 'none') changes.push('auth');

  return { state: changes.length ? 'drifted' : 'synced', changes };
}

/** Human-readable summary of what a sync would change, for tooltips. */
function describeChanges(request, source) {
  const { state, changes } = syncState(request, source);
  if (state !== 'drifted') return [];

  const out = [];
  if (changes.includes('host')) {
    out.push(`Host: ${originOf(request.url) || '(none)'} → ${source.origin}`);
  }
  if (changes.includes('headers')) {
    const patch = buildPatch(request, source);
    const before = new Map(normalizeHeaders(request.headers));
    const after = new Map(normalizeHeaders(patch.headers));
    let added = 0;
    let updated = 0;
    let removed = 0;
    for (const [k, v] of after) {
      if (!before.has(k)) added++;
      else if (before.get(k) !== v) updated++;
    }
    for (const k of before.keys()) if (!after.has(k)) removed++;

    const bits = [];
    if (updated) bits.push(`${updated} updated`);
    if (added) bits.push(`${added} added`);
    if (removed) bits.push(`${removed} removed`);
    out.push(`Headers: ${bits.join(', ')}`);
  }
  if (changes.includes('auth')) out.push('Auth: set to None (source carries Authorization)');
  return out;
}

module.exports = { parseSource, buildPatch, syncState, describeChanges, originOf, splitUrl };

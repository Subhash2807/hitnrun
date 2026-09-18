/**
 * Keeps the URL bar and the Params / Path Variables grids in sync, the way
 * users expect: typing `?a=1` in the URL fills the grid, and editing the grid
 * rewrites the URL.
 */

import { blankRow } from './bulk.js';

function safeDecode(v) {
  try {
    return decodeURIComponent(String(v).replace(/\+/g, ' '));
  } catch {
    return v;
  }
}

/** Build the string shown in the URL bar: base + enabled query params. */
export function composeUrl(base = '', params = []) {
  const enabled = params.filter((p) => p.enabled !== false && (p.key || p.value));
  if (!enabled.length) return base;

  // Don't encode {{vars}} — they must stay readable and get substituted later.
  const encode = (s) =>
    String(s ?? '')
      .split(/(\{\{[^}]*\}\})/g)
      .map((part) => (part.startsWith('{{') ? part : encodeURIComponent(part)))
      .join('');

  const qs = enabled.map((p) => `${encode(p.key)}=${encode(p.value)}`).join('&');
  const [withoutHash, hash] = splitHash(base);
  return `${withoutHash}${withoutHash.includes('?') ? '&' : '?'}${qs}${hash}`;
}

function splitHash(url) {
  const idx = url.indexOf('#');
  return idx === -1 ? [url, ''] : [url.slice(0, idx), url.slice(idx)];
}

/**
 * Split a typed URL into { base, params }.
 * Disabled params from the previous state are preserved — unchecking a param
 * removes it from the URL, and we must not lose it on the next keystroke.
 */
export function decomposeUrl(typed, previousParams = []) {
  const [beforeHash, hash] = splitHash(typed);
  const qIdx = beforeHash.indexOf('?');

  const disabled = previousParams.filter((p) => p.enabled === false && p.key);

  if (qIdx === -1) {
    return { base: beforeHash + hash, params: disabled };
  }

  const base = beforeHash.slice(0, qIdx) + hash;
  const qs = beforeHash.slice(qIdx + 1);

  const descriptions = new Map(previousParams.filter((p) => p.description).map((p) => [p.key, p.description]));

  const params = [];
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    const decodedKey = safeDecode(key);
    params.push({
      key: decodedKey,
      value: safeDecode(value),
      description: descriptions.get(decodedKey) || '',
      enabled: true,
    });
  }

  return { base, params: [...params, ...disabled] };
}

/**
 * Path variables are `:name` segments in the URL. Re-derive them on every URL
 * change, keeping values already typed for names that still exist.
 */
export function syncPathVars(url, previous = []) {
  const [beforeHash] = splitHash(url);
  const beforeQuery = beforeHash.split('?')[0];

  // Skip the scheme so `https://` isn't read as a `:` segment.
  const afterScheme = beforeQuery.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const names = [];
  for (const segment of afterScheme.split('/').slice(1)) {
    const match = segment.match(/^:([A-Za-z0-9_-]+)/);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }

  const existing = new Map(previous.map((p) => [p.key, p]));
  return names.map((name) => existing.get(name) || { key: name, value: '', description: '', enabled: true });
}

export function ensureTrailing(rows) {
  const last = rows[rows.length - 1];
  if (!last || last.key || last.value) return [...rows, blankRow()];
  return rows;
}

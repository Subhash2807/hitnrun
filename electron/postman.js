'use strict';

/**
 * Import a Postman v2.0/v2.1 collection — including the ones hitnrun exports
 * from a test doc — as a hitnrun collection.
 */

const { defaultRequest, uid } = require('./workspace');

function urlString(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (url.raw) return url.raw;
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
  const p = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
  const proto = url.protocol ? `${url.protocol}://` : '';
  return `${proto}${host}${p ? '/' + p : ''}`;
}

/** Split "https://x/y?a=1" into the base URL and a params list, as the editor stores it. */
function splitUrl(raw) {
  const q = raw.indexOf('?');
  if (q === -1) return { url: raw, params: [] };
  const params = raw
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const dec = (s) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      return {
        key: dec(eq === -1 ? pair : pair.slice(0, eq)),
        value: eq === -1 ? '' : dec(pair.slice(eq + 1)),
        description: '',
        enabled: true,
      };
    });
  return { url: raw.slice(0, q), params };
}

const kv = (list) =>
  (list || [])
    .filter((h) => h && h.key)
    .map((h) => ({ key: h.key, value: h.value ?? '', description: h.description || '', enabled: h.disabled !== true }));

function authValue(list, key) {
  if (!Array.isArray(list)) return list?.[key] ?? '';
  return list.find((e) => e.key === key)?.value ?? '';
}

function convertAuth(auth) {
  if (!auth) return { type: 'inherit' };
  if (auth.type === 'noauth') return { type: 'none' };
  if (auth.type === 'bearer') return { type: 'bearer', token: authValue(auth.bearer, 'token') };
  if (auth.type === 'basic') {
    return { type: 'basic', username: authValue(auth.basic, 'username'), password: authValue(auth.basic, 'password') };
  }
  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      key: authValue(auth.apikey, 'key'),
      value: authValue(auth.apikey, 'value'),
      in: authValue(auth.apikey, 'in') === 'query' ? 'query' : 'header',
    };
  }
  return { type: 'inherit' };
}

function convertBody(body) {
  const empty = { mode: 'none', raw: '', rawType: 'json', fields: [], src: '', graphql: { query: '', variables: '' } };
  if (!body || !body.mode) return empty;
  if (body.mode === 'raw') {
    const lang = body.options?.raw?.language;
    const raw = body.raw ?? '';
    const rawType = ['json', 'xml', 'html', 'javascript'].includes(lang) ? lang : /^\s*[[{]/.test(raw) ? 'json' : 'text';
    return { ...empty, mode: 'raw', raw, rawType };
  }
  if (body.mode === 'urlencoded') return { ...empty, mode: 'urlencoded', fields: kv(body.urlencoded) };
  if (body.mode === 'formdata') {
    return {
      ...empty,
      mode: 'form-data',
      fields: (body.formdata || [])
        .filter((f) => f && f.key)
        .map((f) => ({
          key: f.key,
          value: f.type === 'file' ? '' : f.value ?? '',
          type: f.type === 'file' ? 'file' : 'text',
          src: f.type === 'file' ? (Array.isArray(f.src) ? f.src[0] : f.src) || '' : '',
          description: '',
          enabled: f.disabled !== true,
        })),
    };
  }
  if (body.mode === 'graphql') {
    return { ...empty, mode: 'graphql', graphql: { query: body.graphql?.query || '', variables: body.graphql?.variables || '' } };
  }
  return empty;
}

function convertItems(items) {
  const out = [];
  for (const item of items || []) {
    if (Array.isArray(item.item)) {
      out.push({ id: uid('fld'), type: 'folder', name: item.name || 'Folder', items: convertItems(item.item) });
      continue;
    }
    const r = item.request;
    if (!r) continue;
    const request = typeof r === 'string' ? { method: 'GET', url: r } : r;
    const { url, params } = splitUrl(urlString(request.url));
    out.push(
      defaultRequest({
        name: item.name || 'Request',
        method: String(request.method || 'GET').toUpperCase(),
        url,
        params,
        headers: kv(request.header),
        auth: convertAuth(request.auth),
        body: convertBody(request.body),
        description: typeof request.description === 'string' ? request.description : request.description?.content || '',
      })
    );
  }
  return out;
}

function collectionAuth(auth) {
  const converted = convertAuth(auth);
  return converted.type === 'inherit' ? { type: 'none' } : converted;
}

/** Returns { ok, collection } or { ok:false, error }. The collection is not yet saved. */
function importPostman(text) {
  let json;
  try {
    json = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ok: false, error: 'That file is not valid JSON' };
  }
  if (!json || !json.info || !Array.isArray(json.item)) {
    return { ok: false, error: 'That is not a Postman collection (v2.0 or v2.1)' };
  }
  return {
    ok: true,
    collection: {
      id: uid('col'),
      name: json.info.name || 'Imported collection',
      description: typeof json.info.description === 'string' ? json.info.description : '',
      variables: (json.variable || []).filter((v) => v.key).map((v) => ({ key: v.key, value: String(v.value ?? ''), enabled: v.disabled !== true })),
      auth: collectionAuth(json.auth),
      items: convertItems(json.item),
    },
  };
}

module.exports = { importPostman };

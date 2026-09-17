'use strict';

/**
 * Variable resolution ({{name}}) and compilation of a stored request model into
 * the flat spec the HTTP engine wants.
 *
 * Precedence, highest first: environment -> collection -> globals.
 */

const crypto = require('node:crypto');

const DYNAMIC = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000) + 1),
  $randomAlphaNumeric: () => Math.random().toString(36).slice(2, 3),
  $randomBoolean: () => String(Math.random() > 0.5),
};

/** Build a flat lookup of variable name -> value from the workspace. */
function buildScope(state, collection) {
  const scope = new Map();
  for (const g of state.globals || []) {
    if (g.enabled !== false && g.key) scope.set(g.key, g.value ?? '');
  }
  if (collection) {
    for (const v of collection.variables || []) {
      if (v.enabled !== false && v.key) scope.set(v.key, v.value ?? '');
    }
  }
  const env = (state.environments || []).find((e) => e.id === state.activeEnvironmentId);
  if (env) {
    for (const v of env.values || []) {
      if (v.enabled !== false && v.key) scope.set(v.key, v.value ?? '');
    }
  }
  return scope;
}

/**
 * Substitute {{vars}} in a string. Resolves nested references up to `depth`
 * so a variable whose value is itself `{{other}}` works.
 */
function resolveString(input, scope, depth = 5) {
  if (typeof input !== 'string' || !input.includes('{{')) return input;
  let out = input;
  for (let i = 0; i < depth; i++) {
    let replaced = false;
    out = out.replace(/\{\{([^{}]+)\}\}/g, (match, rawName) => {
      const name = rawName.trim();
      if (name in DYNAMIC) {
        replaced = true;
        return DYNAMIC[name]();
      }
      if (scope.has(name)) {
        replaced = true;
        return String(scope.get(name) ?? '');
      }
      return match; // unresolved — leave it visible rather than blanking it
    });
    if (!replaced) break;
  }
  return out;
}

/** Report which {{vars}} a request references and which of those are missing. */
function findUnresolved(request, scope) {
  const seen = new Set();
  const missing = new Set();
  const scan = (v) => {
    if (typeof v !== 'string') return;
    for (const m of v.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const name = m[1].trim();
      seen.add(name);
      if (!(name in DYNAMIC) && !scope.has(name)) missing.add(name);
    }
  };
  const visit = (node) => {
    if (node == null) return;
    if (typeof node === 'string') return scan(node);
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node === 'object') return Object.values(node).forEach(visit);
  };
  visit({
    url: request.url,
    params: request.params,
    pathVars: request.pathVars,
    headers: request.headers,
    auth: request.auth,
    body: request.body,
  });
  return { referenced: [...seen], missing: [...missing] };
}

const RAW_CONTENT_TYPE = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  text: 'text/plain',
  javascript: 'application/javascript',
};

/** Compile a stored request into the wire spec consumed by http-engine.sendRequest. */
function compile(request, state, collection) {
  const scope = buildScope(state, collection);
  const r = (v) => resolveString(v ?? '', scope);

  let url = r(request.url || '').trim();
  for (const pv of request.pathVars || []) {
    if (!pv.key) continue;
    url = url.split(`:${pv.key}`).join(encodeURIComponent(r(pv.value ?? '')));
  }
  if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = 'http://' + url;

  const query = (request.params || [])
    .filter((p) => p.enabled !== false && p.key)
    .map((p) => [r(p.key), r(p.value ?? '')]);

  const headers = (request.headers || [])
    .filter((h) => h.enabled !== false && h.key)
    .map((h) => [r(h.key), r(h.value ?? '')]);

  // `inherit` walks up to the collection's auth.
  let auth = request.auth || { type: 'none' };
  if (auth.type === 'inherit') auth = collection?.auth || { type: 'none' };
  auth = JSON.parse(JSON.stringify(auth));
  for (const key of ['token', 'username', 'password', 'key', 'value']) {
    if (typeof auth[key] === 'string') auth[key] = r(auth[key]);
  }

  const model = request.body || { mode: 'none' };
  let body = { type: 'none' };

  if (model.mode === 'raw') {
    body = { type: 'text', text: r(model.raw || ''), contentType: RAW_CONTENT_TYPE[model.rawType || 'text'] };
  } else if (model.mode === 'graphql') {
    let variables;
    const rawVars = r(model.graphql?.variables || '');
    if (rawVars.trim()) {
      try {
        variables = JSON.parse(rawVars);
      } catch {
        variables = undefined;
      }
    }
    body = {
      type: 'text',
      text: JSON.stringify({ query: r(model.graphql?.query || ''), variables }),
      contentType: 'application/json',
    };
  } else if (model.mode === 'urlencoded') {
    body = {
      type: 'urlencoded',
      fields: (model.fields || [])
        .filter((f) => f.enabled !== false && f.key)
        .map((f) => ({ key: r(f.key), value: r(f.value ?? ''), enabled: true })),
    };
  } else if (model.mode === 'form-data') {
    body = {
      type: 'form',
      fields: (model.fields || [])
        .filter((f) => f.enabled !== false && f.key)
        .map((f) => ({
          key: r(f.key),
          value: r(f.value ?? ''),
          type: f.type === 'file' ? 'file' : 'text',
          src: f.src,
          contentType: f.contentType,
          enabled: true,
        })),
    };
  } else if (model.mode === 'file') {
    body = { type: 'file', src: model.src };
  }

  const s = state.settings || {};
  const rs = request.settings || {};

  return {
    spec: {
      method: (request.method || 'GET').toUpperCase(),
      url,
      query,
      headers,
      auth,
      body,
      options: {
        timeout: rs.timeout ?? s.timeout ?? 0,
        followRedirects: rs.followRedirects ?? s.followRedirects ?? true,
        maxRedirects: s.maxRedirects ?? 10,
        rejectUnauthorized: (rs.sslVerify ?? s.sslVerify ?? true) !== false,
      },
    },
    scope,
    unresolved: findUnresolved(request, scope),
  };
}

module.exports = { compile, buildScope, resolveString, findUnresolved, DYNAMIC };

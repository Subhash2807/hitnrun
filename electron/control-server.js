'use strict';

/**
 * Agent control server.
 *
 * A loopback-only HTTP API that lets Claude Code (or any terminal agent) drive
 * the running app: create a request from a cURL string, patch a header it got
 * wrong, duplicate it, send it, read the decoded response.
 *
 * Bound to 127.0.0.1 so nothing off-machine can reach it. Set a token in
 * Settings if you want an extra lock; it is off by default for local use.
 */

const http = require('node:http');
const { parseCurl, toCurl } = require('./curl');
const { execute } = require('./runner');
const { buildScope } = require('./resolve');
const { defaultRequest } = require('./workspace');

class ControlServer {
  constructor({ workspace, onEvent }) {
    this.workspace = workspace;
    this.onEvent = onEvent || (() => {});
    this.server = null;
    this.port = null;
  }

  start(port = 47600) {
    return new Promise((resolve) => {
      if (this.server) return resolve({ ok: true, port: this.port });

      this.server = http.createServer((req, res) => this._handle(req, res));

      this.server.on('error', (err) => {
        this.server = null;
        resolve({ ok: false, error: err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message });
      });

      this.server.listen(port, '127.0.0.1', () => {
        this.port = port;
        resolve({ ok: true, port });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        this.port = null;
        resolve();
      });
    });
  }

  async _handle(req, res) {
    const send = (status, payload) => {
      const body = JSON.stringify(payload ?? null, null, 2);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    };

    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const segments = url.pathname.split('/').filter(Boolean);
      const method = req.method.toUpperCase();

      // Optional shared secret.
      const token = this.workspace.getState().settings?.controlServer?.token;
      if (token) {
        const provided =
          (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-client-token'];
        if (provided !== token) return send(401, { error: 'Invalid or missing control token' });
      }

      const body = await readJson(req);
      if (body === INVALID_JSON) return send(400, { error: 'Request body is not valid JSON' });

      const result = await this._route(method, segments, url, body, send);
      if (result !== undefined) send(result.status ?? 200, result.body);
    } catch (err) {
      send(500, { error: err?.message || String(err), stack: err?.stack });
    }
  }

  async _route(method, seg, url, body, send) {
    const ws = this.workspace;
    const [root, id, action] = seg;

    /* --------------------------------------------------------- discovery */
    if (!root) {
      return {
        body: {
          name: 'API Client control server',
          version: 1,
          docs: 'Every endpoint takes and returns JSON. Bodies accept either a full request model or { "curl": "..." }.',
          endpoints: {
            'GET /health': 'liveness check',
            'GET /state': 'entire workspace',
            'GET /collections': 'list collections',
            'POST /collections': '{ name } -> create',
            'DELETE /collections/:id': 'delete a collection',
            'POST /collections/:id/folders': '{ name } -> create folder',
            'GET /requests': 'flat list of every saved request',
            'GET /requests/:id': 'one request (add ?curl=1 for its cURL form)',
            'POST /requests': '{ curl } or { collectionId, name, method, url, headers, params, body } -> create + autosave',
            'PATCH /requests/:id': 'partial update; { curl } replaces the whole request',
            'POST /requests/:id/duplicate': 'duplicate in place',
            'DELETE /requests/:id': 'delete',
            'POST /requests/:id/send': 'run it, returns decoded response + test results',
            'POST /send': '{ curl } or a request model -> run without saving',
            'POST /curl/parse': '{ curl } -> parsed request model, nothing saved',
            'GET /environments': 'list environments',
            'POST /environments': '{ name, values:[{key,value}] }',
            'PATCH /environments/:id': 'update',
            'POST /environments/:id/activate': 'make active',
            'GET /variables': 'resolved variable scope',
            'PUT /variables/:key': '{ value, scope: environment|globals }',
            'GET /history': 'recent runs (?limit=)',
            'POST /ui/open': '{ requestId } -> open it in a tab and focus the window',
          },
        },
      };
    }

    if (root === 'health') return { body: { ok: true, port: this.port, requests: countRequests(ws) } };
    if (root === 'state') return { body: ws.getState() };

    /* ------------------------------------------------------- collections */
    if (root === 'collections') {
      if (method === 'GET' && !id) {
        return { body: ws.getState().collections.map(summarizeCollection) };
      }
      if (method === 'POST' && !id) {
        const c = ws.createCollection(body?.name || 'New Collection');
        return { status: 201, body: summarizeCollection(c) };
      }
      if (method === 'PATCH' && id) {
        const c = ws.updateCollection(id, body || {});
        return c ? { body: summarizeCollection(c) } : { status: 404, body: { error: 'Collection not found' } };
      }
      if (method === 'DELETE' && id) {
        return ws.deleteCollection(id) ? { body: { deleted: true } } : { status: 404, body: { error: 'Collection not found' } };
      }
      if (method === 'POST' && id && action === 'folders') {
        const f = ws.createFolder(id, body?.name || 'New Folder');
        return f ? { status: 201, body: f } : { status: 404, body: { error: 'Collection not found' } };
      }
    }

    /* ---------------------------------------------------------- requests */
    if (root === 'requests') {
      if (method === 'GET' && !id) {
        const out = [];
        for (const hit of ws.walk()) {
          if (hit.request) out.push(summarizeRequest(hit.request, hit.collection, hit.parent));
        }
        return { body: out };
      }

      if (method === 'GET' && id) {
        const hit = ws.findRequest(id);
        if (!hit) return { status: 404, body: { error: 'Request not found' } };
        const payload = { ...hit.request, collectionId: hit.collection.id, collectionName: hit.collection.name };
        if (url.searchParams.get('curl')) payload.curl = toCurl(hit.request);
        return { body: payload };
      }

      if (method === 'POST' && !id) {
        let fields;
        if (body?.curl) {
          const parsed = parseCurl(body.curl);
          if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
          fields = parsed.request;
          if (body.name) fields.name = body.name;
        } else {
          fields = pickRequestFields(body || {});
        }
        const container = body?.folderId || body?.collectionId;
        const created = ws.createRequest(container, fields);
        this.onEvent({ type: 'request:created', requestId: created.id, open: body?.open !== false });
        return { status: 201, body: { ...created, curl: toCurl(created) } };
      }

      if (method === 'PATCH' && id) {
        const hit = ws.findRequest(id);
        if (!hit) return { status: 404, body: { error: 'Request not found' } };
        let patch;
        if (body?.curl) {
          const parsed = parseCurl(body.curl);
          if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
          patch = parsed.request;
          delete patch.name; // keep the name the user gave it
        } else {
          patch = pickRequestFields(body || {});
        }
        const updated = ws.updateRequest(id, patch);
        this.onEvent({ type: 'request:updated', requestId: id });
        return { body: { ...updated, curl: toCurl(updated) } };
      }

      if (method === 'POST' && id && action === 'duplicate') {
        const clone = ws.duplicateRequest(id);
        if (!clone) return { status: 404, body: { error: 'Request not found' } };
        this.onEvent({ type: 'request:created', requestId: clone.id, open: body?.open !== false });
        return { status: 201, body: clone };
      }

      if (method === 'DELETE' && id) {
        const ok = ws.deleteRequest(id);
        this.onEvent({ type: 'request:deleted', requestId: id });
        return ok ? { body: { deleted: true } } : { status: 404, body: { error: 'Request not found' } };
      }

      if (method === 'POST' && id && action === 'send') {
        const hit = ws.findRequest(id);
        if (!hit) return { status: 404, body: { error: 'Request not found' } };
        this.onEvent({ type: 'request:sending', requestId: id });
        const result = await execute(ws, hit.request, { collection: hit.collection });
        this.onEvent({ type: 'request:result', requestId: id, result });
        return { body: presentResult(result) };
      }
    }

    /* ------------------------------------------------------------- ad hoc */
    if (root === 'send' && method === 'POST') {
      let fields;
      if (body?.curl) {
        const parsed = parseCurl(body.curl);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        fields = parsed.request;
      } else {
        fields = pickRequestFields(body || {});
      }
      const ephemeral = defaultRequest(fields);
      const result = await execute(ws, ephemeral, { collection: null, recordHistory: true });
      this.onEvent({ type: 'adhoc:result', result });
      return { body: presentResult(result) };
    }

    if (root === 'curl' && id === 'parse' && method === 'POST') {
      const parsed = parseCurl(body?.curl || '');
      return parsed.ok ? { body: parsed.request } : { status: 400, body: { error: parsed.error } };
    }

    /* ------------------------------------------------------ environments */
    if (root === 'environments') {
      if (method === 'GET' && !id) {
        return {
          body: ws.getState().environments.map((e) => ({
            ...e,
            active: e.id === ws.getState().activeEnvironmentId,
          })),
        };
      }
      if (method === 'POST' && !id) {
        const env = ws.createEnvironment(body?.name || 'New Environment', normalizeVars(body?.values));
        return { status: 201, body: env };
      }
      if (method === 'PATCH' && id) {
        const patch = { ...body };
        if (patch.values) patch.values = normalizeVars(patch.values);
        const env = ws.updateEnvironment(id, patch);
        return env ? { body: env } : { status: 404, body: { error: 'Environment not found' } };
      }
      if (method === 'DELETE' && id) {
        return ws.deleteEnvironment(id) ? { body: { deleted: true } } : { status: 404, body: { error: 'Environment not found' } };
      }
      if (method === 'POST' && id && action === 'activate') {
        ws.setActiveEnvironment(id);
        return { body: { activeEnvironmentId: id } };
      }
    }

    /* --------------------------------------------------------- variables */
    if (root === 'variables') {
      if (method === 'GET') {
        const scope = buildScope(ws.getState(), null);
        return { body: Object.fromEntries(scope) };
      }
      if (method === 'PUT' && id) {
        const ok = ws.setVariable(body?.scope === 'globals' ? 'globals' : 'environment', id, body?.value ?? '');
        return ok
          ? { body: { key: id, value: body?.value ?? '' } }
          : { status: 400, body: { error: 'No active environment. Activate one first or use scope "globals".' } };
      }
    }

    /* ----------------------------------------------------------- history */
    if (root === 'history') {
      if (method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 50;
        return { body: ws.getState().history.slice(0, limit).map(({ snapshot, ...rest }) => rest) };
      }
      if (method === 'DELETE') {
        ws.clearHistory();
        return { body: { cleared: true } };
      }
    }

    /* ---------------------------------------------------------------- ui */
    if (root === 'ui' && id === 'open' && method === 'POST') {
      this.onEvent({ type: 'ui:open', requestId: body?.requestId, focus: true });
      return { body: { opened: body?.requestId } };
    }

    return { status: 404, body: { error: `No route for ${method} /${seg.join('/')}` } };
  }
}

/* ------------------------------------------------------------- helpers */

const INVALID_JSON = Symbol('invalid-json');

function readJson(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(null);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) req.destroy();
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(INVALID_JSON);
      }
    });
    req.on('error', () => resolve(null));
  });
}

const REQUEST_FIELDS = ['name', 'method', 'url', 'params', 'pathVars', 'headers', 'auth', 'body', 'scripts', 'settings', 'description'];

function pickRequestFields(source) {
  const out = {};
  for (const key of REQUEST_FIELDS) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

function normalizeVars(values) {
  if (!Array.isArray(values)) {
    // Accept { key: value } objects too — friendlier for agents.
    if (values && typeof values === 'object') {
      return Object.entries(values).map(([key, value]) => ({ key, value: String(value), enabled: true }));
    }
    return [];
  }
  return values.map((v) => ({ key: v.key, value: v.value ?? '', enabled: v.enabled !== false }));
}

function summarizeCollection(c) {
  return { id: c.id, name: c.name, description: c.description, variables: c.variables, itemCount: c.items.length };
}

function summarizeRequest(r, collection, parent) {
  return {
    id: r.id,
    name: r.name,
    method: r.method,
    url: r.url,
    collectionId: collection.id,
    collectionName: collection.name,
    folderId: parent.id === collection.id ? null : parent.id,
    folderName: parent.id === collection.id ? null : parent.name,
    updatedAt: r.updatedAt,
  };
}

/** Decode the response body so agents get readable text/JSON, not base64. */
function presentResult(result) {
  if (!result.response) return result;
  const res = result.response;
  if (res.error) {
    return { ok: false, error: res.error, request: result.request, timeMs: result.timeMs, scriptLogs: result.scriptLogs };
  }

  const buf = Buffer.from(res.bodyBase64 || '', 'base64');
  const headers = Object.fromEntries(res.headers || []);
  const contentType = (headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
  const isText =
    !contentType ||
    /json|text|xml|javascript|urlencoded|html|csv|yaml/.test(contentType);

  const out = {
    ok: res.status >= 200 && res.status < 400,
    status: res.status,
    statusText: res.statusText,
    timeMs: res.timeMs,
    size: res.size,
    headers,
    redirects: res.redirects,
    finalUrl: res.finalUrl,
    request: result.request,
    tests: result.tests,
    scriptLogs: result.scriptLogs,
    unresolvedVariables: result.unresolved?.missing || [],
  };

  if (isText) {
    const text = buf.toString('utf8');
    out.body = text.length > 1_000_000 ? text.slice(0, 1_000_000) + '\n...[truncated]' : text;
    if (/json/.test(contentType) || /^\s*[[{]/.test(text)) {
      try {
        out.json = JSON.parse(text);
      } catch {
        /* not JSON after all */
      }
    }
  } else {
    out.body = null;
    out.bodyBase64 = buf.length < 2_000_000 ? buf.toString('base64') : null;
    out.note = 'Binary response omitted from text body';
  }

  return out;
}

function countRequests(ws) {
  let n = 0;
  for (const hit of ws.walk()) if (hit.request) n++;
  return n;
}

module.exports = { ControlServer };

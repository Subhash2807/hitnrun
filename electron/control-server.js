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
const { parseSource, buildPatch, syncState, describeChanges } = require('./sync');

class ControlServer {
  constructor({ workspace, aiWorkspace, docs = null, environmentName = null, onEvent }) {
    this.workspace = workspace;
    this.aiWorkspace = aiWorkspace;
    this.docs = docs;
    this.environmentName = environmentName || (() => null);
    this.onEvent = onEvent || (() => {});
    this.server = null;
    this.port = null;
  }

  /** The AI guardrail policy, as configured in Settings. */
  _policy() {
    return this.workspace.getState().settings?.aiPolicy || {};
  }

  /**
   * Writes to the USER workspace are refused by default. AI sessions have their
   * own workspace; this is the wall between them. The user can lower it in
   * Settings when they deliberately want an agent editing their requests.
   */
  _userWritesAllowed() {
    return this.workspace.getState().settings?.allowAgentUserWrites === true;
  }

  /**
   * Offer a send made through this server to the test-doc recording. Lands when
   * recording in auto mode, or when the caller asked for it with `record: true`.
   * Returns a short note for the response, or null when nothing was recorded.
   */
  _record(result, { force = false, requestId = null } = {}) {
    if (!this.docs || !result) return null;
    const rec = this.docs.recording();
    if (!rec) return force ? { recorded: false, reason: 'No recording is running. Start one with POST /docs/recording.' } : null;
    const step = force
      ? rec.paused
        ? null
        : this.docs.addStep(rec.docId, result, { source: 'ai', requestId, environment: this.environmentName() })
      : this.docs.capture(result, { source: 'ai', requestId, environment: this.environmentName() });
    if (step) return { recorded: true, docId: rec.docId, docName: rec.name, stepId: step.id };
    return force ? { recorded: false, reason: 'The recording is paused.' } : null;
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
          (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-hitnrun-token'];
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
          name: 'hitnrun control server',
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
            'PUT /sync/source': '{ curl, environmentId? } -> set the environment source cURL (omit curl to clear)',
            'GET /sync/source': 'the active environment source cURL',
            'GET /sync/status': 'which requests are in sync / drifted',
            'POST /requests/:id/sync': 'pull headers + host from the source cURL',
            'POST /collections/:id/sync': 'sync every request in a collection or folder',
            'POST /ui/open': '{ requestId } -> open it in a tab and focus the window',
            'GET /docs': 'test docs (summaries) and the current recording',
            'GET /docs/:id': 'one doc with every step (?bodies=full for untruncated bodies)',
            'PATCH /docs/:id': '{ name?, description? }',
            'PATCH /docs/:id/steps/:stepId': '{ title?, note?, expected?, status: untested|pass|fail }',
            'DELETE /docs/:id/steps/:stepId': 'remove a step',
            'POST /docs/:id/steps/:stepId/move': '{ index } -> move to a zero-based position',
            'GET /docs/recording': 'the current recording, or null',
            'POST /docs/recording': '{ name, mode: auto|manual, docId? } -> start (or resume docId)',
            'PATCH /docs/recording': '{ mode?, paused? }',
            'DELETE /docs/recording': 'stop recording',
          },
        },
      };
    }

    if (root === 'health') return { body: { ok: true, port: this.port, requests: countRequests(ws) } };
    if (root === 'state') return { body: ws.getState() };

    /* ----------------------------------------------------------------- ai */
    if (root === 'ai') return this._routeAi(method, seg, url, body);

    /* ---------------------------------------------------------------- ui */
    // Only focuses a tab — nothing is written — so it sits outside the wall.
    if (root === 'ui' && id === 'open' && method === 'POST') {
      this.onEvent({ type: 'ui:open', requestId: body?.requestId, focus: true });
      return { body: { opened: body?.requestId } };
    }

    /* -------------------------------------------------------------- docs */
    // Test docs live in their own store, and the user has chosen to let agents
    // read and edit them, so they sit outside the user-workspace wall. Deleting
    // a whole doc stays a UI-only action.
    if (root === 'docs') return this._routeDocs(method, seg, url, body);

    // Everything below touches the USER workspace. Reads are always fine;
    // writes need the wall lowered explicitly.
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && !this._userWritesAllowed()) {
      return {
        status: 403,
        body: {
          error:
            'Writing to the user workspace is disabled. AI sessions have their own workspace — use the /ai/* endpoints, ' +
            'or copy what you need with POST /ai/copy. The user can allow direct writes in Settings → AI guardrails.',
          userWritesDisabled: true,
        },
      };
    }

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
        const doc = this._record(result, { force: body?.record === true, requestId: id });
        return { body: withDoc(presentResult(result), doc) };
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
      const doc = this._record(result, { force: body?.record === true });
      return { body: withDoc(presentResult(result), doc) };
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

    /* --------------------------------------------------------------- sync */
    if (root === 'sync') {
      // Refresh the active environment's source cURL — the call an agent makes
      // after grabbing a fresh one out of the browser.
      if (method === 'PUT' && id === 'source') {
        const state = ws.getState();
        const envId = body?.environmentId || state.activeEnvironmentId;
        if (!envId) return { status: 400, body: { error: 'No active environment. Activate one or pass environmentId.' } };

        if (!body?.curl) {
          ws.setEnvironmentSource(envId, null);
          this.onEvent({ type: 'sync:source', environmentId: envId });
          return { body: { cleared: true } };
        }
        const parsed = parseSource(body.curl);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        ws.setEnvironmentSource(envId, parsed.source);
        this.onEvent({ type: 'sync:source', environmentId: envId });
        return {
          body: {
            environmentId: envId,
            origin: parsed.source.origin,
            headerCount: parsed.source.headers.length,
            headers: parsed.source.headers.map((h) => h.key),
          },
        };
      }

      if (method === 'GET' && id === 'source') {
        const source = ws.activeSource();
        return source ? { body: source } : { status: 404, body: { error: 'No source cURL on the active environment' } };
      }

      // Drift report across the whole workspace.
      if (method === 'GET' && id === 'status') {
        const source = ws.activeSource();
        const out = [];
        for (const hit of ws.walk()) {
          if (!hit.request) continue;
          const state = syncState(hit.request, source);
          out.push({
            id: hit.request.id,
            name: hit.request.name,
            collection: hit.collection.name,
            state: state.state,
            changes: state.changes,
          });
        }
        return { body: { hasSource: !!source, origin: source?.origin ?? null, requests: out } };
      }
    }

    if (root === 'requests' && id && action === 'sync' && method === 'POST') {
      const hit = ws.findRequest(id);
      if (!hit) return { status: 404, body: { error: 'Request not found' } };
      const result = this._sync([hit.request]);
      this.onEvent({ type: 'request:updated', requestId: id });
      return result.ok ? { body: result } : { status: 400, body: result };
    }

    if (root === 'collections' && id && action === 'sync' && method === 'POST') {
      const requests = ws.requestsIn(id);
      if (!requests.length) return { status: 404, body: { error: 'No requests in that collection or folder' } };
      const result = this._sync(requests);
      this.onEvent({ type: 'request:updated' });
      return result.ok ? { body: result } : { status: 400, body: result };
    }

    return { status: 404, body: { error: `No route for ${method} /${seg.join('/')}` } };
  }

  /**
   * The AI-facing API. Everything here writes to the AI workspace only; the
   * user's requests are reachable read-only, and by copy.
   */
  async _routeAi(method, seg, url, body) {
    const ai = this.aiWorkspace;
    const [, section, id, action] = seg;

    if (!ai) return { status: 503, body: { error: 'AI workspace is not available' } };

    /* ------------------------------------------------------------ sessions */
    if (section === 'sessions') {
      if (method === 'POST' && !id) {
        const mode = this.workspace.getState().settings?.aiSessionMode || 'per-session';
        const started = ai.startSession({
          client: body?.client || 'agent',
          label: body?.label,
          mode,
        });
        this.onEvent({ type: 'ai:session', sessionId: started.sessionId });
        return {
          status: 201,
          body: {
            ...started,
            policy: this._policy(),
            note:
              'Work only inside this session. You cannot modify the user\'s saved requests; ' +
              'copy anything you need with POST /ai/copy.',
          },
        };
      }
      if (method === 'GET' && !id) return { body: ai.listSessions() };
      if (method === 'DELETE' && id) {
        const done = ai.discardSession(id);
        this.onEvent({ type: 'ai:session' });
        return done ? { body: { discarded: true } } : { status: 404, body: { error: 'Session not found' } };
      }
    }

    /* ----------------------------------------------------------- workspace */
    if (section === 'workspace' && method === 'GET') {
      return { body: { collections: ai.getState().collections, sessions: ai.listSessions() } };
    }

    if (section === 'policy' && method === 'GET') {
      return {
        body: {
          ...this._policy(),
          explanation:
            'These rules apply to AI sessions only. Blocked methods and hosts are refused before the request leaves the machine, including across redirects.',
        },
      };
    }

    /* --------------------------------------------------------------- copy */
    if (section === 'copy' && method === 'POST') {
      if (!body?.sessionId) return { status: 400, body: { error: 'sessionId is required' } };
      if (!body?.sourceId) return { status: 400, body: { error: 'sourceId is required (a request, folder or collection id from the user workspace)' } };
      const result = ai.copyFromUser(body.sessionId, body.sourceId);
      this.onEvent({ type: 'ai:changed' });
      return result.ok ? { status: 201, body: result } : { status: 400, body: result };
    }

    /* ------------------------------------------------------------ folders */
    if (section === 'folders' && method === 'POST') {
      const folder = ai.createFolder(body?.sessionId, body?.name || 'New Folder', body?.folderId);
      if (!folder) return { status: 400, body: { error: 'Unknown AI session' } };
      this.onEvent({ type: 'ai:changed' });
      return { status: 201, body: folder };
    }

    /* ----------------------------------------------------------- requests */
    if (section === 'requests') {
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
        const created = ai.createRequest(body?.sessionId, fields, body?.folderId);
        if (!created) return { status: 400, body: { error: 'Unknown AI session. Call POST /ai/sessions first.' } };
        ai.touchSession(body.sessionId);
        this.onEvent({ type: 'ai:changed' });
        return { status: 201, body: { ...created, curl: toCurl(created) } };
      }

      if (method === 'GET' && id) {
        const hit = ai.findRequest(id);
        return hit ? { body: hit.request } : { status: 404, body: { error: 'Request not found in the AI workspace' } };
      }

      if (method === 'PATCH' && id) {
        const hit = ai.findRequest(id);
        if (!hit) {
          return {
            status: 404,
            body: { error: 'Request not found in the AI workspace. You cannot edit the user\'s requests — copy it first with POST /ai/copy.' },
          };
        }
        let patch;
        if (body?.curl) {
          const parsed = parseCurl(body.curl);
          if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
          patch = parsed.request;
          delete patch.name;
        } else {
          patch = pickRequestFields(body || {});
        }
        const updated = ai.updateRequest(id, patch);
        this.onEvent({ type: 'ai:changed' });
        return { body: updated };
      }

      if (method === 'DELETE' && id) {
        const done = ai.deleteRequest(id);
        this.onEvent({ type: 'ai:changed' });
        return done ? { body: { deleted: true } } : { status: 404, body: { error: 'Request not found in the AI workspace' } };
      }

      if (method === 'POST' && id && action === 'send') {
        const hit = ai.findRequest(id);
        if (!hit) return { status: 404, body: { error: 'Request not found in the AI workspace' } };
        return this._aiSend(hit.request, hit.collection, { record: body?.record === true });
      }
    }

    /* -------------------------------------------------------------- adhoc */
    if (section === 'send' && method === 'POST') {
      let fields;
      if (body?.curl) {
        const parsed = parseCurl(body.curl);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        fields = parsed.request;
      } else {
        fields = pickRequestFields(body || {});
      }
      return this._aiSend(defaultRequest(fields), null, { record: body?.record === true });
    }

    return { status: 404, body: { error: `No AI route for ${method} /${seg.join('/')}` } };
  }

  /** Run a request under AI guardrails, resolving variables from the user's environments. */
  async _aiSend(request, collection, { record = false } = {}) {
    const policy = this._policy();
    const userState = this.workspace.getState();

    const result = await execute(this.aiWorkspace.store, request, {
      collection,
      policy,
      // Read-only view of the user's variables, so copied requests still resolve.
      varSource: {
        globals: [...(userState.globals || []), ...(this.aiWorkspace.getState().globals || [])],
        environments: userState.environments,
        activeEnvironmentId: userState.activeEnvironmentId,
        settings: userState.settings,
      },
    });

    this.onEvent({ type: 'ai:changed' });

    // A send refused by the guardrails never happened, so it is not documented.
    const doc = result.response?.blocked ? null : this._record(result, { force: record, requestId: request.id });

    if (result.response?.blocked) {
      return {
        status: 403,
        body: {
          blocked: true,
          reason: result.response.error.message,
          policy: { blockedHosts: policy.blockedHosts, blockedMethods: policy.blockedMethods },
        },
      };
    }
    return { body: withDoc(presentResult(result), doc) };
  }

  /** Test documentation: read and edit docs, drive the recording. */
  _routeDocs(method, seg, url, body) {
    const docs = this.docs;
    if (!docs) return { status: 503, body: { error: 'Test docs are not available' } };
    const [, id, sub, stepId, action] = seg;

    if (id === 'recording') {
      if (method === 'GET') return { body: docs.recording() };
      if (method === 'POST') {
        if (body?.docId && !docs.get(body.docId)) return { status: 404, body: { error: 'Doc not found' } };
        return { status: 201, body: docs.startRecording({ name: body?.name, description: body?.description, mode: body?.mode, docId: body?.docId }) };
      }
      if (method === 'PATCH') {
        const rec = docs.setRecording(body || {});
        return rec ? { body: rec } : { status: 404, body: { error: 'Nothing is being recorded' } };
      }
      if (method === 'DELETE') {
        return docs.stopRecording() ? { body: { stopped: true } } : { status: 404, body: { error: 'Nothing is being recorded' } };
      }
    }

    if (method === 'GET' && !id) return { body: { docs: docs.list(), recording: docs.recording() } };

    const doc = id ? docs.get(id) : null;
    if (id && !doc) return { status: 404, body: { error: 'Doc not found' } };

    if (!sub) {
      if (method === 'GET') return { body: presentDoc(doc, url.searchParams.get('bodies') === 'full') };
      if (method === 'PATCH') {
        docs.update(id, { name: body?.name, description: body?.description });
        return { body: presentDoc(docs.get(id), false) };
      }
      if (method === 'DELETE') {
        return { status: 403, body: { error: 'Deleting a whole doc is only possible in the app. You can delete individual steps.' } };
      }
    }

    if (sub === 'steps' && stepId) {
      if (!docs.findStep(id, stepId)) return { status: 404, body: { error: 'Step not found in that doc' } };
      if (method === 'PATCH' && !action) {
        if (body?.status && !['untested', 'pass', 'fail'].includes(body.status)) {
          return { status: 400, body: { error: 'status must be untested, pass or fail' } };
        }
        return { body: docs.updateStep(id, stepId, body || {}) };
      }
      if (method === 'DELETE' && !action) return { body: { deleted: docs.deleteStep(id, stepId) } };
      if (method === 'POST' && action === 'move') {
        if (!Number.isInteger(body?.index)) return { status: 400, body: { error: 'index (a zero-based integer) is required' } };
        docs.moveStep(id, stepId, body.index);
        return { body: { order: docs.get(id).steps.map((s) => s.id) } };
      }
    }

    return { status: 404, body: { error: `No docs route for ${method} /${seg.join('/')}` } };
  }

  /** Shared by the per-request and per-collection sync routes. */
  _sync(requests) {
    const source = this.workspace.activeSource();
    if (!source) return { ok: false, error: 'The active environment has no source cURL' };

    const out = { ok: true, origin: source.origin, synced: 0, alreadyInSync: 0, exempt: 0, details: [] };
    for (const request of requests) {
      const before = syncState(request, source);
      if (before.state === 'exempt') {
        out.exempt++;
        out.details.push({ id: request.id, name: request.name, outcome: 'exempt' });
        continue;
      }
      if (before.state === 'synced') {
        out.alreadyInSync++;
        out.details.push({ id: request.id, name: request.name, outcome: 'already-in-sync' });
        continue;
      }
      const changes = describeChanges(request, source);
      this.workspace.applySyncPatch(request.id, buildPatch(request, source));
      out.synced++;
      out.details.push({ id: request.id, name: request.name, outcome: 'synced', changes });
    }
    return out;
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

function withDoc(payload, doc) {
  return doc ? { ...payload, doc } : payload;
}

// Enough of each body for an agent to write notes about, without flooding it.
const AGENT_BODY_CHARS = 8000;

function presentDoc(doc, fullBodies) {
  const cut = (text) =>
    text == null || fullBodies || text.length <= AGENT_BODY_CHARS
      ? text
      : `${text.slice(0, AGENT_BODY_CHARS)}\n...[${text.length - AGENT_BODY_CHARS} more characters — ask with ?bodies=full]`;
  return {
    ...doc,
    steps: doc.steps.map((s, index) => ({
      index,
      ...s,
      request: { ...s.request, body: cut(s.request.body) },
      response: s.response ? { ...s.response, body: cut(s.response.body) } : null,
    })),
  };
}

function countRequests(ws) {
  let n = 0;
  for (const hit of ws.walk()) if (hit.request) n++;
  return n;
}

module.exports = { ControlServer };

'use strict';

/**
 * Orchestrates one request execution:
 *   resolve variables -> pre-request script -> re-resolve -> send -> tests -> history
 *
 * The re-resolve step matters: a pre-request script that calls
 * pm.environment.set() must affect the request that actually goes out.
 */

const { compile, buildScope, resolveString } = require('./resolve');
const { sendRequest } = require('./http-engine');
const { runScript } = require('./scripts');

function makeHandlers(workspace, collection, extraHeaders) {
  const state = workspace.getState();

  const activeEnv = () => state.environments.find((e) => e.id === state.activeEnvironmentId);

  const listFor = (scope) => {
    if (scope === 'globals') return state.globals;
    if (scope === 'collection') return collection?.variables;
    return activeEnv()?.values;
  };

  return {
    getVar(scope, key) {
      if (scope === 'any') {
        for (const s of ['environment', 'collection', 'globals']) {
          const v = this.getVar(s, key);
          if (v !== undefined) return v;
        }
        return undefined;
      }
      const list = listFor(scope);
      const row = list?.find((v) => v.key === key && v.enabled !== false);
      return row ? row.value : undefined;
    },
    setVar(scope, key, value) {
      const list = listFor(scope);
      if (!list) return false;
      const row = list.find((v) => v.key === key);
      if (row) row.value = value;
      else list.push({ key, value, enabled: true });
      workspace.touch('variables:update');
      return true;
    },
    unsetVar(scope, key) {
      const list = listFor(scope);
      if (!list) return false;
      const idx = list.findIndex((v) => v.key === key);
      if (idx !== -1) {
        list.splice(idx, 1);
        workspace.touch('variables:update');
      }
      return true;
    },
    allVars(scope) {
      const list = listFor(scope) || [];
      return Object.fromEntries(list.filter((v) => v.enabled !== false).map((v) => [v.key, v.value]));
    },
    clearVars(scope) {
      const list = listFor(scope);
      if (list) {
        list.length = 0;
        workspace.touch('variables:update');
      }
    },
    replaceIn(template) {
      return resolveString(template, buildScope(workspace.getState(), collection));
    },
    addRequestHeader(key, value) {
      if (key) extraHeaders.push([String(key), String(value ?? '')]);
    },
  };
}

/**
 * Run a request. Resolves to a result envelope; transport failures come back
 * as `response.error` rather than a thrown exception.
 */
async function execute(workspace, request, { collection = null, onProgress, recordHistory = true } = {}) {
  const startedAt = Date.now();
  const extraHeaders = [];
  const handlers = makeHandlers(workspace, collection, extraHeaders);

  // First pass gives the pre-request script a view of the request.
  const first = compile(request, workspace.getState(), collection);

  const pre = runScript(request.scripts?.pre, {
    request: {
      id: request.id,
      name: request.name,
      method: first.spec.method,
      url: first.spec.url,
      headers: first.spec.headers,
      bodyText: first.spec.body?.text,
    },
    response: null,
    handlers,
  });

  if (pre.error) {
    return {
      ok: false,
      phase: 'pre-request',
      error: pre.error,
      scriptLogs: pre.logs,
      tests: [],
      timeMs: Date.now() - startedAt,
    };
  }

  // Second pass picks up any variables the pre-request script wrote.
  const { spec, unresolved } = compile(request, workspace.getState(), collection);
  spec.headers.push(...extraHeaders);

  if (!spec.url) {
    return {
      ok: false,
      phase: 'request',
      error: { message: 'Enter a URL before sending', code: 'ERR_NO_URL' },
      scriptLogs: pre.logs,
      tests: [],
      timeMs: 0,
    };
  }

  const response = await sendRequest(spec, { onProgress });

  let post = { logs: [], tests: [], error: null };
  if (!response.error) {
    post = runScript(request.scripts?.test, {
      request: { id: request.id, name: request.name, method: spec.method, url: spec.url, headers: spec.headers },
      response,
      handlers,
    });
  }

  const result = {
    ok: !response.error,
    request: {
      id: request.id,
      name: request.name,
      method: spec.method,
      url: spec.url,
      headers: spec.headers,
      bodyPreview: spec.body?.text ?? null,
    },
    response,
    tests: post.tests,
    scriptLogs: [...pre.logs, ...post.logs],
    scriptError: post.error,
    unresolved,
    timeMs: Date.now() - startedAt,
  };

  if (recordHistory) {
    workspace.addHistory({
      requestId: request.id,
      name: request.name,
      method: spec.method,
      url: spec.url,
      status: response.status ?? null,
      statusText: response.statusText ?? null,
      timeMs: response.timeMs ?? null,
      size: response.size?.decoded ?? null,
      error: response.error?.message ?? null,
      snapshot: JSON.parse(JSON.stringify(request)),
    });
  }

  return result;
}

module.exports = { execute };

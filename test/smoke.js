'use strict';

/**
 * Headless smoke test for everything that lives in the main process.
 * Run with: node test/smoke.js
 *
 * Spins up a throwaway HTTP server, drives the real engine against it, and
 * exercises the agent control API end to end.
 */

const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { parseCurl, toCurl } = require('../electron/curl');
const { Workspace, defaultRequest } = require('../electron/workspace');
const { compile } = require('../electron/resolve');
const { execute } = require('../electron/runner');
const { ControlServer } = require('../electron/control-server');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed++;
      failures.push({ name, err });
      console.log(`  FAIL ${name}\n       ${err.message}`);
    });
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------ fixtures */

function startEchoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/redirect') {
          res.writeHead(302, { Location: '/landed' });
          return res.end();
        }
        if (url.pathname === '/landed') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ landed: true }));
        }
        if (url.pathname === '/status/500') {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('boom');
        }
        if (url.pathname === '/cookie') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': ['a=1; Path=/; HttpOnly', 'b=2; Path=/x'],
          });
          return res.end('{}');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: req.headers,
            body: body.toString('utf8'),
          })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function tempWorkspace() {
  const file = path.join(os.tmpdir(), `apiclient-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const ws = new Workspace(file);
  ws.load();
  ws.saveNow = () => {}; // don't touch disk during tests
  ws.scheduleSave = () => {};
  return { ws, file };
}

async function callApi(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* leave null */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------------------------------------------------------------- main */

(async () => {
  const { server, port } = await startEchoServer();
  const origin = `http://127.0.0.1:${port}`;

  /* ============================================================== cURL */
  section('cURL parsing');

  await test('parses a simple GET', () => {
    const r = parseCurl(`curl https://api.example.com/users`);
    assert.ok(r.ok);
    assert.equal(r.request.method, 'GET');
    assert.equal(r.request.url, 'https://api.example.com/users');
  });

  await test('parses method, headers and a JSON body', () => {
    const r = parseCurl(`curl -X POST 'https://api.example.com/login' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Trace: abc' \\
  -d '{"user":"me","pass":"secret"}'`);
    assert.ok(r.ok);
    const req = r.request;
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.length, 2);
    assert.equal(req.body.mode, 'raw');
    assert.equal(req.body.rawType, 'json');
    assert.deepEqual(JSON.parse(req.body.raw), { user: 'me', pass: 'secret' });
  });

  await test('infers POST when a body is present without -X', () => {
    const r = parseCurl(`curl https://x.com/a -d 'hello=world'`);
    assert.equal(r.request.method, 'POST');
  });

  await test('splits the query string into params', () => {
    const r = parseCurl(`curl 'https://x.com/search?q=hello%20world&page=2'`);
    assert.equal(r.request.url, 'https://x.com/search');
    assert.deepEqual(
      r.request.params.map((p) => [p.key, p.value]),
      [['q', 'hello world'], ['page', '2']]
    );
  });

  await test('extracts bearer auth out of the header', () => {
    const r = parseCurl(`curl https://x.com -H 'Authorization: Bearer tok_123'`);
    assert.equal(r.request.auth.type, 'bearer');
    assert.equal(r.request.auth.token, 'tok_123');
    assert.equal(r.request.headers.length, 0);
  });

  await test('handles -u basic auth', () => {
    const r = parseCurl(`curl -u admin:hunter2 https://x.com`);
    assert.equal(r.request.auth.type, 'basic');
    assert.equal(r.request.auth.username, 'admin');
    assert.equal(r.request.auth.password, 'hunter2');
  });

  await test('handles multipart -F including files', () => {
    const r = parseCurl(`curl -F 'name=jane' -F 'avatar=@/tmp/a.png' https://x.com/upload`);
    assert.equal(r.request.body.mode, 'form-data');
    assert.equal(r.request.body.fields[0].value, 'jane');
    assert.equal(r.request.body.fields[1].type, 'file');
    assert.equal(r.request.body.fields[1].src, '/tmp/a.png');
  });

  await test('handles urlencoded bodies', () => {
    const r = parseCurl(`curl -X POST https://x.com -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1&b=two'`);
    assert.equal(r.request.body.mode, 'urlencoded');
    assert.deepEqual(r.request.body.fields.map((f) => [f.key, f.value]), [['a', '1'], ['b', 'two']]);
  });

  await test('-G moves data into the query string', () => {
    const r = parseCurl(`curl -G https://x.com/s -d 'q=cats' -d 'n=5'`);
    assert.equal(r.request.method, 'GET');
    assert.equal(r.request.body.mode, 'none');
    assert.deepEqual(r.request.params.map((p) => p.key), ['q', 'n']);
  });

  await test('detects GraphQL payloads', () => {
    const r = parseCurl(`curl https://x.com/graphql -H 'Content-Type: application/json' -d '{"query":"query { me { id } }","variables":{"a":1}}'`);
    assert.equal(r.request.body.mode, 'graphql');
    assert.match(r.request.body.graphql.query, /query \{ me/);
  });

  await test('survives Windows ^ continuations and double quotes', () => {
    const r = parseCurl(`curl "https://x.com/a" ^\n  -H "Accept: application/json" ^\n  -d "{\\"k\\":1}"`);
    assert.ok(r.ok);
    assert.equal(r.request.headers[0].key, 'Accept');
    assert.equal(r.request.body.raw.replace(/\s/g, ''), '{"k":1}');
  });

  await test('derives path variables from :segments', () => {
    const r = parseCurl(`curl https://x.com/users/:id/posts/:postId`);
    assert.deepEqual(r.request.pathVars.map((p) => p.key), ['id', 'postId']);
  });

  await test('rejects input with no URL', () => {
    assert.equal(parseCurl('curl -X POST').ok, false);
  });

  section('cURL generation');

  await test('round-trips through toCurl', () => {
    const original = `curl -X POST 'https://api.example.com/login' -H 'Content-Type: application/json' -d '{"a":1}'`;
    const first = parseCurl(original);
    const generated = toCurl(first.request, { multiline: false });
    const second = parseCurl(generated);
    assert.equal(second.request.method, 'POST');
    assert.equal(second.request.url, 'https://api.example.com/login');
    assert.deepEqual(JSON.parse(second.request.body.raw), { a: 1 });
  });

  await test('emits params back onto the URL', () => {
    const req = defaultRequest({
      method: 'GET',
      url: 'https://x.com/s',
      params: [{ key: 'q', value: 'a b', enabled: true }, { key: 'skip', value: 'x', enabled: false }],
    });
    const curl = toCurl(req, { multiline: false });
    assert.match(curl, /q=a%20b/);
    assert.ok(!curl.includes('skip'));
  });

  /* ========================================================= workspace */
  section('Workspace');

  await test('creates, updates, duplicates and deletes a request', () => {
    const { ws } = tempWorkspace();
    const col = ws.getState().collections[0];
    const req = ws.createRequest(col.id, { name: 'One', method: 'GET', url: 'https://a.com' });
    assert.ok(ws.findRequest(req.id));

    ws.updateRequest(req.id, { method: 'POST' });
    assert.equal(ws.findRequest(req.id).request.method, 'POST');

    const clone = ws.duplicateRequest(req.id);
    assert.equal(clone.name, 'One Copy');
    assert.notEqual(clone.id, req.id);
    assert.equal(col.items.length, 2);

    ws.deleteRequest(req.id);
    assert.equal(ws.findRequest(req.id), null);
    assert.equal(col.items.length, 1);
  });

  await test('duplicate names increment past an existing copy', () => {
    const { ws } = tempWorkspace();
    const col = ws.getState().collections[0];
    const req = ws.createRequest(col.id, { name: 'Thing' });
    ws.duplicateRequest(req.id);
    const third = ws.duplicateRequest(req.id);
    assert.equal(third.name, 'Thing Copy 2');
  });

  await test('protects id and type from updateRequest', () => {
    const { ws } = tempWorkspace();
    const req = ws.createRequest(null, { name: 'X' });
    ws.updateRequest(req.id, { id: 'hacked', type: 'folder', name: 'Y' });
    assert.equal(ws.findRequest(req.id).request.id, req.id);
    assert.equal(ws.findRequest(req.id).request.type, 'request');
    assert.equal(ws.findRequest(req.id).request.name, 'Y');
  });

  await test('deleting a collection closes its tabs', () => {
    const { ws } = tempWorkspace();
    const col = ws.getState().collections[0];
    const req = ws.createRequest(col.id, { name: 'Tabbed' });
    ws.patchUi({ tabs: [req.id], activeTabId: req.id });
    ws.deleteCollection(col.id);
    assert.deepEqual(ws.getState().ui.tabs, []);
    assert.equal(ws.getState().ui.activeTabId, null);
  });

  /* ========================================================== resolve */
  section('Variable resolution');

  await test('substitutes environment variables', () => {
    const { ws } = tempWorkspace();
    const env = ws.createEnvironment('Local', [
      { key: 'base', value: origin, enabled: true },
      { key: 'token', value: 'abc123', enabled: true },
    ]);
    ws.setActiveEnvironment(env.id);
    const req = defaultRequest({ url: '{{base}}/echo', auth: { type: 'bearer', token: '{{token}}' } });
    const { spec } = compile(req, ws.getState(), null);
    assert.equal(spec.url, `${origin}/echo`);
    assert.equal(spec.auth.token, 'abc123');
  });

  await test('reports missing variables instead of blanking them', () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({ url: '{{nope}}/x' });
    const { spec, unresolved } = compile(req, ws.getState(), null);
    assert.deepEqual(unresolved.missing, ['nope']);
    assert.match(spec.url, /\{\{nope\}\}/);
  });

  await test('substitutes path variables', () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({
      url: `${origin}/users/:id`,
      pathVars: [{ key: 'id', value: '42' }],
    });
    const { spec } = compile(req, ws.getState(), null);
    assert.equal(spec.url, `${origin}/users/42`);
  });

  /* ======================================================== execution */
  section('HTTP engine');

  await test('sends a GET and decodes the response', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({ method: 'GET', url: `${origin}/echo`, params: [{ key: 'a', value: '1', enabled: true }] });
    const result = await execute(ws, req, {});
    assert.ok(result.ok, result.response?.error?.message);
    assert.equal(result.response.status, 200);
    const body = JSON.parse(Buffer.from(result.response.bodyBase64, 'base64').toString());
    assert.equal(body.method, 'GET');
    assert.deepEqual(body.query, { a: '1' });
  });

  await test('sends a JSON body with the right content-type', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({
      method: 'POST',
      url: `${origin}/echo`,
      body: { mode: 'raw', rawType: 'json', raw: '{"hello":"world"}' },
    });
    const result = await execute(ws, req, {});
    const body = JSON.parse(Buffer.from(result.response.bodyBase64, 'base64').toString());
    assert.equal(body.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(body.body), { hello: 'world' });
  });

  await test('sends multipart form data', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({
      method: 'POST',
      url: `${origin}/echo`,
      body: { mode: 'form-data', fields: [{ key: 'name', value: 'jane', type: 'text', enabled: true }] },
    });
    const result = await execute(ws, req, {});
    const body = JSON.parse(Buffer.from(result.response.bodyBase64, 'base64').toString());
    assert.match(body.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(body.body, /name="name"/);
    assert.match(body.body, /jane/);
  });

  await test('follows redirects and records the hops', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({ url: `${origin}/redirect` });
    const result = await execute(ws, req, {});
    assert.equal(result.response.status, 200);
    assert.equal(result.response.redirects.length, 1);
    assert.match(result.response.finalUrl, /\/landed$/);
  });

  await test('honours followRedirects: false', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({ url: `${origin}/redirect`, settings: { followRedirects: false } });
    const result = await execute(ws, req, {});
    assert.equal(result.response.status, 302);
  });

  await test('surfaces connection errors without throwing', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({ url: 'http://127.0.0.1:1/nothing' });
    const result = await execute(ws, req, {});
    assert.equal(result.ok, false);
    assert.ok(result.response.error.code);
  });

  await test('reports a missing URL rather than crashing', async () => {
    const { ws } = tempWorkspace();
    const result = await execute(ws, defaultRequest({ url: '' }), {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_NO_URL');
  });

  await test('records history', async () => {
    const { ws } = tempWorkspace();
    await execute(ws, defaultRequest({ url: `${origin}/echo` }), {});
    assert.equal(ws.getState().history.length, 1);
    assert.equal(ws.getState().history[0].status, 200);
  });

  /* ========================================================== scripts */
  section('Scripts');

  await test('runs a test script and reports pass/fail', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({
      url: `${origin}/echo`,
      scripts: {
        test: `
          pm.test('status is 200', () => pm.response.to.have.status(200));
          pm.test('is json', () => pm.expect(pm.response.json()).to.have.property('method'));
          pm.test('deliberately fails', () => pm.expect(1).to.equal(2));
        `,
      },
    });
    const result = await execute(ws, req, {});
    assert.equal(result.tests.length, 3);
    assert.equal(result.tests[0].passed, true);
    assert.equal(result.tests[1].passed, true);
    assert.equal(result.tests[2].passed, false);
    assert.match(result.tests[2].error, /to equal/);
  });

  await test('a pre-request script can set a variable used by the request', async () => {
    const { ws } = tempWorkspace();
    const env = ws.createEnvironment('E', []);
    ws.setActiveEnvironment(env.id);
    const req = defaultRequest({
      url: `${origin}/echo`,
      headers: [{ key: 'X-Token', value: '{{tok}}', enabled: true }],
      scripts: { pre: `pm.environment.set('tok', 'from-script');` },
    });
    const result = await execute(ws, req, {});
    const body = JSON.parse(Buffer.from(result.response.bodyBase64, 'base64').toString());
    assert.equal(body.headers['x-token'], 'from-script');
  });

  await test('captures console output', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({ url: `${origin}/echo`, scripts: { test: `console.log('hi', {a:1});` } });
    const result = await execute(ws, req, {});
    assert.match(result.scriptLogs.map((l) => l.text).join(' '), /hi/);
  });

  await test('a broken pre-request script aborts before sending', async () => {
    const { ws } = tempWorkspace();
    const req = defaultRequest({ url: `${origin}/echo`, scripts: { pre: `throw new Error('nope')` } });
    const result = await execute(ws, req, {});
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'pre-request');
    assert.match(result.error.message, /nope/);
  });

  /* =================================================== control server */
  section('Agent control server');

  const { ws: controlWs } = tempWorkspace();
  const events = [];
  const control = new ControlServer({ workspace: controlWs, onEvent: (e) => events.push(e) });
  const started = await control.start(0);
  assert.ok(started.ok, 'control server should start');
  const cport = control.server.address().port;
  control.port = cport;

  await test('serves an endpoint index', async () => {
    const res = await callApi(cport, 'GET', '/');
    assert.equal(res.status, 200);
    assert.ok(res.json.endpoints['POST /requests']);
  });

  let createdId;

  await test('creates a request from a cURL string', async () => {
    const res = await callApi(cport, 'POST', '/requests', {
      curl: `curl -X POST '${origin}/echo' -H 'Content-Type: application/json' -d '{"from":"agent"}'`,
    });
    assert.equal(res.status, 201);
    createdId = res.json.id;
    assert.equal(res.json.method, 'POST');
    assert.ok(controlWs.findRequest(createdId), 'request should be persisted in the workspace');
    assert.ok(events.some((e) => e.type === 'request:created'));
  });

  await test('lists requests', async () => {
    const res = await callApi(cport, 'GET', '/requests');
    assert.equal(res.status, 200);
    assert.ok(res.json.some((r) => r.id === createdId));
  });

  await test('patches a single field', async () => {
    const res = await callApi(cport, 'PATCH', `/requests/${createdId}`, {
      headers: [{ key: 'X-Fixed', value: 'yes', enabled: true }],
    });
    assert.equal(res.status, 200);
    assert.equal(controlWs.findRequest(createdId).request.headers[0].key, 'X-Fixed');
  });

  await test('sends a saved request and returns a decoded body', async () => {
    const res = await callApi(cport, 'POST', `/requests/${createdId}/send`);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 200);
    assert.equal(res.json.json.method, 'POST');
    assert.equal(res.json.json.headers['x-fixed'], 'yes');
  });

  await test('duplicates a request', async () => {
    const res = await callApi(cport, 'POST', `/requests/${createdId}/duplicate`);
    assert.equal(res.status, 201);
    assert.notEqual(res.json.id, createdId);
  });

  await test('runs an ad-hoc cURL without saving it', async () => {
    const before = [...controlWs.walk()].filter((h) => h.request).length;
    const res = await callApi(cport, 'POST', '/send', { curl: `curl ${origin}/echo?adhoc=1` });
    assert.equal(res.status, 200);
    assert.equal(res.json.json.query.adhoc, '1');
    const after = [...controlWs.walk()].filter((h) => h.request).length;
    assert.equal(after, before, 'ad-hoc send must not create a saved request');
  });

  await test('manages environments and variables', async () => {
    const created = await callApi(cport, 'POST', '/environments', { name: 'Staging', values: { base: origin } });
    assert.equal(created.status, 201);
    await callApi(cport, 'POST', `/environments/${created.json.id}/activate`);
    await callApi(cport, 'PUT', '/variables/token', { value: 'xyz' });
    const vars = await callApi(cport, 'GET', '/variables');
    assert.equal(vars.json.base, origin);
    assert.equal(vars.json.token, 'xyz');
  });

  await test('returns the cURL form of a saved request', async () => {
    const res = await callApi(cport, 'GET', `/requests/${createdId}?curl=1`);
    assert.match(res.json.curl, /^curl -X POST/);
  });

  await test('deletes a request', async () => {
    const res = await callApi(cport, 'DELETE', `/requests/${createdId}`);
    assert.equal(res.status, 200);
    assert.equal(controlWs.findRequest(createdId), null);
  });

  await test('404s an unknown route', async () => {
    const res = await callApi(cport, 'GET', '/nope');
    assert.equal(res.status, 404);
  });

  await test('rejects malformed JSON with a 400', async () => {
    const res = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: cport, path: '/requests', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => resolve({ status: response.statusCode }));
      });
      r.write('{ not json');
      r.end();
    });
    assert.equal(res.status, 400);
  });

  await test('enforces a token when one is configured', async () => {
    controlWs.patchSettings({ controlServer: { enabled: true, port: cport, token: 'sekret' } });
    const denied = await callApi(cport, 'GET', '/health');
    assert.equal(denied.status, 401);
    controlWs.patchSettings({ controlServer: { enabled: true, port: cport } });
    const allowed = await callApi(cport, 'GET', '/health');
    assert.equal(allowed.status, 200);
  });

  await control.stop();
  server.close();

  /* ------------------------------------------------------------ report */
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`\n  ${f.name}\n${f.err.stack}`);
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});

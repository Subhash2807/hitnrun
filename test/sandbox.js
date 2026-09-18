'use strict';

/**
 * Tests for the AI sandbox: workspace isolation, copy/promote, and guardrails.
 * Run with: node test/sandbox.js
 */

const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { Workspace, defaultRequest } = require('../electron/workspace');
const { AiWorkspace } = require('../electron/ai-workspace');
const { ControlServer } = require('../electron/control-server');
const { checkRequest, hostMatches, normalizePolicy } = require('../electron/guardrails');

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

const section = (t) => console.log(`\n${t}`);

function tempPair() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const user = new Workspace(path.join(os.tmpdir(), `ac-user-${stamp}.json`));
  user.load();
  user.saveNow = () => {};
  user.scheduleSave = () => {};

  const ai = new AiWorkspace(path.join(os.tmpdir(), `ac-ai-${stamp}.json`), () => user.getState());
  ai.load();
  ai.store.saveNow = () => {};
  ai.store.scheduleSave = () => {};
  return { user, ai };
}

function startEcho() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function api(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const { server, port: echoPort } = await startEcho();
  const origin = `http://127.0.0.1:${echoPort}`;

  /* ========================================================== guardrails */
  section('Guardrails — host matching');

  await test('exact hostname matches', () => {
    assert.equal(hostMatches('api.prod.com', 'api.prod.com'), true);
    assert.equal(hostMatches('other.com', 'api.prod.com'), false);
  });

  await test('an exact rule does NOT cover subdomains', () => {
    assert.equal(hostMatches('api.prod.com', 'prod.com'), false);
  });

  await test('wildcard covers subdomains and the bare domain', () => {
    assert.equal(hostMatches('api.prod.com', '*.prod.com'), true);
    assert.equal(hostMatches('deep.api.prod.com', '*.prod.com'), true);
    assert.equal(hostMatches('prod.com', '*.prod.com'), true);
    assert.equal(hostMatches('notprod.com', '*.prod.com'), false);
  });

  await test('matching is case-insensitive', () => {
    assert.equal(hostMatches('API.Prod.COM', 'api.prod.com'), true);
  });

  section('Guardrails — policy');

  const policy = normalizePolicy({ blockedHosts: ['*.prod.com', 'payments.internal'], blockedMethods: ['DELETE', 'put'] });

  await test('blocks a blocked method', () => {
    const v = checkRequest({ method: 'DELETE', url: 'https://safe.com/x' }, policy);
    assert.equal(v.allowed, false);
    assert.equal(v.rule, 'method');
  });

  await test('method blocking is case-insensitive both ways', () => {
    assert.equal(checkRequest({ method: 'put', url: 'https://safe.com/x' }, policy).allowed, false);
  });

  await test('blocks a blocked host', () => {
    const v = checkRequest({ method: 'GET', url: 'https://api.prod.com/orders' }, policy);
    assert.equal(v.allowed, false);
    assert.equal(v.rule, 'host');
    assert.match(v.reason, /api\.prod\.com/);
  });

  await test('allows everything else', () => {
    assert.equal(checkRequest({ method: 'GET', url: 'https://staging.example.com/x' }, policy).allowed, true);
    assert.equal(checkRequest({ method: 'POST', url: 'https://staging.example.com/x' }, policy).allowed, true);
  });

  await test('a disabled policy allows everything', () => {
    const off = normalizePolicy({ enabled: false, blockedHosts: ['*.prod.com'], blockedMethods: ['DELETE'] });
    assert.equal(checkRequest({ method: 'DELETE', url: 'https://api.prod.com/x' }, off).allowed, true);
  });

  await test('DELETE is blocked by default', () => {
    assert.equal(checkRequest({ method: 'DELETE', url: 'https://any.com/x' }, normalizePolicy({})).allowed, false);
  });

  await test('accepts a comma/space separated string from the settings UI', () => {
    const p = normalizePolicy({ blockedHosts: 'a.com, *.b.com  c.com', blockedMethods: 'delete,put' });
    assert.deepEqual(p.blockedHosts, ['a.com', '*.b.com', 'c.com']);
    assert.deepEqual(p.blockedMethods, ['DELETE', 'PUT']);
  });

  /* ======================================================== ai workspace */
  section('AI workspace isolation');

  await test('sessions get their own collection', () => {
    const { ai } = tempPair();
    const a = ai.startSession({ client: 'claude-code' });
    const b = ai.startSession({ client: 'claude-code' });
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(a.collectionId, b.collectionId);
    assert.equal(ai.getState().collections.length, 2);
  });

  await test('shared mode reuses one collection', () => {
    const { ai } = tempPair();
    const a = ai.startSession({ mode: 'shared' });
    const b = ai.startSession({ mode: 'shared' });
    assert.equal(a.collectionId, b.collectionId);
    assert.equal(ai.getState().collections.length, 1);
  });

  await test('AI requests never appear in the user workspace', () => {
    const { user, ai } = tempPair();
    const s = ai.startSession({});
    ai.createRequest(s.sessionId, { name: 'AI thing', url: 'https://x.com' });

    let userCount = 0;
    for (const hit of user.walk()) if (hit.request) userCount++;
    assert.equal(userCount, 0, 'user workspace must stay empty');
    assert.equal(ai.sessionCollection(s.sessionId).items.length, 1);
  });

  await test('copying clones with fresh ids and leaves the original alone', () => {
    const { user, ai } = tempPair();
    const col = user.getState().collections[0];
    const original = user.createRequest(col.id, {
      name: 'User request',
      url: 'https://user.example.com/a',
      headers: [{ key: 'X-Orig', value: '1', enabled: true }],
    });

    const s = ai.startSession({});
    const copied = ai.copyFromUser(s.sessionId, original.id);
    assert.ok(copied.ok);
    assert.notEqual(copied.id, original.id, 'the copy must have a new id');

    // Mutating the copy must not affect the user's original.
    ai.updateRequest(copied.id, { url: 'https://changed.example.com/a', name: 'Changed' });
    assert.equal(user.findRequest(original.id).request.url, 'https://user.example.com/a');
    assert.equal(user.findRequest(original.id).request.name, 'User request');
    assert.equal(ai.findRequest(copied.id).request.url, 'https://changed.example.com/a');
  });

  await test('copying a folder brings its requests, all re-identified', () => {
    const { user, ai } = tempPair();
    const col = user.getState().collections[0];
    const folder = user.createFolder(col.id, 'Orders');
    const r1 = user.createRequest(folder.id, { name: 'A', url: 'https://u.com/a' });
    user.createRequest(folder.id, { name: 'B', url: 'https://u.com/b' });

    const s = ai.startSession({});
    const copied = ai.copyFromUser(s.sessionId, folder.id);
    assert.ok(copied.ok);
    assert.equal(copied.requests, 2);

    const ids = [];
    for (const hit of ai.store.walk()) if (hit.request) ids.push(hit.request.id);
    assert.equal(ids.length, 2);
    assert.ok(!ids.includes(r1.id), 'copied requests must not reuse user ids');
  });

  await test('the AI cannot reach a user request by id', () => {
    const { user, ai } = tempPair();
    const original = user.createRequest(null, { name: 'Private', url: 'https://u.com' });
    ai.startSession({});
    assert.equal(ai.findRequest(original.id), null);
    assert.equal(ai.updateRequest(original.id, { url: 'https://evil.com' }), null);
    assert.equal(ai.deleteRequest(original.id), false);
    assert.equal(user.findRequest(original.id).request.url, 'https://u.com');
  });

  await test('creating into a foreign folder falls back to the session root', () => {
    const { user, ai } = tempPair();
    const userFolder = user.createFolder(user.getState().collections[0].id, 'User folder');
    const s = ai.startSession({});
    const made = ai.createRequest(s.sessionId, { name: 'Sneaky' }, userFolder.id);
    assert.ok(made);
    assert.equal(userFolder.items.length, 0, 'nothing may land in the user folder');
    assert.equal(ai.sessionCollection(s.sessionId).items.length, 1);
  });

  await test('discarding a session removes its work', () => {
    const { ai } = tempPair();
    const s = ai.startSession({});
    ai.createRequest(s.sessionId, { name: 'Temp' });
    assert.equal(ai.discardSession(s.sessionId), true);
    assert.equal(ai.getState().collections.length, 0);
    assert.equal(ai.listSessions().length, 0);
  });

  await test('promotion exports a detached clone', () => {
    const { ai } = tempPair();
    const s = ai.startSession({});
    const made = ai.createRequest(s.sessionId, { name: 'Good work', url: 'https://x.com' });
    const exported = ai.exportForPromotion(made.id);
    assert.equal(exported.kind, 'request');
    assert.notEqual(exported.value.id, made.id);
    assert.equal(exported.value.name, 'Good work');
  });

  /* ===================================================== over the wire */
  section('Control API — sandbox enforcement');

  const { user, ai } = tempPair();
  user.patchSettings({ aiPolicy: normalizePolicy({ blockedHosts: ['blocked.example.com'], blockedMethods: ['DELETE'] }) });
  const control = new ControlServer({ workspace: user, aiWorkspace: ai, onEvent: () => {} });
  await control.start(0);
  const cport = control.server.address().port;
  control.port = cport;

  const userReq = user.createRequest(user.getState().collections[0].id, {
    name: 'User owned',
    url: `${origin}/user`,
  });

  let sessionId;

  await test('a session can be opened', async () => {
    const res = await api(cport, 'POST', '/ai/sessions', { client: 'test' });
    assert.equal(res.status, 201);
    sessionId = res.json.sessionId;
    assert.ok(sessionId);
  });

  await test('writes to the user workspace are refused by default', async () => {
    const res = await api(cport, 'POST', '/requests', { curl: 'curl https://x.com' });
    assert.equal(res.status, 403);
    assert.equal(res.json.userWritesDisabled, true);

    const del = await api(cport, 'DELETE', `/requests/${userReq.id}`);
    assert.equal(del.status, 403);
    assert.ok(user.findRequest(userReq.id), 'the user request must survive');
  });

  await test('reads of the user workspace still work', async () => {
    const res = await api(cport, 'GET', '/requests');
    assert.equal(res.status, 200);
    assert.ok(res.json.some((r) => r.id === userReq.id));
  });

  await test('the user can lower the wall deliberately', async () => {
    user.patchSettings({ allowAgentUserWrites: true });
    const res = await api(cport, 'POST', '/requests', { curl: `curl ${origin}/allowed` });
    assert.equal(res.status, 201);
    user.patchSettings({ allowAgentUserWrites: false });
  });

  await test('AI requests are created in the AI workspace', async () => {
    const res = await api(cport, 'POST', '/ai/requests', { sessionId, curl: `curl ${origin}/mine` });
    assert.equal(res.status, 201);
    assert.ok(ai.findRequest(res.json.id));
    assert.equal(user.findRequest(res.json.id), null);
  });

  await test('the AI cannot PATCH a user request through /ai', async () => {
    const res = await api(cport, 'PATCH', `/ai/requests/${userReq.id}`, { url: 'https://evil.com' });
    assert.equal(res.status, 404);
    assert.match(res.json.error, /copy it first/i);
    assert.equal(user.findRequest(userReq.id).request.url, `${origin}/user`);
  });

  await test('copy brings a user request across', async () => {
    const res = await api(cport, 'POST', '/ai/copy', { sessionId, sourceId: userReq.id });
    assert.equal(res.status, 201);
    assert.ok(ai.findRequest(res.json.id));
  });

  await test('a permitted AI send works', async () => {
    const made = await api(cport, 'POST', '/ai/requests', { sessionId, curl: `curl ${origin}/ok` });
    const res = await api(cport, 'POST', `/ai/requests/${made.json.id}/send`);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 200);
  });

  await test('a blocked METHOD is refused before it leaves', async () => {
    const made = await api(cport, 'POST', '/ai/requests', { sessionId, curl: `curl -X DELETE ${origin}/thing` });
    const res = await api(cport, 'POST', `/ai/requests/${made.json.id}/send`);
    assert.equal(res.status, 403);
    assert.equal(res.json.blocked, true);
    assert.match(res.json.reason, /DELETE is blocked/);
  });

  await test('a blocked HOST is refused', async () => {
    const res = await api(cport, 'POST', '/ai/send', { curl: 'curl https://blocked.example.com/x' });
    assert.equal(res.status, 403);
    assert.equal(res.json.blocked, true);
    assert.match(res.json.reason, /blocked-hosts/);
  });

  await test('the user sending the same thing is NOT blocked', async () => {
    // Guardrails are for AI sessions only — the user's own sends go through
    // the IPC path with no policy at all.
    const { execute } = require('../electron/runner');
    const req = defaultRequest({ method: 'DELETE', url: `${origin}/thing` });
    const result = await execute(user, req, {});
    assert.equal(result.ok, true, 'the user must not be subject to AI guardrails');
    assert.equal(result.response.status, 200);
  });

  await test('policy is discoverable by the agent', async () => {
    const res = await api(cport, 'GET', '/ai/policy');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.blockedMethods, ['DELETE']);
  });

  await control.stop();
  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`\n  ${f.name}\n${f.err.stack}`);
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});

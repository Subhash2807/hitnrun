'use strict';

/**
 * Test documentation (recording, steps, exports, agent access), the Postman
 * import that makes exported docs re-runnable, and the code panel's snippets.
 *
 *   node test/docs.js
 */

const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { DocStore, buildStep } = require('../electron/docs');
const { toMarkdown, toHtml, toPostman, maskDoc, maskHeaders, maskUrl, maskBody } = require('../electron/doc-export');
const { importPostman } = require('../electron/postman');
const { generate } = require('../electron/codegen');
const { execute } = require('../electron/runner');
const { Workspace, defaultRequest } = require('../electron/workspace');
const { AiWorkspace } = require('../electron/ai-workspace');
const { ControlServer } = require('../electron/control-server');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.stack}`);
  }
}

const tmp = (label) => path.join(os.tmpdir(), `hitnrun-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

/** A local server so sends are real, and nothing leaves the machine. */
function startTarget() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url.startsWith('/binary')) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
        res.writeHead(req.url.startsWith('/missing') ? 404 : 200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'session=abc123def456; Path=/; HttpOnly',
        });
        res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization || null, got: body || null, token: 'tok_live_9f8e7d6c5b4a' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function userWorkspace(base) {
  const ws = new Workspace(tmp('ws'));
  ws.load();
  const env = ws.createEnvironment('Staging');
  ws.updateEnvironment(env.id, {
    values: [
      { key: 'base_url', value: base, enabled: true },
      { key: 'token', value: 'secret-token-1234567890', enabled: true },
    ],
  });
  ws.setActiveEnvironment(env.id);
  return ws;
}

(async () => {
  const { server, base } = await startTarget();

  console.log('\nrecording');

  await test('capture only records while a recording runs in auto mode', async () => {
    const docs = new DocStore(tmp('docs'));
    const ws = userWorkspace(base);
    const req = ws.createRequest(null, { name: 'Login', method: 'GET', url: '{{base_url}}/login' });
    const result = await execute(ws, req, {});

    assert.equal(docs.capture(result), null, 'nothing recording');
    const rec = docs.startRecording({ name: 'Login flow', mode: 'manual' });
    assert.equal(rec.mode, 'manual');
    assert.equal(docs.capture(result), null, 'manual mode ignores plain sends');
    assert.ok(docs.capture(result, { force: true }), 'manual mode takes a forced add');

    docs.setRecording({ mode: 'auto' });
    assert.ok(docs.capture(result));
    docs.setRecording({ paused: true });
    assert.equal(docs.capture(result), null, 'paused');
    docs.setRecording({ paused: false });
    docs.stopRecording();
    assert.equal(docs.capture(result), null, 'stopped');
    assert.equal(docs.get(rec.docId).steps.length, 2);
  });

  await test('only one recording at a time; starting another switches to it', () => {
    const docs = new DocStore(tmp('docs'));
    const a = docs.startRecording({ name: 'A' });
    const b = docs.startRecording({ name: 'B' });
    assert.notEqual(a.docId, b.docId);
    assert.equal(docs.recording().docId, b.docId);
    docs.startRecording({ docId: a.docId, mode: 'manual' });
    assert.equal(docs.recording().docId, a.docId, 'resume an existing doc');
    assert.equal(docs.list().length, 2, 'resuming does not create a doc');
  });

  await test('a step keeps the complete resolved URL, headers and full bodies', async () => {
    const ws = userWorkspace(base);
    const req = ws.createRequest(null, {
      name: 'Create order',
      method: 'POST',
      url: '{{base_url}}/orders',
      params: [{ key: 'dry', value: 'no', enabled: true }],
      auth: { type: 'bearer', token: '{{token}}' },
      body: { mode: 'raw', rawType: 'json', raw: '{"item":"book","qty":2}' },
    });
    const result = await execute(ws, req, {});
    const step = buildStep(result, { environment: 'Staging', requestId: req.id });

    assert.equal(step.request.url, `${base}/orders?dry=no`, 'no {{base_url}}, query included');
    assert.equal(step.title, 'Create order');
    assert.equal(step.environment, 'Staging');
    const auth = step.request.headers.find(([k]) => k === 'Authorization');
    assert.equal(auth[1], 'Bearer secret-token-1234567890', 'stored as sent; masking happens on export');
    assert.equal(step.request.body, '{"item":"book","qty":2}');
    assert.equal(step.response.status, 200);
    assert.equal(JSON.parse(step.response.body).got, '{"item":"book","qty":2}');
    assert.equal(step.status, 'untested');
  });

  await test('failed sends and binary responses are recorded sensibly', async () => {
    const ws = userWorkspace(base);
    const down = await execute(ws, defaultRequest({ url: 'http://127.0.0.1:1/nothing' }), { recordHistory: false });
    const s1 = buildStep(down);
    assert.equal(s1.response, null);
    assert.ok(s1.error);
    assert.equal(s1.title, 'GET /nothing', 'unnamed requests get METHOD /path');

    const bin = await execute(ws, defaultRequest({ name: 'Logo', url: `${base}/binary` }), { recordHistory: false });
    const s2 = buildStep(bin);
    assert.equal(s2.response.binary, true);
    assert.equal(s2.response.body, null);
  });

  await test('steps can be edited, reordered and deleted, and it all persists', async () => {
    const file = tmp('docs');
    const docs = new DocStore(file);
    const ws = userWorkspace(base);
    const { docId } = docs.startRecording({ name: 'Flow' });
    for (const p of ['/a', '/b', '/c']) {
      docs.capture(await execute(ws, defaultRequest({ url: base + p }), { recordHistory: false }));
    }
    const [a, b, c] = docs.get(docId).steps;
    docs.updateStep(docId, b.id, { title: 'Verify', note: 'n', expected: 'e', status: 'pass' });
    docs.updateStep(docId, b.id, { status: 'bogus' });
    assert.equal(docs.findStep(docId, b.id).step.status, 'pass', 'invalid status ignored');
    docs.moveStep(docId, c.id, 0);
    assert.deepEqual(docs.get(docId).steps.map((s) => s.id), [c.id, a.id, b.id]);
    docs.moveStep(docId, c.id, 99);
    assert.deepEqual(docs.get(docId).steps.map((s) => s.id), [a.id, b.id, c.id], 'clamped to the end');
    assert.equal(docs.deleteStep(docId, a.id), true);
    docs.update(docId, { name: '  Checkout  ', description: 'Summary' });
    docs.saveNow();

    const again = new DocStore(file);
    again.load();
    const doc = again.get(docId);
    assert.equal(doc.name, 'Checkout');
    assert.equal(doc.description, 'Summary');
    assert.deepEqual(doc.steps.map((s) => s.title), ['Verify', 'GET /c']);
    assert.equal(again.recording().docId, docId, 'recording survives a restart');
    assert.deepEqual(again.list()[0].counts, { pass: 1, fail: 0, untested: 1 });
  });

  await test('deleting the recording doc stops the recording; duplicate gets fresh ids', () => {
    const docs = new DocStore(tmp('docs'));
    const { docId } = docs.startRecording({ name: 'X' });
    docs.addStep(docId, { request: { method: 'GET', fullUrl: 'https://x.test/' }, response: { status: 204, headers: [], bodyBase64: '' } });
    const copy = docs.duplicate(docId);
    assert.notEqual(copy.steps[0].id, docs.get(docId).steps[0].id);
    assert.equal(copy.name, 'X (copy)');
    docs.remove(docId);
    assert.equal(docs.recording(), null);
  });

  console.log('\nexport');

  const sampleDoc = async () => {
    const docs = new DocStore(tmp('docs'));
    const ws = userWorkspace(base);
    const { docId } = docs.startRecording({ name: 'Login | OTP', description: 'Covers the OTP login.' });
    const login = ws.createRequest(null, {
      name: 'Login',
      method: 'POST',
      url: '{{base_url}}/login',
      params: [{ key: 'api_key', value: 'k-123456789012345', enabled: true }],
      auth: { type: 'bearer', token: '{{token}}' },
      body: { mode: 'raw', rawType: 'json', raw: '{"user":"sam","password":"hunter2","author":"keep me"}' },
    });
    docs.capture(await execute(ws, login, {}), { environment: 'Staging' });
    docs.capture(await execute(ws, defaultRequest({ name: 'Missing', url: `${base}/missing` }), {}), { environment: 'Staging' });
    const doc = docs.get(docId);
    docs.updateStep(docId, doc.steps[0].id, { title: 'Log in | OTP', status: 'pass', expected: 'Returns a token', note: 'Cookie set' });
    docs.updateStep(docId, doc.steps[1].id, { status: 'fail' });
    return docs.get(docId);
  };

  await test('masking hides secrets but keeps look-alike names', () => {
    const headers = maskHeaders([
      ['Authorization', 'Bearer abcdefghijklmnop1a2f'],
      ['Cookie', 'sid=1; theme=dark'],
      ['X-Api-Key', 'short'],
      ['Content-Type', 'application/json'],
    ]);
    assert.equal(headers[0][1], 'Bearer ••••••1a2f');
    assert.equal(headers[1][1], 'sid=••••••; theme=••••••');
    assert.equal(headers[2][1], '••••••');
    assert.equal(headers[3][1], 'application/json');
    assert.equal(maskUrl('https://x.test/a?api_key=zzz&page=2'), 'https://x.test/a?api_key=••••••&page=2');
    const body = JSON.parse(maskBody('{"password":"p","author":"a","nested":{"access_token":"t"},"footprint":1}', 'application/json'));
    assert.equal(body.password, '••••••');
    assert.equal(body.author, 'a');
    assert.equal(body.nested.access_token, '••••••');
    assert.equal(body.footprint, 1);
  });

  await test('Markdown: summary table, collapsed sections, masked by default', async () => {
    const doc = await sampleDoc();
    const md = toMarkdown(doc);
    assert.match(md, /^# Login \| OTP/);
    assert.match(md, /Covers the OTP login\./);
    assert.match(md, /\| 1 \| Log in \\\| OTP \| .*\| ✅ \|/, 'pipes in cells are escaped');
    assert.match(md, /\| 2 \| Missing \| .*\| 404 · .*\| ❌ \|/);
    assert.match(md, /<details><summary>Response body<\/summary>/);
    assert.match(md, /\*\*Expected:\*\* Returns a token/);
    assert.match(md, new RegExp(`\`POST\` ${base.replace(/[.]/g, '\\.')}/login\\?api_key=••••••`));
    assert.ok(!md.includes('secret-token-1234567890'), 'bearer token masked');
    assert.ok(!md.includes('hunter2'), 'password masked');
    assert.ok(!md.includes('tok_live_9f8e7d6c5b4a'), 'token in the response body masked');
    assert.ok(md.includes('keep me'));
    assert.ok(toMarkdown(doc, { mask: false }).includes('hunter2'), 'masking can be turned off');
    assert.equal(doc.steps[0].request.body.includes('hunter2'), true, 'the stored doc is never changed');
  });

  await test('HTML: self-contained, escaped, collapsed unless expanded for PDF', async () => {
    const doc = await sampleDoc();
    doc.steps[0].note = '<script>alert(1)</script>';
    const html = toHtml(doc);
    assert.match(html, /^<!doctype html>/);
    assert.ok(!/<script>alert/.test(html), 'content is escaped');
    assert.ok(!/<(script|link)[^>]+(src|href)=/i.test(html), 'no external resources');
    assert.match(html, /<details><summary>Response body/);
    assert.match(toHtml(doc, { expandAll: true }), /<details open><summary>Response body/);
  });

  await test('Postman export imports back as a runnable collection in the same order', async () => {
    const doc = await sampleDoc();
    const json = JSON.parse(toPostman(doc, { mask: false }));
    assert.match(json.info.schema, /v2\.1\.0/);
    assert.deepEqual(json.item.map((i) => i.name), ['1. Log in | OTP', '2. Missing']);
    assert.equal(json.item[0].response[0].code, 200);

    const imported = importPostman(JSON.stringify(json));
    assert.ok(imported.ok, imported.error);
    const [login, missing] = imported.collection.items;
    assert.equal(login.method, 'POST');
    assert.equal(login.url, `${base}/login`);
    assert.deepEqual(login.params.map((p) => [p.key, p.value]), [['api_key', 'k-123456789012345']]);
    assert.equal(login.body.mode, 'raw');
    assert.equal(login.body.rawType, 'json');
    assert.ok(login.headers.some((h) => h.key === 'Authorization'));
    assert.ok(!login.headers.some((h) => /^(user-agent|content-length)$/i.test(h.key)), 'transport headers dropped');
    assert.equal(missing.url, `${base}/missing`);

    // And the imported request actually runs.
    const ws = new Workspace(tmp('ws'));
    ws.importCollection(imported.collection);
    const run = await execute(ws, login, {});
    assert.equal(run.response.status, 200);
    assert.equal(JSON.parse(Buffer.from(run.response.bodyBase64, 'base64').toString()).auth, 'Bearer secret-token-1234567890');
  });

  await test('Postman import handles folders, auth, form bodies and bad input', () => {
    const out = importPostman({
      info: { name: 'Shop', schema: 'x' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] },
      variable: [{ key: 'host', value: 'https://shop.test' }],
      item: [
        {
          name: 'Cart',
          item: [
            {
              name: 'Add',
              request: {
                method: 'post',
                url: { raw: '{{host}}/cart?x=1&y', host: ['{{host}}'], path: ['cart'] },
                header: [{ key: 'X-Off', value: '1', disabled: true }],
                body: { mode: 'urlencoded', urlencoded: [{ key: 'sku', value: 'A1' }] },
                auth: { type: 'apikey', apikey: [{ key: 'key', value: 'K' }, { key: 'value', value: 'V' }, { key: 'in', value: 'query' }] },
              },
            },
          ],
        },
      ],
    });
    assert.ok(out.ok);
    assert.equal(out.collection.auth.token, '{{t}}');
    assert.equal(out.collection.variables[0].key, 'host');
    const folder = out.collection.items[0];
    assert.equal(folder.type, 'folder');
    const add = folder.items[0];
    assert.equal(add.method, 'POST');
    assert.equal(add.url, '{{host}}/cart');
    assert.deepEqual(add.params.map((p) => [p.key, p.value]), [['x', '1'], ['y', '']]);
    assert.equal(add.headers[0].enabled, false);
    assert.equal(add.body.mode, 'urlencoded');
    assert.deepEqual(add.auth, { type: 'apikey', key: 'K', value: 'V', in: 'query' });

    assert.equal(importPostman('not json').ok, false);
    assert.equal(importPostman({ hello: 1 }).ok, false);
  });

  console.log('\ncode panel');

  await test('snippets keep {{vars}} by default and fill them in when asked', () => {
    const ws = userWorkspace('https://api.example.test');
    const req = ws.createRequest(null, {
      method: 'POST',
      url: '{{base_url}}/login',
      params: [{ key: 'v', value: '2', enabled: true }],
      auth: { type: 'bearer', token: '{{token}}' },
      body: { mode: 'raw', rawType: 'json', raw: '{"remember":true,"otp":null}' },
    });
    const state = ws.getState();

    const curl = generate(req, { state, language: 'curl' });
    assert.match(curl, /'\{\{base_url\}\}\/login\?v=2'/);
    assert.match(generate(req, { state, language: 'curl', resolve: true }), /'https:\/\/api\.example\.test\/login\?v=2'/);

    const fetchCode = generate(req, { state, language: 'fetch', resolve: true });
    assert.match(fetchCode, /fetch\("https:\/\/api\.example\.test\/login\?v=2"/);
    assert.match(fetchCode, /"Authorization": "Bearer secret-token-1234567890"/);
    assert.match(fetchCode, /JSON\.stringify\(/);
    assert.match(generate(req, { state, language: 'fetch' }), /fetch\("\{\{base_url\}\}\/login\?v=2"/);

    const py = generate(req, { state, language: 'python' });
    assert.match(py, /^import requests/);
    assert.match(py, /"remember": True/);
    assert.match(py, /"otp": None/);
    assert.match(py, /requests\.request\("POST", url, headers=headers, json=payload\)/);
    assert.throws(() => generate(req, { state, language: 'cobol' }));
  });

  console.log('\nagent access over the control server');

  await test('docs routes: read, edit, reorder, drive recording — but not delete a doc', async () => {
    const ws = userWorkspace(base);
    const docs = new DocStore(tmp('docs'));
    const ai = new AiWorkspace(tmp('ai'), () => ws.getState());
    ai.load();
    const srv = new ControlServer({ workspace: ws, aiWorkspace: ai, docs, environmentName: () => 'Staging' });
    const port = 48100 + Math.floor(Math.random() * 400);
    await srv.start(port);
    const call = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    try {
      const started = await call('POST', '/docs/recording', { name: 'Agent run', mode: 'manual' });
      assert.equal(started.status, 201);
      const docId = started.body.docId;

      const session = (await call('POST', '/ai/sessions', { client: 'test' })).body;
      // Manual mode: a plain AI send is not recorded, one with record:true is.
      const plain = await call('POST', '/ai/send', { curl: `curl ${base}/one` });
      assert.equal(plain.body.doc, undefined);
      const recorded = await call('POST', '/ai/send', { curl: `curl ${base}/two`, record: true });
      assert.equal(recorded.body.doc.recorded, true);

      // Auto mode records AI sends by themselves, marked as sent by Claude.
      await call('PATCH', '/docs/recording', { mode: 'auto' });
      const made = (await call('POST', '/ai/requests', { sessionId: session.sessionId, curl: `curl ${base}/three` })).body;
      await call('POST', `/ai/requests/${made.id}/send`);

      const doc = (await call('GET', `/docs/${docId}`)).body;
      assert.deepEqual(doc.steps.map((s) => new URL(s.request.url).pathname), ['/two', '/three']);
      assert.ok(doc.steps.every((s) => s.source === 'ai' && s.environment === 'Staging'));
      assert.equal(doc.steps[0].index, 0);

      const [two, three] = doc.steps;
      const edited = await call('PATCH', `/docs/${docId}/steps/${two.id}`, { title: 'Second', status: 'pass', note: 'ok' });
      assert.equal(edited.body.status, 'pass');
      assert.equal((await call('PATCH', `/docs/${docId}/steps/${two.id}`, { status: 'maybe' })).status, 400);
      const moved = await call('POST', `/docs/${docId}/steps/${three.id}/move`, { index: 0 });
      assert.deepEqual(moved.body.order, [three.id, two.id]);
      await call('PATCH', `/docs/${docId}`, { description: 'Written by Claude' });
      assert.equal(docs.get(docId).description, 'Written by Claude');

      assert.equal((await call('DELETE', `/docs/${docId}`)).status, 403, 'whole docs are deleted in the app only');
      assert.equal((await call('DELETE', `/docs/${docId}/steps/${three.id}`)).body.deleted, true);

      // Docs sit outside the user-workspace wall, which stays up.
      assert.equal((await call('POST', '/collections', { name: 'nope' })).status, 403);

      assert.equal((await call('DELETE', '/docs/recording')).status, 200);
      const list = (await call('GET', '/docs')).body;
      assert.equal(list.recording, null);
      assert.equal(list.docs[0].stepCount, 1);
    } finally {
      await srv.stop();
    }
  });

  await test('a send blocked by the guardrails is never documented', async () => {
    const ws = userWorkspace(base);
    ws.patchSettings({ aiPolicy: { enabled: true, blockedHosts: [], blockedMethods: ['DELETE'] } });
    const docs = new DocStore(tmp('docs'));
    const ai = new AiWorkspace(tmp('ai'), () => ws.getState());
    ai.load();
    const srv = new ControlServer({ workspace: ws, aiWorkspace: ai, docs });
    const port = 48600 + Math.floor(Math.random() * 300);
    await srv.start(port);
    try {
      const { docId } = docs.startRecording({ name: 'Guarded', mode: 'auto' });
      const res = await fetch(`http://127.0.0.1:${port}/ai/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curl: `curl -X DELETE ${base}/x` }),
      });
      assert.equal(res.status, 403);
      assert.equal(docs.get(docId).steps.length, 0);
    } finally {
      await srv.stop();
    }
  });

  server.close();
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => /^hitnrun-(docs|ws|ai|user)-/.test(n))) {
    fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

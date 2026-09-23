'use strict';

/**
 * Folder rename/delete, the built-in Global environment, AI workspace cleanup,
 * and the folded-JSON labels.
 *
 *   node test/workspace-extras.js
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { Workspace } = require('../electron/workspace');
const { AiWorkspace } = require('../electron/ai-workspace');

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

(async () => {
  console.log('\nfolders');

  await test('a folder can be renamed', () => {
    const ws = new Workspace(tmp('ws'));
    const folder = ws.createFolder(null, 'Old');
    ws.updateFolder(folder.id, { name: '  New  ' });
    assert.equal(ws.findFolder(folder.id).folder.name, 'New');
  });

  await test('a blank rename keeps the old name', () => {
    const ws = new Workspace(tmp('ws'));
    const folder = ws.createFolder(null, 'Keep');
    ws.updateFolder(folder.id, { name: '   ' });
    assert.equal(ws.findFolder(folder.id).folder.name, 'Keep');
  });

  await test('deleting a nested folder removes everything inside and closes its tabs', () => {
    const ws = new Workspace(tmp('ws'));
    const outer = ws.createFolder(null, 'Outer');
    const inner = ws.createFolder(outer.id, 'Inner');
    const req = ws.createRequest(inner.id, { name: 'deep' });
    const keep = ws.createRequest(null, { name: 'keep' });
    ws.patchUi({ tabs: [req.id, keep.id], activeTabId: req.id });

    assert.equal(ws.deleteFolder(inner.id), true);
    assert.equal(ws.findFolder(inner.id), null);
    assert.equal(ws.findRequest(req.id), null);
    assert.ok(ws.findFolder(outer.id), 'parent folder survives');
    assert.ok(ws.findRequest(keep.id), 'unrelated request survives');
    assert.deepEqual(ws.getState().ui.tabs, [keep.id]);
    assert.equal(ws.getState().ui.activeTabId, keep.id);
  });

  await test('deleting an unknown folder is a no-op', () => {
    const ws = new Workspace(tmp('ws'));
    assert.equal(ws.deleteFolder('fld_nope'), false);
  });

  console.log('\nGlobal environment');

  await test('a fresh workspace gets an active Global environment', () => {
    const ws = new Workspace(tmp('ws'));
    ws.load();
    const env = ws.ensureDefaultEnvironment();
    assert.equal(env.name, 'Global');
    assert.equal(env.builtin, true);
    assert.equal(ws.getState().activeEnvironmentId, env.id);
  });

  await test('it is created once, and does not steal an existing active environment', () => {
    const ws = new Workspace(tmp('ws'));
    const mine = ws.createEnvironment('Staging');
    ws.setActiveEnvironment(mine.id);
    ws.ensureDefaultEnvironment();
    assert.equal(ws.ensureDefaultEnvironment(), null);
    assert.equal(ws.getState().environments.filter((e) => e.builtin).length, 1);
    assert.equal(ws.getState().activeEnvironmentId, mine.id);
  });

  await test('the Global environment cannot be deleted; others can', () => {
    const ws = new Workspace(tmp('ws'));
    const global = ws.ensureDefaultEnvironment();
    const other = ws.createEnvironment('Temp');
    assert.equal(ws.deleteEnvironment(global.id), false);
    assert.equal(ws.deleteEnvironment(other.id), true);
    assert.ok(ws.getState().environments.find((e) => e.id === global.id));
  });

  await test('deactivating Global survives a reload', () => {
    const file = tmp('ws');
    const ws = new Workspace(file);
    ws.ensureDefaultEnvironment();
    ws.setActiveEnvironment(null);
    ws.saveNow();

    const again = new Workspace(file);
    again.load();
    again.ensureDefaultEnvironment();
    assert.equal(again.getState().activeEnvironmentId, null);
    assert.equal(again.getState().environments.filter((e) => e.builtin).length, 1);
  });

  console.log('\nAI workspace cleanup');

  const aiPair = () => {
    const user = new Workspace(tmp('user'));
    const ai = new AiWorkspace(tmp('ai'), () => user.getState());
    ai.load();
    return { user, ai };
  };

  await test('deleteNode removes an AI request or folder', () => {
    const { ai } = aiPair();
    const { sessionId } = ai.startSession({ client: 'test' });
    const folder = ai.createFolder(sessionId, 'F');
    const inFolder = ai.createRequest(sessionId, { name: 'in' }, folder.id);
    const loose = ai.createRequest(sessionId, { name: 'loose' });

    assert.equal(ai.deleteNode(loose.id), true);
    assert.equal(ai.findRequest(loose.id), null);
    assert.equal(ai.deleteNode(folder.id), true);
    assert.equal(ai.findRequest(inFolder.id), null);
    assert.equal(ai.listSessions().length, 1, 'the session itself stays');
  });

  await test('deleteNode cannot reach the user workspace', () => {
    const { user, ai } = aiPair();
    const mine = user.createRequest(null, { name: 'mine' });
    ai.startSession({ client: 'test' });
    assert.equal(ai.deleteNode(mine.id), false);
    assert.ok(user.findRequest(mine.id));
  });

  await test('discardAll removes every session and its requests', () => {
    const { user, ai } = aiPair();
    const mine = user.createRequest(null, { name: 'mine' });
    const a = ai.startSession({ client: 'a' });
    ai.startSession({ client: 'b' });
    ai.createRequest(a.sessionId, { name: 'x' });

    ai.discardAll();
    assert.equal(ai.listSessions().length, 0);
    assert.equal(ai.getState().collections.length, 0);
    assert.ok(user.findRequest(mine.id), 'user work untouched');
    assert.equal(ai.createRequest(a.sessionId, { name: 'late' }), null, 'old session id is dead');
  });

  console.log('\nsmall fixes');

  const { parseCurl } = require('../electron/curl');

  await test('a cURL URL that starts with a variable keeps it as written', () => {
    const parsed = parseCurl('curl "{{base_url}}/headers?x=1" -H "Authorization: Bearer T"');
    assert.ok(parsed.ok, parsed.error);
    assert.equal(parsed.request.url, '{{base_url}}/headers');
    assert.deepEqual(parsed.request.params.map((p) => [p.key, p.value]), [['x', '1']]);
    assert.equal(parseCurl('curl example.com/a').request.url, 'https://example.com/a');
  });

  await test('the default User-Agent carries the package version', () => {
    const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'electron', 'http-engine.js'), 'utf8');
    assert.ok(!/hitnrun\/\d+\.\d+\.\d+/.test(src), 'no hard-coded version');
    assert.ok(src.includes("require('../package.json')"));
  });

  await test('ui/open works while user-workspace writes are walled off', async () => {
    const { ControlServer } = require('../electron/control-server');
    const ws = new Workspace(tmp('ws'));
    const events = [];
    const server = new ControlServer({ workspace: ws, onEvent: (e) => events.push(e) });
    const port = 47700 + Math.floor(Math.random() * 200);
    await server.start(port);
    try {
      const open = await fetch(`http://127.0.0.1:${port}/ui/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'req_x' }),
      });
      assert.equal(open.status, 200);
      assert.ok(events.some((e) => e.type === 'ui:open' && e.requestId === 'req_x'));

      const write = await fetch(`http://127.0.0.1:${port}/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'nope' }),
      });
      assert.equal(write.status, 403, 'real writes are still refused');
    } finally {
      await server.stop();
    }
  });

  console.log('\nfolded JSON labels');

  const { countEntries, describeFold } = await import('../src/lib/foldLabel.mjs');

  await test('counts array items and object keys', () => {
    assert.equal(describeFold('[', '\n  1,\n  2,\n  3\n'), '3 items');
    assert.equal(describeFold('{', '"a": 1, "b": 2'), '2 keys');
    assert.equal(describeFold('[', '"only"'), '1 item');
    assert.equal(describeFold('{', '"k": null'), '1 key');
  });

  await test('empty containers count as zero', () => {
    assert.equal(countEntries(''), 0);
    assert.equal(countEntries('  \n  '), 0);
    assert.equal(describeFold('[', ''), '0 items');
  });

  await test('ignores commas inside nested values and strings', () => {
    const inner = '\n {"id":1,"tags":["a","b"]},\n {"id":2,"name":"x, y \\" z"},\n {"id":3}\n';
    assert.equal(countEntries(inner), 3);
    assert.equal(countEntries('"a,b": [1,2,3], "c": {"d": ","}'), 2);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

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

  await test('a malformed saved tab list is cleaned on load instead of blanking the window', () => {
    const file = tmp('ws');
    require('node:fs').writeFileSync(
      file,
      JSON.stringify({
        collections: [],
        ui: { tabs: [['req_a', 'req_b'], 'req_c', null, 'req_c', 42, 'req_d'], activeTabId: ['req_a'] },
      })
    );
    const ws = new Workspace(file);
    ws.load();
    assert.deepEqual(ws.getState().ui.tabs, ['req_c', 'req_d']);
    assert.equal(ws.getState().ui.activeTabId, 'req_d');
    ws.patchUi({ tabs: ['req_c', ['x']], activeTabId: 'req_c' });
    assert.deepEqual(ws.getState().ui.tabs, ['req_c']);
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

  console.log('\nepoch time panel');

  const E = await import('../src/lib/epoch.mjs');
  const MS = 1695391932115; // 2023-09-22T14:12:12.115Z

  await test('epochs are read in the unit their size implies', () => {
    assert.deepEqual(E.parseTimestamp(String(MS)), { ms: MS, unit: 'milliseconds' });
    assert.deepEqual(E.parseTimestamp('1695391932'), { ms: 1695391932000, unit: 'seconds' });
    assert.deepEqual(E.parseTimestamp('1695391932115000'), { ms: MS, unit: 'microseconds' });
    assert.deepEqual(E.parseTimestamp('1695391932115000000'), { ms: MS, unit: 'nanoseconds' });
  });

  await test('quotes, commas and dates are understood; junk is not', () => {
    assert.equal(E.parseTimestamp(`"${MS}",`).ms, MS);
    assert.equal(E.parseTimestamp('1,695,391,932,115').ms, MS);
    assert.deepEqual(E.parseTimestamp('2023-09-22T14:12:12.115Z'), { ms: MS, unit: 'date' });
    assert.ok(E.parseTimestamp('soon').error);
    assert.ok(E.parseTimestamp('9'.repeat(25)).error, 'out of Date range');
    assert.equal(E.parseTimestamp('  '), null);
  });

  await test('a moment is shown in the chosen zone, with its offset', () => {
    const india = E.describeMoment(MS, 'Asia/Kolkata');
    assert.equal(india.iso, '2023-09-22T19:42:12.115+05:30');
    assert.match(india.local, /^Fri, 22 Sept? 2023, 19:42:12\.115 GMT\+05:30$/);
    assert.equal(india.utc, '2023-09-22T14:12:12.115Z');
    assert.equal(india.seconds, '1695391932');
    assert.equal(E.describeMoment(MS, 'UTC').iso, '2023-09-22T14:12:12.115+00:00');
    // Daylight saving: New York is -04:00 in September.
    assert.equal(E.describeMoment(MS, 'America/New_York').iso, '2023-09-22T10:12:12.115-04:00');
  });

  await test('relative time picks the largest whole unit', () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(E.relativeTime(now - 3 * 3600e3, now), '3 hours ago');
    assert.equal(E.relativeTime(now + 2 * 86400e3, now), 'in 2 days');
    assert.equal(E.relativeTime(now, now), 'now');
  });

  await test('the zone list starts with UTC, uses current names, and searches by city, name or offset', () => {
    const ids = E.timeZones().map((z) => z.id);
    assert.equal(ids[0], 'UTC');
    assert.equal(ids.includes('Asia/Calcutta'), false, 'old ICU names are replaced');
    assert.equal(new Set(ids).size, ids.length, 'no duplicates after renaming');
    assert.ok(E.searchZones('kolkata').some((z) => z.id === 'Asia/Kolkata'));
    assert.ok(E.searchZones('india standard').some((z) => z.id === 'Asia/Kolkata'));
    assert.ok(E.searchZones('+05:30').some((z) => z.id === 'Asia/Kolkata'));
    assert.ok(E.searchZones('new york').some((z) => z.id === 'America/New_York'));
    assert.equal(E.currentZoneName('Asia/Calcutta'), 'Asia/Kolkata');
    assert.equal(E.isZone('Mars/Olympus_Mons'), false);
  console.log('\nsidebar search');
  const { searchTree, ancestorsOf, queryWords } = await import('../src/lib/treeSearch.mjs');
  const req = (id, name, method, url) => ({ id, type: 'request', name, method, url });
  const tree = [
    {
      id: 'c1', name: 'Shop API', items: [
        { id: 'f1', type: 'folder', name: 'Users', items: [
          req('r1', 'List users', 'GET', 'https://x/users'),
          { id: 'f1a', type: 'folder', name: 'Admin', items: [req('r2', 'Ban', 'POST', 'https://x/admin/ban')] },
        ] },
        { id: 'f2', type: 'folder', name: 'Orders', items: [req('r3', 'Refund', 'POST', 'https://x/orders/1/refund')] },
        req('r4', 'Health', 'GET', 'https://x/health'),
      ],
    },
    { id: 'c2', name: 'Other', items: [{ id: 'f3', type: 'folder', name: 'Misc', items: [req('r5', 'Ping', 'GET', 'https://ping.dev')] }] },
  ];

  await test('a blank query is no search', () => {
    assert.equal(searchTree(tree, ''), null);
    assert.equal(searchTree(tree, '   '), null);
    assert.deepEqual(queryWords('  A  b '), ['a', 'b']);
  });

  await test('a match deep in a folder opens every folder on the way, and only those', () => {
    const m = searchTree(tree, 'ban');
    assert.deepEqual([...m.requests], ['r2']);
    assert.deepEqual([...m.containers].sort(), ['c1', 'f1', 'f1a']);
  });

  await test('names, URLs and methods match, case aside', () => {
    assert.deepEqual([...searchTree(tree, 'REFUND').requests], ['r3']);
    assert.deepEqual([...searchTree(tree, 'ping.dev').requests], ['r5']);
    assert.deepEqual([...searchTree(tree, 'post').requests].sort(), ['r2', 'r3']);
  });

  await test("a folder's name finds what is inside it, and words combine", () => {
    assert.deepEqual([...searchTree(tree, 'users').requests].sort(), ['r1', 'r2']);
    assert.deepEqual([...searchTree(tree, 'users post').requests], ['r2']);
    assert.deepEqual([...searchTree(tree, 'misc').containers].sort(), ['c2', 'f3']);
  });

  await test('no match leaves nothing to show', () => {
    const m = searchTree(tree, 'nothing-like-this');
    assert.equal(m.requests.size, 0);
    assert.equal(m.containers.size, 0);
  });

  await test('missing names, URLs and items do not break the search', () => {
    const odd = [{ id: 'c', name: undefined, items: [{ id: 'r', type: 'request' }, null, { id: 'f', type: 'folder' }] }];
    assert.equal(searchTree(odd, 'x').requests.size, 0);
    assert.equal(searchTree(odd, 'undefined').requests.size, 0);
  });

  await test('the folders around a request are found, outermost first', () => {
    assert.deepEqual(ancestorsOf(tree, 'r2'), ['c1', 'f1', 'f1a']);
    assert.deepEqual(ancestorsOf(tree, 'r4'), ['c1']);
    assert.deepEqual(ancestorsOf(tree, 'nope'), []);
  });

  console.log('\nxml formatter');
  const X = await import('../src/lib/xmlFormat.mjs');

  await test('beautify indents elements and keeps text-only elements on one line', () => {
    assert.equal(
      X.formatXml('<a><b>1</b><c><d/></c></a>'),
      '<a>\n  <b>1</b>\n  <c>\n    <d/>\n  </c>\n</a>'
    );
    assert.equal(X.formatXml('<a><b>1</b></a>', { indent: 4 }), '<a>\n    <b>1</b>\n</a>');
    assert.equal(X.formatXml('<a><b>1</b></a>', { indent: '\t' }), '<a>\n\t<b>1</b>\n</a>');
  });

  await test('comments, CDATA, declarations and attribute values survive untouched', () => {
    const doc = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY e "v">]><a  x="1 > 0"   y=\'q = r\'><!-- c --><b><![CDATA[<raw> & ]]></b></a>';
    const out = X.formatXml(doc);
    for (const piece of ['<?xml version="1.0"?>', '<!DOCTYPE a [<!ENTITY e "v">]>', '<a x="1 > 0" y=\'q = r\'>', '<!-- c -->', '<b><![CDATA[<raw> & ]]></b>']) {
      assert.ok(out.includes(piece), `${piece} in\n${out}`);
    }
    assert.equal(X.formatXml(out), out, 'idempotent');
  });

  await test('minify removes only the whitespace between tags', () => {
    assert.equal(X.formatXml('<a>\n  <b> x y </b>\n  <c/>\n</a>', { minify: true }), '<a><b> x y </b><c/></a>');
  });

  await test('mixed text and xml:space="preserve" keep their whitespace', () => {
    assert.equal(X.formatXml('<r><p>Hi <b>you</b> !</p></r>'), '<r>\n  <p>Hi <b>you</b> !</p>\n</r>');
    const pre = '<pre xml:space="preserve">  a\n   b </pre>';
    assert.ok(X.formatXml(`<r>${pre}</r>`).includes(pre));
  });

  await test('problems are reported with where they are', () => {
    const e = (t) => X.parseXml(t).error;
    assert.deepEqual([e('<a>\n<b></a>').line, e('<a>\n<b></a>').col], [2, 4]);
    assert.match(e('<a>\n<b></a>').message, /Expected <\/b> but found <\/a>/);
    assert.match(e('<a>').message, /<a> is never closed/);
    assert.match(e('<a x=1/>').message, /must be in quotes/);
    assert.match(e('<a x="1" x="2"/>').message, /twice/);
    assert.match(e('<a>1 < 2</a>').message, /&lt;/);
    assert.match(e('<!-- x').message, /never closed/);
    assert.match(e('</a>').message, /closes nothing/);
    assert.equal(e('<a/>'), null);
    assert.equal(e(''), null);
  });

  await test('two roots or stray text are invalid, but can still be formatted', () => {
    const r = X.parseXml('<a/><b/>');
    assert.equal(r.error.fatal, false);
    assert.match(r.error.message, /More than one root/);
    assert.equal(X.formatXml('<a/><b/>'), '<a/>\n<b/>');
  });

  await test('formatting broken XML throws with a line and column', () => {
    assert.throws(() => X.formatXml('<a>\n<b>'), (err) => err.line === 2 && /never closed/.test(err.message));
    assert.equal(X.prettyXmlOrSame('<a><b></a>'), '<a><b></a>');
  });

  await test('response bodies: tryPretty indents XML that holds text', async () => {
    // The old pretty-printer lost track of depth after any element holding text.
    const out = X.prettyXmlOrSame('<list><item>a</item><item>b</item><n><x>1</x></n></list>');
    assert.equal(out, '<list>\n  <item>a</item>\n  <item>b</item>\n  <n>\n    <x>1</x>\n  </n>\n</list>');
  });

  await test('elements are counted', () => {
    assert.equal(X.countElements(X.parseXml('<a><b/><c><d/></c></a>').nodes), 4);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

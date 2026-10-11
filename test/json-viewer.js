'use strict';

/**
 * The JSON viewer: its parser, formatter and tree helpers (src/lib/jsonTree.mjs),
 * the bridge from a response to a page (src/lib/responseJson.mjs), and the
 * store that keeps its files (electron/json-files.js).
 *
 * The parser is checked against JSON.parse on thousands of generated and
 * mutated documents: it must accept exactly what JSON.parse accepts, and
 * formatting must never change a value.
 *
 *   node test/json-viewer.js
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { JsonFileStore, exportFileName, MAX_BYTES } = require('../electron/json-files');
const { Workspace } = require('../electron/workspace');

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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hitnrun-json-'));

/* ------------------------------------------------------- generated JSON */

// Seeded, so a failure can be reproduced.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed) {
  const rnd = mulberry32(seed);
  const int = (n) => Math.floor(rnd() * n);
  const pick = (list) => list[int(list.length)];
  const ws = () => pick(['', '', '', ' ', '\n', '  ', '\t', '\r\n', '\n    ']);

  const digits = (n) => Array.from({ length: n }, () => int(10)).join('');
  const number = () => {
    let s = rnd() < 0.3 ? '-' : '';
    s += rnd() < 0.2 ? '0' : String(1 + int(9)) + digits(int(rnd() < 0.1 ? 25 : 6));
    if (rnd() < 0.3) s += `.${digits(1 + int(5))}`;
    if (rnd() < 0.15) s += pick(['e', 'E']) + pick(['', '+', '-']) + digits(1 + int(3));
    return s;
  };
  const CHARS = ['a', 'b', 'Z', ' ', '0', '9', 'é', '中', '😀', ' ', '<', '/', ':', ',', '{', ']', "'"];
  const ESCAPES = ['\\"', '\\\\', '\\/', '\\b', '\\f', '\\n', '\\r', '\\t', '\\u00e9', '\\uD83D\\uDE00', '\\ud800', '\\u0000', '\\uFFFF'];
  const string = () => {
    let s = '"';
    const len = int(rnd() < 0.1 ? 40 : 8);
    for (let i = 0; i < len; i++) s += rnd() < 0.2 ? pick(ESCAPES) : pick(CHARS);
    return `${s}"`;
  };
  const KEYS = ['"id"', '"name"', '"a b"', '"x"', '"x"', '"~/"', '""', '"é"', '"1"', '"0"', '"\\u0061"', '"a"'];

  const value = (depth) => {
    const roll = int(depth > 5 ? 5 : 8);
    if (roll === 0) return pick(['true', 'false', 'null']);
    if (roll === 1 || roll === 2) return number();
    if (roll === 3 || roll === 4) return string();
    if (roll === 5 || roll === 6) {
      const n = int(5);
      if (n === 0) return `[${ws()}]`;
      return `[${Array.from({ length: n }, () => ws() + value(depth + 1) + ws()).join(',')}]`;
    }
    const n = int(5);
    if (n === 0) return `{${ws()}}`;
    return `{${Array.from({ length: n }, () => `${ws()}${pick(KEYS)}${ws()}:${ws()}${value(depth + 1)}${ws()}`).join(',')}}`;
  };
  return { rnd, int, pick, document: () => ws() + value(0) + ws() };
}

/** JSON.parse's verdict, with a leading byte order mark allowed as the viewer allows it. */
function oracle(text) {
  try {
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch {
    return { ok: false };
  }
}

/** Every node in a tree, parents before children. */
function allNodes(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    out.push(node);
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}

/** Follow a path made by jsonPath() through a parsed value. */
function evalPath(value, pathText) {
  assert.ok(pathText.startsWith('$'));
  const re = /\.([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/gy;
  re.lastIndex = 1;
  let cur = value;
  while (re.lastIndex < pathText.length) {
    const m = re.exec(pathText);
    assert.ok(m, `unparseable path ${pathText}`);
    if (m[1] !== undefined) cur = cur[m[1]];
    else if (m[2] !== undefined) cur = cur[Number(m[2])];
    else cur = cur[JSON.parse(m[3])];
  }
  return cur;
}

const hasDuplicateKeys = (text, root, keyName) =>
  allNodes(root).some((n) => n.type === 'object' && new Set(n.children.map((c) => keyName(text, c))).size !== n.children.length);

(async () => {
  const J = await import('../src/lib/jsonTree.mjs');
  const R = await import('../src/lib/responseJson.mjs');

  console.log('\nparsing');

  await test('every kind of value parses, with positions that slice back to it', () => {
    const text = '{"s":"x\\n\\u00e9","n":-1.5e3,"t":true,"f":false,"z":null,"a":[1,[],{}],"o":{"k":"v"}}';
    const r = J.parseJson(text);
    assert.equal(r.ok, true);
    assert.equal(r.count, 12);
    assert.equal(r.depth, 2);
    const types = r.root.children.map((c) => c.type);
    assert.deepEqual(types, ['string', 'number', 'boolean', 'boolean', 'null', 'array', 'object']);
    for (const node of allNodes(r.root)) {
      assert.deepEqual(J.toValue(text, node), JSON.parse(text.slice(node.from, node.to)));
      if (node.keyFrom >= 0) assert.equal(text[node.keyFrom], '"');
    }
    assert.equal(J.keyName(text, r.root.children[0]), 's');
  });

  await test('scalars, whitespace and a byte order mark around the root are fine', () => {
    for (const text of ['0', '-0', '"x"', 'null', ' \n\t\r true \n', '﻿{"a":1}', '[ ]', '{ }']) {
      assert.equal(J.parseJson(text).ok, true, text);
    }
  });

  await test('nothing but whitespace is "empty", not an error', () => {
    for (const text of ['', '   ', '\n\n', '﻿', '\t\r\n']) {
      assert.deepEqual(J.parseJson(text), { ok: false, empty: true });
    }
  });

  await test('errors say what is wrong and point at the right place', () => {
    const cases = [
      ['{', 1, 2, "missing '}' to close the object opened on line 1"],
      ['[1,2,]', 1, 5, "Trailing comma — remove the ',' before ']'"],
      ['{"a":1,\n}', 1, 7, 'Trailing comma'],
      ["{'a':1}", 1, 2, 'Property names must use double quotes'],
      ['{a:1}', 1, 2, 'Property names must be in double quotes'],
      ['[1 2]', 1, 4, 'is a comma missing?'],
      ['{"a":1\n"b":2}', 2, 1, 'is a comma missing?'],
      ['[1}', 1, 3, "the brackets don't match"],
      ['{"a" 1}', 1, 6, "Expected ':' after the property name"],
      ['"abc', 1, 1, 'Unterminated string'],
      ['["a\nb"]', 1, 4, "can't contain a line break"],
      ['"a\\qb"', 1, 3, 'Invalid escape "\\q"'],
      ['"\\u12G4"', 1, 2, '\\u must be followed by 4 hex digits'],
      ['"a\tb"', 1, 3, 'A tab must be escaped'],
      ['"\u0001"', 1, 2, 'Control character U+0001'],
      ['01', 1, 1, 'leading zeros'],
      ['1.', 1, 1, 'a digit is needed after the decimal point'],
      ['1e+', 1, 1, 'the exponent needs digits'],
      ['0x1F', 1, 1, 'hex numbers'],
      ['-', 1, 1, 'Invalid number "-"'],
      ['+1', 1, 1, 'numbers must start with a digit'],
      ['.5', 1, 1, 'numbers must start with a digit'],
      ['NaN', 1, 1, 'numbers must be finite'],
      ['-Infinity', 1, 1, 'numbers must be finite'],
      ['True', 1, 1, 'use true'],
      ['None', 1, 1, 'use null'],
      ['undefined', 1, 1, 'use null'],
      ['nul', 1, 1, 'did you mean null?'],
      ['hello', 1, 1, 'strings must be in double quotes'],
      ["['x']", 1, 2, 'Strings must use double quotes'],
      ['{} {}', 1, 4, "Unexpected '{' after the JSON value"],
      ['// note\n{}', 1, 1, 'Comments are not allowed'],
      ['{"a":1 /* x */}', 1, 8, 'Comments are not allowed'],
      ['[“1”]', 1, 2, 'curly quote'],
      ['{"a":1} ', 1, 8, 'non-breaking space'],
      ['{"a":}', 1, 6, "Expected a value, found '}'"],
      ['[,1]', 1, 2, "Expected a value, found ','"],
      ['{"a":', 1, 6, 'expected a value'],
      ['{"a"', 1, 5, "expected ':'"],
      ['[1,', 1, 4, 'expected a value'],
      ['{"x":[1,\n2', 2, 2, "missing ']' to close the array opened on line 1"],
      ['{,}', 1, 2, "found ','"],
    ];
    for (const [text, line, column, message] of cases) {
      const r = J.parseJson(text);
      assert.equal(r.ok, false, `${JSON.stringify(text)} should fail`);
      assert.ok(r.error.message.includes(message), `${JSON.stringify(text)}: "${r.error.message}" should mention "${message}"`);
      assert.deepEqual([r.error.line, r.error.column], [line, column], `${JSON.stringify(text)}: ${r.error.message}`);
      assert.ok(r.error.offset >= 0 && r.error.offset <= text.length);
    }
  });

  await test('accepts exactly what JSON.parse accepts (generated documents)', () => {
    const g = generator(1234);
    for (let i = 0; i < 3000; i++) {
      const text = g.document();
      const want = oracle(text);
      assert.equal(want.ok, true, `generator produced invalid JSON: ${text}`);
      const r = J.parseJson(text);
      assert.equal(r.ok, true, `${JSON.stringify(text)}: ${r.error?.message}`);
      assert.deepStrictEqual(JSON.parse(J.formatJson(text, r.root)), want.value);
    }
  });

  await test('accepts exactly what JSON.parse accepts (mutated documents)', () => {
    const g = generator(99);
    const NOISE = ['"', '\\', ',', ':', '{', '}', '[', ']', ' ', '\n', '0', '-', '.', 'e', 't', 'n', 'u', 'x', "'", '/', '*', '\t', '\u0001', ' '];
    let rejected = 0;
    for (let i = 0; i < 6000; i++) {
      let text = g.document();
      for (let m = 1 + g.int(3); m > 0; m--) {
        const at = g.int(text.length + 1);
        const roll = g.int(3);
        if (roll === 0) text = text.slice(0, at) + text.slice(at + 1);
        else if (roll === 1) text = text.slice(0, at) + g.pick(NOISE) + text.slice(at);
        else text = text.slice(0, at) + g.pick(NOISE) + text.slice(at + 1);
      }
      const want = oracle(text);
      const r = J.parseJson(text);
      assert.equal(r.ok, want.ok, `${JSON.stringify(text)}: JSON.parse ${want.ok ? 'accepts' : 'rejects'}, viewer ${r.ok ? 'accepts' : r.error?.message || 'says empty'}`);
      if (r.ok) assert.deepStrictEqual(JSON.parse(J.formatJson(text, r.root)), want.value);
      else {
        rejected++;
        if (!r.empty) assert.ok(r.error.offset >= 0 && r.error.offset <= text.length && r.error.message);
      }
    }
    assert.ok(rejected > 1000, 'the mutations should break plenty of documents');
  });

  await test('a 200,000-deep document parses without overflowing the stack', () => {
    const n = 200000;
    const text = '['.repeat(n) + ']'.repeat(n);
    const r = J.parseJson(text);
    assert.equal(r.ok, true);
    assert.equal(r.depth, n - 1);
    assert.equal(J.formatJson(text, r.root, { minify: true }), text);
    const unclosed = J.parseJson('['.repeat(n));
    assert.equal(unclosed.ok, false);
    assert.match(unclosed.error.message, /missing '\]'/);
  });

  console.log('\nformatting');

  await test('beautify matches JSON.stringify for 2, 4 spaces and tabs; minify matches it compact', () => {
    const g = generator(7);
    for (let i = 0; i < 1500; i++) {
      // Re-serialise first so strings and numbers are in JSON.stringify's own spelling.
      const canonical = JSON.stringify(JSON.parse(g.document()));
      const r = J.parseJson(canonical);
      const value = JSON.parse(canonical);
      assert.equal(J.formatJson(canonical, r.root), JSON.stringify(value, null, 2));
      assert.equal(J.formatJson(canonical, r.root, { indent: 4 }), JSON.stringify(value, null, 4));
      assert.equal(J.formatJson(canonical, r.root, { indent: 'tab' }), JSON.stringify(value, null, '\t'));
      assert.equal(J.formatJson(canonical, r.root, { minify: true }), canonical);
    }
  });

  await test('numbers and strings are kept exactly as written', () => {
    const text = '{"id":12345678901234567890,"price":1.50,"exp":1E+5,"neg":-0,"s":"caf\\u00e9 \\/ \\"q\\""}';
    const r = J.parseJson(text);
    const out = J.formatJson(text, r.root);
    for (const piece of ['12345678901234567890', '1.50', '1E+5', '-0', '"caf\\u00e9 \\/ \\"q\\""']) {
      assert.ok(out.includes(piece), `lost ${piece}`);
    }
    // JSON.stringify(JSON.parse()) is what loses precision; the viewer must not.
    assert.ok(!JSON.stringify(JSON.parse(text)).includes('12345678901234567890'));
  });

  await test('duplicate keys are kept, in order', () => {
    const text = '{"a":1,"a":2,"b":3}';
    const r = J.parseJson(text);
    assert.equal(J.formatJson(text, r.root, { minify: true }), text);
    assert.equal(J.formatJson(text, r.root, { minify: true, sortKeys: true }), text);
  });

  await test('sort keys orders every object, keeps arrays in order, and changes no value', () => {
    const text = '{"b":{"z":1,"y":[{"d":1,"c":2}]},"a":[3,1,2],"B":0,"é":1,"":2}';
    const r = J.parseJson(text);
    const sorted = J.formatJson(text, r.root, { sortKeys: true, minify: true });
    assert.equal(sorted, '{"":2,"B":0,"a":[3,1,2],"b":{"y":[{"c":2,"d":1}],"z":1},"é":1}');
    const g = generator(55);
    for (let i = 0; i < 500; i++) {
      const doc = g.document();
      const p = J.parseJson(doc);
      assert.deepStrictEqual(JSON.parse(J.formatJson(doc, p.root, { sortKeys: true })), JSON.parse(doc));
    }
  });

  await test('formatting is idempotent, and a sub-tree formats on its own', () => {
    const g = generator(31);
    for (let i = 0; i < 500; i++) {
      const doc = g.document();
      const once = J.formatJson(doc, J.parseJson(doc).root);
      assert.equal(J.formatJson(once, J.parseJson(once).root), once);
    }
    const text = '{"outer":{"inner":[1,{"x":true}]}}';
    const r = J.parseJson(text);
    const inner = r.root.children[0];
    assert.equal(J.formatJson(text, inner), JSON.stringify({ inner: [1, { x: true }] }, null, 2));
    assert.equal(J.formatJson(text, inner.children[0].children[0]), '1');
  });

  await test('indenting a pathologically deep document throws a RangeError, not something worse', () => {
    const n = 200000;
    const text = '['.repeat(n) + ']'.repeat(n);
    assert.throws(() => J.formatJson(text, J.parseJson(text).root), RangeError);
  });

  console.log('\npositions and paths');

  await test('the cursor finds the deepest value it is in', () => {
    const text = '{\n  "a": {\n    "b": [10, 20]\n  },\n  "c": "x"\n}';
    const r = J.parseJson(text);
    const at = (needle, offset = 0) => J.jsonPath(text, J.nodeAt(r.root, text.indexOf(needle) + offset));
    assert.equal(at('"a"'), '$.a');
    assert.equal(at('"a"', 2), '$.a');
    assert.equal(at('"b"'), '$.a.b');
    assert.equal(at('10'), '$.a.b[0]');
    assert.equal(at('10', 2), '$.a.b[0]'); // right after the value
    assert.equal(at(', 20'), '$.a.b[0]'); // the comma right after a value still touches it
    assert.equal(at(', 20', 1), '$.a.b'); // between items
    assert.equal(at('20'), '$.a.b[1]');
    assert.equal(at('"x"'), '$.c');
    assert.equal(at('{'), '$');
    assert.equal(J.jsonPath(text, J.nodeAt(r.root, text.length)), '$');
  });

  await test('nodeAt agrees with the node ranges everywhere in random documents', () => {
    const g = generator(4242);
    for (let i = 0; i < 400; i++) {
      const text = g.document();
      const r = J.parseJson(text);
      const nodes = allNodes(r.root);
      for (const node of nodes) {
        assert.equal(J.nodeAt(r.root, J.nodeStart(node)), node);
        if (!node.children) assert.equal(J.nodeAt(r.root, node.to), node);
      }
      for (let k = 0; k < 20; k++) {
        const pos = g.int(text.length + 1);
        const hit = J.nodeAt(r.root, pos);
        if (hit !== r.root) assert.ok(J.nodeStart(hit) <= pos && pos <= hit.to);
        // Nothing deeper contains the position.
        for (const kid of hit.children || []) assert.ok(!(J.nodeStart(kid) <= pos && pos <= kid.to));
      }
    }
  });

  await test('paths lead back to the value, including awkward property names', () => {
    const text = '{"plain":1,"a b":{"x.y":[{"é":true}]},"":{"\\"q\\"":null},"1st":2,"$ok_1":3,"a\\u0062":4}';
    const r = J.parseJson(text);
    const value = JSON.parse(text);
    const paths = allNodes(r.root).map((n) => J.jsonPath(text, n));
    assert.ok(paths.includes('$["a b"]["x.y"][0]["é"]'));
    assert.ok(paths.includes('$[""]["\\"q\\""]'));
    assert.ok(paths.includes('$["1st"]'));
    assert.ok(paths.includes('$.$ok_1'));
    assert.ok(paths.includes('$.ab'));
    for (const node of allNodes(r.root)) {
      assert.deepStrictEqual(evalPath(value, J.jsonPath(text, node)), J.toValue(text, node));
    }
    const g = generator(77);
    for (let i = 0; i < 300; i++) {
      const doc = g.document();
      const p = J.parseJson(doc);
      if (hasDuplicateKeys(doc, p.root, J.keyName)) continue;
      const v = JSON.parse(doc);
      for (const node of allNodes(p.root)) assert.deepStrictEqual(evalPath(v, J.jsonPath(doc, node)), J.toValue(doc, node));
    }
  });

  await test('state keys are unique, survive reformatting, and tell repeated names apart', () => {
    const text = '{"a":{"x":1},"a":{"x":2},"a/b":[1,{"~":0}],"":3}';
    const r = J.parseJson(text);
    const keys = allNodes(r.root).map((n) => J.stateKey(text, n));
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(r.root.children.map((c) => J.stateKey(text, c)), ['/a', '/a~2', '/a~1b', '/']);
    for (const node of allNodes(r.root)) assert.equal(J.findByKey(text, r.root, J.stateKey(text, node)), node);

    const pretty = J.formatJson(text, r.root, { indent: 4 });
    const p = J.parseJson(pretty);
    for (const node of allNodes(r.root)) {
      const again = J.findByKey(pretty, p.root, J.stateKey(text, node));
      assert.ok(again, J.stateKey(text, node));
      assert.equal(J.formatJson(pretty, again, { minify: true }), J.formatJson(text, node, { minify: true }));
    }
    assert.equal(J.findByKey(text, r.root, '/nope'), null);
    assert.equal(J.findByKey(text, r.root, '/a~1b/9'), null);
    assert.equal(J.findByKey(text, r.root, '/a~1b/01'), null);
    assert.equal(J.findByKey(text, r.root, '/a/x/deeper'), null);
  });

  console.log('\nthe tree');

  await test('collapsed containers hide their children', () => {
    const text = '{"a":{"b":1,"c":[1,2]},"d":2}';
    const r = J.parseJson(text);
    const labels = (rows) => rows.map((n) => J.jsonPath(text, n));
    assert.deepEqual(labels(J.visibleNodes(r.root, () => true)), ['$', '$.a', '$.a.b', '$.a.c', '$.a.c[0]', '$.a.c[1]', '$.d']);
    assert.deepEqual(labels(J.visibleNodes(r.root, (n) => n === r.root)), ['$', '$.a', '$.d']);
    assert.deepEqual(labels(J.visibleNodes(r.root, () => false)), ['$']);
    assert.deepEqual(J.visibleNodes(null, () => true), []);
  });

  await test('the filter keeps matches and the way to them, and matches names and values', () => {
    const text = '{"jobName":"Sync","scheduleData":{"timeZone":"Asia/Kolkata","startTime":null},"jobData":{"url":"/parts","podId":"PROD_C"}}';
    const r = J.parseJson(text);
    const rows = (q, isOpen = () => false) => J.visibleNodes(r.root, isOpen, J.filterTree(text, r.root, q)).map((n) => J.jsonPath(text, n));
    assert.deepEqual(rows('kolkata'), ['$', '$.scheduleData', '$.scheduleData.timeZone']);
    assert.deepEqual(rows('TIME'), ['$', '$.scheduleData', '$.scheduleData.timeZone', '$.scheduleData.startTime']);
    assert.deepEqual(rows('job'), ['$', '$.jobName', '$.jobData']);
    // A matching container stays closed until opened, then shows all of itself.
    assert.deepEqual(rows('job', (n) => J.keyName(text, n) === 'jobData'), ['$', '$.jobName', '$.jobData', '$.jobData.url', '$.jobData.podId']);
    assert.deepEqual(rows('null'), ['$', '$.scheduleData', '$.scheduleData.startTime']);
    assert.deepEqual(rows('no such thing'), []);
    assert.equal(J.filterTree(text, r.root, '   '), null);
  });

  await test('labels and previews', () => {
    const text = `{"a":[1],"b":[],"c":{"x":1,"y":2},"s":"${'z'.repeat(300)}","e":"😀😀"}`;
    const r = J.parseJson(text);
    const [a, b, c, s, e] = r.root.children;
    assert.equal(J.countLabel(a), '1 item');
    assert.equal(J.countLabel(b), '0 items');
    assert.equal(J.countLabel(c), '2 keys');
    assert.equal(J.previewText(text, s, 20), `"${'z'.repeat(19)}…"`);
    assert.equal(J.previewText(text, e, 3), '"😀…"'); // never splits the emoji's surrogate pair
    assert.equal(J.previewText(text, e), '"😀😀"');
  });

  await test('copy value gives a string without quotes, a number as written, a container as JSON', () => {
    const text = '{"s":"a\\nb","n":1.50,"o":{"k":[true]}}';
    const r = J.parseJson(text);
    const [s, n, o] = r.root.children;
    assert.equal(J.copyText(text, s), 'a\nb');
    assert.equal(J.copyText(text, n), '1.50');
    assert.equal(J.copyText(text, o, { indent: 2 }), '{\n  "k": [\n    true\n  ]\n}');
  });

  await test('JSON stored inside a string is recognised', () => {
    const text = '{"payload":"{\\"a\\":1,\\"b\\":[2]}","list":"\\n  [1, 2]","plain":"hello","broken":"{\\"a\\":","num":5}';
    const r = J.parseJson(text);
    const [payload, list, plain, broken, num] = r.root.children;
    assert.equal(J.embeddedJson(text, payload), '{"a":1,"b":[2]}');
    assert.equal(J.embeddedJson(text, list), '\n  [1, 2]');
    assert.equal(J.embeddedJson(text, plain), null);
    assert.equal(J.embeddedJson(text, broken), null);
    assert.equal(J.embeddedJson(text, num), null);
  });

  await test('text for a new file is beautified when valid and left alone when not', () => {
    assert.equal(J.beautifyIfValid('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}');
    assert.equal(J.beautifyIfValid('{"a":1}', 4), '{\n    "a": 1\n}');
    assert.equal(J.beautifyIfValid('{"a":1}', 'tab'), '{\n\t"a": 1\n}');
    assert.equal(J.beautifyIfValid('{"a":1,}\r\n'), '{"a":1,}\n');
    assert.equal(J.beautifyIfValid(''), '');
    assert.equal(J.beautifyIfValid('not json'), 'not json');
    const deep = '['.repeat(200000) + ']'.repeat(200000);
    assert.equal(J.beautifyIfValid(deep), deep, 'too deep to indent: kept as it came');
  });

  await test('line and column count from 1', () => {
    assert.deepEqual(J.lineCol('ab\ncd', 0), { line: 1, column: 1 });
    assert.deepEqual(J.lineCol('ab\ncd', 2), { line: 1, column: 3 });
    assert.deepEqual(J.lineCol('ab\ncd', 3), { line: 2, column: 1 });
    assert.deepEqual(J.lineCol('ab\ncd', 5), { line: 2, column: 3 });
  });

  console.log('\nfrom a response');

  await test('JSON bodies open, whatever the content type says; other bodies say why not', () => {
    assert.equal(R.notJsonReason('application/json; charset=utf-8', '{"a":1}'), null);
    assert.equal(R.notJsonReason('application/problem+json', '{"status":404}'), null);
    assert.equal(R.notJsonReason('application/vnd.api+json', '[]'), null);
    assert.equal(R.notJsonReason('application/json', '"pong"'), null, 'a scalar is JSON too');
    assert.equal(R.notJsonReason('application/json', '{"broken":'), null, 'broken JSON opens, so the viewer can show where');
    assert.equal(R.notJsonReason('text/plain', '  \n {"a":1}'), null, 'JSON sent as text');
    assert.equal(R.notJsonReason('application/octet-stream', '[1,2]'), null);
    assert.equal(R.notJsonReason('', '{"a":1}'), null, 'no content type');
    assert.equal(R.notJsonReason(undefined, '[1]'), null);
    assert.equal(R.notJsonReason('text/html; charset=utf-8', '<!doctype html>'), 'This response is text/html, not JSON');
    assert.equal(R.notJsonReason('application/xml', '<a/>'), 'This response is application/xml, not JSON');
    assert.equal(R.notJsonReason('text/plain', 'hello'), 'This response is text/plain, not JSON');
    assert.equal(R.notJsonReason('text/plain', '42'), 'This response is text/plain, not JSON', 'a bare number in plain text is just text');
    assert.equal(R.notJsonReason('', 'hello'), 'This response is not JSON');
    assert.equal(R.notJsonReason('application/json', ''), 'The response body is empty');
    assert.equal(R.notJsonReason('application/json', ' \n\t '), 'The response body is empty');
    assert.equal(R.notJsonReason('text/plain', null), 'The response body is empty');
    assert.equal(R.notJsonReason('image/png', '\ufffdPNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR'), 'The response body is binary, not JSON');
    assert.equal(R.notJsonReason('application/json', '{\u0000}'), 'The response body is binary, not JSON');
    const big = '[' + '1,'.repeat(3_000_000) + '1]';
    const t0 = Date.now();
    assert.equal(R.notJsonReason('text/plain', big), null);
    assert.ok(Date.now() - t0 < 100, 'deciding never parses the body');
  });

  await test('a page is named after the request, or after what the URL points at', () => {
    assert.equal(R.responsePageName('Get order', 'https://api.example.com/orders/1042'), 'Get order.json');
    assert.equal(R.responsePageName('  users.json ', 'https://x.test/'), 'users.json', 'no second .json');
    assert.equal(R.responsePageName('New Request', 'https://api.example.com/v1/users?page=2'), 'users.json');
    assert.equal(R.responsePageName('', 'https://api.example.com/orders/1042'), 'orders 1042.json');
    assert.equal(R.responsePageName(undefined, 'https://api.example.com/users/3f2a9c1e-77b0-4c3e-9d2b-0a6f4f1c8e21'), 'users 3f2a9c1e-77b0-4c3e-9d2b-0a6f4f1c8e21.json');
    assert.equal(R.responsePageName(null, 'https://api.example.com/feed.json'), 'feed.json');
    assert.equal(R.responsePageName(null, 'https://api.example.com/v1.2'), 'v1.2.json', 'only a word counts as an extension');
    assert.equal(R.responsePageName(null, 'https://api.example.com/search/caf%C3%A9'), 'café.json');
    assert.equal(R.responsePageName(null, 'https://api.example.com/bad/%E0%A4%A'), '%E0%A4%A.json', 'a broken escape is kept as it is');
    assert.equal(R.responsePageName(null, 'http://127.0.0.1:47600/'), '127.0.0.1.json');
    assert.equal(R.responsePageName(null, '1042'), 'response.json', 'not a URL');
    assert.equal(R.responsePageName(null, undefined), 'response.json');
    assert.equal(R.responsePageName(null, 'https://api.example.com/42'), '42.json', 'an id with nothing before it stays');
  });

  console.log('\nfile store');

  await test('new files are numbered, listed newest first, and saved to disk', () => {
    const dir = path.join(tmpDir(), 'json-files');
    const store = new JsonFileStore(dir);
    store.load();
    const a = store.create();
    const b = store.create({ content: '[1]' });
    assert.equal(a.name, 'Untitled 1.json');
    assert.equal(b.name, 'Untitled 2.json');
    assert.deepEqual(store.list().map((f) => f.id), [b.id, a.id]);
    store.remove(a.id);
    assert.equal(store.create().name, 'Untitled 1.json'); // the lowest free number
    store.saveNow();

    const again = new JsonFileStore(dir);
    again.load();
    assert.equal(again.list().length, 2);
    assert.equal(again.get(b.id).content, '[1]');
    assert.equal(again.get(b.id).size, 3);
  });

  await test('edits are debounced, written atomically, and only real changes count', async () => {
    const dir = path.join(tmpDir(), 'json-files');
    const store = new JsonFileStore(dir);
    store.load();
    const events = [];
    store.on('changed', (e) => events.push(e.reason));
    const f = store.create({ name: 'a.json', content: '{}' });
    store.update(f.id, { content: '{"a":1}' });
    assert.equal(fs.existsSync(store.textPath(f.id)), false, 'nothing written before the debounce');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(fs.readFileSync(store.textPath(f.id), 'utf8'), '{"a":1}');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
    const before = events.length;
    store.update(f.id, { content: '{"a":1}' });
    store.update(f.id, { name: 'a.json' });
    store.update(f.id, { name: '   ' });
    assert.equal(events.length, before, 'no-op updates are not changes');
    assert.equal(store.update('jsn_0000000000000000', { name: 'x' }), null);
  });

  await test('line endings are normalised and sizes are in bytes', () => {
    const store = new JsonFileStore(path.join(tmpDir(), 'json-files'));
    store.load();
    const f = store.create({ content: '{\r\n"é":1\r}' });
    assert.equal(store.get(f.id).content, '{\n"é":1\n}');
    assert.equal(f.size, 10);
  });

  await test('rename, duplicate and delete', () => {
    const dir = path.join(tmpDir(), 'json-files');
    const store = new JsonFileStore(dir);
    store.load();
    const f = store.create({ name: '  orders.json  ', content: '{"n":1}' });
    assert.equal(f.name, 'orders.json');
    const c1 = store.duplicate(f.id);
    const c2 = store.duplicate(f.id);
    const c3 = store.duplicate(c1.id);
    assert.deepEqual([c1.name, c2.name, c3.name], ['orders copy.json', 'orders copy 2.json', 'orders copy 3.json']);
    assert.equal(store.get(c1.id).content, '{"n":1}');
    assert.deepEqual(store.list().map((x) => x.id).slice(0, 2), [f.id, c2.id], 'a copy goes right after its original');
    assert.equal(store.update(f.id, { name: 'renamed\u0000.json' }).name, 'renamed .json');
    store.saveNow();
    assert.equal(store.remove(c1.id), true);
    assert.equal(store.remove(c1.id), false);
    assert.equal(store.get(c1.id), null);
    const again = new JsonFileStore(dir);
    again.load();
    assert.equal(again.list().length, 3);
  });

  await test('a page from a response gets a name of its own', () => {
    const store = new JsonFileStore(path.join(tmpDir(), 'json-files'));
    store.load();
    const names = ['orders.json', 'orders.json', 'Orders.json', 'orders.json'].map((name) => store.create({ name, unique: true }).name);
    assert.deepEqual(names, ['orders.json', 'orders 2.json', 'Orders 3.json', 'orders 4.json'], 'names are compared ignoring case');
    assert.equal(store.create({ name: 'orders.json' }).name, 'orders.json', 'files opened from disk keep their name');
    assert.equal(store.create({ name: 'notes', unique: true }).name, 'notes');
    assert.equal(store.create({ name: 'notes', unique: true }).name, 'notes 2');
    assert.equal(store.create({ name: '  ', unique: true }).name, 'Untitled 1.json');
    store.remove(store.list().find((f) => f.name === 'orders 2.json').id);
    assert.equal(store.create({ name: 'orders.json', unique: true }).name, 'orders 2.json', 'a freed number is used again');
  });

  await test('bad arguments from the window are shrugged off', () => {
    const store = new JsonFileStore(path.join(tmpDir(), 'json-files'));
    store.load();
    assert.equal(store.create(null).name, 'Untitled 1.json');
    const f = store.create({ content: 42 });
    assert.equal(store.get(f.id).content, '42');
    assert.equal(store.update(f.id, null).name, f.name);
    assert.equal(store.update(f.id, { name: 7, content: null }).name, f.name);
    assert.equal(store.get(f.id).content, '42');
    assert.equal(store.get(null), null);
    assert.equal(store.remove(undefined), false);
    assert.equal(store.duplicate({}), null);
  });

  await test('files over the size limit are refused', () => {
    const store = new JsonFileStore(path.join(tmpDir(), 'json-files'));
    store.load();
    const big = 'x'.repeat(MAX_BYTES + 1);
    assert.equal(store.create({ content: big }), null);
    const f = store.create({ content: '{}' });
    assert.equal(store.update(f.id, { content: big }), null);
    assert.equal(store.get(f.id).content, '{}');
  });

  await test('a corrupt index is backed up and the texts are recovered', () => {
    const dir = path.join(tmpDir(), 'json-files');
    const store = new JsonFileStore(dir);
    store.load();
    const f = store.create({ name: 'keep.json', content: '{"keep":true}' });
    store.saveNow();
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json');
    const again = new JsonFileStore(dir);
    again.on('error', () => {});
    again.load();
    assert.equal(again.list().length, 1);
    assert.equal(again.get(f.id).content, '{"keep":true}');
    assert.match(again.list()[0].name, /^Recovered 1\.json$/);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('index.json.corrupt-')));
  });

  await test('leftover texts and temp files are cleaned up; ids from outside are ignored', async () => {
    const dir = path.join(tmpDir(), 'json-files');
    const store = new JsonFileStore(dir);
    store.load();
    store.create({ content: '1' });
    store.saveNow();
    fs.writeFileSync(path.join(dir, 'jsn_aaaaaaaaaaaaaaaa.json'), 'orphan');
    fs.writeFileSync(path.join(dir, 'jsn_bbbbbbbbbbbbbbbb.json.tmp'), 'half');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    index.files.push({ id: '../../evil', name: 'x' }, { id: 'jsn_cccccccccccccccc', name: 'missing text.json' });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
    const again = new JsonFileStore(dir);
    again.load();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(again.list().map((f) => f.name), ['Untitled 1.json', 'missing text.json']);
    assert.equal(again.get('jsn_cccccccccccccccc').content, '');
    assert.equal(again.get('../../evil'), null);
    const left = fs.readdirSync(dir);
    assert.ok(!left.includes('jsn_aaaaaaaaaaaaaaaa.json'));
    assert.ok(!left.includes('jsn_bbbbbbbbbbbbbbbb.json.tmp'));
    assert.ok(left.includes('notes.txt'));
  });

  await test('save-as names end in .json and are safe for the file system', () => {
    assert.equal(exportFileName('orders.json'), 'orders.json');
    assert.equal(exportFileName('Get users'), 'Get users.json');
    assert.equal(exportFileName('v1.2'), 'v1.2.json');
    assert.equal(exportFileName('a/b:c'), 'a b c.json');
    assert.equal(exportFileName('data.jsonc'), 'data.jsonc');
    assert.equal(exportFileName(''), 'data.json');
  });

  console.log('\nworkspace');

  await test('the viewer\'s tabs and mode are sanitised like the request tabs', () => {
    const ws = new Workspace(path.join(tmpDir(), 'ws.json'));
    ws.saveNow = () => {};
    ws.scheduleSave = () => {};
    assert.equal(ws.getState().ui.view, 'requests');
    ws.patchUi({ view: 'json', jsonTabs: ['jsn_1', ['nested'], null, 'jsn_1', 'jsn_2'], jsonActiveId: 'jsn_9' });
    assert.equal(ws.getState().ui.view, 'json');
    assert.deepEqual(ws.getState().ui.jsonTabs, ['jsn_1', 'jsn_2']);
    assert.equal(ws.getState().ui.jsonActiveId, 'jsn_2');
    ws.patchUi({ view: 'bogus', jsonTabs: 'not a list' });
    assert.equal(ws.getState().ui.view, 'requests');
    assert.deepEqual(ws.getState().ui.jsonTabs, []);
    assert.equal(ws.getState().ui.jsonActiveId, null);
  });

  await test('a saved workspace from before the viewer loads with it switched off', () => {
    const file = path.join(tmpDir(), 'ws.json');
    fs.writeFileSync(file, JSON.stringify({ ui: { tabs: [], activeTabId: null } }));
    const ws = new Workspace(file);
    ws.load();
    assert.equal(ws.getState().ui.view, 'requests');
    assert.deepEqual(ws.getState().ui.jsonTabs, []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

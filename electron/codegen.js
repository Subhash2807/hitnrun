'use strict';

/**
 * Code snippets for the request's Code panel: cURL, JavaScript fetch, Python.
 *
 * With `resolve` on, {{variables}} are filled from the active environment, the
 * collection and globals; off, they stay as written so the snippet can be
 * shared without leaking values.
 */

const { compile, buildScope, resolveString } = require('./resolve');
const { toCurl } = require('./curl');
const { fullUrl } = require('./runner');

const LANGUAGES = [
  { id: 'curl', label: 'cURL' },
  { id: 'fetch', label: 'JavaScript – fetch' },
  { id: 'python', label: 'Python – requests' },
];

/** Resolve against nothing, so {{vars}} survive compile untouched. */
function blankState(state) {
  return { globals: [], environments: [], activeEnvironmentId: null, settings: state.settings };
}

function wire(request, state, collection, resolve) {
  const coll = collection ? { ...collection, variables: resolve ? collection.variables : [] } : null;
  const { spec } = compile(request, resolve ? state : blankState(state), coll);
  const headers = [...spec.headers];
  const auth = spec.auth || {};
  if (auth.type === 'bearer' && auth.token) headers.push(['Authorization', `Bearer ${auth.token}`]);
  else if (auth.type === 'basic') {
    const raw = `${auth.username ?? ''}:${auth.password ?? ''}`;
    headers.push(['Authorization', `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`]);
  } else if (auth.type === 'apikey' && auth.key && auth.in !== 'query') headers.push([auth.key, auth.value ?? '']);

  const b = spec.body || {};
  if (b.type === 'text' && b.contentType && !headers.some(([k]) => /^content-type$/i.test(k))) {
    headers.push(['Content-Type', b.contentType]);
  }

  // fullUrl() needs a parseable URL; a {{base_url}} prefix isn't one.
  let url = fullUrl(spec);
  if (url === spec.url && spec.query.length) {
    const qs = spec.query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  if (!resolve) url = url.replace(/^http:\/\/(\{\{)/, '$1').replace(/%7B%7B/g, '{{').replace(/%7D%7D/g, '}}');

  return { method: spec.method, url, headers, body: spec.body };
}

const js = (v) => JSON.stringify(v);
const py = (v) => JSON.stringify(v); // a JSON string literal is a valid Python string literal

function toFetch(w) {
  const lines = [];
  const opts = [`  method: ${js(w.method)},`];
  if (w.headers.length) {
    opts.push('  headers: {');
    for (const [k, v] of w.headers) opts.push(`    ${js(k)}: ${js(v)},`);
    opts.push('  },');
  }
  const b = w.body || {};
  if (b.type === 'text') {
    let bodyExpr = js(b.text);
    try {
      if (/json/i.test(b.contentType || '')) bodyExpr = `JSON.stringify(${JSON.stringify(JSON.parse(b.text), null, 2).replace(/\n/g, '\n  ')})`;
    } catch { /* keep raw */ }
    opts.push(`  body: ${bodyExpr},`);
  } else if (b.type === 'urlencoded') {
    opts.push(`  body: new URLSearchParams(${js(Object.fromEntries(b.fields.map((f) => [f.key, f.value])))}),`);
  } else if (b.type === 'form') {
    lines.push('const form = new FormData();');
    for (const f of b.fields) {
      lines.push(f.type === 'file' ? `form.append(${js(f.key)}, fileInput.files[0]); // ${f.src || 'file'}` : `form.append(${js(f.key)}, ${js(f.value)});`);
    }
    lines.push('');
    opts.push('  body: form,');
  } else if (b.type === 'file') {
    opts.push(`  body: fileBlob, // ${b.src || 'file'}`);
  }
  lines.push(`const response = await fetch(${js(w.url)}, {`, ...opts, '});', '', 'console.log(response.status, await response.text());');
  return lines.join('\n');
}

function toPython(w) {
  const lines = ['import requests', ''];
  lines.push(`url = ${py(w.url)}`);
  const args = ['url'];
  if (w.headers.length) {
    lines.push('headers = {');
    for (const [k, v] of w.headers) lines.push(`    ${py(k)}: ${py(v)},`);
    lines.push('}');
    args.push('headers=headers');
  }
  const b = w.body || {};
  if (b.type === 'text') {
    let parsed;
    try {
      if (/json/i.test(b.contentType || '')) parsed = JSON.parse(b.text);
    } catch { /* not JSON */ }
    if (parsed !== undefined) {
      lines.push(`payload = ${pyLiteral(parsed, 0)}`);
      args.push('json=payload');
    } else {
      lines.push(`data = ${py(b.text)}`);
      args.push('data=data');
    }
  } else if (b.type === 'urlencoded') {
    lines.push(`data = ${pyLiteral(Object.fromEntries(b.fields.map((f) => [f.key, f.value])), 0)}`);
    args.push('data=data');
  } else if (b.type === 'form') {
    const text = b.fields.filter((f) => f.type !== 'file');
    const files = b.fields.filter((f) => f.type === 'file');
    if (text.length) {
      lines.push(`data = ${pyLiteral(Object.fromEntries(text.map((f) => [f.key, f.value])), 0)}`);
      args.push('data=data');
    }
    if (files.length) {
      lines.push('files = {');
      for (const f of files) lines.push(`    ${py(f.key)}: open(${py(f.src || 'file')}, "rb"),`);
      lines.push('}');
      args.push('files=files');
    }
  } else if (b.type === 'file') {
    lines.push(`data = open(${py(b.src || 'file')}, "rb")`);
    args.push('data=data');
  }
  lines.push('', `response = requests.request(${py(w.method)}, ${args.join(', ')})`, 'print(response.status_code, response.text)');
  return lines.join('\n');
}

/** JSON value -> Python literal (True/False/None instead of true/false/null). */
function pyLiteral(value, indent) {
  const pad = '    '.repeat(indent + 1);
  const end = '    '.repeat(indent);
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return py(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => pad + pyLiteral(v, indent + 1)).join(',\n')},\n${end}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad}${py(k)}: ${pyLiteral(v, indent + 1)}`).join(',\n')},\n${end}}`;
}

function generate(request, { state, collection = null, language = 'curl', resolve = false } = {}) {
  if (language === 'curl') {
    const scope = buildScope(state, collection);
    return toCurl(request, resolve ? { resolve: (v) => resolveString(v ?? '', scope) } : {});
  }
  const w = wire(request, state, collection, resolve);
  if (language === 'fetch') return toFetch(w);
  if (language === 'python') return toPython(w);
  throw new Error(`Unknown language "${language}"`);
}

module.exports = { generate, LANGUAGES };

'use strict';

/**
 * Turn a test doc into something you can hand to someone else:
 *   Markdown  — pastes into GitHub, Jira, Confluence
 *   HTML      — one self-contained file, opens in any browser
 *   Postman   — a v2.1 collection, so the steps can be re-run in order
 *
 * Secrets are masked by default, because the whole point is sharing.
 * Screenshots can't be masked: they go out exactly as taken.
 */

const crypto = require('node:crypto');

/* ---------------------------------------------------------------- masking */

const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'apikey',
  'x-auth-token', 'x-access-token', 'x-refresh-token', 'x-csrf-token', 'x-xsrf-token', 'x-amz-security-token',
]);
// Matched against header, query and JSON key names. Tight on purpose: "author"
// or "footprint" must not get masked.
const SECRET_NAME =
  /password|passwd|passphrase|^pass$|secret|token|api[-_]?key|authoriz|^auth$|session[-_]?id|^sid$|signature|credential|cvv|^otp$|[-_]otp$|^pin$|private[-_]?key/i;

const DOTS = '••••••';

/** Keep a short tail so two masked values can still be told apart. */
function maskValue(value) {
  const s = String(value ?? '');
  if (!s) return s;
  const scheme = s.match(/^(Bearer|Basic|Token|Digest)\s+/i);
  const rest = scheme ? s.slice(scheme[0].length) : s;
  const tail = rest.length > 12 ? rest.slice(-4) : '';
  return `${scheme ? scheme[0] : ''}${DOTS}${tail}`;
}

function maskCookie(value) {
  return String(value ?? '')
    .split(/;\s*/)
    .map((part, i) => {
      const eq = part.indexOf('=');
      if (eq === -1) return part;
      const key = part.slice(0, eq);
      // Set-Cookie attributes (Path, Expires…) after the first pair stay readable.
      if (i > 0 && /^(path|expires|max-age|domain|samesite|secure|httponly)$/i.test(key.trim())) return part;
      return `${key}=${DOTS}`;
    })
    .join('; ');
}

function maskHeaders(pairs) {
  return (pairs || []).map(([k, v]) => {
    const lower = String(k).toLowerCase();
    if (lower === 'cookie' || lower === 'set-cookie') return [k, maskCookie(v)];
    // CORS headers name things like "credentials" but never carry a secret.
    if (lower.startsWith('access-control-')) return [k, v];
    if (SECRET_HEADERS.has(lower) || SECRET_NAME.test(lower)) return [k, maskValue(v)];
    return [k, v];
  });
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const [k] of [...u.searchParams]) {
      if (SECRET_NAME.test(k)) {
        u.searchParams.set(k, DOTS);
        changed = true;
      }
    }
    // URLSearchParams re-encodes the dots; show them as written.
    return changed ? u.href.replace(/%E2%80%A2/g, '•') : url;
  } catch {
    return url;
  }
}

function maskJson(node) {
  if (Array.isArray(node)) return node.map(maskJson);
  // Echo endpoints often return the request body as a JSON string; look inside.
  if (typeof node === 'string' && /^\s*[[{]/.test(node)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(node)));
    } catch {
      return node;
    }
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = SECRET_NAME.test(k) && (typeof v === 'string' || typeof v === 'number') ? maskValue(v) : maskJson(v);
    }
    return out;
  }
  return node;
}

function maskBody(text, contentType) {
  if (text == null) return text;
  const trimmed = String(text).trim();
  if (/json/i.test(contentType || '') || /^[[{]/.test(trimmed)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(trimmed)), null, 2);
    } catch { /* not JSON */ }
  }
  if (/urlencoded/i.test(contentType || '')) {
    return String(text)
      .split('&')
      .map((pair) => {
        const [k, ...v] = pair.split('=');
        return SECRET_NAME.test(decodeURIComponent(k)) && v.length ? `${k}=${DOTS}` : pair;
      })
      .join('&');
  }
  return text;
}

/** A copy of the doc with secrets hidden. The stored doc is never changed. */
function maskDoc(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  for (const step of copy.steps) {
    if (isShot(step)) continue;
    step.request.url = maskUrl(step.request.url);
    step.request.headers = maskHeaders(step.request.headers);
    step.request.body = maskBody(step.request.body, step.request.bodyContentType);
    if (step.response) {
      step.response.headers = maskHeaders(step.response.headers);
      step.response.body = maskBody(step.response.body, step.response.contentType);
    }
  }
  return copy;
}

/* ---------------------------------------------------------------- helpers */

const isShot = (step) => step.kind === 'shot';
const hasShots = (doc) => doc.steps.some(isShot);

function pretty(text, contentType) {
  if (text == null) return '';
  const trimmed = String(text).trim();
  if (/json/i.test(contentType || '') || /^[[{]/.test(trimmed)) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch { /* leave as is */ }
  }
  return String(text);
}

function fenceLang(contentType, text) {
  const ct = contentType || '';
  if (/json/i.test(ct) || /^\s*[[{]/.test(text || '')) return 'json';
  if (/html/i.test(ct)) return 'html';
  if (/xml/i.test(ct)) return 'xml';
  if (/javascript/i.test(ct)) return 'js';
  return '';
}

/** A fence longer than any backtick run inside, so bodies can't break out. */
function fence(text, lang) {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

const STATUS_ICON = { pass: '✅', fail: '❌', untested: '⚪' };
const STATUS_WORD = { pass: 'Pass', fail: 'Fail', untested: 'Not checked' };

const fmtDate = (ms) => new Date(ms).toLocaleString();
const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function tally(doc) {
  const c = { pass: 0, fail: 0, untested: 0 };
  for (const s of doc.steps) c[s.status] = (c[s.status] || 0) + 1;
  return c;
}

function prepare(doc, { mask = true } = {}) {
  return mask ? maskDoc(doc) : doc;
}

/* --------------------------------------------------------------- markdown */

function toMarkdown(source, options = {}) {
  const doc = prepare(source, options);
  const c = tally(doc);
  const envs = [...new Set(doc.steps.map((s) => s.environment).filter(Boolean))];
  const out = [];

  out.push(`# ${doc.name}`, '');
  if (doc.description?.trim()) out.push(doc.description.trim(), '');
  out.push(
    `| | |`,
    `|---|---|`,
    `| **Recorded** | ${fmtDate(doc.createdAt)} |`,
    `| **Steps** | ${doc.steps.length} — ✅ ${c.pass} pass · ❌ ${c.fail} fail · ⚪ ${c.untested} not checked |`,
    ...(envs.length ? [`| **Environment** | ${envs.join(', ')} |`] : []),
    ''
  );

  if (doc.steps.length) {
    out.push('## Summary', '', '| # | Step | Request | Result | Status |', '|---|---|---|---|---|');
    doc.steps.forEach((s, i) => {
      if (isShot(s)) return out.push(`| ${i + 1} | ${escCell(s.title)} | 📷 Screenshot | | ${STATUS_ICON[s.status]} |`);
      const result = s.response ? `${s.response.status} · ${s.response.timeMs ?? '?'} ms` : 'Failed';
      out.push(`| ${i + 1} | ${escCell(s.title)} | \`${s.request.method}\` ${escCell(s.request.url)} | ${result} | ${STATUS_ICON[s.status]} |`);
    });
    out.push('');
  }

  doc.steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title} ${STATUS_ICON[s.status]}`, '');
    if (isShot(s)) return out.push(...markdownShot(s, options), '');
    const result = s.response
      ? `**${s.response.status} ${s.response.statusText}** · ${s.response.timeMs ?? '?'} ms · ${fmtBytes(s.response.size)}`
      : `**Failed:** ${s.error}`;
    out.push(`\`${s.request.method}\` ${s.request.url}`, '', `→ ${result}`, '');
    const meta = [`Sent ${fmtDate(s.at)}`];
    if (s.environment) meta.push(`env: ${s.environment}`);
    if (s.source === 'ai') meta.push('sent by Claude');
    out.push(`<sub>${meta.join(' · ')}</sub>`, '');

    if (s.expected?.trim()) out.push(`**Expected:** ${s.expected.trim()}`, '');
    if (s.note?.trim()) out.push(`> ${s.note.trim().replace(/\n/g, '\n> ')}`, '');
    if (s.tests?.length) {
      out.push('**Tests**', '');
      for (const t of s.tests) out.push(`- ${t.passed ? '✅' : '❌'} ${t.name}${t.error ? ` — ${t.error}` : ''}`);
      out.push('');
    }

    out.push(details('Request headers', headerBlock(s.request.headers)));
    if (s.request.body != null && s.request.body !== '') {
      const body = pretty(s.request.body, s.request.bodyContentType);
      out.push(details('Request body', fence(body, fenceLang(s.request.bodyContentType, body)) + truncNote(s.request.bodyTruncated)));
    }
    if (s.response) {
      out.push(details('Response headers', headerBlock(s.response.headers)));
      if (s.response.binary) {
        out.push(details('Response body', `_Binary response (${s.response.contentType || 'unknown type'}, ${fmtBytes(s.response.size)}) — not included._`));
      } else if (s.response.body) {
        const body = pretty(s.response.body, s.response.contentType);
        out.push(details('Response body', fence(body, fenceLang(s.response.contentType, body)) + truncNote(s.response.truncated)));
      }
    }
    out.push('');
  });

  out.push('---', `_Generated by hitnrun on ${fmtDate(Date.now())}._`, '');
  return out.join('\n');
}

/** A screenshot links into the images folder written next to the .md (see `shotFileName`). */
function markdownShot(s, { imageDir } = {}) {
  const out = [];
  const meta = [`Taken ${fmtDate(s.at)}`];
  if (s.shot?.source) meta.push(s.shot.source);
  out.push(`<sub>${meta.join(' · ')}</sub>`, '');
  if (s.expected?.trim()) out.push(`**Expected:** ${s.expected.trim()}`, '');
  if (s.note?.trim()) out.push(`> ${s.note.trim().replace(/\n/g, '\n> ')}`, '');
  const alt = String(s.title).replace(/[[\]]/g, '');
  out.push(imageDir ? `![${alt}](<${imageDir}/${shotFileName(s)}>)` : '_Screenshot not included._', '');
  return out;
}

/** The name a screenshot gets in an exported images folder: unique per step. */
function shotFileName(step) {
  return `${step.id}.png`;
}

const escCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const headerBlock = (pairs) => fence((pairs || []).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)', 'http');
const truncNote = (t) => (t ? '\n\n_Truncated — the full body was larger than the recording limit._' : '');

// <details> renders collapsed on GitHub, GitLab and most Markdown viewers.
function details(summary, body) {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>\n`;
}

/* ------------------------------------------------------------------- html */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const METHOD_COLOR = {
  GET: '#16a34a', POST: '#d97706', PUT: '#2563eb', PATCH: '#7c3aed', DELETE: '#dc2626', HEAD: '#0891b2', OPTIONS: '#db2777',
};

/**
 * @param {object} options
 *   mask      hide secrets (default true)
 *   expandAll open every section — used for PDF, where nothing can be clicked
 *   image     (file) => Buffer | null, the PNG behind a screenshot step; embedded as data:
 */
function toHtml(source, options = {}) {
  const doc = prepare(source, options);
  const open = options.expandAll ? ' open' : '';
  const c = tally(doc);
  const envs = [...new Set(doc.steps.map((s) => s.environment).filter(Boolean))];

  const section = (title, inner) => `<details${open}><summary>${esc(title)}</summary>${inner}</details>`;
  const pre = (text) => `<pre>${esc(text)}</pre>`;
  const headerTable = (pairs) =>
    pairs?.length
      ? `<table class="kv">${pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`
      : '<p class="dim">(none)</p>';

  const shotSection = (s, i) => {
    const meta = [`Taken ${esc(fmtDate(s.at))}`];
    if (s.shot?.source) meta.push(esc(s.shot.source));
    const png = options.image ? options.image(s.shot?.file) : null;
    const parts = [];
    if (s.expected?.trim()) parts.push(`<p><b>Expected:</b> ${esc(s.expected.trim())}</p>`);
    if (s.note?.trim()) parts.push(`<blockquote>${esc(s.note.trim()).replace(/\n/g, '<br>')}</blockquote>`);
    parts.push(png
      ? `<img class="shot" src="data:image/png;base64,${png.toString('base64')}" alt="${esc(s.title)}">`
      : '<p class="dim">Screenshot file is missing.</p>');
    return `<section class="step" id="step-${i + 1}">
        <h2><span class="num">${i + 1}</span>${esc(s.title)}<span class="status ${s.status}">${STATUS_ICON[s.status]} ${STATUS_WORD[s.status]}</span></h2>
        <div class="meta">📷 ${meta.join(' · ')}</div>
        ${parts.join('\n')}
      </section>`;
  };

  const steps = doc.steps
    .map((s, i) => {
      if (isShot(s)) return shotSection(s, i);
      const r = s.response;
      const code = r ? `<span class="code ${r.status < 300 ? 'ok' : r.status < 400 ? 'redir' : 'bad'}">${r.status} ${esc(r.statusText)}</span>
          <span class="dim">${r.timeMs ?? '?'} ms · ${fmtBytes(r.size)}</span>`
        : `<span class="code bad">Failed</span> <span class="dim">${esc(s.error)}</span>`;
      const meta = [`Sent ${esc(fmtDate(s.at))}`];
      if (s.environment) meta.push(`env: ${esc(s.environment)}`);
      if (s.source === 'ai') meta.push('sent by Claude');

      const parts = [];
      if (s.expected?.trim()) parts.push(`<p><b>Expected:</b> ${esc(s.expected.trim())}</p>`);
      if (s.note?.trim()) parts.push(`<blockquote>${esc(s.note.trim()).replace(/\n/g, '<br>')}</blockquote>`);
      if (s.tests?.length) {
        parts.push(`<ul class="tests">${s.tests.map((t) => `<li>${t.passed ? '✅' : '❌'} ${esc(t.name)}${t.error ? ` — <span class="dim">${esc(t.error)}</span>` : ''}</li>`).join('')}</ul>`);
      }
      parts.push(section('Request headers', headerTable(s.request.headers)));
      if (s.request.body != null && s.request.body !== '') {
        parts.push(section('Request body', pre(pretty(s.request.body, s.request.bodyContentType)) + (s.request.bodyTruncated ? '<p class="dim">Truncated.</p>' : '')));
      }
      if (r) {
        parts.push(section('Response headers', headerTable(r.headers)));
        if (r.binary) parts.push(section('Response body', `<p class="dim">Binary response (${esc(r.contentType)}) — not included.</p>`));
        else if (r.body) parts.push(section('Response body', pre(pretty(r.body, r.contentType)) + (r.truncated ? '<p class="dim">Truncated.</p>' : '')));
      }

      return `<section class="step" id="step-${i + 1}">
        <h2><span class="num">${i + 1}</span>${esc(s.title)}<span class="status ${s.status}">${STATUS_ICON[s.status]} ${STATUS_WORD[s.status]}</span></h2>
        <div class="line"><span class="method" style="background:${METHOD_COLOR[s.request.method] || '#555'}">${esc(s.request.method)}</span><code class="url">${esc(s.request.url)}</code></div>
        <div class="line">${code}</div>
        <div class="meta">${meta.join(' · ')}</div>
        ${parts.join('\n')}
      </section>`;
    })
    .join('\n');

  const summaryRows = doc.steps
    .map((s, i) => isShot(s)
      ? `<tr><td>${i + 1}</td><td><a href="#step-${i + 1}">${esc(s.title)}</a></td><td>📷 Screenshot</td><td></td><td>${STATUS_ICON[s.status]}</td></tr>`
      : `<tr><td>${i + 1}</td><td><a href="#step-${i + 1}">${esc(s.title)}</a></td><td><b>${esc(s.request.method)}</b> ${esc(s.request.url)}</td><td>${s.response ? `${s.response.status} · ${s.response.timeMs ?? '?'} ms` : 'Failed'}</td><td>${STATUS_ICON[s.status]}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.name)}</title>
<style>
  :root { --bg:#fff; --fg:#1f2328; --dim:#6b7280; --line:#e5e7eb; --soft:#f6f8fa; --accent:#0284c7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181d; --fg:#e6e6e6; --dim:#9aa0a6; --line:#2d3139; --soft:#1e2127; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { margin: 0 0 6px; font-size: 26px; }
  .brand { color: var(--accent); font-weight: 600; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  .desc { white-space: pre-wrap; margin: 10px 0 16px; }
  .facts { display:flex; flex-wrap:wrap; gap:8px 22px; color:var(--dim); margin-bottom: 20px; }
  .facts b { color: var(--fg); }
  table { border-collapse: collapse; width: 100%; }
  .summary td, .summary th { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  .summary td:nth-child(3) { word-break: break-all; font-family: ui-monospace,Consolas,monospace; font-size: 12.5px; }
  .summary a { color: var(--accent); text-decoration: none; }
  .step { border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 18px 0; break-inside: avoid-page; }
  .step h2 { font-size: 17px; margin: 0 0 10px; display:flex; align-items:center; gap:10px; }
  .num { display:inline-grid; place-items:center; min-width:24px; height:24px; border-radius:12px; background:var(--accent); color:#fff; font-size:12px; }
  .status { margin-left:auto; font-size:12px; font-weight:500; padding:2px 10px; border-radius:12px; background:var(--soft); }
  .status.pass { color:#16a34a; } .status.fail { color:#dc2626; } .status.untested { color:var(--dim); }
  .line { display:flex; align-items:center; gap:10px; margin: 4px 0; flex-wrap: wrap; }
  .method { color:#fff; font-weight:700; font-size:11px; padding:2px 7px; border-radius:4px; }
  .url { word-break: break-all; font-size: 13px; }
  .code { font-weight:600; } .code.ok { color:#16a34a; } .code.redir { color:#d97706; } .code.bad { color:#dc2626; }
  .meta, .dim { color: var(--dim); font-size: 12.5px; }
  blockquote { margin: 10px 0; padding: 6px 12px; border-left: 3px solid var(--accent); background: var(--soft); border-radius: 0 6px 6px 0; }
  details { border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
  summary { cursor: pointer; padding: 7px 12px; font-weight: 500; user-select: none; }
  details[open] > summary { border-bottom: 1px solid var(--line); }
  details > :not(summary) { margin: 10px 12px; }
  pre { background: var(--soft); padding: 10px 12px; border-radius: 6px; overflow: auto; max-height: 560px; font: 12.5px/1.5 ui-monospace,Consolas,monospace; white-space: pre-wrap; word-break: break-word; }
  .kv td { padding: 3px 8px; border-bottom: 1px solid var(--line); font: 12.5px ui-monospace,Consolas,monospace; vertical-align: top; word-break: break-all; }
  .kv td:first-child { width: 32%; color: var(--dim); }
  .tests { padding-left: 18px; margin: 8px 0; }
  .shot { display: block; margin-top: 10px; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
  footer { color: var(--dim); font-size: 12px; margin-top: 30px; }
  @media print { pre { max-height: none; } .step { border-color: #ccc; } }
</style></head>
<body><main>
  <div class="brand">hitnrun · test documentation</div>
  <h1>${esc(doc.name)}</h1>
  ${doc.description?.trim() ? `<div class="desc">${esc(doc.description.trim())}</div>` : ''}
  <div class="facts">
    <span>Recorded <b>${esc(fmtDate(doc.createdAt))}</b></span>
    <span>Steps <b>${doc.steps.length}</b></span>
    <span>✅ <b>${c.pass}</b> pass</span><span>❌ <b>${c.fail}</b> fail</span><span>⚪ <b>${c.untested}</b> not checked</span>
    ${envs.length ? `<span>Environment <b>${esc(envs.join(', '))}</b></span>` : ''}
  </div>
  ${doc.steps.length ? `<table class="summary"><thead><tr><th>#</th><th>Step</th><th>Request</th><th>Result</th><th></th></tr></thead><tbody>${summaryRows}</tbody></table>` : '<p class="dim">No steps recorded.</p>'}
  ${steps}
  <footer>Generated by hitnrun on ${esc(fmtDate(Date.now()))}${options.mask === false ? '' : ' · secrets masked'}.</footer>
</main></body></html>`;
}

/* ---------------------------------------------------------------- postman */

const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function toPostman(source, options = {}) {
  const doc = prepare(source, options);
  // Postman has nowhere to put an image; numbering still follows the doc.
  const item = doc.steps.map((s, i) => [s, i]).filter(([s]) => !isShot(s)).map(([s, i]) => {
    const header = (s.request.headers || [])
      // Transport headers the client will add itself.
      .filter(([k]) => !/^(content-length|host|accept-encoding|user-agent)$/i.test(k))
      .map(([key, value]) => ({ key, value }));
    const request = { method: s.request.method, header, url: s.request.url };
    if (s.request.body != null && s.request.body !== '') {
      const ct = s.request.bodyContentType || '';
      request.body = { mode: 'raw', raw: s.request.body };
      if (/json/i.test(ct)) request.body.options = { raw: { language: 'json' } };
    }
    const description = [s.expected && `Expected: ${s.expected}`, s.note].filter(Boolean).join('\n\n');
    if (description) request.description = description;

    const entry = { name: `${i + 1}. ${s.title}`, request };
    if (s.response) {
      entry.response = [
        {
          name: `${s.response.status} ${s.response.statusText}`.trim(),
          originalRequest: request,
          status: s.response.statusText,
          code: s.response.status,
          header: (s.response.headers || []).map(([key, value]) => ({ key, value })),
          body: s.response.body ?? '',
        },
      ];
    }
    return entry;
  });

  return JSON.stringify(
    {
      info: {
        _postman_id: crypto.randomUUID(),
        name: doc.name,
        description: doc.description || '',
        schema: POSTMAN_SCHEMA,
      },
      item,
    },
    null,
    2
  );
}

/* ---------------------------------------------------------------- formats */

const FORMATS = {
  markdown: { ext: 'md', label: 'Markdown', filter: { name: 'Markdown', extensions: ['md'] } },
  html: { ext: 'html', label: 'HTML', filter: { name: 'HTML', extensions: ['html'] } },
  pdf: { ext: 'pdf', label: 'PDF', filter: { name: 'PDF', extensions: ['pdf'] } },
  postman: { ext: 'postman_collection.json', label: 'Postman collection', filter: { name: 'Postman collection', extensions: ['json'] } },
};

function safeFileName(name) {
  return String(name || 'test-doc').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'test-doc';
}

module.exports = {
  toMarkdown, toHtml, toPostman, maskDoc, hasShots, shotFileName, maskHeaders, maskUrl, maskBody, maskValue, FORMATS, safeFileName, POSTMAN_SCHEMA,
};

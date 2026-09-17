'use strict';

/**
 * cURL parsing and generation.
 *
 * Lives in the main process so there is exactly one implementation: the URL bar
 * (via IPC) and the agent control server both call through here.
 */

/** Shell-aware tokenizer: single quotes, double quotes, $'..', backslash and ^ continuations. */
function tokenize(input) {
  const tokens = [];
  let i = 0;
  let cur = '';
  let started = false;
  const s = String(input);

  const push = () => {
    if (started) tokens.push(cur);
    cur = '';
    started = false;
  };

  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      i += s[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (c === '^' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      i += s[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (c === '`' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      push();
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      i++;
      continue;
    }

    // ANSI-C quoting: $'foo\nbar'
    if (c === '$' && s[i + 1] === "'") {
      started = true;
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\') {
          const n = s[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
          if (n in map) {
            cur += map[n];
            i += 2;
            continue;
          }
        }
        cur += s[i++];
      }
      i++;
      continue;
    }

    if (c === "'") {
      started = true;
      i++;
      while (i < s.length && s[i] !== "'") cur += s[i++];
      i++;
      continue;
    }

    if (c === '"') {
      started = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && '"\\$`\n'.includes(s[i + 1])) {
          if (s[i + 1] === '\n') {
            i += 2;
            continue;
          }
          cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      i++;
      continue;
    }

    if (c === '\\' && i + 1 < s.length) {
      started = true;
      cur += s[i + 1];
      i += 2;
      continue;
    }

    started = true;
    cur += c;
    i++;
  }
  push();
  return tokens;
}

function looksLikeCurl(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return false;
  return /^curl(\.exe)?[\s\n]/i.test(t) || /^curl(\.exe)?$/i.test(t);
}

const kv = (key, value) => ({ key, value: value ?? '', description: '', enabled: true });

function splitOnce(str, sep) {
  const idx = str.indexOf(sep);
  if (idx === -1) return [str, null];
  return [str.slice(0, idx), str.slice(idx + sep.length)];
}

/**
 * Parse a cURL command into the app's request model.
 * Returns { ok: true, request } or { ok: false, error }.
 */
function parseCurl(command) {
  const tokens = tokenize(command);
  if (!tokens.length) return { ok: false, error: 'Empty command' };

  let start = 0;
  if (/^curl(\.exe)?$/i.test(tokens[0])) start = 1;

  const headers = [];
  const formFields = [];
  const urlencodedFields = [];
  const dataParts = [];
  let url = null;
  let method = null;
  let user = null;
  let isGet = false; // -G moves data into the query string
  let dataIsJson = false;
  let insecure = false;
  let followRedirects = false;
  let binaryFile = null;

  for (let i = start; i < tokens.length; i++) {
    let t = tokens[i];
    const next = () => tokens[++i];

    // Support --header=value as well as --header value
    let inlineValue = null;
    if (t.startsWith('--') && t.includes('=')) {
      const [flag, val] = splitOnce(t, '=');
      // Only treat as inline if the flag is a known value-taking flag.
      if (
        [
          '--header', '--request', '--data', '--data-raw', '--data-binary', '--data-ascii',
          '--data-urlencode', '--form', '--form-string', '--user', '--url', '--user-agent',
          '--referer', '--cookie', '--json', '--connect-timeout', '--max-time', '--output',
        ].includes(flag)
      ) {
        t = flag;
        inlineValue = val;
      }
    }
    const take = () => (inlineValue !== null ? inlineValue : next());

    switch (t) {
      case '-H':
      case '--header': {
        const raw = take();
        if (raw == null) break;
        const [k, v] = splitOnce(raw, ':');
        if (v === null) {
          // "Header;" means send an empty header
          headers.push(kv(k.replace(/;$/, ''), ''));
        } else {
          headers.push(kv(k.trim(), v.trim()));
        }
        break;
      }
      case '-X':
      case '--request':
        method = (take() || '').toUpperCase();
        break;
      case '--url':
        url = take();
        break;
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
        dataParts.push(take() ?? '');
        break;
      case '--data-binary': {
        const v = take() ?? '';
        if (v.startsWith('@')) binaryFile = v.slice(1);
        else dataParts.push(v);
        break;
      }
      case '--json': {
        dataParts.push(take() ?? '');
        dataIsJson = true;
        break;
      }
      case '--data-urlencode': {
        const raw = take() ?? '';
        const [k, v] = splitOnce(raw, '=');
        if (v === null) urlencodedFields.push(kv('', k));
        else urlencodedFields.push(kv(k, v));
        break;
      }
      case '-F':
      case '--form':
      case '--form-string': {
        const raw = take() ?? '';
        const [k, v] = splitOnce(raw, '=');
        if (v === null) break;
        if (v.startsWith('@') || v.startsWith('<')) {
          const [src, ...rest] = v.slice(1).split(';');
          const typePart = rest.find((r) => r.trim().startsWith('type='));
          formFields.push({
            key: k,
            type: 'file',
            src,
            contentType: typePart ? typePart.trim().slice(5) : '',
            value: '',
            enabled: true,
            description: '',
          });
        } else {
          formFields.push({ key: k, type: 'text', value: v, enabled: true, description: '' });
        }
        break;
      }
      case '-u':
      case '--user':
        user = take();
        break;
      case '-A':
      case '--user-agent':
        headers.push(kv('User-Agent', take()));
        break;
      case '-e':
      case '--referer':
        headers.push(kv('Referer', take()));
        break;
      case '-b':
      case '--cookie':
        headers.push(kv('Cookie', take()));
        break;
      case '-G':
      case '--get':
        isGet = true;
        break;
      case '-k':
      case '--insecure':
        insecure = true;
        break;
      case '-L':
      case '--location':
        followRedirects = true;
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      // Flags we accept and ignore — they do not affect the request we build.
      case '-s': case '--silent': case '-S': case '--show-error':
      case '-v': case '--verbose': case '-i': case '--include':
      case '--compressed': case '-f': case '--fail': case '-#': case '--progress-bar':
      case '-g': case '--globoff': case '--no-buffer': case '-N':
        break;
      // Flags that consume an argument we do not model.
      case '-o': case '--output': case '--connect-timeout': case '--max-time':
      case '-m': case '--retry': case '--cert': case '--key': case '--cacert':
      case '-x': case '--proxy': case '--resolve': case '-w': case '--write-out':
        take();
        break;
      default:
        if (t.startsWith('-') && t.length > 1) {
          // Unknown flag: skip. Bundled short flags like -sS land here harmlessly.
          break;
        }
        if (!url) url = t;
        break;
    }
  }

  if (!url) return { ok: false, error: 'No URL found in the cURL command' };
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = 'https://' + url;

  // Split query string off the URL into the params grid.
  const params = [];
  let cleanUrl = url;
  const qIdx = url.indexOf('?');
  if (qIdx !== -1) {
    cleanUrl = url.slice(0, qIdx);
    const hashIdx = url.indexOf('#', qIdx);
    const qs = hashIdx === -1 ? url.slice(qIdx + 1) : url.slice(qIdx + 1, hashIdx);
    for (const pair of qs.split('&')) {
      if (!pair) continue;
      const [k, v] = splitOnce(pair, '=');
      params.push(kv(safeDecode(k), v === null ? '' : safeDecode(v)));
    }
    if (hashIdx !== -1) cleanUrl += url.slice(hashIdx);
  }

  const data = dataParts.join('&');

  // -G sends the data as query params instead of a body.
  if (isGet && (data || urlencodedFields.length)) {
    for (const pair of data.split('&')) {
      if (!pair) continue;
      const [k, v] = splitOnce(pair, '=');
      params.push(kv(safeDecode(k), v === null ? '' : safeDecode(v)));
    }
    for (const f of urlencodedFields) params.push(kv(f.key, f.value));
    urlencodedFields.length = 0;
    dataParts.length = 0;
  }

  const contentTypeHeader = headers.find((h) => h.key.toLowerCase() === 'content-type');
  const contentType = (contentTypeHeader?.value || (dataIsJson ? 'application/json' : '')).toLowerCase();

  // Decide the body mode from what curl was actually told to send.
  let body = { mode: 'none', raw: '', rawType: 'json', fields: [], src: '', graphql: { query: '', variables: '' } };

  if (formFields.length) {
    body = { ...body, mode: 'form-data', fields: formFields };
  } else if (binaryFile) {
    body = { ...body, mode: 'file', src: binaryFile };
  } else if (urlencodedFields.length) {
    body = { ...body, mode: 'urlencoded', fields: urlencodedFields };
  } else if (!isGet && data) {
    if (contentType.includes('x-www-form-urlencoded')) {
      const fields = [];
      for (const pair of data.split('&')) {
        if (!pair) continue;
        const [k, v] = splitOnce(pair, '=');
        fields.push(kv(safeDecode(k), v === null ? '' : safeDecode(v)));
      }
      body = { ...body, mode: 'urlencoded', fields };
    } else {
      let rawType = 'text';
      if (contentType.includes('json') || isProbablyJson(data)) rawType = 'json';
      else if (contentType.includes('xml')) rawType = 'xml';
      else if (contentType.includes('html')) rawType = 'html';

      let raw = data;
      if (rawType === 'json') {
        try {
          raw = JSON.stringify(JSON.parse(data), null, 2);
        } catch {
          /* leave the payload exactly as given */
        }
      }
      // GraphQL requests are JSON with a `query` key — surface them in the GraphQL tab.
      if (rawType === 'json') {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed.query === 'string' && /^\s*(query|mutation|subscription|\{)/.test(parsed.query)) {
            body = {
              ...body,
              mode: 'graphql',
              graphql: {
                query: parsed.query,
                variables: parsed.variables ? JSON.stringify(parsed.variables, null, 2) : '',
              },
            };
          }
        } catch {
          /* not GraphQL */
        }
      }
      if (body.mode !== 'graphql') body = { ...body, mode: 'raw', raw, rawType };
    }
  }

  if (!method) {
    method = body.mode !== 'none' ? 'POST' : 'GET';
  }

  let auth = { type: 'none' };
  if (user) {
    const [username, password] = splitOnce(user, ':');
    auth = { type: 'basic', username, password: password ?? '' };
  } else {
    const authHeader = headers.find((h) => h.key.toLowerCase() === 'authorization');
    if (authHeader && /^bearer\s+/i.test(authHeader.value)) {
      auth = { type: 'bearer', token: authHeader.value.replace(/^bearer\s+/i, '') };
      headers.splice(headers.indexOf(authHeader), 1);
    }
  }

  return {
    ok: true,
    request: {
      name: deriveName(cleanUrl, method),
      method,
      url: cleanUrl,
      params,
      pathVars: derivePathVars(cleanUrl),
      headers,
      auth,
      body,
      settings: { followRedirects, sslVerify: !insecure },
    },
  };
}

function safeDecode(v) {
  try {
    return decodeURIComponent(String(v).replace(/\+/g, ' '));
  } catch {
    return v;
  }
}

function isProbablyJson(s) {
  const t = String(s).trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** `:id` and `{{id}}`-free path segments become path variables. */
function derivePathVars(url) {
  const vars = [];
  try {
    const u = new URL(url);
    for (const seg of u.pathname.split('/')) {
      if (seg.startsWith(':') && seg.length > 1) {
        vars.push({ key: seg.slice(1), value: '', description: '' });
      }
    }
  } catch {
    /* unparseable URL — no path vars */
  }
  return vars;
}

function deriveName(url, method) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const tail = segs.slice(-2).join('/');
    return tail ? `${method} /${tail}` : `${method} ${u.hostname}`;
  } catch {
    return `${method} request`;
  }
}

/* ---------------------------------------------------------------- generate */

function shellQuote(value) {
  const s = String(value ?? '');
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Render a request model back to a cURL command.
 * `resolve` is an optional function applied to every value (variable substitution).
 */
function toCurl(request, { resolve = (v) => v, multiline = true } = {}) {
  const nl = multiline ? ' \\\n  ' : ' ';
  const parts = ['curl'];
  const method = (request.method || 'GET').toUpperCase();

  let url = resolve(request.url || '');
  for (const pv of request.pathVars || []) {
    if (pv.key) url = url.replace(`:${pv.key}`, encodeURIComponent(resolve(pv.value ?? '')));
  }
  const enabledParams = (request.params || []).filter((p) => p.enabled !== false && p.key);
  if (enabledParams.length) {
    const qs = enabledParams
      .map((p) => `${encodeURIComponent(resolve(p.key))}=${encodeURIComponent(resolve(p.value ?? ''))}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  if (method !== 'GET') parts.push(`-X ${method}`);
  parts.push(shellQuote(url));

  const headerLines = [];
  for (const h of request.headers || []) {
    if (h.enabled === false || !h.key) continue;
    headerLines.push(`-H ${shellQuote(`${resolve(h.key)}: ${resolve(h.value ?? '')}`)}`);
  }

  const auth = request.auth || { type: 'none' };
  if (auth.type === 'bearer' && auth.token) {
    headerLines.push(`-H ${shellQuote(`Authorization: Bearer ${resolve(auth.token)}`)}`);
  } else if (auth.type === 'basic') {
    headerLines.push(`-u ${shellQuote(`${resolve(auth.username ?? '')}:${resolve(auth.password ?? '')}`)}`);
  } else if (auth.type === 'apikey' && auth.key && auth.in !== 'query') {
    headerLines.push(`-H ${shellQuote(`${resolve(auth.key)}: ${resolve(auth.value ?? '')}`)}`);
  }

  const body = request.body || { mode: 'none' };
  const hasContentType = (request.headers || []).some(
    (h) => h.enabled !== false && h.key.toLowerCase() === 'content-type'
  );

  const bodyLines = [];
  if (body.mode === 'raw' && body.raw) {
    const ct = { json: 'application/json', xml: 'application/xml', html: 'text/html', text: 'text/plain' }[
      body.rawType || 'text'
    ];
    if (!hasContentType && ct) headerLines.push(`-H ${shellQuote(`Content-Type: ${ct}`)}`);
    bodyLines.push(`-d ${shellQuote(resolve(body.raw))}`);
  } else if (body.mode === 'graphql') {
    if (!hasContentType) headerLines.push(`-H ${shellQuote('Content-Type: application/json')}`);
    let variables;
    try {
      variables = body.graphql?.variables ? JSON.parse(resolve(body.graphql.variables)) : undefined;
    } catch {
      variables = undefined;
    }
    bodyLines.push(
      `-d ${shellQuote(JSON.stringify({ query: resolve(body.graphql?.query || ''), variables }))}`
    );
  } else if (body.mode === 'urlencoded') {
    if (!hasContentType) headerLines.push(`-H ${shellQuote('Content-Type: application/x-www-form-urlencoded')}`);
    const pairs = (body.fields || [])
      .filter((f) => f.enabled !== false && f.key)
      .map((f) => `${encodeURIComponent(resolve(f.key))}=${encodeURIComponent(resolve(f.value ?? ''))}`);
    if (pairs.length) bodyLines.push(`-d ${shellQuote(pairs.join('&'))}`);
  } else if (body.mode === 'form-data') {
    for (const f of body.fields || []) {
      if (f.enabled === false || !f.key) continue;
      const v = f.type === 'file' ? `@${f.src || ''}` : resolve(f.value ?? '');
      bodyLines.push(`-F ${shellQuote(`${resolve(f.key)}=${v}`)}`);
    }
  } else if (body.mode === 'file' && body.src) {
    bodyLines.push(`--data-binary ${shellQuote(`@${body.src}`)}`);
  }

  const all = [...headerLines, ...bodyLines];
  if (request.settings?.followRedirects) all.push('-L');
  if (request.settings?.sslVerify === false) all.push('-k');

  return parts.join(' ') + (all.length ? nl + all.join(nl) : '');
}

module.exports = { parseCurl, toCurl, looksLikeCurl, tokenize };

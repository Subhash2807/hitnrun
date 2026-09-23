'use strict';

/**
 * The HTTP engine runs in Electron's main process (Node), not in the renderer.
 * That is what lets us ignore CORS, read raw/duplicate response headers, follow
 * redirects manually, and measure real connection timings.
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { version } = require('../package.json');

const MIME = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

function guessMime(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function buildMultipart(fields) {
  const boundary = '--------------------------' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const f of fields) {
    if (f.enabled === false || !f.key) continue;
    if (f.type === 'file') {
      const src = f.src;
      if (!src || !fs.existsSync(src)) continue;
      const data = fs.readFileSync(src);
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${f.key}"; filename="${path.basename(src)}"\r\n` +
            `Content-Type: ${f.contentType || guessMime(src)}\r\n\r\n`
        )
      );
      chunks.push(data, Buffer.from('\r\n'));
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${f.key}"\r\n\r\n` +
            `${f.value ?? ''}\r\n`
        )
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Turn the request model's body descriptor into a Buffer + implied Content-Type. */
function materializeBody(body) {
  if (!body || body.type === 'none') return { buffer: null, contentType: null };

  if (body.type === 'text') {
    return { buffer: Buffer.from(body.text ?? '', 'utf8'), contentType: body.contentType || null };
  }
  if (body.type === 'urlencoded') {
    const usp = new URLSearchParams();
    for (const f of body.fields || []) {
      if (f.enabled === false || !f.key) continue;
      usp.append(f.key, f.value ?? '');
    }
    return {
      buffer: Buffer.from(usp.toString(), 'utf8'),
      contentType: 'application/x-www-form-urlencoded',
    };
  }
  if (body.type === 'form') {
    const { body: buf, contentType } = buildMultipart(body.fields || []);
    return { buffer: buf, contentType };
  }
  if (body.type === 'file') {
    if (!body.src || !fs.existsSync(body.src)) return { buffer: null, contentType: null };
    return { buffer: fs.readFileSync(body.src), contentType: guessMime(body.src) };
  }
  return { buffer: null, contentType: null };
}

function decompress(buffer, encoding) {
  try {
    const enc = (encoding || '').toLowerCase();
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    /* fall through and return the raw bytes */
  }
  return buffer;
}

/** node's rawHeaders is a flat [k, v, k, v, ...] array — preserves duplicates and casing. */
function pairHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  return out;
}

function headerLookup(pairs, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of pairs) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === lower);
}

function applyAuth(spec, headers, urlObj) {
  const auth = spec.auth;
  if (!auth || auth.type === 'none' || !auth.type) return;

  if (auth.type === 'bearer' && auth.token) {
    headers.push(['Authorization', `Bearer ${auth.token}`]);
  } else if (auth.type === 'basic') {
    const raw = `${auth.username ?? ''}:${auth.password ?? ''}`;
    headers.push(['Authorization', `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`]);
  } else if (auth.type === 'apikey' && auth.key) {
    if (auth.in === 'query') urlObj.searchParams.append(auth.key, auth.value ?? '');
    else headers.push([auth.key, auth.value ?? '']);
  }
}

/**
 * Perform one HTTP exchange, following redirects manually so each hop is visible.
 * Never throws — transport failures come back as { error }.
 */
function sendRequest(spec, { onProgress } = {}) {
  return new Promise((resolve) => {
    const opts = spec.options || {};
    const timeout = opts.timeout ?? 0;
    const maxRedirects = opts.followRedirects === false ? 0 : opts.maxRedirects ?? 10;
    const redirects = [];
    const startedAt = Date.now();

    let urlObj;
    try {
      urlObj = new URL(spec.url);
    } catch {
      return resolve({
        error: { message: `Invalid URL: ${spec.url || '(empty)'}`, code: 'ERR_INVALID_URL' },
        timeMs: 0,
      });
    }
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return resolve({
        error: { message: `Unsupported protocol "${urlObj.protocol}"`, code: 'ERR_PROTOCOL' },
        timeMs: 0,
      });
    }

    let method = (spec.method || 'GET').toUpperCase();
    let headers = (spec.headers || []).filter(([k]) => k && k.trim());

    for (const [k, v] of spec.query || []) {
      if (k) urlObj.searchParams.append(k, v ?? '');
    }
    applyAuth(spec, headers, urlObj);

    const { buffer: bodyBuf, contentType } = materializeBody(spec.body);
    if (bodyBuf && contentType && !hasHeader(headers, 'content-type')) {
      headers.push(['Content-Type', contentType]);
    }
    if (bodyBuf && !hasHeader(headers, 'content-length')) {
      headers.push(['Content-Length', String(bodyBuf.length)]);
    }
    if (!hasHeader(headers, 'user-agent')) headers.push(['User-Agent', `hitnrun/${version}`]);
    if (!hasHeader(headers, 'accept')) headers.push(['Accept', '*/*']);
    if (!hasHeader(headers, 'accept-encoding')) headers.push(['Accept-Encoding', 'gzip, deflate, br']);

    const hop = (currentUrl, currentMethod, currentBody, hopCount) => {
      // Consulted on every hop, so a redirect can't carry an AI session onto a
      // blocked host. Returns a reason string to refuse, or null to allow.
      if (opts.guard) {
        const refusal = opts.guard(currentUrl.href, currentMethod);
        if (refusal) {
          return resolve({
            error: { message: refusal, code: 'ERR_BLOCKED_BY_POLICY' },
            blocked: true,
            timeMs: Date.now() - startedAt,
            redirects,
          });
        }
      }

      const lib = currentUrl.protocol === 'https:' ? https : http;
      const timings = { start: Date.now() };

      const headerObj = {};
      for (const [k, v] of headers) {
        // Node collapses duplicates unless we pass an array.
        if (headerObj[k] === undefined) headerObj[k] = v;
        else if (Array.isArray(headerObj[k])) headerObj[k].push(v);
        else headerObj[k] = [headerObj[k], v];
      }

      const req = lib.request(
        {
          protocol: currentUrl.protocol,
          hostname: currentUrl.hostname,
          port: currentUrl.port || (currentUrl.protocol === 'https:' ? 443 : 80),
          path: currentUrl.pathname + currentUrl.search,
          method: currentMethod,
          headers: headerObj,
          rejectUnauthorized: opts.rejectUnauthorized !== false,
          setHost: true,
        },
        (res) => {
          timings.firstByte = Date.now();
          const location = res.headers.location;
          const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode);

          if (isRedirect && location && hopCount < maxRedirects) {
            res.resume(); // drain so the socket can be reused
            redirects.push({ status: res.statusCode, from: currentUrl.href, to: location });
            let nextUrl;
            try {
              nextUrl = new URL(location, currentUrl);
            } catch {
              // Unparseable Location — treat the redirect itself as the answer.
              return collect(res, currentUrl, currentMethod, timings);
            }
            // 301/302/303 downgrade to GET and drop the body, matching browser behaviour.
            let nextMethod = currentMethod;
            let nextBody = currentBody;
            if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && currentMethod !== 'HEAD')) {
              nextMethod = 'GET';
              nextBody = null;
              headers = headers.filter(([k]) => !['content-type', 'content-length'].includes(k.toLowerCase()));
            }
            if (nextUrl.host !== currentUrl.host) {
              headers = headers.filter(([k]) => k.toLowerCase() !== 'authorization');
            }
            onProgress?.({ phase: 'redirect', status: res.statusCode, to: nextUrl.href });
            return hop(nextUrl, nextMethod, nextBody, hopCount + 1);
          }

          collect(res, currentUrl, currentMethod, timings);
        }
      );

      const collect = (res, finalUrl, finalMethod, t) => {
        const parts = [];
        let received = 0;
        res.on('data', (d) => {
          parts.push(d);
          received += d.length;
          onProgress?.({ phase: 'download', received });
        });
        res.on('end', () => {
          const rawBuf = Buffer.concat(parts);
          const headerPairs = pairHeaders(res.rawHeaders);
          const decoded = decompress(rawBuf, headerLookup(headerPairs, 'content-encoding'));
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            httpVersion: res.httpVersion,
            headers: headerPairs,
            bodyBase64: decoded.toString('base64'),
            size: { body: rawBuf.length, decoded: decoded.length, headers: res.rawHeaders.join('').length },
            timeMs: Date.now() - startedAt,
            timings: {
              dns: t.dns ? t.dns - t.start : null,
              connect: t.connect && t.dns ? t.connect - t.dns : null,
              tls: t.tls && t.connect ? t.tls - t.connect : null,
              firstByte: t.firstByte - t.start,
              total: Date.now() - startedAt,
            },
            redirects,
            finalUrl: finalUrl.href,
            finalMethod,
            requestHeaders: headers,
            requestBodyPreview: currentBody ? currentBody.subarray(0, 64 * 1024).toString('utf8') : null,
          });
        });
        res.on('error', (err) => {
          resolve({ error: { message: err.message, code: err.code }, timeMs: Date.now() - startedAt, redirects });
        });
      };

      req.on('socket', (socket) => {
        socket.on('lookup', () => (timings.dns = Date.now()));
        socket.on('connect', () => (timings.connect = Date.now()));
        socket.on('secureConnect', () => (timings.tls = Date.now()));
      });

      if (timeout > 0) {
        req.setTimeout(timeout, () => {
          req.destroy(Object.assign(new Error(`Request timed out after ${timeout}ms`), { code: 'ETIMEDOUT' }));
        });
      }

      req.on('error', (err) => {
        resolve({
          error: { message: err.message, code: err.code || 'ERR_NETWORK' },
          timeMs: Date.now() - startedAt,
          redirects,
        });
      });

      if (currentBody) req.write(currentBody);
      req.end();
    };

    hop(urlObj, method, bodyBuf, 0);
  });
}

module.exports = { sendRequest, guessMime };

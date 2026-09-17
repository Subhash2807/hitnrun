/** Presentation helpers. No state, no side effects. */

export function prettyBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function prettyTime(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function statusClass(status) {
  if (status == null) return 'status-none';
  if (status < 200) return 'status-info';
  if (status < 300) return 'status-ok';
  if (status < 400) return 'status-redirect';
  if (status < 500) return 'status-client-error';
  return 'status-server-error';
}

export const METHOD_COLORS = {
  GET: 'method-get',
  POST: 'method-post',
  PUT: 'method-put',
  PATCH: 'method-patch',
  DELETE: 'method-delete',
  HEAD: 'method-head',
  OPTIONS: 'method-options',
};

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** base64 -> UTF-8 text, without blowing up on large or invalid payloads. */
export function decodeBase64(b64) {
  if (!b64) return '';
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

export function base64ToBlobUrl(b64, mime) {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  } catch {
    return null;
  }
}

/** Pretty-print when we can; otherwise hand back the original string untouched. */
export function tryPretty(text, language) {
  if (!text) return text;
  if (language === 'json') {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  if (language === 'xml' || language === 'html') return prettyXml(text);
  return text;
}

function prettyXml(xml) {
  const tokens = xml.replace(/>\s*</g, '><').replace(/</g, '\n<').split('\n').filter(Boolean);
  let depth = 0;
  const out = [];
  for (const token of tokens) {
    if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + token);
    if (/^<[^!?/][^>]*[^/]>$/.test(token) && !/<\/.+>/.test(token)) depth++;
  }
  return out.join('\n');
}

export function detectLanguage(contentType, body) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('javascript')) return 'javascript';
  if (ct) return 'text';
  const trimmed = (body || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('<')) return 'xml';
  return 'text';
}

export function headerValue(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  const hit = headers.find(([k]) => k.toLowerCase() === lower);
  return hit?.[1];
}

export function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

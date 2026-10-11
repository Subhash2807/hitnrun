/**
 * A response body as a page in the JSON viewer: whether it can be one, and
 * what the page is called. No DOM, so the tests run it under plain Node.
 */

/** Why a response body can't open in the JSON viewer, or null when it can. */
export function notJsonReason(contentType, text) {
  if (!text || !/\S/.test(text)) return 'The response body is empty';
  // Binary data decoded as text is full of NULs; JSON never has a raw one.
  if (text.slice(0, 8192).includes('\u0000')) return 'The response body is binary, not JSON';
  // The content type says so, or the body starts like an object or array
  // (plenty of APIs send JSON as text/plain or with no type at all). Broken
  // JSON still opens: the viewer is where you find out what is wrong with it.
  if (/json/i.test(contentType || '') || /^\s*[[{]/.test(text)) return null;
  const type = String(contentType || '').split(';')[0].trim();
  return type ? `This response is ${type}, not JSON` : 'This response is not JSON';
}

/**
 * The page's name: the request's, or for an unnamed request whatever its URL
 * points at — "/api/users" gives "users.json", "/orders/1042" "orders 1042.json".
 */
export function responsePageName(requestName, url) {
  const name = String(requestName ?? '').trim();
  const base = name && name !== 'New Request' ? name : urlName(url);
  return /\.json$/i.test(base) ? base : `${base}.json`;
}

function urlName(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'response';
  }
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodePart);
  let last = parts.pop();
  if (!last) return parsed.hostname || 'response';
  last = last.replace(/\.[a-z]{1,5}$/i, '') || last;
  // An id says little on its own, so it keeps the name before it.
  if (parts.length && /^(\d+|(?=[0-9a-f-]*\d)[0-9a-f-]{8,})$/i.test(last)) last = `${parts.pop()} ${last}`;
  return last;
}

function decodePart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The headers worth a glance before every send: which sandbox, dealer and
 * tenant a request is about to hit. The request bar shows the ones a request
 * carries, with their values as they will be sent.
 *
 * Plain module so the Node tests can import it.
 */

export const KEY_HEADERS = ['tek-sandbox-id', 'dealerId', 'tenantname'];

/** Variable lookup in the same order the sender uses: globals, collection, environment. */
export function variableScope(state, collection) {
  const scope = new Map();
  const add = (rows) => {
    for (const v of rows || []) if (v.enabled !== false && v.key) scope.set(v.key, v.value ?? '');
  };
  add(state?.globals);
  add(collection?.variables);
  add((state?.environments || []).find((e) => e.id === state?.activeEnvironmentId)?.values);
  return scope;
}

/**
 * Fill {{vars}} from the scope, following nested references a few levels.
 * Dynamic values ({{$guid}}) and unknown names stay as written; the unknown
 * ones are listed in `missing`.
 */
export function resolveValue(raw, scope) {
  let value = String(raw ?? '');
  for (let i = 0; i < 5 && value.includes('{{'); i++) {
    const next = value.replace(/\{\{([^{}]+)\}\}/g, (match, name) => (scope.has(name.trim()) ? String(scope.get(name.trim())) : match));
    if (next === value) break;
    value = next;
  }
  const missing = [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1].trim()).filter((n) => !n.startsWith('$'));
  return { value, missing };
}

/**
 * The key headers this request sends, in KEY_HEADERS order. Names match
 * without regard to case; disabled rows are not sent, so they don't count.
 * `index` is the row in request.headers, for editing it in place.
 */
export function findKeyHeaders(request, scope = new Map()) {
  const rows = request?.headers || [];
  const found = [];
  for (const name of KEY_HEADERS) {
    const index = rows.findIndex((h) => h.enabled !== false && (h.key || '').trim().toLowerCase() === name.toLowerCase());
    if (index < 0) continue;
    const raw = rows[index].value ?? '';
    found.push({ name: rows[index].key.trim(), index, raw, ...resolveValue(raw, scope) });
  }
  return found;
}

/** The request's headers with one row's value replaced. */
export function setHeaderValue(request, index, value) {
  return (request.headers || []).map((h, i) => (i === index ? { ...h, value } : h));
}

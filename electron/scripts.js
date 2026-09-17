'use strict';

/**
 * Pre-request and test script sandbox.
 *
 * Scripts run in a node:vm context with a `pm` API and a small chai-style
 * `expect`. Scripts are yours, so this is a convenience boundary, not a
 * security boundary — no network or filesystem globals are injected.
 */

const vm = require('node:vm');

/* ------------------------------------------------------------- assertions */

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

const show = (v) => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

class Assertion {
  constructor(target, negated = false) {
    this.__target = target;
    this.__negated = negated;
  }

  get not() {
    return new Assertion(this.__target, !this.__negated);
  }

  // Chain words carry no meaning; they exist so assertions read like English.
  get to() { return this; }
  get be() { return this; }
  get been() { return this; }
  get is() { return this; }
  get that() { return this; }
  get which() { return this; }
  get and() { return this; }
  get has() { return this; }
  get have() { return this; }
  get with() { return this; }
  get at() { return this; }
  get of() { return this; }
  get same() { return this; }
  get but() { return this; }
  get does() { return this; }
  get deep() { return this; }
  get an() { return this; }
  get a_() { return this; }

  __assert(pass, message, negatedMessage) {
    if (this.__negated ? pass : !pass) {
      throw new AssertionError(this.__negated ? negatedMessage : message);
    }
    return this;
  }

  equal(expected) {
    const t = this.__target;
    const pass = typeof t === 'object' && t !== null ? deepEqual(t, expected) : t === expected;
    return this.__assert(
      pass,
      `expected ${show(t)} to equal ${show(expected)}`,
      `expected ${show(t)} not to equal ${show(expected)}`
    );
  }
  equals(e) { return this.equal(e); }
  eq(e) { return this.equal(e); }
  eql(e) { return this.equal(e); }

  get ok() {
    return this.__assert(!!this.__target, `expected ${show(this.__target)} to be truthy`, `expected ${show(this.__target)} to be falsy`);
  }
  get true() {
    return this.__assert(this.__target === true, `expected ${show(this.__target)} to be true`, `expected ${show(this.__target)} not to be true`);
  }
  get false() {
    return this.__assert(this.__target === false, `expected ${show(this.__target)} to be false`, `expected ${show(this.__target)} not to be false`);
  }
  get null() {
    return this.__assert(this.__target === null, `expected ${show(this.__target)} to be null`, `expected ${show(this.__target)} not to be null`);
  }
  get undefined() {
    return this.__assert(this.__target === undefined, `expected ${show(this.__target)} to be undefined`, `expected value to be defined`);
  }
  get exist() {
    return this.__assert(this.__target != null, `expected ${show(this.__target)} to exist`, `expected ${show(this.__target)} not to exist`);
  }
  get empty() {
    const t = this.__target;
    const len = typeof t === 'string' || Array.isArray(t) ? t.length : t && typeof t === 'object' ? Object.keys(t).length : 0;
    return this.__assert(len === 0, `expected ${show(t)} to be empty`, `expected ${show(t)} not to be empty`);
  }

  a(type) {
    const actual = Array.isArray(this.__target) ? 'array' : this.__target === null ? 'null' : typeof this.__target;
    return this.__assert(actual === type, `expected ${show(this.__target)} to be a ${type} but got ${actual}`, `expected ${show(this.__target)} not to be a ${type}`);
  }

  above(n) {
    return this.__assert(this.__target > n, `expected ${show(this.__target)} to be above ${n}`, `expected ${show(this.__target)} not to be above ${n}`);
  }
  greaterThan(n) { return this.above(n); }
  below(n) {
    return this.__assert(this.__target < n, `expected ${show(this.__target)} to be below ${n}`, `expected ${show(this.__target)} not to be below ${n}`);
  }
  lessThan(n) { return this.below(n); }
  least(n) {
    return this.__assert(this.__target >= n, `expected ${show(this.__target)} to be at least ${n}`, `expected ${show(this.__target)} to be below ${n}`);
  }
  most(n) {
    return this.__assert(this.__target <= n, `expected ${show(this.__target)} to be at most ${n}`, `expected ${show(this.__target)} to be above ${n}`);
  }
  within(lo, hi) {
    const t = this.__target;
    return this.__assert(t >= lo && t <= hi, `expected ${show(t)} to be within ${lo}..${hi}`, `expected ${show(t)} not to be within ${lo}..${hi}`);
  }

  property(name, value) {
    const t = this.__target;
    const hasIt = t != null && Object.prototype.hasOwnProperty.call(t, name);
    this.__assert(hasIt, `expected object to have property ${show(name)}`, `expected object not to have property ${show(name)}`);
    if (arguments.length > 1 && !this.__negated) {
      const actual = t[name];
      const pass = typeof actual === 'object' && actual !== null ? deepEqual(actual, value) : actual === value;
      if (!pass) throw new AssertionError(`expected property ${show(name)} to equal ${show(value)} but got ${show(actual)}`);
    }
    return this;
  }

  include(needle) {
    const t = this.__target;
    let pass = false;
    if (typeof t === 'string') pass = t.includes(needle);
    else if (Array.isArray(t)) pass = t.some((x) => (typeof x === 'object' ? deepEqual(x, needle) : x === needle));
    else if (t && typeof t === 'object' && needle && typeof needle === 'object') {
      pass = Object.entries(needle).every(([k, v]) => deepEqual(t[k], v));
    }
    return this.__assert(pass, `expected ${show(t)} to include ${show(needle)}`, `expected ${show(t)} not to include ${show(needle)}`);
  }
  includes(n) { return this.include(n); }
  contain(n) { return this.include(n); }
  contains(n) { return this.include(n); }

  match(re) {
    return this.__assert(re.test(String(this.__target)), `expected ${show(this.__target)} to match ${re}`, `expected ${show(this.__target)} not to match ${re}`);
  }

  oneOf(list) {
    return this.__assert(list.includes(this.__target), `expected ${show(this.__target)} to be one of ${show(list)}`, `expected ${show(this.__target)} not to be one of ${show(list)}`);
  }

  lengthOf(n) {
    const len = this.__target?.length;
    return this.__assert(len === n, `expected length ${len} to be ${n}`, `expected length not to be ${n}`);
  }

  // pm.response.to.have.status(200) / .status('OK')
  status(expected) {
    const res = this.__target;
    const actual = typeof expected === 'string' ? res?.status : res?.code;
    return this.__assert(actual === expected, `expected response status ${show(actual)} to be ${show(expected)}`, `expected response status not to be ${show(expected)}`);
  }

  header(name, value) {
    const actual = this.__target?.headers?.get?.(name);
    this.__assert(actual !== undefined, `expected response to have header ${show(name)}`, `expected response not to have header ${show(name)}`);
    if (arguments.length > 1 && !this.__negated && actual !== value) {
      throw new AssertionError(`expected header ${show(name)} to be ${show(value)} but got ${show(actual)}`);
    }
    return this;
  }

  get json() {
    try {
      this.__target.json();
      return this.__assert(true, '', 'expected response not to be JSON');
    } catch {
      return this.__assert(false, 'expected response body to be valid JSON', '');
    }
  }

  get success() {
    const code = this.__target?.code;
    return this.__assert(code >= 200 && code < 300, `expected a 2xx status but got ${code}`, `expected a non-2xx status but got ${code}`);
  }
}

function expect(target) {
  return new Assertion(target);
}

/* ---------------------------------------------------------------- pm API */

function buildResponseApi(response) {
  if (!response || response.error) return null;
  const bodyBuffer = Buffer.from(response.bodyBase64 || '', 'base64');
  const text = bodyBuffer.toString('utf8');
  const headerPairs = response.headers || [];

  const headers = {
    get: (name) => {
      const lower = String(name).toLowerCase();
      const hit = headerPairs.find(([k]) => k.toLowerCase() === lower);
      return hit ? hit[1] : undefined;
    },
    has: (name) => headers.get(name) !== undefined,
    all: () => Object.fromEntries(headerPairs),
    toObject: () => Object.fromEntries(headerPairs),
  };

  const api = {
    code: response.status,
    status: response.statusText,
    responseTime: response.timeMs,
    responseSize: response.size?.decoded ?? bodyBuffer.length,
    headers,
    text: () => text,
    json: () => JSON.parse(text),
  };
  Object.defineProperty(api, 'to', { get: () => new Assertion(api) });
  return api;
}

/**
 * Execute a script. Never throws: a failing script comes back as { error }.
 *
 * `handlers` supplies live access to workspace variables so pm.environment.set
 * writes through to the real workspace (and therefore auto-saves).
 */
function runScript(code, { request, response, handlers, timeoutMs = 5000 } = {}) {
  const logs = [];
  const tests = [];

  if (!code || !code.trim()) return { logs, tests, error: null, skipped: true };

  const log = (level) => (...args) => {
    logs.push({
      level,
      text: args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a, null, 2);
          } catch {
            return String(a);
          }
        })
        .join(' '),
    });
  };

  const varApi = (scope) => ({
    get: (key) => handlers.getVar(scope, key),
    set: (key, value) => handlers.setVar(scope, key, value),
    unset: (key) => handlers.unsetVar(scope, key),
    has: (key) => handlers.getVar(scope, key) !== undefined,
    toObject: () => handlers.allVars(scope),
    clear: () => handlers.clearVars(scope),
  });

  const responseApi = buildResponseApi(response);

  const pm = {
    environment: varApi('environment'),
    globals: varApi('globals'),
    collectionVariables: varApi('collection'),
    variables: {
      get: (key) => handlers.getVar('any', key),
      set: (key, value) => handlers.setVar('environment', key, value),
      has: (key) => handlers.getVar('any', key) !== undefined,
      replaceIn: (template) => handlers.replaceIn(template),
    },
    request: {
      method: request?.method,
      url: request?.url,
      headers: {
        get: (name) => {
          const lower = String(name).toLowerCase();
          const hit = (request?.headers || []).find(([k]) => k.toLowerCase() === lower);
          return hit ? hit[1] : undefined;
        },
        add: (h) => handlers.addRequestHeader(h.key, h.value),
        upsert: (h) => handlers.addRequestHeader(h.key, h.value),
      },
      body: request?.bodyText,
    },
    response: responseApi,
    expect,
    test: (name, fn) => {
      try {
        fn();
        tests.push({ name, passed: true });
      } catch (err) {
        tests.push({ name, passed: false, error: err?.message || String(err) });
      }
    },
    sendRequest: () => {
      throw new Error('pm.sendRequest() is not supported in this build');
    },
    info: { requestName: request?.name, requestId: request?.id },
  };

  const sandbox = {
    pm,
    expect,
    console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('log') },
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    Promise,
    Map,
    Set,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout: undefined,
    responseCode: responseApi ? { code: responseApi.code, name: responseApi.status } : undefined,
    responseBody: responseApi ? responseApi.text() : undefined,
  };

  try {
    const context = vm.createContext(sandbox);
    new vm.Script(code, { filename: 'script.js' }).runInContext(context, { timeout: timeoutMs });
    return { logs, tests, error: null };
  } catch (err) {
    return {
      logs,
      tests,
      error: { message: err?.message || String(err), stack: err?.stack },
    };
  }
}

module.exports = { runScript, expect, Assertion, AssertionError };

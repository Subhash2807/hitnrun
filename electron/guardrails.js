'use strict';

/**
 * Guardrails for AI-originated requests.
 *
 * These apply ONLY to sends that come from an AI session. Requests you send
 * yourself from the app window are never checked — you are trusted on your own
 * machine; a language model driving your session is not.
 *
 * Two independent rules:
 *   blockedHosts    - hostnames the AI must never call (your production API)
 *   blockedMethods  - verbs the AI must never use (DELETE by default)
 *
 * Both are denylists: everything not named is allowed. That keeps day-to-day
 * testing frictionless while making the irreversible things impossible.
 */

const DEFAULT_POLICY = {
  enabled: true,
  blockedHosts: [],
  blockedMethods: ['DELETE'],
};

/**
 * Does `hostname` match a denylist entry?
 *
 * Supported forms:
 *   api.prod.com    exact hostname
 *   *.prod.com      any subdomain, and the bare domain itself
 *   prod.com        exact only — does NOT silently cover subdomains
 */
function hostMatches(hostname, pattern) {
  const host = String(hostname || '').toLowerCase().trim();
  const rule = String(pattern || '').toLowerCase().trim();
  if (!host || !rule) return false;

  if (rule.startsWith('*.')) {
    const bare = rule.slice(2);
    return host === bare || host.endsWith('.' + bare);
  }
  return host === rule;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Check a request before it is sent.
 * Returns { allowed: true } or { allowed: false, reason, rule }.
 *
 * `url` must be the RESOLVED url — checking a `{{base_url}}` template would let
 * a variable smuggle the AI onto a blocked host.
 */
function checkRequest({ method, url }, policy = DEFAULT_POLICY) {
  const active = { ...DEFAULT_POLICY, ...(policy || {}) };
  if (!active.enabled) return { allowed: true };

  const verb = String(method || 'GET').toUpperCase();
  const blockedVerb = (active.blockedMethods || []).find((m) => String(m).toUpperCase() === verb);
  if (blockedVerb) {
    return {
      allowed: false,
      rule: 'method',
      reason:
        `${verb} is blocked for AI sessions. Blocked methods: ${(active.blockedMethods || []).join(', ')}. ` +
        `Ask the user to run this one themselves, or change it in Settings → AI guardrails.`,
    };
  }

  const hostname = hostnameOf(url);
  if (!hostname) {
    return { allowed: false, rule: 'url', reason: `Could not read a hostname from "${url}".` };
  }

  const blockedHost = (active.blockedHosts || []).find((h) => hostMatches(hostname, h));
  if (blockedHost) {
    return {
      allowed: false,
      rule: 'host',
      reason:
        `${hostname} is on the AI blocked-hosts list (matched "${blockedHost}"). ` +
        `This host is off limits to AI sessions. Ask the user to send this request themselves.`,
    };
  }

  return { allowed: true };
}

/**
 * Build the per-hop guard handed to the HTTP engine.
 *
 * Redirects are the hole a host denylist would otherwise leave open: a request
 * to an allowed host that 302s onto production must still be stopped, so every
 * hop is re-checked rather than just the first.
 */
function buildGuard(policy) {
  const active = { ...DEFAULT_POLICY, ...(policy || {}) };
  if (!active.enabled) return null;

  return (url, method) => {
    const verdict = checkRequest({ method, url }, active);
    return verdict.allowed ? null : verdict.reason;
  };
}

/** Normalise user input from the settings UI into a policy object. */
function normalizePolicy(input = {}) {
  const clean = (list) =>
    (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/))
      .map((s) => String(s).trim())
      .filter(Boolean);

  // An ABSENT list falls back to the default; an explicitly empty one clears it.
  // Collapsing those two cases would let a partial settings object silently
  // switch the DELETE block off — a guardrail must never fail open by accident.
  return {
    enabled: input.enabled !== false,
    blockedHosts:
      input.blockedHosts === undefined ? [...DEFAULT_POLICY.blockedHosts] : clean(input.blockedHosts),
    blockedMethods:
      input.blockedMethods === undefined
        ? [...DEFAULT_POLICY.blockedMethods]
        : clean(input.blockedMethods).map((m) => m.toUpperCase()),
  };
}

module.exports = { checkRequest, buildGuard, hostMatches, normalizePolicy, DEFAULT_POLICY };

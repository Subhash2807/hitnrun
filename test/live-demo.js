'use strict';

/**
 * End-to-end walkthrough of the AI sandbox against the RUNNING app.
 * Run with the app open: node test/live-demo.js
 */

const BASE = `http://127.0.0.1:${process.env.API_CLIENT_PORT || 47600}`;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const line = (label, value) => console.log(`  ${String(label).padEnd(38)} ${value}`);

(async () => {
  console.log('\nAI sandbox, against the live app\n');

  const session = await call('POST', '/ai/sessions', { client: 'claude-code', label: 'demo' });
  line('AI session opened', `${session.json.sessionId} (${session.json.mode})`);

  const beforeUser = (await call('GET', '/requests')).json.length;
  line('user requests before', beforeUser);

  const blockedWrite = await call('POST', '/requests', { curl: 'curl https://example.com' });
  line('AI writes to USER workspace', blockedWrite.status === 403 ? 'REFUSED (403)' : `ALLOWED (${blockedWrite.status}) <-- BAD`);

  const blockedDelete = await call('DELETE', '/requests/anything');
  line('AI deletes a USER request', blockedDelete.status === 403 ? 'REFUSED (403)' : `ALLOWED (${blockedDelete.status}) <-- BAD`);

  const mine = await call('POST', '/ai/requests', {
    sessionId: session.json.sessionId,
    curl: 'curl https://httpbin.org/get?who=ai',
  });
  line('AI creates in OWN workspace', `${mine.status} "${mine.json.name}"`);

  const sent = await call('POST', `/ai/requests/${mine.json.id}/send`);
  line('AI sends an allowed GET', `${sent.status} -> HTTP ${sent.json.status}`);

  const del = await call('POST', '/ai/send', { curl: 'curl -X DELETE https://httpbin.org/delete' });
  line('AI sends DELETE', del.json?.blocked ? 'BLOCKED by guardrails' : `ALLOWED (${del.status}) <-- BAD`);

  await call('PUT', '/sync/source', {});
  const policyRes = await call('GET', '/ai/policy');
  line('blocked methods', JSON.stringify(policyRes.json.blockedMethods));

  const afterUser = (await call('GET', '/requests')).json.length;
  line('user requests after', `${afterUser} ${afterUser === beforeUser ? '(unchanged)' : '<-- CHANGED, BAD'}`);

  const ws = (await call('GET', '/ai/workspace')).json;
  line('AI workspace sessions', ws.sessions.length);
  line('AI workspace requests', ws.sessions.reduce((n, s) => n + s.requestCount, 0));

  console.log('');
})().catch((err) => {
  console.error('Is the app running?', err.message);
  process.exit(1);
});

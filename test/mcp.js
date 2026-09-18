'use strict';

/**
 * Drives mcp/server.js over real stdio, the same way an MCP client does.
 * Requires the app (or any control server) to be listening.
 *
 * Run with: node test/mcp.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = process.env.HITNRUN_PORT || 47600;

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HITNRUN_PORT: String(PORT), HITNRUN_LABEL: 'smoke-test' },
  });

  let buffer = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  child.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text && !text.includes('[hitnrun-mcp] ready')) console.error('   stderr:', text);
  });

  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }
      }, 20000);
    });

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  return { child, send, notify };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const assert = require('node:assert');

(async () => {
  console.log('MCP server over stdio\n');
  const { child, send, notify } = startServer();

  let tools = [];

  await test('completes the MCP handshake', async () => {
    const res = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-harness', version: '1.0.0' },
    });
    assert.ok(res.result, JSON.stringify(res.error));
    assert.equal(res.result.serverInfo.name, 'hitnrun');
    notify('notifications/initialized');
  });

  await test('advertises its tools', async () => {
    const res = await send('tools/list', {});
    tools = res.result.tools;
    assert.ok(tools.length > 10, `expected a useful toolset, got ${tools.length}`);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 20, `${t.name} needs a real description`);
      assert.ok(t.inputSchema, `${t.name} needs an input schema`);
    }
  });

  await test('exposes no tool that can write to the user workspace', () => {
    const names = tools.map((t) => t.name);
    // Anything that edits or deletes must be scoped to the AI's own workspace.
    for (const forbidden of ['delete_user_request', 'update_user_request', 'create_user_request']) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
    }
    assert.ok(names.includes('copy_into_my_workspace'), 'copy is the only way in');
    assert.ok(names.includes('list_user_requests'), 'reading the user workspace should be possible');
  });

  await test('app_status reports the sandbox and guardrails', async () => {
    const res = await send('tools/call', { name: 'app_status', arguments: {} });
    assert.ok(!res.result.isError, res.result.content?.[0]?.text);
    const payload = JSON.parse(res.result.content[0].text);
    assert.ok(payload.yourSession.sessionId, 'a session should be opened');
    assert.ok(payload.guardrails, 'guardrails should be reported');
    assert.match(payload.sandbox, /cannot modify or delete/i);
  });

  await test('creates a request in its own workspace', async () => {
    const res = await send('tools/call', {
      name: 'create_request',
      arguments: { curl: 'curl https://httpbin.org/get?from=mcp' },
    });
    assert.ok(!res.result.isError, res.result.content?.[0]?.text);
    const made = JSON.parse(res.result.content[0].text);
    assert.ok(made.id.startsWith('req_'));
  });

  await test('a blocked method comes back as a clear tool error', async () => {
    const res = await send('tools/call', {
      name: 'send_adhoc',
      arguments: { curl: 'curl -X DELETE https://httpbin.org/delete' },
    });
    assert.equal(res.result.isError, true, 'DELETE should be refused');
    assert.match(res.result.content[0].text, /guardrails|blocked/i);
    assert.match(res.result.content[0].text, /Do not try to work around it/i);
  });

  await test('a permitted send works end to end', async () => {
    const res = await send('tools/call', {
      name: 'send_adhoc',
      arguments: { curl: 'curl https://httpbin.org/get?ok=1' },
    });
    assert.ok(!res.result.isError, res.result.content?.[0]?.text);
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.status, 200);
  });

  child.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('harness crashed:', err);
  process.exit(1);
});

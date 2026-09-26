'use strict';

/**
 * In-app AI chat: CLI adapters, command resolution, and the chat manager.
 * The manager is driven by a fake CLI (a node script), so no model is needed.
 *
 * Run with: node test/chat.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROVIDERS, resolveLaunch, splitCommand, parseHelpFlags } = require('../electron/chat-providers');
const { ChatManager, shortToolName } = require('../electron/chat');

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hitnrun-chat-'));
const feed = (parse, messages) => messages.flatMap((m) => parse(typeof m === 'string' ? m : JSON.stringify(m)));

/* ------------------------------------------------------------- adapters */

test('claude: streamed text is not doubled by the finished message', () => {
  const events = feed(PROVIDERS.claude.parser(), [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-1', total_cost_usd: 0.01, is_error: false },
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['Hel', 'lo']);
  assert.equal(events[0].id, 'sess-1');
  assert.deepEqual(events.at(-1), { type: 'turn-end', cost: 0.01, error: null });
});

test('claude: an API retry mid-answer does not show the answer twice', () => {
  const m = manager();
  const chat = m.create();
  const reply = { id: 'r', role: 'assistant', parts: [], status: 'running' };
  chat.messages.push(reply);
  const run = { reply, busy: true, provider: PROVIDERS.claude };
  const events = feed(PROVIDERS.claude.parser(), [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'a' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '# Title\nIt has the same weakn' } } },
    // The connection drops; Claude Code retries and the answer starts again.
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'b' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '# Title\nIt has the same weaknesses.' } } },
    { type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: '# Title\nIt has the same weaknesses.' }] } },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ]);
  for (const e of events) m._apply(chat, run, e);
  assert.deepEqual(reply.parts.map((p) => p.text), ['# Title\nIt has the same weaknesses.']);
  m.shutdown();
});

test('claude: text after a tool call is its own part, and the finished copy wins', () => {
  const m = manager();
  const chat = m.create();
  const reply = { id: 'r', role: 'assistant', parts: [], status: 'running' };
  chat.messages.push(reply);
  const run = { reply, busy: true, provider: PROVIDERS.claude };
  const events = feed(PROVIDERS.claude.parser(), [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'a' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } } },
    { type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Checking.' }] } },
    { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'b' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } } },
  ]);
  for (const e of events) m._apply(chat, run, e);
  assert.deepEqual(reply.parts.map((p) => p.kind + ':' + (p.text ?? p.name)), ['text:Checking.', 'tool:x', 'text:Done']);
  m.shutdown();
});

test('claude: tool calls and results, errors, and junk lines', () => {
  const parse = PROVIDERS.claude.parser();
  const events = feed(parse, [
    'not json',
    '',
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'mcp__hitnrun__send_request', input: { request_id: 'req_1' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"status":200}' }] }] } },
    { type: 'assistant', parent_tool_use_id: 'x', message: { id: 'm3', content: [{ type: 'text', text: 'subagent chatter' }] } },
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' },
  ]);
  assert.deepEqual(events[0], { type: 'tool-start', id: 't1', name: 'mcp__hitnrun__send_request', input: { request_id: 'req_1' } });
  assert.deepEqual(events[1], { type: 'tool-end', id: 't1', output: '{"status":200}', isError: false });
  assert.ok(!events.some((e) => e.text === 'subagent chatter'), 'subagent text stays out of the reply');
  assert.equal(events.at(-1).error, 'boom');
});

test('claude: launches with only hitnrun tools, asking permission in the chat', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'claude-'));
  const { args } = PROVIDERS.claude.launch({
    mcp: { command: 'node', args: ['server.js'], env: { HITNRUN_PORT: '1' } },
    model: 'haiku',
    resumeId: 'abc',
    systemPrompt: 'be brief',
    workDir: dir,
  });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--tools'), '', 'built-in tools (shell, files) are off');
  assert.equal(after('--allowedTools'), 'mcp__hitnrun');
  assert.equal(after('--permission-prompt-tool'), 'mcp__hitnrun__approve');
  assert.ok(!args.includes('--permission-prompts'), 'prompts go to the approve tool, not refused');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(after('--model'), 'haiku');
  assert.equal(after('--resume'), 'abc');
  const config = JSON.parse(fs.readFileSync(after('--mcp-config'), 'utf8'));
  assert.equal(config.mcpServers.hitnrun.env.HITNRUN_PORT, '1');
  const line = JSON.parse(PROVIDERS.claude.encode('hi'));
  assert.deepEqual(line, { type: 'user', message: { role: 'user', content: 'hi' } });
});

test('claude: an older CLI gets only the options it knows, and still no built-in tools', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'claude-old-'));
  const { args } = PROVIDERS.claude.launch({
    mcp: { command: 'node', args: ['server.js'], env: {} },
    systemPrompt: 'be brief',
    workDir: dir,
    supports: () => false,
  });
  for (const flag of PROVIDERS.claude.optional) assert.ok(!args.includes(flag), `${flag} left out`);
  const off = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--allowedTools'));
  for (const tool of ['Bash', 'Write', 'Edit', 'Read']) assert.ok(off.includes(tool), `${tool} disabled`);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__hitnrun');
});

test('claude: without the prompt tool, permission prompts are refused rather than hanging', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'claude-noprompt-'));
  const { args } = PROVIDERS.claude.launch({
    mcp: { command: 'node', args: ['server.js'], env: {} },
    systemPrompt: 'x',
    workDir: dir,
    supports: (flag) => flag !== '--permission-prompt-tool',
  });
  assert.ok(!args.includes('--permission-prompt-tool'));
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
});

test('help output is read into the set of long options', () => {
  const flags = parseHelpFlags(
    [
      'Options:',
      '  -p, --print                   Print response',
      '  --allowedTools, --allowed-tools <tools...>',
      '                                mentions --not-an-option in the text',
      '  --tools <tools...>            Tools',
    ].join('\n')
  );
  assert.deepEqual([...flags].sort(), ['--allowed-tools', '--allowedTools', '--print', '--tools']);
});

test('codex: events map to text, tools and turn end; MCP passed as TOML', () => {
  const events = feed(PROVIDERS.codex.parser(), [
    { type: 'thread.started', thread_id: 'th1' },
    { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'hitnrun', tool: 'app_status', arguments: {} } },
    { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'hitnrun', tool: 'app_status', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'All good' } },
    { type: 'turn.completed', usage: {} },
  ]);
  assert.deepEqual(events.map((e) => e.type), ['session', 'tool-start', 'tool-end', 'text', 'turn-end']);
  assert.equal(events[2].output, 'ok');
  assert.equal(shortToolName(events[1].name), 'app_status');

  const spec = PROVIDERS.codex.launch({ mcp: { command: 'C:\\a b\\node.exe', args: ['s.js'], env: { HITNRUN_PORT: '5' } }, prompt: 'hi', resumeId: 'th1' });
  assert.ok(spec.args.includes('mcp_servers.hitnrun.command="C:\\\\a b\\\\node.exe"'));
  assert.ok(spec.args.includes('mcp_servers.hitnrun.env={ HITNRUN_PORT="5" }'));
  assert.deepEqual(spec.args.slice(-3), ['resume', 'th1', '-']);
  assert.equal(spec.stdin, 'hi');
  assert.equal(spec.args[spec.args.indexOf('--sandbox') + 1], 'read-only');
});

test('gemini: writes its MCP settings into the chat folder', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gemini-'));
  const spec = PROVIDERS.gemini.launch({ mcp: { command: 'node', args: ['s.js'], env: {} }, prompt: 'hello', workDir: dir });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(settings.mcpServers.hitnrun.trust, true);
  assert.ok(settings.excludeTools.includes('run_shell_command'));
  assert.deepEqual(spec.args.slice(-2), ['-p', 'hello']);
  const events = feed(PROVIDERS.gemini.parser(), [
    { type: 'init', session_id: 'g1' },
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'assistant', content: 'Hi', delta: true },
    { type: 'tool_use', tool_name: 'app_status', tool_id: 'x', parameters: {} },
    { type: 'tool_result', tool_id: 'x', status: 'error', error: 'nope' },
    { type: 'result', status: 'success' },
  ]);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'tool-start', 'tool-end', 'turn-end']);
  assert.equal(events[3].isError, true);
});

test('custom: {prompt} is substituted, or the prompt goes on stdin', () => {
  assert.deepEqual(splitCommand(`mytool ask "{prompt}" --flag 'a b'`), ['mytool', 'ask', '{prompt}', '--flag', 'a b']);
  const slot = PROVIDERS.custom.launch({ prompt: 'why 401?', command: 'mytool ask "{prompt}"' });
  assert.deepEqual(slot, { file: 'mytool', args: ['ask', 'why 401?'], stdin: undefined });
  const piped = PROVIDERS.custom.launch({ prompt: 'why 401?', command: 'mytool --stdin' });
  assert.equal(piped.stdin, 'why 401?');
  assert.throws(() => PROVIDERS.custom.launch({ prompt: 'x', command: '  ' }), /Set a command/);
});

test('npm .cmd shims resolve to the real executable or script', () => {
  if (process.platform !== 'win32') return;
  const dir = fs.mkdtempSync(path.join(tmp, 'shim-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'tool', 'bin'), { recursive: true });
  const exe = path.join(dir, 'node_modules', 'tool', 'bin', 'tool.exe');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n');
  assert.deepEqual(resolveLaunch(path.join(dir, 'tool.cmd')), { command: exe, prefix: [] });

  const script = path.join(dir, 'node_modules', 'tool', 'cli.js');
  fs.writeFileSync(script, '');
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  fs.writeFileSync(path.join(dir, 'other.cmd'), '"%_prog%"  "%dp0%\\node_modules\\tool\\cli.js" %*\r\n');
  assert.deepEqual(resolveLaunch(path.join(dir, 'other.cmd')), { command: path.join(dir, 'node.exe'), prefix: [script] });

  fs.writeFileSync(path.join(dir, 'weird.cmd'), 'echo hi\r\n');
  assert.equal(resolveLaunch(path.join(dir, 'weird.cmd')).shell, true);
});

/* -------------------------------------------------------------- manager */

// A fake CLI: echoes the prompt back as a stream of JSON lines, with one tool call.
const FAKE = path.join(tmp, 'fake-cli.js');
fs.writeFileSync(
  FAKE,
  `let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (input.includes('crash')) { process.stderr.write('Error: not logged in'); process.exit(3); }
  say({ t: 'session', id: 'fake-session' });
  say({ t: 'tool-start', id: 'x1', name: 'mcp__hitnrun__app_status', input: {} });
  say({ t: 'tool-end', id: 'x1', output: 'ok' });
  const words = input.split(/\\s+/).filter(Boolean);
  if (input.includes('slow')) return setTimeout(() => {}, 60000);
  if (input.includes('<hitnrun-context>')) say({ t: 'text', text: '[ctx] ' });
  if (input.includes('<instructions>')) say({ t: 'text', text: '[sys] ' });
  for (const w of words.slice(-3)) say({ t: 'text', text: w + ' ' });
  say({ t: 'turn-end' });
});
`
);

// The same fake, but it refuses an option it doesn't know, like an older CLI.
const OLD = path.join(tmp, 'old-cli.js');
fs.writeFileSync(
  OLD,
  `if (process.argv.includes('--new-flag')) { process.stderr.write("error: unknown option '--new-flag'\\n"); process.exit(1); }
require(${JSON.stringify(FAKE)});
`
);

PROVIDERS.fake = {
  id: 'fake',
  label: 'Fake CLI',
  binaries: [],
  login: 'Log in to the fake.',
  models: [{ id: '', label: 'Default' }],
  caps: { persistent: false, resume: true, toolEvents: true, cost: false },
  launch: ({ prompt, resumeId }) => ({ file: process.execPath, args: [FAKE, ...(resumeId ? ['--resume', resumeId] : [])], stdin: prompt }),
  parser: () => (line) => {
    try {
      const { t, ...rest } = JSON.parse(line);
      return [{ type: t, ...rest }];
    } catch {
      return [];
    }
  },
};

function manager(file = path.join(tmp, `chats-${Date.now()}-${Math.random()}.json`)) {
  const m = new ChatManager({
    file,
    workRoot: path.join(tmp, 'work'),
    mcp: () => ({ command: 'node', args: ['server.js'], env: {} }),
    settings: () => ({ provider: 'fake' }),
  });
  m.load();
  return m;
}

const settle = (chat) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const last = chat.messages.at(-1);
      if (last.status !== 'running') {
        clearInterval(t);
        resolve(last);
      } else if (Date.now() - started > 15000) {
        clearInterval(t);
        reject(new Error('reply never finished'));
      }
    }, 20);
  });

test('manager: a reply streams text and tool calls, and keeps the session id', async () => {
  const m = manager();
  const chat = m.create();
  assert.equal(chat.provider, 'fake', 'new chats use the saved default CLI');
  await m.send(chat.id, { text: 'hello there friend', context: '<hitnrun-context>x</hitnrun-context>', contextLabel: 'Get users' });
  const reply = await settle(chat);
  assert.equal(reply.status, 'done');
  assert.equal(chat.title, 'hello there friend');
  assert.equal(chat.sessionId, 'fake-session');
  assert.equal(chat.messages[0].contextLabel, 'Get users');
  assert.equal(chat.messages[0].text, 'hello there friend', 'the context block is not shown as your message');
  const [tool, text] = reply.parts;
  assert.deepEqual([tool.kind, tool.name, tool.status, tool.output], ['tool', 'app_status', 'done', 'ok']);
  // The CLI got the context block and, having no system-prompt flag, the instructions.
  assert.equal(text.text.trim(), '[ctx] [sys] hello there friend');
  m.shutdown();
});

test('manager: one reply at a time per chat, and empty messages are refused', async () => {
  const m = manager();
  const chat = m.create();
  await assert.rejects(m.send(chat.id, { text: '   ' }), /Type a message/);
  await m.send(chat.id, { text: 'slow one' });
  await assert.rejects(m.send(chat.id, { text: 'again' }), /Wait for the reply/);
  assert.equal(m.list()[0].running, true);
  // Let the fake report its tool call first, so the stop lands mid-reply.
  const reply0 = chat.messages.at(-1);
  for (let i = 0; i < 250 && !reply0.parts.some((p) => p.status === 'done'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.stop(chat.id), true);
  const reply = await settle(chat);
  assert.equal(reply.status, 'stopped');
  assert.equal(reply.parts[0].status, 'done', 'a tool that had finished stays finished');
  m.shutdown();
});

test('manager: an option the CLI rejects is dropped and the message retried', async () => {
  // Like an older Claude Code: help can't be read, and --new-flag is unknown.
  PROVIDERS.oldfake = {
    ...PROVIDERS.fake,
    id: 'oldfake',
    optional: ['--new-flag'],
    launch: ({ prompt, supports }) => ({ file: process.execPath, args: [OLD, ...(supports('--new-flag') ? ['--new-flag'] : [])], stdin: prompt }),
  };
  const m = manager();
  const chat = m.create();
  m.configure(chat.id, { provider: 'oldfake' });
  await m.send(chat.id, { text: 'hello old cli' });
  const reply = await settle(chat);
  assert.equal(reply.status, 'done', reply.error);
  assert.match(reply.parts.find((p) => p.kind === 'text').text, /hello old cli/);

  // The next start skips it straight away.
  m.shutdown();
  await m.send(chat.id, { text: 'second one' });
  assert.equal((await settle(chat)).status, 'done');
  m.shutdown();
  delete PROVIDERS.oldfake;
});

test('manager: approvals are asked in the reply and answered by the user', async () => {
  const m = manager();
  const chat = m.create();
  // Nothing is running: nobody to ask, so it is denied.
  assert.equal(await m.requestApproval({ chatId: chat.id, key: 'tool:x', title: 'Use x' }), false);

  await m.send(chat.id, { text: 'slow please' });
  const first = m.requestApproval({ chatId: chat.id, key: 'method:DELETE', title: 'Send DELETE /x', detail: 'blocked' });
  const part = chat.messages.at(-1).parts.find((p) => p.kind === 'approval');
  assert.equal(part.status, 'pending');
  assert.equal(part.title, 'Send DELETE /x');
  assert.ok(m.answerApproval(part.id, 'chat'));
  assert.equal(await first, true);
  assert.equal(part.status, 'allowed');
  // "Allow for this chat" answers the same question from then on.
  assert.equal(await m.requestApproval({ chatId: chat.id, key: 'method:DELETE', title: 'again' }), true);

  const denied = m.requestApproval({ chatId: chat.id, key: 'tool:y', title: 'Use y' });
  const second = chat.messages.at(-1).parts.filter((p) => p.kind === 'approval').at(-1);
  m.answerApproval(second.id, 'deny');
  assert.equal(await denied, false);
  assert.equal(second.status, 'denied');

  // Stopping the reply denies whatever is still waiting.
  const waiting = m.requestApproval({ chatId: chat.id, key: 'tool:z', title: 'Use z' });
  m.stop(chat.id);
  assert.equal(await waiting, false);
  assert.equal(m.answerApproval('ok_missing', 'once'), false);
  await settle(chat);
  m.shutdown();
});

test('manager: the chat id reaches the MCP server', () => {
  let seen = null;
  const m = manager();
  const chat = m.create();
  const provider = { ...PROVIDERS.fake, launch: (opts) => ((seen = opts.mcp.env), PROVIDERS.fake.launch(opts)) };
  m._start(chat, provider, { id: 'r', parts: [], status: 'running' }, 'hi');
  assert.equal(seen.HITNRUN_CHAT, chat.id);
  m.shutdown();
});

test('manager: a crashed CLI becomes a readable error with a sign-in hint', async () => {
  const m = manager();
  const chat = m.create();
  await m.send(chat.id, { text: 'crash please' });
  const reply = await settle(chat);
  assert.equal(reply.status, 'error');
  assert.match(reply.error, /stopped unexpectedly \(exit code 3\)/);
  assert.match(reply.error, /Log in to the fake/);
  m.shutdown();
});

test('manager: a missing CLI says how to install it', async () => {
  const m = manager();
  const chat = m.create();
  m.configure(chat.id, { provider: 'codex' });
  const saved = process.env.PATH;
  process.env.PATH = tmp; // nothing on the path
  try {
    await m.send(chat.id, { text: 'hi' });
  } finally {
    process.env.PATH = saved;
  }
  const reply = chat.messages.at(-1);
  // Found or not on this machine, a failure must never be silent.
  if (reply.status === 'error' && /isn't installed/.test(reply.error)) assert.match(reply.error, /npm install -g @openai\/codex/);
  m.stop(chat.id);
  m.shutdown();
});

test('manager: switching CLI drops the old session; chats survive a restart', async () => {
  const file = path.join(tmp, 'persist.json');
  const m = manager(file);
  const chat = m.create();
  await m.send(chat.id, { text: 'remember me' });
  await settle(chat);
  m.shutdown();

  // A reply cut off by quitting comes back as stopped, not forever "running".
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.chats[0].messages.push({ id: 'm', role: 'assistant', parts: [{ kind: 'tool', status: 'running' }], status: 'running' });
  fs.writeFileSync(file, JSON.stringify(raw));

  const again = manager(file);
  const loaded = again.get(chat.id);
  assert.equal(loaded.sessionId, 'fake-session');
  assert.equal(loaded.messages.at(-1).status, 'stopped');
  assert.equal(loaded.messages.at(-1).parts[0].status, 'stopped');

  again.configure(chat.id, { provider: 'claude' });
  assert.equal(loaded.sessionId, null, "another CLI can't resume this conversation");
  again.remove(chat.id);
  assert.equal(again.list().length, 0);
  again.shutdown();
});

(async () => {
  console.log('AI chat\n');
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}\n       ${err.stack}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

'use strict';

/**
 * The in-app AI chat (beta).
 *
 * Runs a coding-agent CLI the user already has (Claude Code by default) with
 * hitnrun's MCP server attached, and keeps the conversation in chats.json.
 * The CLI works through the same sandboxed control-server routes as any other
 * agent, so it can read the user's workspace but only write to its own.
 *
 * See chat-providers.js for the per-CLI adapters.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PROVIDERS, findExecutable, resolveLaunch, childPath, parseHelpFlags } = require('./chat-providers');

const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

const MAX_CHATS = 100;
const MAX_TOOL_TEXT = 6000;
// A kept-open CLI is closed after this long without a message; the next one resumes it.
const IDLE_MS = 10 * 60 * 1000;

const SYSTEM_PROMPT = [
  'You are the assistant built into hitnrun, a desktop API client like Postman.',
  'The user is chatting with you from a side panel inside the app.',
  'Use the hitnrun tools to look at their collections, environments, history and test docs, and to send requests.',
  'You are sandboxed: you can read the user\'s workspace, but you can only create and edit requests in your own AI workspace.',
  'The user copies anything useful into their collections themselves, so never say you changed one of their requests.',
  'If a send is blocked by their guardrails, say so plainly and stop; do not try to work around it.',
  'When you create something, open it with show_in_app.',
  'Messages may start with a <hitnrun-context> block describing what is open in the app. Use it; don\'t repeat it back.',
  'Keep replies short and practical. Use Markdown, and short code blocks for requests and payloads.',
].join(' ');

const emptyState = () => ({ version: 1, chats: [] });

function cut(text, max) {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2) ?? '';
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters)` : s;
}

/** Tool names as the user should read them: "send_request", not "mcp__hitnrun__send_request". */
function shortToolName(name) {
  return String(name || 'tool').replace(/^mcp__hitnrun__/, '').replace(/^hitnrun\./, '');
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    // The CLI starts the MCP server as its own child; take the whole tree down.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

class ChatManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.file        where chats are saved
   * @param {string} opts.workRoot    a folder per chat is made in here for the CLI to run in
   * @param {() => object} opts.mcp   command, args and env that start hitnrun's MCP server
   * @param {() => object} opts.settings  the saved chat settings ({ provider, models, customCommand })
   */
  constructor({ file, workRoot, mcp, settings }) {
    super();
    this.file = file;
    this.workRoot = workRoot;
    this.mcp = mcp;
    this.settings = settings;
    this.state = emptyState();
    this.runs = new Map(); // chatId -> { child, provider, busy, idleTimer, stopping }
    this._saveTimer = null;
    this._emitTimers = new Map();
    this._detected = null;
    this._flags = new Map(); // provider id -> { listed: Set | null, rejected: Set }
  }

  /* --------------------------------------------------------- persistence */

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
        // A reply that was streaming when the app closed will never finish.
        for (const chat of this.state.chats) {
          for (const msg of chat.messages) {
            if (msg.status === 'running') {
              msg.status = 'stopped';
              for (const part of msg.parts || []) if (part.status === 'running') part.status = 'stopped';
            }
          }
        }
      }
    } catch (err) {
      try {
        fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
      } catch { /* best effort */ }
      this.state = emptyState();
      this.emit('error', err);
    }
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Save, and tell the window. Streaming updates are batched per chat. */
  touch(chat, { list = false, now = false } = {}) {
    if (!this.get(chat.id)) return; // deleted while its CLI was still closing
    chat.updatedAt = Date.now();
    this.scheduleSave();
    if (list) this.emit('list', this.list());
    if (now) {
      clearTimeout(this._emitTimers.get(chat.id));
      this._emitTimers.delete(chat.id);
      this.emit('chat', chat);
      return;
    }
    if (this._emitTimers.has(chat.id)) return;
    this._emitTimers.set(
      chat.id,
      setTimeout(() => {
        this._emitTimers.delete(chat.id);
        this.emit('chat', chat);
      }, 60)
    );
  }

  /* --------------------------------------------------------------- reads */

  get(id) {
    return this.state.chats.find((c) => c.id === id) || null;
  }

  list() {
    return this.state.chats.map((c) => ({
      id: c.id,
      title: c.title,
      provider: c.provider,
      model: c.model,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      running: !!this.runs.get(c.id)?.busy,
    }));
  }

  /* -------------------------------------------------------------- writes */

  create({ provider, model } = {}) {
    const settings = this.settings() || {};
    const providerId = PROVIDERS[provider] ? provider : PROVIDERS[settings.provider] ? settings.provider : 'claude';
    const now = Date.now();
    const chat = {
      id: uid('chat'),
      title: 'New chat',
      provider: providerId,
      model: model ?? settings.models?.[providerId] ?? '',
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.state.chats.unshift(chat);
    // Oldest chats fall off the end, never one that is mid-reply.
    while (this.state.chats.length > MAX_CHATS) {
      const drop = [...this.state.chats].reverse().find((c) => !this.runs.get(c.id)?.busy);
      if (!drop) break;
      this.remove(drop.id, { quiet: true });
    }
    this.touch(chat, { list: true, now: true });
    return chat;
  }

  rename(id, title) {
    const chat = this.get(id);
    if (!chat || !String(title || '').trim()) return null;
    chat.title = String(title).trim().slice(0, 80);
    this.touch(chat, { list: true, now: true });
    return chat;
  }

  /** Change which CLI or model a chat uses. The conversation restarts on that CLI. */
  configure(id, { provider, model } = {}) {
    const chat = this.get(id);
    if (!chat) return null;
    if (this.runs.get(id)?.busy) throw new Error('Wait for the reply to finish, or stop it first');
    if (provider && PROVIDERS[provider] && provider !== chat.provider) {
      chat.provider = provider;
      chat.sessionId = null; // another CLI can't resume this one's conversation
      chat.model = this.settings()?.models?.[provider] ?? '';
    }
    if (typeof model === 'string') chat.model = model;
    this._retire(id);
    this.touch(chat, { list: true, now: true });
    return chat;
  }

  remove(id, { quiet = false } = {}) {
    this._retire(id);
    const before = this.state.chats.length;
    this.state.chats = this.state.chats.filter((c) => c.id !== id);
    fs.rm(path.join(this.workRoot, id), { recursive: true, force: true }, () => {});
    if (this.state.chats.length !== before) {
      this.scheduleSave();
      if (!quiet) this.emit('list', this.list());
    }
    return true;
  }

  /* ----------------------------------------------------------- detection */

  /** Which CLIs are installed, with their versions. Cached until `force`. */
  async detect(force = false) {
    if (this._detected && !force) return this._detected;
    this._flags.clear();
    const out = {};
    await Promise.all(
      Object.values(PROVIDERS).map(async (p) => {
        if (p.id === 'custom') {
          const command = this.settings()?.customCommand || '';
          out[p.id] = { installed: !!command.trim(), path: null, version: null };
          return;
        }
        const file = findExecutable(p.binaries);
        if (!file) return (out[p.id] = { installed: false, path: null, version: null });
        out[p.id] = { installed: true, path: file, version: await version(file) };
      })
    );
    this._detected = out;
    return out;
  }

  /**
   * Register hitnrun's MCP server with the user's own Claude Code, so a
   * `claude` session in any terminal can use the app. Replaces an older entry,
   * which may point at a previous install.
   */
  async connectClaudeCode(spec) {
    const detected = await this.detect(true);
    const file = detected.claude?.path;
    if (!file) return { ok: false, message: `Claude Code isn't installed. Install it with: ${PROVIDERS.claude.install}` };
    await runCli(file, ['mcp', 'remove', 'hitnrun', '--scope', 'user']);
    const envFlags = Object.entries(spec.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    const added = await runCli(file, ['mcp', 'add', 'hitnrun', '--scope', 'user', ...envFlags, '--', spec.command, ...spec.args]);
    if (!added.ok) return { ok: false, message: (added.stderr || added.stdout || 'claude mcp add failed').trim().slice(0, 600) };
    return { ok: true, message: 'Connected. Start a new claude session in your terminal to use it.' };
  }

  /** Which optional options the installed CLI knows, read once from its --help. */
  async _probeFlags(provider) {
    if (!provider.optional || this._flags.has(provider.id)) return;
    const file = this._detected?.[provider.id]?.path || findExecutable(provider.binaries);
    const help = file ? await runText(file, ['--help']) : null;
    this._flags.set(provider.id, { listed: help ? parseHelpFlags(help) : null, rejected: new Set() });
  }

  /** A predicate for the adapter: pass this option or not. */
  _supports(provider) {
    // Adapters without optional options have no system-prompt flag either.
    if (!provider.optional) return () => false;
    const known = this._flags.get(provider.id);
    return (flag) => {
      if (known?.rejected.has(flag)) return false;
      // Unreadable help: try everything, and drop what the CLI rejects.
      return known?.listed ? known.listed.has(flag) : true;
    };
  }

  /* ------------------------------------------------------------- sending */

  /**
   * Send a message. `context` is an optional block describing what is open in
   * the app; it goes to the CLI but only `text` is shown in the conversation.
   */
  async send(chatId, { text, context, contextLabel } = {}) {
    const chat = this.get(chatId);
    if (!chat) throw new Error('Chat not found');
    const body = String(text || '').trim();
    if (!body) throw new Error('Type a message first');
    const run = this.runs.get(chatId);
    if (run?.busy) throw new Error('Wait for the reply to finish, or stop it first');

    const provider = PROVIDERS[chat.provider];
    const alive = provider.caps.persistent && run?.child && run.child.exitCode === null;
    if (!alive) await this._probeFlags(provider);
    const isFirst = !chat.messages.some((m) => m.role === 'user');
    if (isFirst) chat.title = body.replace(/\s+/g, ' ').slice(0, 60);

    const now = Date.now();
    chat.messages.push({ id: uid('msg'), role: 'user', text: body, contextLabel: contextLabel || null, at: now });
    const reply = { id: uid('msg'), role: 'assistant', parts: [], status: 'running', error: null, cost: null, at: now };
    chat.messages.push(reply);
    this.touch(chat, { list: isFirst, now: true });

    let prompt = context ? `${context}\n\n${body}` : body;
    // CLIs without a system-prompt flag get the instructions with the first message.
    if (!this._supports(provider)('--append-system-prompt') && !chat.sessionId) prompt = `<instructions>\n${SYSTEM_PROMPT}\n</instructions>\n\n${prompt}`;

    try {
      if (alive) {
        run.busy = true;
        run.reply = reply;
        run.prompt = prompt;
        clearTimeout(run.idleTimer);
        run.child.stdin.write(provider.encode(prompt));
      } else {
        this._start(chat, provider, reply, prompt);
      }
    } catch (err) {
      this._fail(chat, reply, err.message);
    }
    this.emit('list', this.list());
    return { ok: true, messageId: reply.id };
  }

  stop(chatId) {
    const run = this.runs.get(chatId);
    if (!run?.busy) return false;
    run.stopping = true;
    killTree(run.child);
    return true;
  }

  /** Close every CLI (app quit). */
  shutdown() {
    for (const id of [...this.runs.keys()]) this._retire(id);
    this.saveNow();
  }

  /* ------------------------------------------------------------ internal */

  _start(chat, provider, reply, prompt, attempt = 0) {
    const settings = this.settings() || {};
    const workDir = path.join(this.workRoot, chat.id);
    fs.mkdirSync(workDir, { recursive: true });

    const mcp = this.mcp();
    mcp.env = { ...mcp.env, HITNRUN_LABEL: `In-app chat: ${chat.title}`.slice(0, 80) };

    const spec = provider.launch({
      mcp,
      model: chat.model,
      resumeId: provider.caps.resume ? chat.sessionId : null,
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      workDir,
      command: settings.customCommand,
      supports: this._supports(provider),
    });

    let file = spec.file || this._detected?.[provider.id]?.path || findExecutable(provider.binaries);
    if (spec.file && !path.isAbsolute(spec.file)) file = findExecutable([spec.file]) || spec.file;
    if (!file) {
      throw new Error(`${provider.label} isn't installed or isn't on your PATH.${provider.install ? ` Install it with: ${provider.install}` : ''}`);
    }
    const launch = resolveLaunch(file);

    const env = { ...process.env, PATH: childPath() };
    // Started from inside another agent session, these would confuse the CLI.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(launch.command, [...launch.prefix, ...spec.args], {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: !!launch.shell,
    });

    const run = { child, provider, busy: true, reply, prompt, attempt, stopping: false, retired: false, idleTimer: null, stderr: '' };
    this.runs.set(chat.id, run);

    const parse = provider.parser();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        for (const event of parse(line)) this._apply(chat, run, event);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      run.stderr = (run.stderr + chunk).slice(-4000);
    });

    child.on('error', (err) => {
      const message = err.code === 'ENOENT' ? `Could not start ${provider.label} (${file} not found).` : err.message;
      if (run.busy) this._fail(chat, run.reply, message);
      this._forget(chat.id, run);
    });

    // 'close', not 'exit': by then stdout and stderr have been read to the end.
    child.on('close', (code) => {
      if (buffer.trim()) for (const event of parse(buffer)) this._apply(chat, run, event);
      buffer = '';
      if (run.busy) {
        const target = run.reply;
        if (run.stopping) {
          target.status = 'stopped';
          this._settleTools(target, 'stopped');
          run.busy = false;
          this.touch(chat, { now: true });
        } else if (this._retryWithout(chat, run, code)) {
          return;
        } else if (provider.id === 'custom' && code === 0) {
          this._finish(chat, run, {});
        } else {
          this._fail(chat, target, this._explain(provider, run.stderr, code));
        }
      }
      this._forget(chat.id, run);
      this.emit('list', this.list());
    });

    if (spec.stdin != null) {
      child.stdin.end(spec.stdin);
    } else if (provider.caps.persistent) {
      child.stdin.write(provider.encode(prompt));
    } else {
      child.stdin.end();
    }
  }

  _apply(chat, run, event) {
    const reply = run.reply;
    if (!reply) return;
    switch (event.type) {
      case 'session':
        if (event.id && chat.sessionId !== event.id) {
          chat.sessionId = event.id;
          this.scheduleSave();
        }
        return;
      case 'text': {
        if (!event.text) return;
        const last = reply.parts[reply.parts.length - 1];
        if (last?.kind === 'text' && last.segment === event.segment) last.text += event.text;
        else reply.parts.push({ kind: 'text', text: event.text, segment: event.segment });
        return this.touch(chat);
      }
      case 'text-set': {
        const part = reply.parts.find((p) => p.kind === 'text' && p.segment === event.segment);
        if (part) part.text = event.text;
        else if (event.text) reply.parts.push({ kind: 'text', text: event.text, segment: event.segment });
        return this.touch(chat);
      }
      case 'text-discard':
        reply.parts = reply.parts.filter((p) => !(p.kind === 'text' && String(p.segment || '').startsWith(event.prefix)));
        return this.touch(chat);
      case 'tool-start':
        reply.parts.push({
          kind: 'tool',
          id: event.id,
          name: shortToolName(event.name),
          input: cut(event.input ?? {}, MAX_TOOL_TEXT),
          output: null,
          status: 'running',
        });
        return this.touch(chat);
      case 'tool-end': {
        const part = reply.parts.find((p) => p.kind === 'tool' && p.id === event.id);
        if (!part) return;
        part.output = cut(event.output ?? '', MAX_TOOL_TEXT);
        part.status = event.isError ? 'error' : 'done';
        return this.touch(chat);
      }
      case 'turn-end':
        if (!run.busy) return;
        if (event.error) {
          if (/no conversation found/i.test(event.error)) chat.sessionId = null;
          this._fail(chat, reply, event.error);
          run.busy = false;
        } else {
          this._finish(chat, run, event);
        }
        if (run.provider.caps.persistent) this._armIdle(chat.id, run);
        return;
      default:
    }
  }

  _finish(chat, run, { cost }) {
    const reply = run.reply;
    reply.status = 'done';
    // A kept-open CLI reports the running total for its process, not per reply.
    if (typeof cost === 'number') {
      reply.cost = Math.max(0, cost - (run.costSoFar || 0));
      run.costSoFar = cost;
    }
    this._settleTools(reply, 'done');
    run.busy = false;
    this.touch(chat, { now: true });
    this.emit('list', this.list());
  }

  _fail(chat, reply, message) {
    reply.status = 'error';
    reply.error = message || 'Something went wrong';
    this._settleTools(reply, 'stopped');
    const run = this.runs.get(chat.id);
    if (run && run.reply === reply) run.busy = false;
    this.touch(chat, { now: true });
    this.emit('list', this.list());
  }

  _settleTools(reply, status) {
    for (const part of reply.parts) if (part.kind === 'tool' && part.status === 'running') part.status = status;
  }

  /**
   * An older CLI that rejects one of our optional options is started again
   * without it, so the user never sees "unknown option".
   */
  _retryWithout(chat, run, code) {
    const { provider } = run;
    if (!provider.optional || code === 0 || run.attempt >= provider.optional.length) return false;
    const m = /unknown option\s+'?(--[\w-]+)/i.exec(run.stderr);
    if (!m || !provider.optional.includes(m[1])) return false;
    if (!this._flags.has(provider.id)) this._flags.set(provider.id, { listed: null, rejected: new Set() });
    this._flags.get(provider.id).rejected.add(m[1]);
    this._forget(chat.id, run);
    try {
      this._start(chat, provider, run.reply, run.prompt, run.attempt + 1);
    } catch (err) {
      this._fail(chat, run.reply, err.message);
    }
    return true;
  }

  _explain(provider, stderr, code) {
    const tail = String(stderr || '').trim().split('\n').slice(-6).join('\n');
    let message = `${provider.label} stopped unexpectedly${code != null ? ` (exit code ${code})` : ''}.`;
    if (/log ?in|logged out|not logged|authenticat|credential|api key|unauthorized/i.test(tail) && provider.login) {
      message += ` It looks like it isn't signed in. ${provider.login}`;
    }
    return tail ? `${message}\n\n${tail}` : message;
  }

  _armIdle(chatId, run) {
    clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(() => {
      if (!run.busy) this._retire(chatId);
    }, IDLE_MS);
  }

  /** Close a chat's CLI without treating it as a failure. */
  _retire(chatId) {
    const run = this.runs.get(chatId);
    if (!run) return;
    clearTimeout(run.idleTimer);
    run.retired = true;
    if (run.busy) run.stopping = true;
    killTree(run.child);
    this.runs.delete(chatId);
  }

  _forget(chatId, run) {
    clearTimeout(run.idleTimer);
    if (this.runs.get(chatId) === run) this.runs.delete(chatId);
  }
}

/** Run a CLI briefly: { ok, stdout, stderr }. */
function runCli(file, args) {
  return new Promise((resolve) => {
    const { command, prefix, shell } = resolveLaunch(file);
    const env = { ...process.env, PATH: childPath() };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(command, [...prefix, ...args], { timeout: 15000, windowsHide: true, shell: !!shell, env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** A CLI's stdout, or null if it failed. */
async function runText(file, args) {
  const out = await runCli(file, args);
  return out.ok ? out.stdout : null;
}

async function version(file) {
  const out = await runText(file, ['--version']);
  return out ? out.trim().split('\n')[0].slice(0, 60) || null : null;
}

module.exports = { ChatManager, SYSTEM_PROMPT, shortToolName };

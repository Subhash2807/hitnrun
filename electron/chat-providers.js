'use strict';

/**
 * Adapters for the coding-agent CLIs the in-app chat can drive.
 *
 * The chat never talks to a model API itself. It runs a CLI the user already
 * has installed and logged in to, hands it hitnrun's MCP server, and turns the
 * CLI's output stream into a small set of events the UI understands:
 *
 *   { type: 'session', id }                  the CLI's conversation id, for resuming
 *   { type: 'text', text, segment? }         assistant text (appended; may arrive in pieces)
 *   { type: 'text-set', text, segment }      the finished text of a segment (replaces the pieces)
 *   { type: 'text-discard', prefix }         drop segments that were abandoned (an API retry)
 *   { type: 'tool-start', id, name, input }  the agent called a tool
 *   { type: 'tool-end', id, output, isError }
 *   { type: 'turn-end', cost?, error? }      the reply is finished
 *
 * Each adapter declares what it supports (`caps`) so the panel can hide what a
 * tool can't do. The sandbox itself is enforced by the control server, not by
 * the CLI, so it holds whichever tool is on the other end.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWin = process.platform === 'win32';

/* -------------------------------------------------------------- lookup */

/**
 * Where CLIs usually live. Apps launched from Finder or the Start menu don't
 * get the login shell's PATH, so npm's and Homebrew's bin folders are added.
 */
function searchDirs() {
  const home = os.homedir();
  const extra = isWin
    ? [
        process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
        path.join(home, '.local', 'bin'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.bun', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      ];
  const fromPath = (process.env.PATH || '').split(path.delimiter);
  return [...new Set([...fromPath, ...extra].filter(Boolean))];
}

/** PATH for child processes: the app's PATH plus the usual CLI folders. */
function childPath() {
  return searchDirs().join(path.delimiter);
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** First match for any of `names` on the search path. */
function findExecutable(names) {
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of searchDirs()) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * How to actually start a found executable.
 *
 * npm installs Windows commands as .cmd shims, and spawning a .cmd needs a
 * shell, which mangles JSON arguments. The shim names its real target, so we
 * read it and run that directly: an .exe as-is, a script under node.
 */
function resolveLaunch(file) {
  if (!isWin || !/\.(cmd|bat)$/i.test(file)) return { command: file, prefix: [] };
  const dir = path.dirname(file);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* fall through */
  }
  const targets = [...text.matchAll(/"%(?:dp0|~dp0)%\\?([^"]+?\.(?:exe|js|cjs|mjs))"/gi)].map((m) => path.join(dir, m[1]));
  const target = targets.reverse().find(isFile);
  if (target && /\.exe$/i.test(target)) return { command: target, prefix: [] };
  if (target) {
    const node = [path.join(dir, 'node.exe')].find(isFile) || findExecutable(['node']);
    if (node) return { command: node, prefix: [target] };
  }
  return { command: file, prefix: [], shell: true };
}

/* ------------------------------------------------------------- helpers */

function lines(handler) {
  return (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') return [];
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [];
    }
    return handler(msg) || [];
  };
}

/** Tool output as text, however the CLI shaped it. */
function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === 'string' ? part : part?.text ?? JSON.stringify(part))).join('\n');
  }
  if (Array.isArray(value.content)) return toText(value.content);
  return JSON.stringify(value, null, 2);
}

/** Quote a string as a TOML basic string (codex's -c values are TOML). */
function toml(value) {
  return JSON.stringify(String(value));
}

/** Claude Code's own tools, turned off when the CLI is too old for `--tools ""`. */
const CLAUDE_BUILTIN_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep',
  'LS', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'SlashCommand', 'Skill',
];

/** The long options a CLI's --help lists, e.g. `--tools`. */
function parseHelpFlags(help) {
  const flags = new Set();
  for (const line of String(help || '').split('\n')) {
    const m = /^\s{1,6}(?:-\w,\s*)?(--[\w-]+)(?:,\s*(--[\w-]+))?/.exec(line);
    if (!m) continue;
    flags.add(m[1]);
    if (m[2]) flags.add(m[2]);
  }
  return flags;
}

/* ----------------------------------------------------------- adapters */

const claude = {
  id: 'claude',
  label: 'Claude Code',
  binaries: ['claude'],
  install: 'npm install -g @anthropic-ai/claude-code',
  login: 'Run `claude` once in a terminal and log in.',
  models: [
    { id: '', label: 'Default' },
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  // One process per chat, kept open between messages.
  caps: { persistent: true, resume: true, toolEvents: true, cost: true },

  // Options added in later Claude Code versions. Each is passed only when the
  // installed CLI lists it in --help, so older installs still start.
  optional: ['--include-partial-messages', '--strict-mcp-config', '--tools', '--permission-prompts', '--append-system-prompt'],

  launch({ mcp, model, resumeId, systemPrompt, workDir, supports = () => true }) {
    const config = path.join(workDir, 'claude-mcp.json');
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { hitnrun: mcp } }), 'utf8');
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (supports('--include-partial-messages')) args.push('--include-partial-messages');
    args.push('--mcp-config', config);
    if (supports('--strict-mcp-config')) args.push('--strict-mcp-config');
    // No built-in tools at all: no shell, no file access. Only hitnrun's.
    if (supports('--tools')) args.push('--tools', '');
    else args.push('--disallowedTools', ...CLAUDE_BUILTIN_TOOLS);
    args.push('--allowedTools', 'mcp__hitnrun');
    // Anything that would need a prompt is refused rather than hanging.
    if (supports('--permission-prompts')) args.push('--permission-prompts', 'none');
    if (supports('--append-system-prompt')) args.push('--append-system-prompt', systemPrompt);
    if (model) args.push('--model', model);
    if (resumeId) args.push('--resume', resumeId);
    return { args };
  },

  encode(text) {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
  },

  parser() {
    // Text arrives twice: as partial deltas, then as the finished block. Each
    // text block is a segment (message id + block index); the finished copy
    // replaces what streamed. When the API call is retried mid-answer, a new
    // message starts before the old one stopped, and the old one's partial
    // text is dropped so the answer isn't shown twice.
    let current = null;
    let open = false;
    let block = 0;
    const segment = () => `${current}:${block}`;
    return lines((msg) => {
      if (msg.type === 'system' && msg.subtype === 'init') return [{ type: 'session', id: msg.session_id }];
      if (msg.type === 'stream_event') {
        const ev = msg.event || {};
        if (ev.type === 'message_start') {
          const abandoned = open && current ? [{ type: 'text-discard', prefix: `${current}:` }] : [];
          current = ev.message?.id || `anon-${Date.now()}`;
          open = true;
          block = 0;
          return abandoned;
        }
        if (ev.type === 'message_stop') open = false;
        if (ev.type === 'content_block_start') block = ev.index ?? block;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          return [{ type: 'text', text: ev.delta.text, segment: `${current}:${ev.index ?? block}` }];
        }
        return [];
      }
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        const out = [];
        const id = msg.message?.id;
        for (const b of msg.message?.content || []) {
          if (b.type === 'text') out.push({ type: 'text-set', text: b.text, segment: id === current ? segment() : `${id}:0` });
          if (b.type === 'tool_use') out.push({ type: 'tool-start', id: b.id, name: b.name, input: b.input });
        }
        return out;
      }
      if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        return msg.message.content
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({ type: 'tool-end', id: b.tool_use_id, output: toText(b.content), isError: !!b.is_error }));
      }
      if (msg.type === 'result') {
        return [
          { type: 'session', id: msg.session_id },
          {
            type: 'turn-end',
            cost: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
            error: msg.is_error ? toText(msg.result) || msg.subtype || 'Claude Code reported an error' : null,
          },
        ];
      }
      return [];
    });
  },
};

const codex = {
  id: 'codex',
  label: 'Codex CLI',
  binaries: ['codex'],
  experimental: true,
  install: 'npm install -g @openai/codex',
  login: 'Run `codex login` in a terminal.',
  models: [{ id: '', label: 'Default' }],
  // A new process per message; the conversation carries over by resuming.
  caps: { persistent: false, resume: true, toolEvents: true, cost: false },

  launch({ mcp, model, resumeId, prompt }) {
    const env = Object.entries(mcp.env || {})
      .map(([k, v]) => `${k}=${toml(v)}`)
      .join(', ');
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      // Its own shell stays read-only; hitnrun is reached through MCP.
      '--sandbox', 'read-only',
      '-c', `mcp_servers.hitnrun.command=${toml(mcp.command)}`,
      '-c', `mcp_servers.hitnrun.args=[${mcp.args.map(toml).join(', ')}]`,
      '-c', `mcp_servers.hitnrun.env={ ${env} }`,
    ];
    if (model) args.push('-m', model);
    if (resumeId) args.push('resume', resumeId);
    // "-" reads the prompt from stdin, which avoids command-line length limits.
    args.push('-');
    return { args, stdin: prompt };
  },

  parser() {
    return lines((msg) => {
      if (msg.type === 'thread.started') return [{ type: 'session', id: msg.thread_id }];
      const item = msg.item || {};
      if (msg.type === 'item.completed' && item.type === 'agent_message') return [{ type: 'text', text: item.text + '\n\n' }];
      if (item.type === 'mcp_tool_call' || item.type === 'command_execution') {
        const name = item.type === 'mcp_tool_call' ? `${item.server}.${item.tool}` : 'shell';
        if (msg.type === 'item.started') {
          return [{ type: 'tool-start', id: item.id, name, input: item.arguments ?? item.command }];
        }
        if (msg.type === 'item.completed') {
          return [
            {
              type: 'tool-end',
              id: item.id,
              output: toText(item.result ?? item.aggregated_output ?? item.error),
              isError: item.status === 'failed' || !!item.error,
            },
          ];
        }
      }
      if (msg.type === 'turn.completed') return [{ type: 'turn-end' }];
      if (msg.type === 'turn.failed') return [{ type: 'turn-end', error: msg.error?.message || 'Codex reported an error' }];
      if (msg.type === 'error') return [{ type: 'turn-end', error: msg.message || 'Codex reported an error' }];
      return [];
    });
  },
};

const gemini = {
  id: 'gemini',
  label: 'Gemini CLI',
  binaries: ['gemini'],
  experimental: true,
  install: 'npm install -g @google/gemini-cli',
  login: 'Run `gemini` once in a terminal and sign in.',
  models: [
    { id: '', label: 'Default' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  caps: { persistent: false, resume: true, toolEvents: true, cost: false },

  launch({ mcp, model, resumeId, prompt, workDir }) {
    // Gemini reads MCP servers from the project's settings file, and the chat
    // runs in its own folder, so this file is ours. `trust` skips the
    // confirmation it can't show headless; its shell and file writers are off.
    const dir = path.join(workDir, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify(
        {
          mcpServers: { hitnrun: { ...mcp, trust: true } },
          excludeTools: ['run_shell_command', 'write_file', 'replace', 'web_fetch'],
        },
        null,
        2
      ),
      'utf8'
    );
    const args = ['--output-format', 'stream-json'];
    if (model) args.push('-m', model);
    if (resumeId) args.push('--resume', resumeId);
    args.push('-p', prompt);
    return { args };
  },

  parser() {
    return lines((msg) => {
      if (msg.type === 'init') return [{ type: 'session', id: msg.session_id }];
      if (msg.type === 'message' && msg.role === 'assistant') return [{ type: 'text', text: msg.content || '' }];
      if (msg.type === 'tool_use') return [{ type: 'tool-start', id: msg.tool_id, name: msg.tool_name, input: msg.parameters }];
      if (msg.type === 'tool_result') {
        return [{ type: 'tool-end', id: msg.tool_id, output: toText(msg.output ?? msg.error), isError: msg.status === 'error' }];
      }
      if (msg.type === 'error' && msg.severity !== 'warning') return [{ type: 'turn-end', error: msg.message }];
      if (msg.type === 'result') {
        return [{ type: 'turn-end', error: msg.status === 'error' ? toText(msg.error) || 'Gemini reported an error' : null }];
      }
      return [];
    });
  },
};

/**
 * Anything else: a command line with {prompt} where the message goes (or the
 * message on stdin when there is no placeholder). Output is shown as plain text.
 * It only has hitnrun's tools if the user registered the MCP server in it.
 */
const custom = {
  id: 'custom',
  label: 'Custom command',
  binaries: [],
  experimental: true,
  models: [{ id: '', label: 'Default' }],
  caps: { persistent: false, resume: false, toolEvents: false, cost: false },

  launch({ prompt, command }) {
    const parts = splitCommand(command || '');
    if (!parts.length) throw new Error('Set a command for the custom CLI first');
    const hasSlot = parts.some((p) => p.includes('{prompt}'));
    return {
      file: parts[0],
      args: parts.slice(1).map((p) => p.replaceAll('{prompt}', prompt)),
      stdin: hasSlot ? undefined : prompt,
    };
  },

  parser() {
    return (line) => [{ type: 'text', text: line + '\n' }];
  },
};

/** Split a command line on spaces, honouring "double" and 'single' quotes. */
function splitCommand(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const PROVIDERS = { claude, codex, gemini, custom };

module.exports = { PROVIDERS, findExecutable, resolveLaunch, childPath, splitCommand, toText, parseHelpFlags };

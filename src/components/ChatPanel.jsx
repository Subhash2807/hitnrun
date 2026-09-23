import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, api } from '../store.js';
import Markdown from '../lib/markdown.jsx';
import { relativeTime } from '../lib/format.js';
import {
  IconSparkle,
  IconSend,
  IconStop,
  IconPlus,
  IconClose,
  IconClock,
  IconTrash,
  IconTool,
  IconChevronRight,
  IconChevronDown,
  IconCopy,
  IconSync,
} from './Icons.jsx';

/**
 * The AI chat panel (beta), docked on the right of the window.
 *
 * Replies come from a coding-agent CLI running on this machine (Claude Code by
 * default), connected to the app through hitnrun's MCP server. It can read
 * everything and send requests, but only writes to its own AI workspace.
 */

const QUICK_PROMPTS = [
  { label: 'Explain the last response', text: 'Explain the last response of the open request.' },
  { label: 'Why did this fail?', text: 'Why did the open request fail, and how do I fix it?' },
  { label: 'Write tests for it', text: 'Write post-response tests for the open request, based on its last response.' },
  { label: 'Summarise my collections', text: 'Give me a short overview of my collections and what each one covers.' },
];

/** Top-bar button that opens and closes the panel. */
export function ChatToggle() {
  const open = useStore((s) => !!s.state?.ui?.chatOpen);
  const toggleChat = useStore((s) => s.toggleChat);
  const running = useStore((s) => s.chats.some((c) => c.running));
  return (
    <button
      className={`chat-toggle ${open ? 'active' : ''}`}
      title="AI assistant (Ctrl+L)"
      onClick={() => toggleChat()}
    >
      <IconSparkle width={13} height={13} className={running ? 'spin-slow' : ''} />
      Ask AI
      <span className="beta-tag">Beta</span>
    </button>
  );
}

/** "Ask AI" shortcut used on responses and error boxes. */
export function AskAiButton({ prompt, label = 'Ask AI', title }) {
  const toggleChat = useStore((s) => s.toggleChat);
  return (
    <button className="btn btn-sm btn-ghost ask-ai" title={title || prompt} onClick={() => toggleChat(true, { prompt, send: true })}>
      <IconSparkle width={12} height={12} /> {label}
    </button>
  );
}

export default function ChatPanel() {
  const ui = useStore((s) => s.state.ui);
  const chat = useStore((s) => s.chat);
  const toggleChat = useStore((s) => s.toggleChat);
  const newChat = useStore((s) => s.newChat);
  const patchUi = useStore((s) => s.patchUi);
  const view = ui.chatView === 'history' ? 'history' : 'chat';
  const width = ui.chatWidth || 400;

  return (
    <div className="chat-panel" style={{ width }}>
      <ChatResizer />
      <div className="side-panel-head chat-head">
        <IconSparkle width={14} height={14} className="accent" />
        <span className="chat-title" title={chat?.title}>
          {view === 'history' ? 'Chats' : chat?.messages.length ? chat.title : 'AI assistant'}
        </span>
        <span className="beta-tag">Beta</span>
        <div className="grow" />
        <button
          className={`icon-btn ${view === 'history' ? 'active' : ''}`}
          title="Chat history"
          onClick={() => patchUi({ chatView: view === 'history' ? 'chat' : 'history' })}
        >
          <IconClock width={14} height={14} />
        </button>
        <button className="icon-btn" title="New chat" onClick={() => newChat()}>
          <IconPlus width={14} height={14} />
        </button>
        <button className="icon-btn" title="Close (Ctrl+L)" onClick={() => toggleChat(false)}>
          <IconClose width={12} height={12} />
        </button>
      </div>
      {view === 'history' ? <ChatHistory /> : <ChatBody />}
    </div>
  );
}

/* --------------------------------------------------------------- history */

function ChatHistory() {
  const chats = useStore((s) => s.chats);
  const current = useStore((s) => s.chat?.id);
  const openChat = useStore((s) => s.openChat);
  const deleteChat = useStore((s) => s.deleteChat);
  const providers = useStore((s) => s.chatProviders);
  const started = chats.filter((c) => c.messageCount > 0);

  if (!started.length) return <div className="chat-empty-note">No chats yet.</div>;
  return (
    <div className="chat-history">
      {started.map((c) => (
        <div key={c.id} className={`chat-history-row ${c.id === current ? 'active' : ''}`} onClick={() => openChat(c.id)}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="chat-history-title">
              {c.running && <span className="rec-dot pulse" style={{ background: 'var(--accent)' }} />}
              {c.title}
            </div>
            <div className="dim chat-history-meta">
              {providers.find((p) => p.id === c.provider)?.label || c.provider} · {relativeTime(c.updatedAt)}
            </div>
          </div>
          <button
            className="icon-btn"
            title="Delete chat"
            onClick={(e) => {
              e.stopPropagation();
              deleteChat(c.id);
            }}
          >
            <IconTrash width={13} height={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ chat */

function ChatBody() {
  const chat = useStore((s) => s.chat);
  const detected = useStore((s) => s.chatDetected);
  const providers = useStore((s) => s.chatProviders);
  const defaults = useChatDefaults();
  const providerId = chat?.provider || defaults.provider;
  const provider = providers.find((p) => p.id === providerId);
  const status = detected?.[providerId];
  const missing = detected && !status?.installed;
  const running = chat?.messages.at(-1)?.status === 'running';

  return (
    <>
      <ProviderBar chat={chat} provider={provider} providers={providers} detected={detected} defaults={defaults} running={running} />
      {missing ? (
        <ProviderMissing provider={provider} />
      ) : chat?.messages.length ? (
        <MessageList chat={chat} />
      ) : (
        <ChatWelcome provider={provider} />
      )}
      <Composer disabled={!!missing} running={running} />
    </>
  );
}

function ProviderBar({ chat, provider, providers, detected, defaults, running }) {
  const configureChat = useStore((s) => s.configureChat);
  const model = chat ? chat.model : defaults.model;
  const status = detected?.[provider?.id];

  return (
    <div className="chat-provider-bar">
      <select
        className="text-input chat-select"
        value={provider?.id || 'claude'}
        disabled={running}
        title="Which AI CLI answers"
        onChange={(e) => configureChat({ provider: e.target.value })}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.experimental ? ' (experimental)' : ''}
            {detected && !detected[p.id]?.installed ? (p.id === 'custom' ? ' (not set up)' : ' (not found)') : ''}
          </option>
        ))}
      </select>
      {provider && provider.models.length > 1 && (
        <select
          className="text-input chat-select"
          value={model || ''}
          disabled={running}
          title="Model"
          onChange={(e) => configureChat({ model: e.target.value })}
        >
          {provider.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      )}
      <div className="grow" />
      {status?.version && (
        <span className="dim chat-version" title={status.path}>
          v{status.version.replace(/\s*\(.*\)$/, '').replace(/^v/, '')}
        </span>
      )}
    </div>
  );
}

function ProviderMissing({ provider }) {
  const detect = useStore((s) => s.detectChatProviders);
  const defaults = useChatDefaults();
  const saveChatSettings = useStore((s) => s.saveChatSettings);
  const showToast = useStore((s) => s.showToast);
  const [command, setCommand] = useState(defaults.customCommand);

  if (provider?.id === 'custom') {
    return (
      <div className="chat-notice">
        <strong>Custom command</strong>
        <p>
          Any CLI that takes a prompt and prints an answer. Put <code>{'{prompt}'}</code> where the message goes, or leave it
          out to send the message on stdin. Output is shown as plain text.
        </p>
        <input
          className="text-input mono"
          placeholder='e.g. mytool ask "{prompt}"'
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <p className="dim">
          It only gets hitnrun's tools if you register hitnrun's MCP server in that tool yourself (Settings → AI shows the
          config).
        </p>
        <button className="btn btn-primary btn-sm" disabled={!command.trim()} onClick={() => saveChatSettings({ customCommand: command.trim() })}>
          Save command
        </button>
      </div>
    );
  }

  return (
    <div className="chat-notice">
      <strong>{provider?.label || 'This CLI'} isn't installed</strong>
      <p>The assistant runs the CLI on your computer, using your own login. Install it:</p>
      {provider?.install && (
        <div className="chat-install">
          <code>{provider.install}</code>
          <button
            className="icon-btn"
            title="Copy"
            onClick={() => {
              api.copyToClipboard(provider.install);
              showToast('Copied');
            }}
          >
            <IconCopy width={12} height={12} />
          </button>
        </div>
      )}
      {provider?.login && <p className="dim">Then sign in: {provider.login.replace(/`/g, '')}</p>}
      <button className="btn btn-sm" onClick={() => detect(true)}>
        <IconSync width={12} height={12} /> Check again
      </button>
    </div>
  );
}

function ChatWelcome({ provider }) {
  const sendChat = useStore((s) => s.sendChat);
  const hasContext = useStore((s) => !!s.chatContext());
  return (
    <div className="chat-welcome">
      <IconSparkle width={26} height={26} className="accent" />
      <div className="chat-welcome-title">Ask about your APIs</div>
      <p className="dim">
        {provider?.label || 'Your AI CLI'} can read your collections, environments and test docs, and send requests. It
        builds new requests in its own AI workspace; you copy over what you want to keep.
      </p>
      <div className="chat-quick">
        {QUICK_PROMPTS.filter((q, i) => hasContext || i === 3).map((q) => (
          <button key={q.label} className="chat-quick-btn" onClick={() => sendChat(q.text)}>
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageList({ chat }) {
  const ref = useRef(null);
  const stick = useRef(true);

  // Follow the reply as it streams, unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  return (
    <div
      className="chat-messages"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {chat.messages.map((m) => (m.role === 'user' ? <UserMessage key={m.id} message={m} /> : <AssistantMessage key={m.id} message={m} />))}
    </div>
  );
}

function UserMessage({ message }) {
  return (
    <div className="chat-msg user">
      {message.contextLabel && (
        <div className="chat-context-tag" title="What was open in the app was sent along">
          with “{message.contextLabel}”
        </div>
      )}
      <div className="chat-bubble">{message.text}</div>
    </div>
  );
}

function AssistantMessage({ message }) {
  const empty = !message.parts.length;
  return (
    <div className="chat-msg assistant">
      {message.parts.map((part, i) =>
        part.kind === 'tool' ? <ToolCall key={part.id || i} part={part} /> : <Markdown key={i} text={part.text} />
      )}
      {message.status === 'running' && (
        <div className="chat-typing">
          <span />
          <span />
          <span />
          {empty && <em className="dim">Starting…</em>}
        </div>
      )}
      {message.status === 'stopped' && <div className="dim chat-meta">Stopped</div>}
      {message.status === 'error' && <div className="error-box chat-error">{message.error}</div>}
      {message.status === 'done' && typeof message.cost === 'number' && (
        <div className="dim chat-meta" title="Usage reported by the CLI">
          ${message.cost.toFixed(message.cost < 0.01 ? 4 : 3)}
        </div>
      )}
    </div>
  );
}

function ToolCall({ part }) {
  const [open, setOpen] = useState(false);
  const summary = summarize(part.input);
  return (
    <div className={`chat-tool ${part.status}`}>
      <button className="chat-tool-head" onClick={() => setOpen((v) => !v)}>
        {open ? <IconChevronDown width={11} height={11} /> : <IconChevronRight width={11} height={11} />}
        <IconTool width={11} height={11} />
        <span className="chat-tool-name">{part.name}</span>
        <span className="chat-tool-summary dim">{summary}</span>
        <span className={`chat-tool-status ${part.status}`}>
          {part.status === 'running' ? '…' : part.status === 'error' ? 'failed' : part.status === 'stopped' ? 'stopped' : '✓'}
        </span>
      </button>
      {open && (
        <div className="chat-tool-body">
          <div className="dim">Input</div>
          <pre>{part.input}</pre>
          {part.output != null && (
            <>
              <div className="dim">Output</div>
              <pre>{part.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A one-line hint of what a tool was called with. */
function summarize(input) {
  try {
    const value = JSON.parse(input);
    if (!value || typeof value !== 'object') return String(value);
    const pick = value.curl || value.url || value.name || value.request_id || value.doc_id || value.query;
    if (pick) return String(pick).replace(/\s+/g, ' ').slice(0, 70);
    const keys = Object.keys(value);
    return keys.length ? keys.join(', ') : '';
  } catch {
    return String(input || '').slice(0, 70);
  }
}

/* -------------------------------------------------------------- composer */

function Composer({ disabled, running }) {
  const draft = useStore((s) => s.chatDraft);
  const sendChat = useStore((s) => s.sendChat);
  const stopChat = useStore((s) => s.stopChat);
  // Recomputed when the open tab or its response changes.
  const contextLabel = useStore((s) => s.chatContext()?.label || null);
  const [text, setText] = useState(draft);
  const [withContext, setWithContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  // A prefilled prompt (from an Ask button) replaces what's in the box.
  useEffect(() => {
    if (draft) {
      setText(draft);
      ref.current?.focus();
    }
  }, [draft]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [text]);

  const submit = async () => {
    const body = text.trim();
    if (!body || running || disabled || busy) return;
    setBusy(true);
    const out = await sendChat(body, { includeContext: withContext });
    setBusy(false);
    if (out?.ok !== false) setText('');
  };

  return (
    <div className="chat-composer">
      {contextLabel && (
        <button
          className={`chat-context-chip ${withContext ? 'on' : ''}`}
          title={withContext ? 'The open request and its last response are sent with your message. Click to leave them out.' : 'Click to include the open request'}
          onClick={() => setWithContext((v) => !v)}
        >
          {withContext ? '✓' : '+'} {contextLabel}
        </button>
      )}
      <div className="chat-input-row">
        <textarea
          ref={ref}
          className="text-input chat-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? 'Set up a CLI above to start' : 'Ask about this request, or ask for a new one…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {running ? (
          <button className="btn btn-sm chat-send" title="Stop" onClick={stopChat}>
            <IconStop width={12} height={12} />
          </button>
        ) : (
          <button className="btn btn-primary btn-sm chat-send" title="Send (Enter)" disabled={!text.trim() || disabled || busy} onClick={submit}>
            <IconSend width={12} height={12} />
          </button>
        )}
      </div>
      <div className="chat-footnote dim">Enter to send · Shift+Enter for a new line · sandboxed to hitnrun's tools</div>
    </div>
  );
}

/** Default CLI and model for new chats. Selects the saved object itself so it stays referentially stable. */
function useChatDefaults() {
  const settings = useStore((s) => s.state.settings.chat);
  const provider = settings?.provider || 'claude';
  return { provider, model: settings?.models?.[provider] || '', customCommand: settings?.customCommand || '' };
}

/* --------------------------------------------------------------- resizer */

function ChatResizer() {
  const patchUi = useStore((s) => s.patchUi);
  const frame = useRef(null);
  const onMouseDown = (e) => {
    e.preventDefault();
    const onMove = (ev) => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        patchUi({ chatWidth: Math.min(720, Math.max(320, window.innerWidth - ev.clientX)) });
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return <div className="chat-resizer" onMouseDown={onMouseDown} />;
}

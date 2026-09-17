import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, api } from '../store.js';
import KeyValueEditor from './KeyValueEditor.jsx';
import AuthEditor from './AuthEditor.jsx';
import BodyEditor from './BodyEditor.jsx';
import Editor from './Editor.jsx';
import ResponsePanel from './ResponsePanel.jsx';
import Dropdown, { Item, Separator } from './Dropdown.jsx';
import { IconMore, IconCopy, IconTerminal, IconChevronDown } from './Icons.jsx';
import { METHODS, METHOD_COLORS } from '../lib/format.js';
import { composeUrl, decomposeUrl, syncPathVars } from '../lib/url.js';

export default function RequestView({ requestId, theme }) {
  const request = useStore((s) => s.getRequest(requestId));
  const patchRequest = useStore((s) => s.patchRequest);
  const send = useStore((s) => s.send);
  const duplicateRequest = useStore((s) => s.duplicateRequest);
  const deleteRequest = useStore((s) => s.deleteRequest);
  const openModal = useStore((s) => s.openModal);
  const showToast = useStore((s) => s.showToast);
  const result = useStore((s) => s.responses[requestId]);
  const sending = useStore((s) => s.sending[requestId]);

  const [tab, setTab] = useState('params');
  const [splitPct, setSplitPct] = useState(48);
  const [urlFocused, setUrlFocused] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const containerRef = useRef(null);

  if (!request) return null;

  const modelUrl = composeUrl(request.url || '', request.params || []);
  const urlValue = urlFocused ? urlDraft : modelUrl;

  /** Replace the request's wire fields from a cURL command. */
  const importCurl = useCallback(
    async (text) => {
      const parsed = await api.parseCurl(text);
      if (!parsed.ok) {
        showToast(parsed.error || 'Could not parse that cURL command');
        return false;
      }
      const p = parsed.request;
      const keepName = request.name && request.name !== 'New Request';
      patchRequest(requestId, {
        method: p.method,
        url: p.url,
        params: p.params,
        pathVars: p.pathVars,
        headers: p.headers,
        auth: p.auth,
        body: p.body,
        settings: { ...request.settings, ...p.settings },
        ...(keepName ? {} : { name: p.name }),
      });
      setUrlFocused(false);
      showToast('Imported from cURL');
      return true;
    },
    [request, requestId, patchRequest, showToast]
  );

  const onUrlChange = (text) => {
    setUrlDraft(text);
    // A pasted cURL command lands here too if the paste handler was bypassed.
    if (/^\s*curl(\.exe)?[\s\n]/i.test(text)) {
      importCurl(text);
      return;
    }
    const { base, params } = decomposeUrl(text, request.params || []);
    patchRequest(requestId, {
      url: base,
      params,
      pathVars: syncPathVars(base, request.pathVars || []),
    });
  };

  const onUrlPaste = async (e) => {
    const text = e.clipboardData.getData('text');
    if (/^\s*curl(\.exe)?[\s\n]/i.test(text)) {
      e.preventDefault();
      await importCurl(text);
    }
  };

  const copyAsCurl = async () => {
    const curl = await api.toCurl(request);
    await api.copyToClipboard(curl);
    showToast('Copied as cURL');
  };

  const importFromClipboard = async () => {
    const text = await api.readClipboard();
    if (!text?.trim()) return showToast('Clipboard is empty');
    if (!/^\s*curl(\.exe)?[\s\n]/i.test(text)) return showToast('Clipboard does not contain a cURL command');
    await importCurl(text);
  };

  // Menu accelerators are routed from the main process.
  useEffect(() => {
    return api.onMenuCommand((command) => {
      if (command === 'request:send') send(requestId);
      else if (command === 'request:duplicate') duplicateRequest(requestId);
      else if (command === 'request:copyCurl') copyAsCurl();
      else if (command === 'request:importCurl') importFromClipboard();
    });
  }, [requestId, request]);

  const startDrag = (e) => {
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const onMove = (ev) => {
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setSplitPct(Math.min(85, Math.max(15, pct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const counts = {
    params: (request.params || []).filter((p) => p.enabled !== false && p.key).length,
    headers: (request.headers || []).filter((h) => h.enabled !== false && h.key).length,
  };
  const hasBody = request.body && request.body.mode !== 'none';
  const hasAuth = request.auth && !['none', 'inherit'].includes(request.auth.type);
  const hasScripts = !!(request.scripts?.pre?.trim() || request.scripts?.test?.trim());

  return (
    <div className="request-view">
      <div className="request-head">
        <div className="request-title">
          <input
            value={request.name}
            onChange={(e) => patchRequest(requestId, { name: e.target.value })}
            spellCheck={false}
            title="Rename this request"
          />
          <span className="breadcrumb">saved automatically</span>
          <div className="grow" />
          <Dropdown
            align="right"
            trigger={(open) => (
              <button className="icon-btn" onClick={open} title="More actions">
                <IconMore />
              </button>
            )}
          >
            <Item onClick={() => duplicateRequest(requestId)} icon={<IconCopy width={12} height={12} />}>
              Duplicate
            </Item>
            <Item onClick={copyAsCurl} icon={<IconTerminal width={12} height={12} />}>
              Copy as cURL
            </Item>
            <Item onClick={importFromClipboard}>Import cURL from clipboard</Item>
            <Separator />
            <Item
              danger
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: 'Delete request',
                  message: `Delete "${request.name}"?`,
                  onConfirm: () => deleteRequest(requestId),
                })
              }
            >
              Delete
            </Item>
          </Dropdown>
        </div>

        <div className="urlbar">
          <div className="url-group">
            <MethodSelect value={request.method} onChange={(method) => patchRequest(requestId, { method })} />
            <input
              className="url-input"
              value={urlValue}
              spellCheck={false}
              placeholder="Enter URL or paste a cURL command"
              onFocus={() => {
                setUrlDraft(modelUrl);
                setUrlFocused(true);
              }}
              onBlur={() => setUrlFocused(false)}
              onChange={(e) => onUrlChange(e.target.value)}
              onPaste={onUrlPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                  send(requestId);
                }
              }}
            />
          </div>
          <button className="btn btn-primary" disabled={sending} onClick={() => send(requestId)}>
            {sending ? <span className="spinner" /> : 'Send'}
          </button>
        </div>
      </div>

      <div className="split" ref={containerRef}>
        <div className="pane" style={{ height: `${splitPct}%`, flex: 'none' }}>
          <div className="panel-tabs">
            <PanelTab id="params" tab={tab} setTab={setTab} count={counts.params}>Params</PanelTab>
            <PanelTab id="auth" tab={tab} setTab={setTab} dot={hasAuth}>Authorization</PanelTab>
            <PanelTab id="headers" tab={tab} setTab={setTab} count={counts.headers}>Headers</PanelTab>
            <PanelTab id="body" tab={tab} setTab={setTab} dot={hasBody}>Body</PanelTab>
            <PanelTab id="pre" tab={tab} setTab={setTab} dot={!!request.scripts?.pre?.trim()}>Pre-request</PanelTab>
            <PanelTab id="tests" tab={tab} setTab={setTab} dot={!!request.scripts?.test?.trim()}>Tests</PanelTab>
            <PanelTab id="settings" tab={tab} setTab={setTab}>Settings</PanelTab>
          </div>

          {tab === 'params' && (
            <div className="kv-scroll" style={{ display: 'flex', flexDirection: 'column' }}>
              <KeyValueEditor
                auto
                title="Query Params"
                rows={request.params || []}
                onChange={(params) => patchRequest(requestId, { params })}
                emptyNote="Query params you add here appear in the URL above."
              />
              <div style={{ borderTop: '1px solid var(--border)' }}>
                <KeyValueEditor
                  auto
                  title="Path Variables"
                  rows={request.pathVars || []}
                  onChange={(pathVars) => patchRequest(requestId, { pathVars })}
                  toggles={false}
                  keyPlaceholder="Variable"
                  emptyNote={
                    <>
                      Write <code className="mono">:name</code> in the URL path — for example{' '}
                      <code className="mono">/users/:id</code> — and it shows up here.
                    </>
                  }
                />
              </div>
            </div>
          )}

          {tab === 'auth' && (
            <AuthEditor auth={request.auth} onChange={(auth) => patchRequest(requestId, { auth })} />
          )}

          {tab === 'headers' && (
            <KeyValueEditor
              title="Headers"
              rows={request.headers || []}
              onChange={(headers) => patchRequest(requestId, { headers })}
              keyPlaceholder="Header"
              emptyNote="Content-Type, Content-Length, Host and Accept-Encoding are added automatically when needed."
            />
          )}

          {tab === 'body' && (
            <BodyEditor body={request.body} onChange={(body) => patchRequest(requestId, { body })} theme={theme} />
          )}

          {tab === 'pre' && (
            <ScriptTab
              value={request.scripts?.pre}
              onChange={(pre) => patchRequest(requestId, { scripts: { ...request.scripts, pre } })}
              theme={theme}
              hint="Runs before the request is sent. Use pm.environment.set('token', …) to prepare variables."
            />
          )}

          {tab === 'tests' && (
            <ScriptTab
              value={request.scripts?.test}
              onChange={(test) => patchRequest(requestId, { scripts: { ...request.scripts, test } })}
              theme={theme}
              hint="Runs after the response arrives. pm.test(), pm.expect() and pm.response are available."
            />
          )}

          {tab === 'settings' && <RequestSettings request={request} onChange={(settings) => patchRequest(requestId, { settings })} />}
        </div>

        <div className="resizer resizer-h" onMouseDown={startDrag} />

        <div className="pane" style={{ flex: 1 }}>
          <ResponsePanel result={result} sending={sending} theme={theme} />
        </div>
      </div>
    </div>
  );
}

function MethodSelect({ value, onChange }) {
  return (
    <Dropdown
      trigger={(open) => (
        <button className={`method-select ${METHOD_COLORS[value] || ''}`} onClick={open}>
          {value}
          <IconChevronDown width={11} height={11} className="dim" />
        </button>
      )}
    >
      {METHODS.map((m) => (
        <button key={m} className="dropdown-item" onClick={() => onChange(m)}>
          <span className={`method-badge ${METHOD_COLORS[m]}`} style={{ minWidth: 52, textAlign: 'left' }}>
            {m}
          </span>
        </button>
      ))}
    </Dropdown>
  );
}

function PanelTab({ id, tab, setTab, count, dot, children }) {
  return (
    <button className={`panel-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
      {children}
      {count > 0 && <span className="count-pill">{count}</span>}
      {dot && <span className="dot" />}
    </button>
  );
}

function ScriptTab({ value, onChange, hint, theme }) {
  return (
    <div className="editor-section">
      <div className="hint">{hint}</div>
      <Editor value={value ?? ''} language="javascript" onChange={onChange} theme={theme} placeholder="// JavaScript" />
    </div>
  );
}

function RequestSettings({ request, onChange }) {
  const settings = request.settings || {};
  const set = (patch) => onChange({ ...settings, ...patch });

  return (
    <div className="editor-section" style={{ overflowY: 'auto' }}>
      <div className="field-grid">
        <label>Follow redirects</label>
        <div>
          <input
            type="checkbox"
            checked={settings.followRedirects !== false}
            onChange={(e) => set({ followRedirects: e.target.checked })}
          />
        </div>

        <label>Verify TLS certificate</label>
        <div>
          <input
            type="checkbox"
            checked={settings.sslVerify !== false}
            onChange={(e) => set({ sslVerify: e.target.checked })}
          />
          <span className="dim" style={{ marginLeft: 8, fontSize: 11.5 }}>
            Turn off for self-signed certificates on localhost.
          </span>
        </div>

        <label>Timeout (ms)</label>
        <input
          className="text-input"
          type="number"
          min="0"
          placeholder="0 — no timeout"
          value={settings.timeout ?? ''}
          onChange={(e) => set({ timeout: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </div>
    </div>
  );
}

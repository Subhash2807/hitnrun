import { useMemo, useState } from 'react';
import Editor from './Editor.jsx';
import { IconCopy, IconDownload } from './Icons.jsx';
import { api, useStore } from '../store.js';
import { AddToDocButton } from './DocsPanel.jsx';
import {
  prettyBytes,
  prettyTime,
  statusClass,
  decodeBase64,
  base64ToBlobUrl,
  tryPretty,
  detectLanguage,
  headerValue,
} from '../lib/format.js';

export default function ResponsePanel({ requestId, result, sending, theme }) {
  const [tab, setTab] = useState('body');
  const [bodyView, setBodyView] = useState('pretty');
  const [wrap, setWrap] = useState(true);
  const showToast = useStore((s) => s.showToast);

  const response = result?.response;

  const decoded = useMemo(() => {
    if (!response || response.error) return null;
    const contentType = headerValue(response.headers, 'content-type') || '';
    const text = decodeBase64(response.bodyBase64);
    return {
      contentType,
      text,
      language: detectLanguage(contentType, text),
      isImage: /^image\//i.test(contentType),
      isHtml: /html/i.test(contentType),
    };
  }, [response]);

  const cookies = useMemo(() => parseCookies(response?.headers), [response]);

  if (sending) {
    return (
      <div className="pane">
        <div className="response-placeholder">
          <div>
            <div className="spinner" style={{ margin: '0 auto 12px', borderTopColor: 'var(--accent)' }} />
            Sending request…
          </div>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="pane">
        <div className="response-placeholder">
          <div>
            Send the request to see the response here.
            <br />
            <span className="dim">
              Press <span className="kbd">Ctrl</span> <span className="kbd">Enter</span> to send.
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Transport failure, or a script that threw before the request went out.
  const failure = result.error || response?.error;
  if (failure) {
    return (
      <div className="pane">
        <div className="error-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong className="grow">{result.phase === 'pre-request' ? 'Pre-request script failed' : 'Could not send request'}</strong>
            {/* A failure can be worth documenting too. */}
            {result.phase !== 'pre-request' && <AddToDocButton requestId={requestId} />}
          </div>
          <div style={{ marginTop: 6 }}>{failure.message}</div>
          {failure.code && (
            <div style={{ marginTop: 6 }} className="dim">
              <code>{failure.code}</code>
              {HINTS[failure.code] && <div style={{ marginTop: 4 }}>{HINTS[failure.code]}</div>}
            </div>
          )}
        </div>
        {result.scriptLogs?.length > 0 && <ConsoleList logs={result.scriptLogs} />}
      </div>
    );
  }

  const passed = (result.tests || []).filter((t) => t.passed).length;
  const failed = (result.tests || []).length - passed;

  const copyBody = () => {
    api.copyToClipboard(decoded?.text ?? '');
    showToast('Response body copied');
  };

  const saveBody = async () => {
    const name = guessFilename(result.request?.url, decoded?.contentType);
    const saved = await api.saveFile({ defaultPath: name, contentBase64: response.bodyBase64 });
    if (saved) showToast('Saved to ' + saved);
  };

  return (
    <div className="pane">
      <div className="response-head">
        <span className="response-title">Response</span>
        <span className={`stat ${statusClass(response.status)}`}>
          Status <b>{response.status} {response.statusText}</b>
        </span>
        <span className="stat">
          Time <b>{prettyTime(response.timeMs)}</b>
        </span>
        <span className="stat">
          Size <b>{prettyBytes(response.size?.decoded)}</b>
        </span>
        <AddToDocButton requestId={requestId} />
        <button className="icon-btn" title="Copy response body" onClick={copyBody}>
          <IconCopy />
        </button>
        <button className="icon-btn" title="Save response to file" onClick={saveBody}>
          <IconDownload />
        </button>
      </div>

      {result.unresolved?.missing?.length > 0 && (
        <div className="unresolved-bar">
          Unresolved variables: {result.unresolved.missing.map((m) => `{{${m}}}`).join(', ')}
        </div>
      )}

      <div className="panel-tabs">
        <Tab id="body" tab={tab} setTab={setTab}>Body</Tab>
        <Tab id="cookies" tab={tab} setTab={setTab} count={cookies.length}>Cookies</Tab>
        <Tab id="headers" tab={tab} setTab={setTab} count={response.headers?.length}>Headers</Tab>
        <Tab id="tests" tab={tab} setTab={setTab} count={result.tests?.length}>
          Test Results
          {failed > 0 && <span className="count-pill" style={{ color: 'var(--error)' }}>{failed} failed</span>}
        </Tab>
        <Tab id="console" tab={tab} setTab={setTab} count={result.scriptLogs?.length}>Console</Tab>

        {tab === 'body' && (
          <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
            {['pretty', 'raw', 'preview'].map((v) => (
              <button
                key={v}
                className={`link-btn ${bodyView === v ? '' : 'dim'}`}
                style={bodyView === v ? { color: 'var(--accent)' } : { color: 'var(--text-dim)' }}
                onClick={() => setBodyView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
            <button className="link-btn dim" onClick={() => setWrap((w) => !w)} title="Toggle line wrapping">
              {wrap ? 'No Wrap' : 'Wrap'}
            </button>
          </div>
        )}
      </div>

      {tab === 'body' && <BodyView decoded={decoded} response={response} view={bodyView} wrap={wrap} theme={theme} />}

      {tab === 'headers' && (
        <div className="kv-scroll">
          <table className="kv-table">
            <thead>
              <tr>
                <th style={{ width: '34%' }}>Key</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {(response.headers || []).map(([k, v], i) => (
                <tr key={i}>
                  <td style={{ padding: '6px 8px' }} className="mono">{k}</td>
                  <td style={{ padding: '6px 8px', wordBreak: 'break-all' }} className="mono dim">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'cookies' && (
        cookies.length === 0 ? (
          <div className="empty-note">This response did not set any cookies.</div>
        ) : (
          <div className="kv-scroll">
            <table className="kv-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th style={{ width: 120 }}>Path</th>
                  <th style={{ width: 160 }}>Expires</th>
                  <th style={{ width: 80 }}>Flags</th>
                </tr>
              </thead>
              <tbody>
                {cookies.map((c, i) => (
                  <tr key={i}>
                    <td style={{ padding: '6px 8px' }} className="mono">{c.name}</td>
                    <td style={{ padding: '6px 8px', wordBreak: 'break-all' }} className="mono dim">{c.value}</td>
                    <td style={{ padding: '6px 8px' }} className="mono dim">{c.path || '/'}</td>
                    <td style={{ padding: '6px 8px' }} className="mono dim">{c.expires || 'Session'}</td>
                    <td style={{ padding: '6px 8px' }} className="mono dim">{c.flags.join(' ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'tests' && (
        (result.tests || []).length === 0 ? (
          <div className="empty-note">
            No tests ran for this request.
            <br />
            Add assertions in the <strong>Tests</strong> tab, for example:
            <br />
            <code className="mono">pm.test('ok', () =&gt; pm.response.to.have.status(200))</code>
          </div>
        ) : (
          <div className="kv-scroll">
            <div style={{ padding: '8px 14px', fontSize: 12 }} className="dim">
              <span style={{ color: 'var(--ok)' }}>{passed} passed</span>
              {failed > 0 && <span style={{ color: 'var(--error)' }}>, {failed} failed</span>}
            </div>
            {result.tests.map((t, i) => (
              <div key={i} className="test-row">
                <span className={`test-badge ${t.passed ? 'test-pass' : 'test-fail'}`}>{t.passed ? 'PASS' : 'FAIL'}</span>
                <div className="grow">
                  {t.name}
                  {t.error && <div className="test-error">{t.error}</div>}
                </div>
              </div>
            ))}
            {result.scriptError && (
              <div className="error-box">
                <strong>Test script error</strong>
                <div style={{ marginTop: 6 }}>{result.scriptError.message}</div>
              </div>
            )}
          </div>
        )
      )}

      {tab === 'console' && <ConsoleList logs={result.scriptLogs} />}
    </div>
  );
}

function BodyView({ decoded, response, view, wrap, theme }) {
  if (!decoded) return <div className="empty-note">No response body.</div>;

  if (view === 'preview') {
    if (decoded.isImage) {
      const url = base64ToBlobUrl(response.bodyBase64, decoded.contentType);
      return (
        <div className="img-preview">
          {url ? <img src={url} alt="Response" /> : <span className="dim">Could not render image</span>}
        </div>
      );
    }
    if (decoded.isHtml) {
      // sandbox="" blocks scripts, forms and same-origin access in the preview.
      return <iframe className="preview-frame" sandbox="" srcDoc={decoded.text} title="Response preview" />;
    }
    return <div className="empty-note">Preview is available for HTML and image responses.</div>;
  }

  if (!decoded.text) {
    return <div className="empty-note">The response body is empty.</div>;
  }

  const text = view === 'pretty' ? tryPretty(decoded.text, decoded.language) : decoded.text;

  return (
    <Editor
      value={text}
      language={view === 'pretty' ? decoded.language : 'text'}
      readOnly
      wrap={wrap}
      theme={theme}
    />
  );
}

function ConsoleList({ logs }) {
  if (!logs?.length) {
    return (
      <div className="empty-note">
        Nothing logged.
        <br />
        <code className="mono">console.log()</code> inside a pre-request or test script shows up here.
      </div>
    );
  }
  return (
    <div className="kv-scroll">
      {logs.map((l, i) => (
        <div key={i} className={`log-line log-${l.level}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

function Tab({ id, tab, setTab, count, children }) {
  return (
    <button className={`panel-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
      {children}
      {count > 0 && <span className="count-pill">{count}</span>}
    </button>
  );
}

function parseCookies(headers) {
  const out = [];
  for (const [k, v] of headers || []) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const [pair, ...attrs] = v.split(';');
    const eq = pair.indexOf('=');
    const cookie = {
      name: eq === -1 ? pair.trim() : pair.slice(0, eq).trim(),
      value: eq === -1 ? '' : pair.slice(eq + 1).trim(),
      path: '',
      expires: '',
      flags: [],
    };
    for (const attr of attrs) {
      const [rawName, rawValue] = attr.split('=');
      const name = rawName.trim().toLowerCase();
      if (name === 'path') cookie.path = rawValue?.trim();
      else if (name === 'expires') cookie.expires = rawValue?.trim();
      else if (name === 'max-age') cookie.expires = `${rawValue?.trim()}s`;
      else if (['httponly', 'secure'].includes(name)) cookie.flags.push(rawName.trim());
      else if (name === 'samesite') cookie.flags.push(`SameSite=${rawValue?.trim()}`);
    }
    out.push(cookie);
  }
  return out;
}

function guessFilename(url, contentType) {
  let base = 'response';
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) base = last.replace(/\.[^.]+$/, '');
  } catch {
    /* keep the default */
  }
  const ext = /json/.test(contentType) ? '.json'
    : /html/.test(contentType) ? '.html'
    : /xml/.test(contentType) ? '.xml'
    : /^image\/png/.test(contentType) ? '.png'
    : /^image\/jpe?g/.test(contentType) ? '.jpg'
    : /text/.test(contentType) ? '.txt'
    : '.bin';
  return base + ext;
}

const HINTS = {
  ENOTFOUND: 'The hostname could not be resolved. Check the URL for typos.',
  ECONNREFUSED: 'Nothing is listening on that host and port.',
  ETIMEDOUT: 'The server did not respond in time. Raise the timeout in Settings if this is expected.',
  CERT_HAS_EXPIRED: 'The TLS certificate has expired. Turn off SSL verification in Settings to send anyway.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed certificate. Turn off SSL verification in Settings to send anyway.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The certificate chain could not be verified. Turn off SSL verification in Settings to send anyway.',
  ERR_NO_URL: 'Type a URL in the address bar first.',
};

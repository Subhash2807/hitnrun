import { useEffect, useRef, useState } from 'react';
import { useStore, api, findRequest } from '../store.js';
import Dropdown, { Item, Separator } from './Dropdown.jsx';
import { DOC_FORMATS } from './Modals.jsx';
import {
  IconMore, IconTrash, IconCopy, IconDownload, IconGrip, IconRecord, IconPause, IconPlay, IconStop, IconChevronDown, IconCamera,
} from './Icons.jsx';
import { METHOD_COLORS, prettyBytes, prettyTime, statusClass, relativeTime } from '../lib/format.js';

/**
 * A test doc, opened in the main area like a request. Everything is editable in
 * place and auto-saves: the doc name, the summary, and per step the title,
 * expected result, note and pass/fail. Steps reorder by dragging.
 */
export default function DocView({ docId }) {
  const version = useStore((s) => s.docVersions[docId] || 0);
  const recording = useStore((s) => s.recording);
  const openModal = useStore((s) => s.openModal);
  const docCall = useStore((s) => s.docCall);
  const deleteDoc = useStore((s) => s.deleteDoc);
  const stopRecording = useStore((s) => s.stopRecording);
  const [doc, setDoc] = useState(null);
  const [expandAll, setExpandAll] = useState(null); // null = each section keeps its own state
  const [dragId, setDragId] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const listEnd = useRef(null);
  const lastCount = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.docs('get', docId).then((d) => !cancelled && setDoc(d));
    return () => {
      cancelled = true;
    };
  }, [docId, version]);

  // While recording, follow new steps as they arrive.
  const isRecording = recording?.docId === docId;
  useEffect(() => {
    if (!doc) return;
    if (isRecording && lastCount.current != null && doc.steps.length > lastCount.current) {
      listEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    lastCount.current = doc.steps.length;
  }, [doc?.steps.length]);

  if (!doc) return <div className="response-placeholder" style={{ flex: 1 }}>Loading…</div>;

  const counts = { pass: 0, fail: 0, untested: 0 };
  doc.steps.forEach((s) => (counts[s.status] += 1));

  const onDrop = async () => {
    if (dragId == null || dropIndex == null) return;
    const from = doc.steps.findIndex((s) => s.id === dragId);
    // Dropping below yourself shifts the target by one once you're removed.
    const to = dropIndex > from ? dropIndex - 1 : dropIndex;
    setDragId(null);
    setDropIndex(null);
    if (from !== to) await docCall('moveStep', docId, dragId, to);
  };

  return (
    <div className="doc-view">
      <div className="doc-head">
        <div className="doc-title-row">
          <EditableText
            className="doc-title"
            value={doc.name}
            onSave={(name) => name.trim() && docCall('update', docId, { name })}
            placeholder="Doc name"
          />
          {isRecording && (
            <span className={`rec-chip static ${recording.paused ? 'paused' : ''}`}>
              <span className={`rec-dot ${recording.paused ? '' : 'pulse'}`} />
              {recording.paused ? 'Paused' : `Recording · ${recording.mode}`}
            </span>
          )}
          <div className="grow" />
          {isRecording ? (
            <>
              <button className="btn btn-sm" title="Add a screenshot of any screen or window" onClick={() => openModal({ type: 'screenshot' })}>
                <IconCamera width={12} height={12} /> Screenshot
              </button>
              <button className="btn btn-sm" onClick={() => docCall('setRecording', { paused: !recording.paused })}>
                {recording.paused ? <IconPlay width={11} height={11} /> : <IconPause width={12} height={12} />}
                {recording.paused ? 'Resume' : 'Pause'}
              </button>
              <button className="btn btn-sm" onClick={stopRecording}>
                <IconStop width={11} height={11} /> Stop
              </button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => openModal({ type: 'startRecording', docId })}>
              <IconRecord width={11} height={11} style={{ color: 'var(--error)' }} /> Resume recording
            </button>
          )}
          <Dropdown
            align="right"
            trigger={(open) => (
              <button className="btn btn-sm btn-primary" onClick={open}>
                <IconDownload width={12} height={12} /> Download <IconChevronDown width={11} height={11} />
              </button>
            )}
          >
            {DOC_FORMATS.map((f) => (
              <Item key={f.id} onClick={() => openModal({ type: 'exportDoc', id: docId, format: f.id })}>
                {f.label}
              </Item>
            ))}
          </Dropdown>
          <Dropdown
            align="right"
            trigger={(open) => (
              <button className="icon-btn" onClick={open} title="More actions">
                <IconMore />
              </button>
            )}
          >
            <Item onClick={() => setExpandAll(true)}>Expand all sections</Item>
            <Item onClick={() => setExpandAll(false)}>Collapse all sections</Item>
            <Separator />
            <Item onClick={() => docCall('duplicate', docId)} icon={<IconCopy width={12} height={12} />}>Duplicate</Item>
            <Item
              danger
              icon={<IconTrash width={12} height={12} />}
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: 'Delete doc',
                  message: `Delete "${doc.name}" and its ${doc.steps.length} steps? This cannot be undone.`,
                  onConfirm: () => deleteDoc(docId),
                })
              }
            >
              Delete doc
            </Item>
          </Dropdown>
        </div>
        <div className="doc-facts">
          <span>Started {new Date(doc.createdAt).toLocaleString()}</span>
          <span>{doc.steps.length} step{doc.steps.length === 1 ? '' : 's'}</span>
          <span className="doc-pass">✓ {counts.pass} pass</span>
          <span className="doc-fail">✕ {counts.fail} fail</span>
          <span>{counts.untested} not checked</span>
        </div>
        <EditableText
          multiline
          className="doc-summary"
          value={doc.description}
          onSave={(description) => docCall('update', docId, { description })}
          placeholder="Summary — what feature is this, what was tested, anything the reader should know."
        />
      </div>

      <div className="doc-steps" onDragOver={(e) => dragId && e.preventDefault()} onDrop={onDrop}>
        {doc.steps.length === 0 && (
          <div className="tree-empty" style={{ padding: 40 }}>
            {isRecording
              ? recording.mode === 'auto'
                ? 'Send a request, or take a screenshot. It will appear here as step 1.'
                : 'Send a request, then press “+ Add to doc” on the response. Screenshots are added straight away.'
              : 'No steps. Resume recording to add some.'}
          </div>
        )}
        {doc.steps.map((step, i) => (
          <div key={step.id}>
            {dropIndex === i && dragId && <div className="drop-line" />}
            <StepCard
              docId={docId}
              step={step}
              index={i}
              total={doc.steps.length}
              expandAll={expandAll}
              dragging={dragId === step.id}
              onDragStart={() => setDragId(step.id)}
              onDragEnd={() => {
                setDragId(null);
                setDropIndex(null);
              }}
              onDragOverCard={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropIndex(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
              }}
            />
          </div>
        ))}
        {dropIndex === doc.steps.length && dragId && <div className="drop-line" />}
        <div ref={listEnd} />
      </div>
    </div>
  );
}

const STATUSES = [
  { id: 'untested', label: 'Not checked', short: '–' },
  { id: 'pass', label: 'Pass', short: '✓' },
  { id: 'fail', label: 'Fail', short: '✕' },
];

function StepCard({ docId, step, index, total, expandAll, dragging, onDragStart, onDragEnd, onDragOverCard }) {
  const docCall = useStore((s) => s.docCall);
  const openTab = useStore((s) => s.openTab);
  const showToast = useStore((s) => s.showToast);
  const requestExists = useStore((s) => !!(step.requestId && findRequest(s.state, step.requestId)));
  const [grab, setGrab] = useState(false);
  const shot = step.kind === 'shot';

  const update = (patch) => docCall('updateStep', docId, step.id, patch);
  const copy = async (text, what) => {
    await api.copyToClipboard(text);
    showToast(`${what} copied`);
  };
  const copyCurl = async () => {
    await api.copyToClipboard(await api.toCurl(stepAsRequest(step)));
    showToast(step.request.bodyTruncated ? 'cURL copied (the body was cut short when recorded)' : 'cURL copied');
  };

  return (
    <div
      className={`step-card status-${step.status} ${dragging ? 'dragging' : ''}`}
      draggable={grab}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', step.id);
        onDragStart();
      }}
      onDragEnd={() => {
        setGrab(false);
        onDragEnd();
      }}
      onDragOver={onDragOverCard}
    >
      <div className="step-top">
        <span
          className="step-grip"
          title="Drag to reorder"
          onMouseDown={() => setGrab(true)}
          onMouseUp={() => setGrab(false)}
        >
          <IconGrip width={14} height={14} />
        </span>
        <span className="step-num">{index + 1}</span>
        <EditableText className="step-title" value={step.title} onSave={(title) => update({ title })} placeholder="Step title" />
        {step.source === 'ai' && <span className="step-chip" title="Sent by Claude through MCP">Claude</span>}
        <div className="grow" />
        <div className="status-toggle" role="radiogroup" aria-label="Result">
          {STATUSES.map((s) => (
            <button
              key={s.id}
              className={`status-opt ${s.id} ${step.status === s.id ? 'active' : ''}`}
              title={s.label}
              aria-pressed={step.status === s.id}
              onClick={() => update({ status: s.id })}
            >
              {s.short} {s.id !== 'untested' && s.label}
            </button>
          ))}
        </div>
        <Dropdown
          align="right"
          trigger={(open) => (
            <button className="icon-btn" onClick={open} title="Step actions">
              <IconMore width={13} height={13} />
            </button>
          )}
        >
          {shot ? (
            <>
              <Item onClick={() => api.shotOpen(step.shot.file)}>Open image</Item>
              <Item onClick={() => api.shotCopy(step.shot.file).then((ok) => showToast(ok ? 'Image copied' : 'Screenshot file is missing'))}>Copy image</Item>
            </>
          ) : (
            <>
              {requestExists && <Item onClick={() => openTab(step.requestId)}>Open the request</Item>}
              <Item onClick={() => copy(step.request.url, 'URL')}>Copy URL</Item>
              <Item onClick={copyCurl}>Copy as cURL</Item>
            </>
          )}
          {index > 0 && <Item onClick={() => docCall('moveStep', docId, step.id, index - 1)}>Move up</Item>}
          {index < total - 1 && <Item onClick={() => docCall('moveStep', docId, step.id, index + 1)}>Move down</Item>}
          <Separator />
          <Item danger icon={<IconTrash width={12} height={12} />} onClick={() => docCall('deleteStep', docId, step.id)}>
            Remove step
          </Item>
        </Dropdown>
      </div>

      {shot ? (
        <div className="step-line step-meta">
          <span className="step-chip"><IconCamera width={11} height={11} /> Screenshot</span>
          {step.shot.source && <span>{step.shot.source}</span>}
          {step.shot.width && <span>{step.shot.width} × {step.shot.height}</span>}
          <span title={new Date(step.at).toLocaleString()}>{relativeTime(step.at)}</span>
        </div>
      ) : (
        <RequestLines step={step} onCopyUrl={() => copy(step.request.url, 'URL')} onCopyCurl={copyCurl} />
      )}

      <div className="step-notes">
        <label>
          <span>Expected</span>
          <EditableText value={step.expected} onSave={(expected) => update({ expected })} placeholder="What should happen" />
        </label>
        <label>
          <span>Note</span>
          <EditableText multiline value={step.note} onSave={(note) => update({ note })} placeholder="What this step shows, anything odd you noticed" />
        </label>
      </div>

      {shot ? (
        <button className="step-shot" title="Open full size" onClick={() => api.shotOpen(step.shot.file)}>
          <img src={`hitnrun-shot://shots/${step.shot.file}`} alt={step.title} loading="lazy" />
        </button>
      ) : (
        <RequestSections step={step} expandAll={expandAll} />
      )}
    </div>
  );
}

/** Method, URL and the result line of a request step. */
function RequestLines({ step, onCopyUrl, onCopyCurl }) {
  const r = step.response;
  return (
    <>
      <div className="step-line">
        <span className={`method-badge ${METHOD_COLORS[step.request.method] || ''}`}>{step.request.method}</span>
        <code className="step-url" title={step.request.url}>{step.request.url}</code>
        <button className="icon-btn" title="Copy URL" onClick={onCopyUrl}>
          <IconCopy width={12} height={12} />
        </button>
        <button className="icon-btn step-curl" title="Copy as cURL" onClick={onCopyCurl}>
          cURL
        </button>
      </div>
      <div className="step-line step-meta">
        {r ? (
          <>
            <span className={statusClass(r.status)}>
              <b>{r.status}</b> {r.statusText}
            </span>
            <span>{prettyTime(r.timeMs)}</span>
            <span>{prettyBytes(r.size)}</span>
          </>
        ) : (
          <span style={{ color: 'var(--error)' }}>Failed — {step.error}</span>
        )}
        {step.environment && <span>env: {step.environment}</span>}
        <span title={new Date(step.at).toLocaleString()}>{relativeTime(step.at)}</span>
        {step.tests?.length > 0 && (
          <span>
            tests {step.tests.filter((t) => t.passed).length}/{step.tests.length}
          </span>
        )}
      </div>
    </>
  );
}

/** The collapsible headers, bodies and tests of a request step. */
function RequestSections({ step, expandAll }) {
  const r = step.response;
  return (
    <>
      <Section title="Request headers" count={step.request.headers.length} forceOpen={expandAll}>
        <HeaderTable pairs={step.request.headers} />
      </Section>
      {step.request.body != null && step.request.body !== '' && (
        <Section title="Request body" meta={prettyBytes(step.request.body.length)} forceOpen={expandAll} copyText={step.request.body}>
          <Body text={step.request.body} contentType={step.request.bodyContentType} truncated={step.request.bodyTruncated} />
        </Section>
      )}
      {r && (
        <Section title="Response headers" count={r.headers.length} forceOpen={expandAll}>
          <HeaderTable pairs={r.headers} />
        </Section>
      )}
      {r && (
        <Section title="Response body" meta={prettyBytes(r.size)} forceOpen={expandAll} copyText={r.body}>
          {r.binary ? (
            <div className="dim" style={{ padding: 10 }}>Binary response ({r.contentType || 'unknown type'}) — not stored.</div>
          ) : r.body ? (
            <Body text={r.body} contentType={r.contentType} truncated={r.truncated} />
          ) : (
            <div className="dim" style={{ padding: 10 }}>Empty body.</div>
          )}
        </Section>
      )}
      {step.tests?.length > 0 && (
        <Section title="Tests" count={step.tests.length} forceOpen={expandAll}>
          <ul className="step-tests">
            {step.tests.map((t, i) => (
              <li key={i} className={t.passed ? 'doc-pass' : 'doc-fail'}>
                {t.passed ? '✓' : '✕'} {t.name}
                {t.error && <span className="dim"> — {t.error}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// Headers curl works out itself; copying them would pin stale values.
const SKIP_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding']);

/** A recorded step as a request model, for cURL: exactly what was sent. */
function stepAsRequest(step) {
  const sent = step.request;
  const headers = (sent.headers || [])
    .map((h) => (Array.isArray(h) ? { key: h[0], value: h[1] } : { key: h?.key, value: h?.value }))
    .filter((h) => h.key && !SKIP_HEADERS.has(String(h.key).toLowerCase()));
  const hasBody = sent.body != null && sent.body !== '';
  return {
    method: sent.method,
    url: sent.url,
    headers,
    body: hasBody ? { mode: 'raw', raw: sent.body, rawType: /json/i.test(sent.bodyContentType || '') ? 'json' : 'text' } : { mode: 'none' },
  };
}

/** Collapsed by default. Content is only rendered once opened, so big bodies cost nothing until needed. */
function Section({ title, count, meta, forceOpen, copyText, children }) {
  const [open, setOpen] = useState(false);
  const showToast = useStore((s) => s.showToast);
  useEffect(() => {
    if (forceOpen !== null && forceOpen !== undefined) setOpen(forceOpen);
  }, [forceOpen]);

  return (
    <div className={`step-section ${open ? 'open' : ''}`}>
      <div
        className="step-section-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(!open))}
      >
        <IconChevronDown width={12} height={12} className="caret" />
        <span>{title}</span>
        {count != null && <span className="count-pill">{count}</span>}
        {meta && <span className="dim" style={{ fontSize: 11 }}>{meta}</span>}
        <div className="grow" />
        {open && copyText && (
          <button
            className="icon-btn"
            title="Copy"
            onClick={(e) => {
              e.stopPropagation();
              api.copyToClipboard(copyText);
              showToast(`${title} copied`);
            }}
          >
            <IconCopy width={12} height={12} />
          </button>
        )}
      </div>
      {open && <div className="step-section-body">{children}</div>}
    </div>
  );
}

function HeaderTable({ pairs }) {
  if (!pairs?.length) return <div className="dim" style={{ padding: 10 }}>(none)</div>;
  return (
    <table className="kv-table">
      <tbody>
        {pairs.map(([k, v], i) => (
          <tr key={i}>
            <td>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body({ text, contentType, truncated }) {
  let shown = text;
  if (/json/i.test(contentType || '') || /^\s*[[{]/.test(text)) {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch { /* show as is */ }
  }
  return (
    <>
      <pre className="step-body">{shown}</pre>
      {truncated && <div className="dim" style={{ padding: '0 10px 8px', fontSize: 11 }}>Truncated — the body was larger than the 2 MB recording limit.</div>}
    </>
  );
}

/**
 * Text that edits in place and saves itself. While focused it ignores incoming
 * updates, so a refetch after another change can't eat what you're typing.
 */
function EditableText({ value, onSave, placeholder, multiline = false, className = '' }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  const timer = useRef(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!focused) setDraft(value ?? '');
  }, [value, focused]);

  // Grow a textarea to fit what's in it.
  useEffect(() => {
    if (multiline && ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${ref.current.scrollHeight + 2}px`;
    }
  }, [draft, multiline]);

  const change = (text) => {
    setDraft(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSave(text), 400);
  };
  const flush = () => {
    clearTimeout(timer.current);
    if (draft !== (value ?? '')) onSave(draft);
  };

  const props = {
    ref,
    className: `editable ${className}`,
    value: draft,
    placeholder,
    spellCheck: multiline,
    onChange: (e) => change(e.target.value),
    onFocus: () => setFocused(true),
    onBlur: () => {
      flush();
      setFocused(false);
    },
  };
  return multiline ? (
    <textarea rows={1} {...props} />
  ) : (
    <input {...props} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  );
}

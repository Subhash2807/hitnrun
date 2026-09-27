import { useEffect, useState } from 'react';
import { useStore, api } from '../store.js';
// eslint-disable-next-line no-unused-vars
import KeyValueEditor from './KeyValueEditor.jsx';
import { IconClose } from './Icons.jsx';
import { relativeTime } from '../lib/format.js';

export default function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;

  return (
    <Shell>
      {modal.type === 'environment' && <EnvironmentModal id={modal.id} />}
      {modal.type === 'globals' && <GlobalsModal />}
      {modal.type === 'newCollection' && <TextPrompt title="New collection" label="Name" initial="New Collection" method="createCollection" />}
      {modal.type === 'renameCollection' && <RenameCollection id={modal.id} initial={modal.name} />}
      {modal.type === 'renameRequest' && <RenameRequest id={modal.id} initial={modal.name} />}
      {modal.type === 'renameFolder' && <RenameFolder id={modal.id} initial={modal.name} />}
      {modal.type === 'quickSource' && <QuickSourceModal envId={modal.envId} />}
      {modal.type === 'confirm' && <Confirm modal={modal} />}
      {modal.type === 'settings' && <SettingsModal />}
      {modal.type === 'promote' && <PromoteModal modal={modal} />}
      {modal.type === 'aiSetup' && <AiSetupModal />}
      {modal.type === 'startRecording' && <StartRecordingModal docId={modal.docId} />}
      {modal.type === 'renameDoc' && <RenameDoc id={modal.id} initial={modal.name} />}
      {modal.type === 'exportDoc' && <ExportDocModal id={modal.id} format={modal.format} />}
      {modal.type === 'screenshot' && <ScreenshotModal />}
    </Shell>
  );
}

function Shell({ children }) {
  const closeModal = useStore((s) => s.closeModal);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && closeModal();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeModal]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
      {children}
    </div>
  );
}

function Head({ title }) {
  const closeModal = useStore((s) => s.closeModal);
  return (
    <div className="modal-head">
      <h2>{title}</h2>
      <button className="icon-btn" onClick={closeModal}>
        <IconClose />
      </button>
    </div>
  );
}

/* -------------------------------------------------------- environments */

function EnvironmentModal({ id }) {
  const state = useStore((s) => s.state);
  const call = useStore((s) => s.call);
  const closeModal = useStore((s) => s.closeModal);
  const [selected, setSelected] = useState(id);

  const env = state.environments.find((e) => e.id === selected);

  return (
    <div className="modal">
      <Head title="Environments" />
      <div className="modal-body" style={{ padding: 0 }}>
        <div className="env-layout">
          <div className="env-list">
            {state.environments.map((e) => (
              <div
                key={e.id}
                className={`env-item ${e.id === selected ? 'active' : ''}`}
                onClick={() => setSelected(e.id)}
              >
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
                {state.activeEnvironmentId === e.id && <span className="count-pill">active</span>}
              </div>
            ))}
            <div
              className="env-item dim"
              onClick={async () => {
                const created = await call('createEnvironment', 'New Environment', []);
                setSelected(created.id);
              }}
            >
              + New environment
            </div>
          </div>

          <div className="env-detail">
            {!env ? (
              <div className="empty-note">Select an environment.</div>
            ) : (
              <>
                <div className="section-head">
                  <input
                    className="text-input"
                    style={{ maxWidth: 280, fontFamily: 'var(--sans)' }}
                    value={env.name}
                    onChange={(e) => call('updateEnvironment', env.id, { name: e.target.value })}
                  />
                  <div className="section-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => call('setActiveEnvironment', state.activeEnvironmentId === env.id ? null : env.id)}
                    >
                      {state.activeEnvironmentId === env.id ? 'Deactivate' : 'Set active'}
                    </button>
                    {!env.builtin && (
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          await call('deleteEnvironment', env.id);
                          setSelected(null);
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                  <KeyValueEditor
                    auto
                    title="Variables"
                    rows={env.values || []}
                    onChange={(values) => call('updateEnvironment', env.id, { values })}
                    keyPlaceholder="Variable"
                    valuePlaceholder="Value"
                    description={false}
                    emptyNote={<>Reference these anywhere with <code className="mono">{'{{name}}'}</code>.</>}
                  />
                  <SourceCurlPanel env={env} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Done</button>
      </div>
    </div>
  );
}

/**
 * The source cURL for an environment: paste a fresh one from browser DevTools
 * and every request in the workspace can be re-pointed at it.
 */
function SourceCurlPanel({ env }) {
  const setSource = useStore((s) => s.setSource);
  const showToast = useStore((s) => s.showToast);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const source = env.source;

  const save = async () => {
    setBusy(true);
    const result = await setSource(env.id, text);
    setBusy(false);
    if (result.ok) {
      setEditing(false);
      setText('');
    }
  };

  const pasteFromClipboard = async () => {
    const clip = await api.readClipboard();
    if (!clip?.trim()) return showToast('Clipboard is empty');
    setText(clip);
    setEditing(true);
  };

  return (
    <div className="source-panel">
      <div className="section-head" style={{ padding: '0 0 8px' }}>
        <span className="section-title">Source cURL</span>
        <div className="section-actions">
          {!editing && (
            <>
              <button className="link-btn" onClick={pasteFromClipboard}>
                Paste from clipboard
              </button>
              <button
                className="link-btn"
                onClick={() => {
                  setText(source?.curl || '');
                  setEditing(true);
                }}
              >
                {source ? 'Replace' : 'Add'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="hint" style={{ padding: '0 0 8px' }}>
        Copy a request from your browser's Network tab as cURL and paste it here. Requests can then pull
        their headers and host from it, so an expired session is one click to refresh.
      </div>

      {source && !editing && (
        <div className="source-summary">
          <span className="source-origin">{source.origin}</span>
          <span className="dim">{source.headers.length} headers</span>
          <span className="dim">captured {relativeTime(source.capturedAt)}</span>
          <div className="grow" />
          <button
            className="link-btn"
            style={{ color: 'var(--error)' }}
            onClick={() => setSource(env.id, '')}
          >
            Clear
          </button>
        </div>
      )}

      {source && !editing && (
        <div className="header-pills">
          {source.headers.map((h, i) => (
            <span key={i} className="header-pill" title={h.value}>
              {h.key}
            </span>
          ))}
        </div>
      )}

      {!source && !editing && (
        <div className="dim" style={{ fontSize: 12 }}>
          No source cURL set for this environment.
        </div>
      )}

      {editing && (
        <>
          <textarea
            className="source-textarea"
            autoFocus
            spellCheck={false}
            value={text}
            placeholder={"curl 'https://www.example.com/api/v2/search?q=x' \\\n  -H 'cookie: SID=…' \\\n  -H 'authorization: Bearer …'"}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
            <button
              className="btn btn-sm"
              onClick={() => {
                setEditing(false);
                setText('');
              }}
            >
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={save}>
              {busy ? <span className="spinner" /> : 'Save source'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One-step source cURL: paste, save, done. Targets the given environment, else
 * the active one, else the built-in Global — and activates it so the sync chips
 * appear straight away.
 */
function QuickSourceModal({ envId }) {
  const state = useStore((s) => s.state);
  const call = useStore((s) => s.call);
  const setSource = useStore((s) => s.setSource);
  const closeModal = useStore((s) => s.closeModal);
  const envs = state.environments;
  const initial =
    envs.find((e) => e.id === envId) ||
    envs.find((e) => e.id === state.activeEnvironmentId) ||
    envs.find((e) => e.builtin) ||
    envs[0];
  const [targetId, setTargetId] = useState(initial?.id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const target = envs.find((e) => e.id === targetId);

  // Most of the time the cURL was just copied from DevTools — start with it.
  useEffect(() => {
    api.readClipboard().then((clip) => {
      if (/^\s*curl(\.exe)?[\s\n]/i.test(clip || '')) setText((t) => t || clip);
    });
  }, []);

  const save = async () => {
    setBusy(true);
    const result = await setSource(targetId, text);
    if (result.ok && state.activeEnvironmentId !== targetId) await call('setActiveEnvironment', targetId);
    setBusy(false);
    if (result.ok) closeModal();
  };

  return (
    <div className="modal" style={{ maxWidth: 620 }}>
      <Head title="Source cURL" />
      <div className="modal-body" style={{ padding: 16 }}>
        <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <span className="section-title">Environment</span>
          <select className="text-input" style={{ maxWidth: 220 }} value={targetId || ''} onChange={(e) => setTargetId(e.target.value)}>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {target?.source && (
            <span className="dim" style={{ fontSize: 12 }}>
              current: {target.source.origin} · {target.source.headers.length} headers
            </span>
          )}
        </div>
        <textarea
          className="source-textarea"
          autoFocus
          spellCheck={false}
          value={text}
          placeholder={"curl 'https://www.example.com/api/v2/search?q=x' \\\n  -H 'cookie: SID=…' \\\n  -H 'authorization: Bearer …'"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && save()}
        />
        <div className="hint" style={{ padding: '8px 0 0' }}>
          Copy a request from your browser's Network tab as cURL. Ctrl+Enter saves.
        </div>
      </div>
      <div className="modal-foot">
        {target?.source && (
          <button
            className="btn"
            style={{ marginRight: 'auto', color: 'var(--error)' }}
            onClick={async () => {
              await setSource(targetId, '');
              closeModal();
            }}
          >
            Clear source
          </button>
        )}
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !text.trim() || !targetId} onClick={save}>
          {busy ? <span className="spinner" /> : 'Save'}
        </button>
      </div>
    </div>
  );
}

function GlobalsModal() {
  const globals = useStore((s) => s.state.globals);
  const call = useStore((s) => s.call);
  const closeModal = useStore((s) => s.closeModal);

  return (
    <div className="modal" style={{ maxWidth: 640 }}>
      <Head title="Global variables" />
      <div className="modal-body" style={{ display: 'flex', minHeight: 300 }}>
        <KeyValueEditor
          title="Globals"
          rows={globals || []}
          onChange={(values) => call('setGlobals', values)}
          description={false}
          keyPlaceholder="Variable"
          emptyNote="Globals apply to every request, whichever environment is active."
        />
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Done</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- prompts */

function TextPrompt({ title, label, initial, method }) {
  const call = useStore((s) => s.call);
  const closeModal = useStore((s) => s.closeModal);
  const [value, setValue] = useState(initial);

  const submit = async () => {
    if (value.trim()) await call(method, value.trim());
    closeModal();
  };

  return (
    <div className="modal" style={{ maxWidth: 420 }}>
      <Head title={title} />
      <div className="modal-body" style={{ padding: 16 }}>
        <label className="section-title" style={{ display: 'block', marginBottom: 6 }}>{label}</label>
        <input
          className="text-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" onClick={submit}>Create</button>
      </div>
    </div>
  );
}

function RenameCollection({ id, initial }) {
  const call = useStore((s) => s.call);
  const closeModal = useStore((s) => s.closeModal);
  const [value, setValue] = useState(initial);

  const submit = async () => {
    if (value.trim()) await call('updateCollection', id, { name: value.trim() });
    closeModal();
  };

  return <SimpleRename title="Rename collection" value={value} setValue={setValue} submit={submit} close={closeModal} />;
}

function RenameFolder({ id, initial }) {
  const call = useStore((s) => s.call);
  const closeModal = useStore((s) => s.closeModal);
  const [value, setValue] = useState(initial);

  const submit = async () => {
    if (value.trim()) await call('updateFolder', id, { name: value.trim() });
    closeModal();
  };

  return <SimpleRename title="Rename folder" value={value} setValue={setValue} submit={submit} close={closeModal} />;
}

function RenameRequest({ id, initial }) {
  const patchRequest = useStore((s) => s.patchRequest);
  const closeModal = useStore((s) => s.closeModal);
  const [value, setValue] = useState(initial);

  const submit = () => {
    if (value.trim()) patchRequest(id, { name: value.trim() });
    closeModal();
  };

  return <SimpleRename title="Rename request" value={value} setValue={setValue} submit={submit} close={closeModal} />;
}

/* ------------------------------------------------------------- test docs */

const MODE_TEXT = {
  auto: 'Every request you send is added as a step. Delete the ones you don’t need when you review.',
  manual: 'Nothing is added until you press “+ Add to doc” on a response.',
};

function StartRecordingModal({ docId }) {
  const docs = useStore((s) => s.docs);
  const startRecording = useStore((s) => s.startRecording);
  const closeModal = useStore((s) => s.closeModal);
  const resuming = docs.find((d) => d.id === docId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState('auto');

  const submit = async () => {
    await startRecording({ name: name.trim(), description, mode, docId: resuming?.id });
    closeModal();
  };

  return (
    <div className="modal" style={{ maxWidth: 480 }}>
      <Head title={resuming ? `Resume recording “${resuming.name}”` : 'Start documenting'} />
      <div className="modal-body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!resuming && (
          <>
            <label className="field-label">
              Feature or test name
              <input
                className="text-input"
                autoFocus
                placeholder="e.g. Login flow – OTP"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>
            <label className="field-label">
              <span>
                Summary <span style={{ color: 'var(--text-faint)' }}>(optional — you can write it later)</span>
              </span>
              <textarea
                className="text-input"
                rows={2}
                placeholder="What is being tested, and why"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </>
        )}
        <div className="field-label">
          Recording mode
          <div className="mode-choice">
            {['auto', 'manual'].map((m) => (
              <button key={m} className={`mode-option ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
                <b>{m === 'auto' ? 'Auto' : 'Manual'}</b>
                <span>{MODE_TEXT[m]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" onClick={submit}>
          <span className="rec-dot" /> {resuming ? 'Resume' : 'Start recording'}
        </button>
      </div>
    </div>
  );
}

function RenameDoc({ id, initial }) {
  const closeModal = useStore((s) => s.closeModal);
  const [value, setValue] = useState(initial);
  const submit = async () => {
    if (value.trim()) await api.docs('update', id, { name: value.trim() });
    closeModal();
  };
  return <SimpleRename title="Rename doc" value={value} setValue={setValue} submit={submit} close={closeModal} />;
}

export const DOC_FORMATS = [
  { id: 'markdown', label: 'Markdown (.md)', hint: 'For GitHub, Jira, Confluence — sections stay collapsed' },
  { id: 'html', label: 'HTML page (.html)', hint: 'One file that opens in any browser, collapsible sections' },
  { id: 'pdf', label: 'PDF (.pdf)', hint: 'Printable, everything expanded' },
  { id: 'postman', label: 'Postman collection (.json)', hint: 'Re-run the steps in order, in hitnrun or Postman' },
];

function ExportDocModal({ id, format: initialFormat }) {
  const exportDoc = useStore((s) => s.exportDoc);
  const closeModal = useStore((s) => s.closeModal);
  const doc = useStore((s) => s.docs.find((d) => d.id === id));
  const [format, setFormat] = useState(initialFormat || 'markdown');
  const [mask, setMask] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const out = await exportDoc(id, format, mask);
    setBusy(false);
    if (!out?.canceled) closeModal();
  };

  return (
    <div className="modal" style={{ maxWidth: 480 }}>
      <Head title={`Download “${doc?.name ?? 'doc'}”`} />
      <div className="modal-body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="mode-choice">
          {DOC_FORMATS.map((f) => (
            <button key={f.id} className={`mode-option ${format === f.id ? 'active' : ''}`} onClick={() => setFormat(f.id)}>
              <b>{f.label}</b>
              <span>{f.hint}</span>
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Mask secrets
            <div className="dim" style={{ fontSize: 11.5 }}>
              Hides Authorization, cookies, API keys, tokens and password fields (keeps the last 4 characters).
            </div>
          </span>
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? <span className="spinner" /> : 'Download'}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- screenshots */

/**
 * Pick what to capture: each screen and open window, with a live preview.
 * hitnrun steps out of the way while a screen is captured.
 */
function ScreenshotModal() {
  const closeModal = useStore((s) => s.closeModal);
  const recording = useStore((s) => s.recording);
  const takeShot = useStore((s) => s.takeShot);
  const pasteShot = useStore((s) => s.pasteShot);
  const [list, setList] = useState(null); // { ok, sources } | { ok: false, permission }
  const [busy, setBusy] = useState(false);
  const isMac = navigator.userAgent.includes('Mac');

  const load = () => {
    setList(null);
    api.shotSources().then(setList, (err) => setList({ ok: false, error: err.message }));
  };
  useEffect(load, []);

  if (!recording) {
    return (
      <div className="modal" style={{ maxWidth: 420 }}>
        <Head title="Screenshot" />
        <div className="modal-body" style={{ padding: 16 }}>Start a recording first. Screenshots are added to the doc being recorded.</div>
      </div>
    );
  }

  const pick = async (id) => {
    setBusy(true);
    closeModal(); // out of the picture before it's taken
    await takeShot(id);
  };
  const paste = async () => {
    const out = await pasteShot();
    if (out.ok) closeModal();
  };

  const screens = list?.sources?.filter((s) => s.kind === 'screen') || [];
  const windows = list?.sources?.filter((s) => s.kind === 'window') || [];
  const Tile = ({ s }) => (
    <button className="shot-tile" disabled={busy} onClick={() => pick(s.id)} title={s.name}>
      <img src={s.thumbnail} alt="" />
      <span className="ellipsis">{s.name}</span>
    </button>
  );

  return (
    <div className="modal shot-modal">
      <Head title={`Add a screenshot to “${recording.name}”`} />
      <div className="modal-body" style={{ padding: 16 }}>
        {!list && <div className="dim" style={{ padding: 30, textAlign: 'center' }}><span className="spinner" /> Looking for screens and windows…</div>}
        {list && !list.ok && list.permission && (
          <div className="shot-permission">
            <b>hitnrun needs permission to take screenshots.</b>
            <p>
              Open <b>System Settings → Privacy &amp; Security → Screen Recording</b> and turn on <b>hitnrun</b>. macOS
              may ask you to quit and reopen hitnrun afterwards.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary" onClick={() => api.shotSettings()}>Open Screen Recording settings</button>
              <button className="btn" onClick={load}>Check again</button>
            </div>
          </div>
        )}
        {list && !list.ok && !list.permission && <div style={{ color: 'var(--error)' }}>{list.error || 'Could not list screens.'}</div>}
        {list?.ok && (
          <>
            <div className="shot-group">Screens</div>
            <div className="shot-grid">{screens.map((s) => <Tile key={s.id} s={s} />)}</div>
            {windows.length > 0 && <div className="shot-group">Windows</div>}
            <div className="shot-grid">{windows.map((s) => <Tile key={s.id} s={s} />)}</div>
          </>
        )}
      </div>
      <div className="modal-foot">
        <span className="dim" style={{ fontSize: 11.5, marginRight: 'auto' }}>
          Tip: {isMac ? 'Cmd' : 'Ctrl'}+Shift+S captures the screen you're on, from any app.
        </span>
        <button className="btn" onClick={paste} title="Add an image you copied, e.g. with the system snipping tool">Paste image</button>
        <button className="btn" onClick={closeModal}>Cancel</button>
      </div>
    </div>
  );
}

function SimpleRename({ title, value, setValue, submit, close }) {
  return (
    <div className="modal" style={{ maxWidth: 420 }}>
      <Head title={title} />
      <div className="modal-body" style={{ padding: 16 }}>
        <input
          className="text-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" onClick={submit}>Rename</button>
      </div>
    </div>
  );
}

function Confirm({ modal }) {
  const closeModal = useStore((s) => s.closeModal);
  return (
    <div className="modal" style={{ maxWidth: 420 }}>
      <Head title={modal.title} />
      <div className="modal-body" style={{ padding: 16, lineHeight: 1.7 }}>{modal.message}</div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={() => {
            modal.onConfirm?.();
            closeModal();
          }}
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- ai promote */

/** The only path from the AI workspace into the user's. Always user-initiated. */
function PromoteModal({ modal }) {
  const collections = useStore((s) => s.state.collections);
  const promoteFromAi = useStore((s) => s.promoteFromAi);
  const closeModal = useStore((s) => s.closeModal);
  const [target, setTarget] = useState(collections[0]?.id || '');

  return (
    <div className="modal" style={{ maxWidth: 460 }}>
      <Head title="Add to my workspace" />
      <div className="modal-body" style={{ padding: 16, lineHeight: 1.8 }}>
        Copy <strong>{modal.name}</strong> from the AI workspace into your own.
        <br />
        <span className="dim">The AI's copy stays where it is; this makes an independent duplicate.</span>
        <div style={{ marginTop: 14 }}>
          <label className="section-title" style={{ display: 'block', marginBottom: 6 }}>Add to collection</label>
          <select className="select" style={{ width: '100%' }} value={target} onChange={(e) => setTarget(e.target.value)}>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={async () => {
            await promoteFromAi(modal.nodeId, target);
            closeModal();
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- ai setup */

function AiSetupModal() {
  const closeModal = useStore((s) => s.closeModal);
  const showToast = useStore((s) => s.showToast);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    api.aiSetupInfo().then(setInfo);
  }, []);

  const copy = (text, label) => {
    api.copyToClipboard(text);
    showToast(`${label} copied`);
  };

  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState(null);
  const connect = async () => {
    setConnecting(true);
    setResult(null);
    try {
      setResult(await api.aiConnectClaudeCode());
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="modal" style={{ maxWidth: 680 }}>
      <Head title="Connect an AI assistant" />
      <div className="modal-body" style={{ padding: 16, lineHeight: 1.8 }}>
        {!info ? (
          <span className="dim">Loading…</span>
        ) : (
          <>
            <p>
              An AI assistant can create and run requests in this app. It works in its own separate
              workspace — it <strong>cannot change or delete your requests</strong>, and anything it builds
              only reaches your collections if you add it yourself.
            </p>

            <div className="setup-step">
              <div className="setup-num">1</div>
              <div>
                <strong>Claude Code</strong> — connect it in one click:
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 2px' }}>
                  <button className="btn btn-primary btn-sm" disabled={connecting} onClick={connect}>
                    {connecting ? 'Connecting…' : 'Connect Claude Code'}
                  </button>
                  {result && (
                    <span style={{ fontSize: 12, color: result.ok ? 'var(--ok)' : 'var(--error)', whiteSpace: 'pre-wrap' }}>
                      {result.message}
                    </span>
                  )}
                </div>
                <span className="dim" style={{ fontSize: 12 }}>Or run this once, in a terminal on <em>this</em> machine:</span>
                <div className="code-row">
                  <code className="mono">{info.claudeCodeCommand}</code>
                  <button className="btn btn-sm" onClick={() => copy(info.claudeCodeCommand, 'Command')}>Copy</button>
                </div>
                <details style={{ marginTop: 6 }}>
                  <summary className="dim" style={{ cursor: 'pointer', fontSize: 11.5 }}>
                    Using PowerShell? Use this instead
                  </summary>
                  <div className="code-row">
                    <code className="mono">{info.powershellCommand}</code>
                    <button className="btn btn-sm" onClick={() => copy(info.powershellCommand, 'Command')}>Copy</button>
                  </div>
                  <span className="dim" style={{ fontSize: 11 }}>
                    PowerShell consumes the <code className="mono">--</code> separator before the CLI sees it.
                  </span>
                </details>
              </div>
            </div>

            <div className="setup-step">
              <div className="setup-num">2</div>
              <div>
                <strong>Claude Desktop</strong> — or add this to its MCP config file:
                <div className="code-row">
                  <pre className="mono setup-json">{info.configJson}</pre>
                  <button className="btn btn-sm" onClick={() => copy(info.configJson, 'Config')}>Copy</button>
                </div>
              </div>
            </div>

            <div className="setup-step">
              <div className="setup-num">3</div>
              <div>
                Ask it something, for example:
                <br />
                <em className="dim">"Check hitnrun is running, then create a request for https://httpbin.org/get and send it."</em>
              </div>
            </div>

            <p className="dim" style={{ fontSize: 12 }}>
              Keep this app open — the assistant talks to it on 127.0.0.1:{info.port}, reachable only from
              this machine, so Claude Code must run here too.
              {info.packaged
                ? ' No separate Node install is needed; the app provides its own runtime.'
                : ' (Running from source, so this uses the Node on your PATH.)'}
              {info.hasToken && ' Your control token is included above.'}
            </p>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Done</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ settings */

function SettingsModal() {
  const state = useStore((s) => s.state);
  const call = useStore((s) => s.call);
  const closeModal = useStore((s) => s.closeModal);
  const control = useStore((s) => s.control);
  const setControl = (c) => useStore.setState({ control: c });
  const showToast = useStore((s) => s.showToast);
  const settings = state.settings;
  const cs = settings.controlServer || {};

  const set = (patch) => call('patchSettings', patch);

  const restartControl = async (patch) => {
    const next = await api.controlRestart(patch);
    setControl(next);
    showToast(next.running ? `Control server listening on ${next.port}` : next.error || 'Control server stopped');
  };

  return (
    <div className="modal" style={{ maxWidth: 620 }}>
      <Head title="Settings" />
      <div className="modal-body">
        <div className="field-grid" style={{ maxWidth: 'none' }}>
          <label>Theme</label>
          <select className="select" value={settings.theme} onChange={(e) => set({ theme: e.target.value })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>

          <label>Request timeout (ms)</label>
          <input
            className="text-input"
            type="number"
            min="0"
            value={settings.timeout ?? 0}
            onChange={(e) => set({ timeout: Number(e.target.value) })}
          />

          <label>Follow redirects</label>
          <div>
            <input
              type="checkbox"
              checked={settings.followRedirects !== false}
              onChange={(e) => set({ followRedirects: e.target.checked })}
            />
          </div>

          <label>Max redirects</label>
          <input
            className="text-input"
            type="number"
            min="0"
            value={settings.maxRedirects ?? 10}
            onChange={(e) => set({ maxRedirects: Number(e.target.value) })}
          />

          <label>Verify TLS certificates</label>
          <div>
            <input type="checkbox" checked={settings.sslVerify !== false} onChange={(e) => set({ sslVerify: e.target.checked })} />
          </div>

          <label>History limit</label>
          <input
            className="text-input"
            type="number"
            min="10"
            value={settings.historyLimit ?? 500}
            onChange={(e) => set({ historyLimit: Number(e.target.value) })}
          />
        </div>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 8 }}>
          <div className="section-head">
            <span className="section-title">Agent control server</span>
            <span className={`badge ${control.running ? 'live' : ''}`}>
              <span className="dot" />
              {control.running ? `127.0.0.1:${control.port}` : 'stopped'}
            </span>
          </div>
          <div className="hint" style={{ lineHeight: 1.8 }}>
            Lets Claude Code or any terminal agent create, edit and run requests in this app.
            <br />
            Bound to 127.0.0.1 only — nothing outside this machine can reach it.
            <br />
            Try: <code className="mono">curl 127.0.0.1:{cs.port || 47600}</code> for the endpoint list.
          </div>
          <div className="field-grid" style={{ maxWidth: 'none', paddingTop: 0 }}>
            <label>Enabled</label>
            <div>
              <input
                type="checkbox"
                checked={cs.enabled !== false}
                onChange={(e) => restartControl({ enabled: e.target.checked })}
              />
            </div>

            <label>Port</label>
            <div className="row">
              <input
                className="text-input"
                type="number"
                style={{ maxWidth: 120 }}
                defaultValue={cs.port ?? 47600}
                onBlur={(e) => restartControl({ port: Number(e.target.value) })}
              />
              <button className="btn btn-sm" onClick={() => restartControl({})}>Restart</button>
            </div>

            <label>Access token</label>
            <div className="row">
              <input
                className="text-input"
                placeholder="optional — leave empty for no token"
                defaultValue={cs.token ?? ''}
                onBlur={(e) => restartControl({ token: e.target.value.trim() || undefined })}
              />
            </div>
          </div>
          {control.error && (
            <div className="error-box" style={{ margin: '0 16px 14px' }}>{control.error}</div>
          )}
        </div>

        <AiGuardrailsSection settings={settings} />
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Done</button>
      </div>
    </div>
  );
}

/**
 * Guardrails apply to AI sessions only. Requests you send yourself are never
 * checked — this is about bounding what a language model can reach.
 */
function AiGuardrailsSection({ settings }) {
  const call = useStore((s) => s.call);
  const showToast = useStore((s) => s.showToast);
  const openModal = useStore((s) => s.openModal);
  const policy = settings.aiPolicy || {};

  const savePolicy = async (patch) => {
    const next = await api.aiSetPolicy({ ...policy, ...patch });
    await useStore.getState().refresh();
    return next;
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <div className="section-head">
        <span className="section-title">AI guardrails</span>
        <button className="link-btn" onClick={() => openModal({ type: 'aiSetup' })}>
          Connect an AI
        </button>
      </div>
      <div className="hint" style={{ lineHeight: 1.8 }}>
        These apply to AI sessions only — never to requests you send yourself.
        <br />
        AI sessions work in a separate workspace and cannot modify your requests.
      </div>

      <div className="field-grid" style={{ maxWidth: 'none', paddingTop: 0 }}>
        <label>Enforce guardrails</label>
        <div>
          <input
            type="checkbox"
            checked={policy.enabled !== false}
            onChange={(e) => savePolicy({ enabled: e.target.checked })}
          />
        </div>

        <label>Blocked methods</label>
        <input
          className="text-input"
          defaultValue={(policy.blockedMethods || []).join(', ')}
          placeholder="DELETE, PUT"
          onBlur={(e) => savePolicy({ blockedMethods: e.target.value })}
        />

        <label>Blocked hosts</label>
        <input
          className="text-input"
          defaultValue={(policy.blockedHosts || []).join(', ')}
          placeholder="api.prod.com, *.internal.company.com"
          onBlur={(e) => savePolicy({ blockedHosts: e.target.value })}
        />

        <label />
        <span className="dim" style={{ fontSize: 11.5 }}>
          Comma separated. <code className="mono">*.prod.com</code> covers subdomains and the bare domain;
          a plain hostname matches only itself. Checked on every redirect hop too.
        </span>

        <label>Session workspaces</label>
        <select
          className="select"
          value={settings.aiSessionMode || 'per-session'}
          onChange={(e) => call('patchSettings', { aiSessionMode: e.target.value })}
        >
          <option value="per-session">One folder per AI session</option>
          <option value="shared">One shared folder for all sessions</option>
        </select>

        <label>Let AI edit my requests</label>
        <div>
          <input
            type="checkbox"
            checked={settings.allowAgentUserWrites === true}
            onChange={(e) => {
              call('patchSettings', { allowAgentUserWrites: e.target.checked });
              if (e.target.checked) showToast('AI can now modify your own requests directly');
            }}
          />
          <span className="dim" style={{ marginLeft: 8, fontSize: 11.5 }}>
            Off by default. Leave it off unless you want an agent editing your workspace in place.
          </span>
        </div>
      </div>
    </div>
  );
}


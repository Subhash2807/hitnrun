import { useEffect, useState } from 'react';
import { useStore, api } from '../store.js';
import KeyValueEditor from './KeyValueEditor.jsx';
import { IconClose } from './Icons.jsx';

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
      {modal.type === 'confirm' && <Confirm modal={modal} />}
      {modal.type === 'settings' && <SettingsModal />}
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
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        await call('deleteEnvironment', env.id);
                        setSelected(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <KeyValueEditor
                  title="Variables"
                  rows={env.values || []}
                  onChange={(values) => call('updateEnvironment', env.id, { values })}
                  keyPlaceholder="Variable"
                  valuePlaceholder="Value"
                  description={false}
                  emptyNote={<>Reference these anywhere with <code className="mono">{'{{name}}'}</code>.</>}
                />
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
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={closeModal}>Done</button>
      </div>
    </div>
  );
}

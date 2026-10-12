import { useEffect, useRef, useState } from 'react';
import { useStore, api, findRequest } from './store.js';
import Sidebar from './components/Sidebar.jsx';
import RequestView from './components/RequestView.jsx';
import Modals from './components/Modals.jsx';
import DocView from './components/DocView.jsx';
import { RecordControl } from './components/DocsPanel.jsx';
import ChatPanel, { ChatToggle } from './components/ChatPanel.jsx';
import JsonWorkbench from './components/JsonView.jsx';
import Dropdown, { Item, Separator } from './components/Dropdown.jsx';
import { IconPlus, IconClose, IconSettings, IconChevronDown, IconSync, IconDoc, IconDownload, IconBraces } from './components/Icons.jsx';
import { METHOD_COLORS } from './lib/format.js';

export default function App() {
  const ready = useStore((s) => s.ready);
  const state = useStore((s) => s.state);
  const init = useStore((s) => s.init);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    init();
  }, [init]);

  const theme = state?.settings?.theme || 'dark';
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // App-level menu accelerators (per-request ones live in RequestView).
  const createRequest = useStore((s) => s.createRequest);
  const openModal = useStore((s) => s.openModal);
  const closeTab = useStore((s) => s.closeTab);
  const cycleTab = useStore((s) => s.cycleTab);

  useEffect(() => {
    return api.onMenuCommand((command) => {
      const store = useStore.getState();
      const ui = store.state?.ui;
      const active = ui?.activeTabId;
      // In the JSON viewer, new / close / next tab / duplicate act on its files.
      if (ui?.view === 'json') {
        if (command === 'request:new') return store.createJsonFile();
        if (command === 'tab:close') return ui.jsonActiveId && store.closeJsonTab(ui.jsonActiveId);
        if (command === 'tab:next') return store.cycleJsonTab(1);
        if (command === 'tab:prev') return store.cycleJsonTab(-1);
        if (command === 'request:duplicate') return ui.jsonActiveId && store.duplicateJsonFile(ui.jsonActiveId);
      }
      if (command === 'request:new') createRequest(store.state?.collections?.[0]?.id);
      else if (command === 'collection:new') openModal({ type: 'newCollection' });
      else if (command === 'collection:import') store.importPostman();
      else if (command === 'chat:toggle') store.toggleChat();
      else if (command === 'view:json') store.toggleView();
      else if (command === 'tab:close' && active) closeTab(active);
      else if (command === 'tab:next') cycleTab(1);
      else if (command === 'tab:prev') cycleTab(-1);
      else if (command === 'update:check') store.checkForUpdates();
      else if (command === 'shot:pick' && store.recording) openModal({ type: 'screenshot' });
    });
  }, [createRequest, openModal, closeTab, cycleTab]);

  // A file dropped anywhere else would make the window navigate to it and
  // replace the app. The JSON viewer takes drops itself before this runs.
  useEffect(() => {
    const block = (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  if (!ready || !state) {
    return (
      <div className="app">
        <div className="response-placeholder" style={{ flex: 1 }}>Loading…</div>
      </div>
    );
  }

  const activeTabId = state.ui.activeTabId;

  return (
    <div className="app">
      <TopBar />
      <div className="body">
        <Sidebar />
        <SidebarResizer />
        <div className="main">
          {state.ui.view === 'json' ? (
            <JsonWorkbench theme={theme} />
          ) : (
            <>
              <TabBar />
              {activeTabId?.startsWith('doc_') ? (
                <DocView key={activeTabId} docId={activeTabId} />
              ) : activeTabId ? (
                // Keyed so switching tabs resets per-request local UI state.
                <RequestView key={activeTabId} requestId={activeTabId} theme={theme} />
              ) : (
                <EmptyState />
              )}
            </>
          )}
        </div>
        {state.ui.chatOpen && <ChatPanel />}
      </div>
      <Modals />
      {toast && <div className="toast">{toast.message}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- top bar */

function TopBar() {
  const state = useStore((s) => s.state);
  const call = useStore((s) => s.call);
  const control = useStore((s) => s.control);
  const openModal = useStore((s) => s.openModal);

  const activeEnv = state.environments.find((e) => e.id === state.activeEnvironmentId);
  const isMac = navigator.userAgent.includes('Mac');

  return (
    <div className="topbar">
      <div className="brand" style={{ paddingLeft: isMac ? 64 : 0 }}>
        <span className="brand-mark">H</span>
        hitnrun
      </div>

      <ViewSwitch />

      <div className="topbar-spacer" />

      <UpdateButton />

      <RecordControl />

      <ChatToggle />

      <span
        className={`badge ${control.running ? 'live' : ''}`}
        title={
          control.running
            ? `Agent control server listening on 127.0.0.1:${control.port}`
            : control.error || 'Agent control server is stopped'
        }
        onClick={() => openModal({ type: 'settings' })}
        style={{ cursor: 'pointer' }}
      >
        <span className="dot" />
        {control.running ? `:${control.port}` : 'no agent port'}
      </span>

      <button
        className={`icon-btn ${activeEnv?.source ? 'source-set' : ''}`}
        title={
          activeEnv?.source
            ? `Source cURL: ${activeEnv.source.origin} — click to replace`
            : 'Set a source cURL'
        }
        onClick={() => openModal({ type: 'quickSource' })}
      >
        <IconSync />
      </button>

      <Dropdown
        align="right"
        trigger={(open) => (
          <button className="env-picker" onClick={open}>
            <span className="grow" style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {activeEnv ? activeEnv.name : 'No environment'}
            </span>
            <IconChevronDown width={12} height={12} className="dim" />
          </button>
        )}
      >
        <Item onClick={() => call('setActiveEnvironment', null)}>No environment</Item>
        {state.environments.length > 0 && <Separator />}
        {state.environments.map((env) => (
          <Item key={env.id} onClick={() => call('setActiveEnvironment', env.id)}>
            {env.id === state.activeEnvironmentId ? '● ' : '   '}
            {env.name}
          </Item>
        ))}
        <Separator />
        <Item onClick={() => openModal({ type: 'environment', id: state.activeEnvironmentId })}>Manage environments</Item>
        <Item onClick={() => openModal({ type: 'globals' })}>Globals</Item>
      </Dropdown>

      <button className="icon-btn" title="Settings" onClick={() => openModal({ type: 'settings' })}>
        <IconSettings />
      </button>
    </div>
  );
}

/** Shown only once a newer version is out. */
function UpdateButton() {
  const update = useStore((s) => s.update);
  const openModal = useStore((s) => s.openModal);
  if (!update?.latest || !['available', 'downloading', 'installing', 'error'].includes(update.status)) return null;
  const busy = update.status === 'downloading' || update.status === 'installing';
  return (
    <button
      className="update-btn"
      title={`hitnrun ${update.latest.version} is available`}
      onClick={() => openModal({ type: 'update' })}
    >
      <IconDownload width={13} height={13} />
      {busy
        ? update.status === 'installing' ? 'Installing…' : `Updating ${Math.round(update.progress * 100)}%`
        : `Update to ${update.latest.version}`}
    </button>
  );
}

/** Requests or the JSON viewer: the two halves of the app. */
function ViewSwitch() {
  const view = useStore((s) => s.state?.ui?.view || 'requests');
  const setView = useStore((s) => s.setView);
  const mod = navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl';
  return (
    <div className="view-switch" role="tablist" aria-label="View">
      <button
        role="tab"
        aria-selected={view === 'requests'}
        className={view === 'requests' ? 'active' : ''}
        title={`Requests (${mod}+J switches)`}
        onClick={() => setView('requests')}
      >
        Requests
      </button>
      <button
        role="tab"
        aria-selected={view === 'json'}
        className={view === 'json' ? 'active' : ''}
        title={`JSON viewer: beautify JSON and explore it as a tree (${mod}+J)`}
        onClick={() => setView('json')}
      >
        <IconBraces width={12} height={12} /> JSON
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- tabbar */

function TabBar() {
  const state = useStore((s) => s.state);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const createRequest = useStore((s) => s.createRequest);
  // Subscribe to drafts so a tab's title/method updates while you type.
  const drafts = useStore((s) => s.drafts);
  const docs = useStore((s) => s.docs);
  const recording = useStore((s) => s.recording);

  const tabs = state.ui.tabs || [];

  return (
    <div className="tabbar">
      {tabs.map((id) => {
        if (id.startsWith('doc_')) {
          const doc = docs.find((d) => d.id === id);
          if (!doc) return null;
          return (
            <div
              key={id}
              className={`tab ${state.ui.activeTabId === id ? 'active' : ''}`}
              onClick={() => setActiveTab(id)}
              onAuxClick={(e) => e.button === 1 && closeTab(id, { skipFlush: true })}
              title={`Test doc: ${doc.name}`}
            >
              {recording?.docId === id ? <span className="rec-dot pulse" /> : <IconDoc width={13} height={13} className="dim" />}
              <span className="tab-name">{doc.name}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(id, { skipFlush: true });
                }}
              >
                <IconClose width={11} height={11} />
              </button>
            </div>
          );
        }
        const hit = findRequest(state, id);
        if (!hit) return null;
        const request = drafts[id] || hit.request;
        return (
          <div
            key={id}
            className={`tab ${state.ui.activeTabId === id ? 'active' : ''}`}
            onClick={() => setActiveTab(id)}
            onAuxClick={(e) => e.button === 1 && closeTab(id)}
            title={request.url || request.name}
          >
            <span className={`method-badge ${METHOD_COLORS[request.method] || ''}`} style={{ minWidth: 0 }}>
              {request.method}
            </span>
            <span className="tab-name">{request.name}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id);
              }}
            >
              <IconClose width={11} height={11} />
            </button>
          </div>
        );
      })}
      <button className="tab-add" title="New request" onClick={() => createRequest(state.collections[0]?.id)}>
        <IconPlus width={13} height={13} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- resizer */

function SidebarResizer() {
  const patchUi = useStore((s) => s.patchUi);
  const [dragging, setDragging] = useState(false);
  const frame = useRef(null);

  const onMouseDown = (e) => {
    e.preventDefault();
    setDragging(true);
    const onMove = (ev) => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        patchUi({ sidebarWidth: Math.min(560, Math.max(200, ev.clientX)) });
      });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return <div className={`resizer ${dragging ? 'dragging' : ''}`} onMouseDown={onMouseDown} />;
}

/* ---------------------------------------------------------- empty state */

function EmptyState() {
  const createRequest = useStore((s) => s.createRequest);
  const state = useStore((s) => s.state);
  const showToast = useStore((s) => s.showToast);

  const pasteCurl = async () => {
    const text = await api.readClipboard();
    if (!/^\s*curl(\.exe)?[\s\n]/i.test(text || '')) return showToast('Clipboard does not contain a cURL command');
    const parsed = await api.parseCurl(text);
    if (!parsed.ok) return showToast(parsed.error);
    const { name, ...fields } = parsed.request;
    await createRequest(state.collections[0]?.id, { name, ...fields });
  };

  return (
    <div className="response-placeholder" style={{ flex: 1 }}>
      <div>
        <div style={{ fontSize: 15, color: 'var(--text)', marginBottom: 14 }}>No request open</div>
        <button className="btn" onClick={() => createRequest(state.collections[0]?.id)}>
          <IconPlus width={13} height={13} /> New request
        </button>
        <button className="btn" style={{ marginLeft: 8 }} onClick={pasteCurl}>
          Paste cURL from clipboard
        </button>
        <div style={{ marginTop: 22, lineHeight: 2 }}>
          <span className="kbd">Ctrl</span> <span className="kbd">N</span> new request
          <br />
          <span className="kbd">Ctrl</span> <span className="kbd">Enter</span> send
          <br />
          <span className="kbd">Ctrl</span> <span className="kbd">Shift</span> <span className="kbd">V</span> import cURL from clipboard
        </div>
      </div>
    </div>
  );
}

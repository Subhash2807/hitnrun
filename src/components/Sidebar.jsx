import { useMemo, useState } from 'react';
import { useStore, api, walkRequests } from '../store.js';
import Dropdown, { Item, Separator } from './Dropdown.jsx';
import { SyncDot } from './SyncIndicator.jsx';
import AiWorkspacePanel from './AiWorkspacePanel.jsx';
import {
  IconSearch, IconPlus, IconMore, IconChevronDown, IconChevronRight,
  IconFolder, IconLayers, IconClock, IconTrash, IconCopy, IconSync, IconTerminal,
} from './Icons.jsx';
import { METHOD_COLORS, relativeTime, statusClass } from '../lib/format.js';

export default function Sidebar() {
  const state = useStore((s) => s.state);
  const patchUi = useStore((s) => s.patchUi);
  const tab = state?.ui?.sidebarTab || 'collections';

  return (
    <div className="sidebar" style={{ width: state?.ui?.sidebarWidth || 280 }}>
      <div className="sidebar-tabs">
        {[
          ['collections', 'Collections'],
          ['environments', 'Env'],
          ['history', 'History'],
          ['ai', 'AI'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={`sidebar-tab ${tab === id ? 'active' : ''}`}
            onClick={() => patchUi({ sidebarTab: id })}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'collections' && <CollectionsTree />}
      {tab === 'environments' && <EnvironmentsList />}
      {tab === 'history' && <HistoryList />}
      {tab === 'ai' && <AiWorkspacePanel />}
    </div>
  );
}

/* ------------------------------------------------------------ collections */

function CollectionsTree() {
  const state = useStore((s) => s.state);
  const call = useStore((s) => s.call);
  const createRequest = useStore((s) => s.createRequest);
  const syncContainer = useStore((s) => s.syncContainer);
  const openModal = useStore((s) => s.openModal);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const toggle = (id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const matches = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    const ids = new Set();
    for (const { request } of walkRequests(state)) {
      if (request.name.toLowerCase().includes(q) || (request.url || '').toLowerCase().includes(q)) {
        ids.add(request.id);
      }
    }
    return ids;
  }, [query, state]);

  const collections = state?.collections || [];

  return (
    <>
      <div className="sidebar-toolbar">
        <div className="search-box">
          <IconSearch width={12} height={12} className="dim" />
          <input
            value={query}
            placeholder="Search requests"
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        <Dropdown
          align="right"
          trigger={(open) => (
            <button className="icon-btn" onClick={open} title="New">
              <IconPlus />
            </button>
          )}
        >
          <Item onClick={() => createRequest(collections[0]?.id)}>New Request</Item>
          <Item onClick={() => openModal({ type: 'newCollection' })}>New Collection</Item>
        </Dropdown>
      </div>

      <div className="tree">
        {collections.length === 0 && (
          <div className="tree-empty">
            No collections yet.
            <br />
            Use <IconPlus width={11} height={11} /> to create one.
          </div>
        )}

        {collections.map((collection) => (
          <div key={collection.id}>
            <div className="tree-row" onClick={() => toggle(collection.id)} style={{ paddingLeft: 4 }}>
              <span className="tree-caret">
                {collapsed[collection.id] ? <IconChevronRight width={12} height={12} /> : <IconChevronDown width={12} height={12} />}
              </span>
              <span className="tree-label" style={{ fontWeight: 500 }}>{collection.name}</span>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <Dropdown
                  align="right"
                  trigger={(open) => (
                    <button className="icon-btn" onClick={open}>
                      <IconMore width={13} height={13} />
                    </button>
                  )}
                >
                  <Item onClick={() => createRequest(collection.id)}>Add Request</Item>
                  <Item onClick={() => call('createFolder', collection.id, 'New Folder')} icon={<IconFolder width={12} height={12} />}>
                    Add Folder
                  </Item>
                  <Item onClick={() => openModal({ type: 'renameCollection', id: collection.id, name: collection.name })}>
                    Rename
                  </Item>
                  <Separator />
                  <Item onClick={() => syncContainer(collection.id)} icon={<IconSync width={12} height={12} />}>
                    Sync all with source cURL
                  </Item>
                  <Separator />
                  <Item
                    danger
                    icon={<IconTrash width={12} height={12} />}
                    onClick={() =>
                      openModal({
                        type: 'confirm',
                        title: 'Delete collection',
                        message: `Delete "${collection.name}" and everything inside it? This cannot be undone.`,
                        onConfirm: () => call('deleteCollection', collection.id),
                      })
                    }
                  >
                    Delete
                  </Item>
                </Dropdown>
              </div>
            </div>

            {!collapsed[collection.id] && (
              <ItemList items={collection.items} depth={1} collapsed={collapsed} toggle={toggle} matches={matches} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function ItemList({ items, depth, collapsed, toggle, matches }) {
  return items.map((item) =>
    item.type === 'folder' ? (
      <FolderRow key={item.id} folder={item} depth={depth} collapsed={collapsed} toggle={toggle} matches={matches} />
    ) : (
      <RequestRow key={item.id} request={item} depth={depth} matches={matches} />
    )
  );
}

function FolderRow({ folder, depth, collapsed, toggle, matches }) {
  const call = useStore((s) => s.call);
  const createRequest = useStore((s) => s.createRequest);
  const syncContainer = useStore((s) => s.syncContainer);
  const openModal = useStore((s) => s.openModal);

  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: depth * 14 }} onClick={() => toggle(folder.id)}>
        <span className="tree-caret">
          {collapsed[folder.id] ? <IconChevronRight width={12} height={12} /> : <IconChevronDown width={12} height={12} />}
        </span>
        <IconFolder width={12} height={12} className="dim" />
        <span className="tree-label">{folder.name}</span>
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <Dropdown
            align="right"
            trigger={(open) => (
              <button className="icon-btn" onClick={open}>
                <IconMore width={13} height={13} />
              </button>
            )}
          >
            <Item onClick={() => createRequest(folder.id)}>Add Request</Item>
            <Item onClick={() => call('createFolder', folder.id, 'New Folder')}>Add Folder</Item>
            <Item onClick={() => openModal({ type: 'renameFolder', id: folder.id, name: folder.name })}>Rename</Item>
            <Separator />
            <Item onClick={() => syncContainer(folder.id)} icon={<IconSync width={12} height={12} />}>
              Sync all with source cURL
            </Item>
            <Separator />
            <Item
              danger
              icon={<IconTrash width={12} height={12} />}
              onClick={() =>
                openModal({
                  type: 'confirm',
                  title: 'Delete folder',
                  message: `Delete "${folder.name}" and everything inside it? This cannot be undone.`,
                  onConfirm: () => call('deleteFolder', folder.id),
                })
              }
            >
              Delete
            </Item>
          </Dropdown>
        </div>
      </div>
      {!collapsed[folder.id] && (
        <ItemList items={folder.items} depth={depth + 1} collapsed={collapsed} toggle={toggle} matches={matches} />
      )}
    </div>
  );
}

function RequestRow({ request, depth, matches }) {
  const activeTabId = useStore((s) => s.state?.ui?.activeTabId);
  const openTab = useStore((s) => s.openTab);
  const duplicateRequest = useStore((s) => s.duplicateRequest);
  const deleteRequest = useStore((s) => s.deleteRequest);
  const syncRequest = useStore((s) => s.syncRequest);
  const openModal = useStore((s) => s.openModal);
  const showToast = useStore((s) => s.showToast);

  if (matches && !matches.has(request.id)) return null;

  const copyCurl = async () => {
    const curl = await api.toCurl(request);
    await api.copyToClipboard(curl);
    showToast('Copied as cURL');
  };

  return (
    <div
      className={`tree-row ${activeTabId === request.id ? 'active' : ''}`}
      style={{ paddingLeft: depth * 14 + 14 }}
      onClick={() => openTab(request.id)}
    >
      <span className={`method-badge ${METHOD_COLORS[request.method] || ''}`}>{request.method}</span>
      <span className="tree-label">{request.name}</span>
      <SyncDot requestId={request.id} />
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Copy as cURL" onClick={copyCurl}>
          <IconTerminal width={13} height={13} />
        </button>
        <Dropdown
          align="right"
          trigger={(open) => (
            <button className="icon-btn" onClick={open}>
              <IconMore width={13} height={13} />
            </button>
          )}
        >
          <Item onClick={() => openTab(request.id)}>Open</Item>
          <Item onClick={() => duplicateRequest(request.id)} icon={<IconCopy width={12} height={12} />}>
            Duplicate
          </Item>
          <Item onClick={() => syncRequest(request.id)} icon={<IconSync width={12} height={12} />}>
            Sync with source cURL
          </Item>
          <Item onClick={copyCurl}>Copy as cURL</Item>
          <Item onClick={() => openModal({ type: 'renameRequest', id: request.id, name: request.name })}>Rename</Item>
          <Separator />
          <Item
            danger
            icon={<IconTrash width={12} height={12} />}
            onClick={() =>
              openModal({
                type: 'confirm',
                title: 'Delete request',
                message: `Delete "${request.name}"?`,
                onConfirm: () => deleteRequest(request.id),
              })
            }
          >
            Delete
          </Item>
        </Dropdown>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- environments */

function EnvironmentsList() {
  const state = useStore((s) => s.state);
  const call = useStore((s) => s.call);
  const openModal = useStore((s) => s.openModal);
  const envs = state?.environments || [];

  return (
    <>
      <div className="sidebar-toolbar">
        <span className="section-title grow" style={{ paddingLeft: 4 }}>Environments</span>
        <button className="icon-btn" title="New environment" onClick={() => call('createEnvironment', 'New Environment', [])}>
          <IconPlus />
        </button>
      </div>
      <div className="tree">
        {envs.length === 0 && (
          <div className="tree-empty">
            No environments yet.
            <br />
            Create one to store <code className="mono">{'{{variables}}'}</code>.
          </div>
        )}
        {envs.map((env) => (
          <div
            key={env.id}
            className={`tree-row ${state.activeEnvironmentId === env.id ? 'active' : ''}`}
            style={{ paddingLeft: 14 }}
            onClick={() => openModal({ type: 'environment', id: env.id })}
          >
            <span className="tree-label">{env.name}</span>
            <span className="count-pill">{env.values?.length || 0}</span>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              <Dropdown
                align="right"
                trigger={(open) => (
                  <button className="icon-btn" onClick={open}>
                    <IconMore width={13} height={13} />
                  </button>
                )}
              >
                <Item onClick={() => call('setActiveEnvironment', env.id)}>Set Active</Item>
                <Item onClick={() => openModal({ type: 'environment', id: env.id })}>Edit</Item>
                <Item onClick={() => openModal({ type: 'quickSource', envId: env.id })} icon={<IconSync width={12} height={12} />}>
                  Set source cURL
                </Item>
                {!env.builtin && (
                  <>
                    <Separator />
                    <Item danger onClick={() => call('deleteEnvironment', env.id)}>Delete</Item>
                  </>
                )}
              </Dropdown>
            </div>
          </div>
        ))}
        <div className="tree-row" style={{ paddingLeft: 14, marginTop: 8 }} onClick={() => openModal({ type: 'globals' })}>
          <span className="tree-label dim">Globals</span>
          <span className="count-pill">{state?.globals?.length || 0}</span>
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- history */

function HistoryList() {
  const state = useStore((s) => s.state);
  const call = useStore((s) => s.call);
  const openTab = useStore((s) => s.openTab);
  const createRequest = useStore((s) => s.createRequest);
  const history = state?.history || [];

  const reopen = async (entry) => {
    // If the original request still exists, focus it; otherwise restore the snapshot.
    const exists = [...walkRequests(state)].some((h) => h.request.id === entry.requestId);
    if (exists) return openTab(entry.requestId);
    const { id, type, createdAt, updatedAt, ...fields } = entry.snapshot || {};
    if (fields.url) await createRequest(state.collections[0]?.id, fields);
  };

  return (
    <>
      <div className="sidebar-toolbar">
        <span className="section-title grow" style={{ paddingLeft: 4 }}>History</span>
        {history.length > 0 && (
          <button className="icon-btn" title="Clear history" onClick={() => call('clearHistory')}>
            <IconTrash width={13} height={13} />
          </button>
        )}
      </div>
      <div className="tree">
        {history.length === 0 && <div className="tree-empty">Requests you send will appear here.</div>}
        {history.map((entry) => (
          <div key={entry.id} className="tree-row" style={{ paddingLeft: 14, height: 'auto', paddingTop: 5, paddingBottom: 5 }} onClick={() => reopen(entry)}>
            <span className={`method-badge ${METHOD_COLORS[entry.method] || ''}`}>{entry.method}</span>
            <div className="tree-label" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
              <span className="dim" style={{ fontSize: 10.5 }}>
                {relativeTime(entry.at)}
                {entry.status != null && (
                  <span className={statusClass(entry.status)}> · <b>{entry.status}</b></span>
                )}
                {entry.error && <span style={{ color: 'var(--error)' }}> · failed</span>}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

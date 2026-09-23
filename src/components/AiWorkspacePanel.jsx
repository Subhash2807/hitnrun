import { useState } from 'react';
import { useStore } from '../store.js';
import Dropdown, { Item, Separator } from './Dropdown.jsx';
import { IconChevronDown, IconChevronRight, IconFolder, IconMore, IconTrash, IconPlus } from './Icons.jsx';
import { METHOD_COLORS, relativeTime } from '../lib/format.js';

/**
 * The AI's workspace, shown separately from your own.
 *
 * Nothing here is in your collections. Each AI session gets its own folder; you
 * decide what — if anything — crosses over, via "Add to my workspace".
 */
export default function AiWorkspacePanel() {
  const ai = useStore((s) => s.ai);
  const openModal = useStore((s) => s.openModal);
  const discardAiSession = useStore((s) => s.discardAiSession);
  const discardAllAiSessions = useStore((s) => s.discardAllAiSessions);
  const [collapsed, setCollapsed] = useState({});

  const toggle = (id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  const sessions = ai?.sessions || [];

  const confirmDiscard = (session, name) =>
    openModal({
      type: 'confirm',
      title: 'Discard AI session',
      message: `Delete "${name}" and everything the AI created in it? Your own requests are not affected.`,
      onConfirm: () => discardAiSession(session.id),
    });

  return (
    <>
      <div className="sidebar-toolbar">
        <span className="section-title grow" style={{ paddingLeft: 4 }}>AI Workspace</span>
        {sessions.length > 0 && (
          <button
            className="icon-btn"
            title="Discard all AI sessions"
            onClick={() =>
              openModal({
                type: 'confirm',
                title: 'Discard all AI sessions',
                message: `Delete ${sessions.length === 1 ? 'the AI session' : `all ${sessions.length} AI sessions`} and everything in ${sessions.length === 1 ? 'it' : 'them'}? Your own requests are not affected.`,
                onConfirm: discardAllAiSessions,
              })
            }
          >
            <IconTrash width={13} height={13} />
          </button>
        )}
        <button className="icon-btn" title="How to connect an AI" onClick={() => openModal({ type: 'aiSetup' })}>
          <IconPlus />
        </button>
      </div>

      <div className="tree">
        {sessions.length === 0 ? (
          <div className="tree-empty">
            No AI sessions yet.
            <br />
            <br />
            Connect Claude Code and anything it builds appears here — separate from your own requests.
            <br />
            <br />
            <button className="btn btn-sm" onClick={() => openModal({ type: 'aiSetup' })}>
              Set up AI access
            </button>
          </div>
        ) : (
          <div className="ai-note">
            These are the AI's own requests. Your workspace is untouched until you add something.
          </div>
        )}

        {sessions.map((session) => {
          const collection = (ai.collections || []).find((c) => c.id === session.collectionId);
          if (!collection) return null;
          const isOpen = !collapsed[session.id];

          return (
            <div key={session.id}>
              <div className="tree-row" style={{ paddingLeft: 4 }} onClick={() => toggle(session.id)}>
                <span className="tree-caret">
                  {isOpen ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />}
                </span>
                <span className="tree-label" style={{ fontWeight: 500 }}>{collection.name}</span>
                <span className="count-pill">{session.requestCount}</span>
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title="Discard session" onClick={() => confirmDiscard(session, collection.name)}>
                    <IconTrash width={12} height={12} />
                  </button>
                  <Dropdown
                    align="right"
                    trigger={(open) => (
                      <button className="icon-btn" onClick={open}>
                        <IconMore width={13} height={13} />
                      </button>
                    )}
                  >
                    <Item onClick={() => openModal({ type: 'promote', nodeId: collection.id, name: collection.name })}>
                      Add all to my workspace
                    </Item>
                    <Separator />
                    <Item
                      danger
                      icon={<IconTrash width={12} height={12} />}
                      onClick={() => confirmDiscard(session, collection.name)}
                    >
                      Discard session
                    </Item>
                  </Dropdown>
                </div>
              </div>

              {isOpen && (
                <>
                  <div className="session-meta">
                    {session.client} · started {relativeTime(session.startedAt)}
                  </div>
                  <AiItems items={collection.items} depth={1} collapsed={collapsed} toggle={toggle} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function AiItems({ items, depth, collapsed, toggle }) {
  const openModal = useStore((s) => s.openModal);
  const deleteAiNode = useStore((s) => s.deleteAiNode);

  const remove = (item) => (
    <button
      className="icon-btn"
      title={item.type === 'folder' ? 'Delete folder' : 'Delete request'}
      onClick={() =>
        item.type === 'folder'
          ? openModal({
              type: 'confirm',
              title: 'Delete folder',
              message: `Delete "${item.name}" and everything inside it from the AI workspace?`,
              onConfirm: () => deleteAiNode(item.id),
            })
          : deleteAiNode(item.id)
      }
    >
      <IconTrash width={12} height={12} />
    </button>
  );

  return (items || []).map((item) =>
    item.type === 'folder' ? (
      <div key={item.id}>
        <div className="tree-row" style={{ paddingLeft: depth * 14 }} onClick={() => toggle(item.id)}>
          <span className="tree-caret">
            {collapsed[item.id] ? <IconChevronRight width={12} height={12} /> : <IconChevronDown width={12} height={12} />}
          </span>
          <IconFolder width={12} height={12} className="dim" />
          <span className="tree-label">{item.name}</span>
          <div className="row-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="link-btn"
              title="Copy this folder into your workspace"
              onClick={() => openModal({ type: 'promote', nodeId: item.id, name: item.name })}
            >
              Add
            </button>
            {remove(item)}
          </div>
        </div>
        {!collapsed[item.id] && <AiItems items={item.items} depth={depth + 1} collapsed={collapsed} toggle={toggle} />}
      </div>
    ) : (
      <div key={item.id} className="tree-row" style={{ paddingLeft: depth * 14 + 14 }}>
        <span className={`method-badge ${METHOD_COLORS[item.method] || ''}`}>{item.method}</span>
        <span className="tree-label" title={item.url}>{item.name}</span>
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="link-btn"
            title="Copy this request into your workspace"
            onClick={() => openModal({ type: 'promote', nodeId: item.id, name: item.name })}
          >
            Add
          </button>
          {remove(item)}
        </div>
      </div>
    )
  );
}

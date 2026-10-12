import { useMemo, useState } from 'react';
import { useStore } from '../store.js';
import Dropdown, { Item, Separator } from './Dropdown.jsx';
import { IconBraces, IconPlus, IconMore, IconSearch, IconTrash, IconCopy, IconDownload, IconFolderOpen } from './Icons.jsx';
import { prettyBytes, relativeTime } from '../lib/format.js';

/**
 * The sidebar while the JSON viewer is open: every JSON file you have. A
 * file opens in a tab; closing the tab keeps the file here.
 */
export default function JsonPanel() {
  const files = useStore((s) => s.jsonFiles);
  const activeId = useStore((s) => s.state?.ui?.jsonActiveId);
  const createJsonFile = useStore((s) => s.createJsonFile);
  const importJsonFiles = useStore((s) => s.importJsonFiles);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;
  }, [files, query]);

  return (
    <>
      <div className="json-panel-head">
        <IconBraces width={14} height={14} className="accent" />
        <span className="grow">JSON files</span>
        <button className="icon-btn" title="Open .json files from disk" onClick={importJsonFiles}>
          <IconFolderOpen width={14} height={14} />
        </button>
        <button className="icon-btn" title="New JSON file" onClick={() => createJsonFile()}>
          <IconPlus />
        </button>
      </div>

      {files.length > 0 && (
        <div className="sidebar-toolbar">
          <div className="search-box">
            <IconSearch width={12} height={12} className="dim" />
            <input value={query} placeholder="Search files" onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          </div>
        </div>
      )}

      <div className="tree">
        {files.length === 0 && (
          <div className="tree-empty">
            No JSON files yet.
            <br />
            Create one with <IconPlus width={11} height={11} />, open a .json file, or drop one on the viewer.
          </div>
        )}
        {files.length > 0 && shown.length === 0 && <div className="tree-empty">No file matches “{query}”.</div>}
        {shown.map((file) => (
          <JsonFileRow key={file.id} file={file} active={file.id === activeId} />
        ))}
      </div>
    </>
  );
}

function JsonFileRow({ file, active }) {
  const openJsonFile = useStore((s) => s.openJsonFile);
  const duplicateJsonFile = useStore((s) => s.duplicateJsonFile);
  const deleteJsonFile = useStore((s) => s.deleteJsonFile);
  const saveJsonToDisk = useStore((s) => s.saveJsonToDisk);
  const openModal = useStore((s) => s.openModal);

  return (
    <div
      className={`tree-row ${active ? 'active' : ''}`}
      style={{ paddingLeft: 12, height: 'auto', paddingTop: 5, paddingBottom: 5 }}
      onClick={() => openJsonFile(file.id)}
      onDoubleClick={() => openModal({ type: 'renameJson', id: file.id, name: file.name })}
      title={file.name}
    >
      <IconBraces width={13} height={13} className="json-file-icon" />
      <div className="tree-label" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span className="ellipsis">{file.name}</span>
        <span className="dim" style={{ fontSize: 10.5 }}>
          {file.size ? prettyBytes(file.size) : 'empty'} · {relativeTime(file.updatedAt)}
        </span>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <Dropdown
          align="right"
          trigger={(open) => (
            <button className="icon-btn" onClick={open} title="More actions">
              <IconMore width={13} height={13} />
            </button>
          )}
        >
          <Item onClick={() => openJsonFile(file.id)} icon={<IconBraces width={12} height={12} />}>Open</Item>
          <Item onClick={() => openModal({ type: 'renameJson', id: file.id, name: file.name })}>Rename…</Item>
          <Item onClick={() => duplicateJsonFile(file.id)} icon={<IconCopy width={12} height={12} />}>Duplicate</Item>
          <Item onClick={() => saveJsonToDisk(file.id)} icon={<IconDownload width={12} height={12} />}>Save to a file…</Item>
          <Separator />
          <Item
            danger
            icon={<IconTrash width={12} height={12} />}
            onClick={() =>
              openModal({
                type: 'confirm',
                title: 'Delete file',
                message: `Delete "${file.name}"? This cannot be undone.`,
                onConfirm: () => deleteJsonFile(file.id),
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

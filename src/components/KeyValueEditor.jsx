import { useEffect, useState } from 'react';
import { rowsToBulk, bulkToRows, blankRow } from '../lib/bulk.js';
import { IconTrash, IconPlus } from './Icons.jsx';
import { api } from '../store.js';

/**
 * The grid used for headers, query params, path variables and form fields.
 *
 * Two interchangeable modes:
 *   rows — a spreadsheet with per-row enable/disable
 *   bulk — a textarea of `key:value` lines, `//` to disable
 *
 * The bulk textarea keeps its own text while focused so re-serialising the rows
 * can't fight the cursor; rows are pushed upward on every keystroke.
 */
export default function KeyValueEditor({
  rows = [],
  onChange,
  title,
  description = true,
  toggles = true,
  files = false,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  emptyNote,
  actions = null,
  auto = false,
}) {
  const [mode, setMode] = useState('rows');
  const [bulkText, setBulkText] = useState('');

  // Seed the textarea from the rows each time bulk mode is entered.
  useEffect(() => {
    if (mode === 'bulk') setBulkText(rowsToBulk(rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const display = [...rows];
  const last = display[display.length - 1];
  if (!last || last.key || last.value || last.description) display.push(blankRow());

  const commit = (next) => {
    // Drop the trailing placeholder unless the user typed into it.
    const cleaned = next.filter((r, i) => r.key || r.value || r.description || i < next.length - 1);
    onChange(cleaned);
  };

  const updateRow = (index, patch) => {
    const next = display.map((r, i) => (i === index ? { ...r, ...patch } : r));
    commit(next);
  };

  const removeRow = (index) => commit(display.filter((_, i) => i !== index));

  const pickFile = async (index) => {
    const filePath = await api.pickFile({ title: 'Select a file to upload' });
    if (filePath) updateRow(index, { src: filePath, type: 'file' });
  };

  const allChecked = rows.length > 0 && rows.every((r) => r.enabled !== false);
  const toggleAll = () => commit(rows.map((r) => ({ ...r, enabled: !allChecked })));

  return (
    <div className={`editor-section ${auto ? 'auto' : ''}`}>
      <div className="section-head">
        <span className="section-title">{title}</span>
        <div className="section-actions">
          {actions}
          {mode === 'rows' ? (
            <button className="link-btn" onClick={() => setMode('bulk')}>
              Bulk Edit
            </button>
          ) : (
            <button className="link-btn" onClick={() => setMode('rows')}>
              Key-Value Edit
            </button>
          )}
        </div>
      </div>

      {mode === 'bulk' ? (
        <>
          <div className="hint">key:value — one per line. Prefix a line with // to disable it.</div>
          <div className="bulk-area">
            <textarea
              value={bulkText}
              spellCheck={false}
              placeholder={`Content-Type:application/json\nAuthorization:Bearer {{token}}\n//X-Debug:1`}
              onChange={(e) => {
                setBulkText(e.target.value);
                onChange(bulkToRows(e.target.value, rows));
              }}
            />
          </div>
        </>
      ) : (
        <div className="kv-scroll">
          <table className="kv-table">
            <thead>
              <tr>
                {toggles && (
                  <th className="kv-check">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={toggleAll}
                      title={allChecked ? 'Disable all' : 'Enable all'}
                    />
                  </th>
                )}
                <th style={{ width: files ? '26%' : '30%' }}>Key</th>
                {files && <th style={{ width: 90 }}>Type</th>}
                <th>Value</th>
                {description && <th style={{ width: '24%' }}>Description</th>}
                <th className="kv-actions" />
              </tr>
            </thead>
            <tbody>
              {display.map((row, i) => {
                const isPlaceholder = i === display.length - 1 && !row.key && !row.value;
                return (
                  <tr key={i} className={row.enabled === false ? 'disabled' : ''}>
                    {toggles && (
                      <td className="kv-check">
                        {!isPlaceholder && (
                          <input
                            type="checkbox"
                            checked={row.enabled !== false}
                            onChange={(e) => updateRow(i, { enabled: e.target.checked })}
                          />
                        )}
                      </td>
                    )}
                    <td>
                      <input
                        type="text"
                        value={row.key ?? ''}
                        placeholder={keyPlaceholder}
                        spellCheck={false}
                        onChange={(e) => updateRow(i, { key: e.target.value })}
                      />
                    </td>
                    {files && (
                      <td>
                        <select
                          className="select"
                          style={{ width: '100%', border: 'none', height: 30, background: 'transparent' }}
                          value={row.type || 'text'}
                          onChange={(e) => updateRow(i, { type: e.target.value, src: '', value: '' })}
                        >
                          <option value="text">Text</option>
                          <option value="file">File</option>
                        </select>
                      </td>
                    )}
                    <td>
                      {files && row.type === 'file' ? (
                        <button
                          className="link-btn"
                          style={{ padding: '0 8px', height: 30, width: '100%', textAlign: 'left' }}
                          onClick={() => pickFile(i)}
                        >
                          {row.src ? row.src.split(/[\\/]/).pop() : 'Select file…'}
                        </button>
                      ) : (
                        <input
                          type="text"
                          value={row.value ?? ''}
                          placeholder={valuePlaceholder}
                          spellCheck={false}
                          onChange={(e) => updateRow(i, { value: e.target.value })}
                        />
                      )}
                    </td>
                    {description && (
                      <td>
                        <input
                          type="text"
                          value={row.description ?? ''}
                          placeholder="Description"
                          spellCheck={false}
                          onChange={(e) => updateRow(i, { description: e.target.value })}
                        />
                      </td>
                    )}
                    <td className="kv-actions">
                      {!isPlaceholder && (
                        <button className="icon-btn" title="Remove" onClick={() => removeRow(i)}>
                          <IconTrash width={12} height={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && emptyNote && <div className="empty-note">{emptyNote}</div>}
        </div>
      )}
    </div>
  );
}

export function AddRowButton({ onClick, label = 'Add row' }) {
  return (
    <button className="btn btn-sm btn-ghost" onClick={onClick}>
      <IconPlus width={12} height={12} /> {label}
    </button>
  );
}

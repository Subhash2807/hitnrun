import Editor from './Editor.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';
import { tryPretty } from '../lib/format.js';
import { api } from '../store.js';

const MODES = [
  { value: 'none', label: 'none' },
  { value: 'form-data', label: 'form-data' },
  { value: 'urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'raw', label: 'raw' },
  { value: 'file', label: 'binary' },
  { value: 'graphql', label: 'GraphQL' },
];

const RAW_TYPES = [
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'javascript', label: 'JavaScript' },
];

export default function BodyEditor({ body, onChange, theme }) {
  const model = body || { mode: 'none', raw: '', rawType: 'json', fields: [], src: '', graphql: { query: '', variables: '' } };
  const set = (patch) => onChange({ ...model, ...patch });

  const chooseFile = async () => {
    const filePath = await api.pickFile({ title: 'Select the file to send as the body' });
    if (filePath) set({ src: filePath });
  };

  return (
    <div className="editor-section">
      <div className="body-modes">
        {MODES.map((m) => (
          <label key={m.value} className={`radio ${model.mode === m.value ? 'checked' : ''}`}>
            <input
              type="radio"
              name="body-mode"
              checked={model.mode === m.value}
              onChange={() => set({ mode: m.value })}
            />
            {m.label}
          </label>
        ))}

        {model.mode === 'raw' && (
          <>
            <select
              className="select"
              value={model.rawType || 'json'}
              onChange={(e) => set({ rawType: e.target.value })}
              style={{ marginLeft: 'auto' }}
            >
              {RAW_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              className="link-btn"
              title="Reformat the body"
              onClick={() => set({ raw: tryPretty(model.raw, model.rawType) })}
            >
              Beautify
            </button>
          </>
        )}
      </div>

      {model.mode === 'none' && (
        <div className="empty-note">
          This request does not have a body.
          <br />
          Pick a type above, or paste a cURL command into the URL bar to fill one in automatically.
        </div>
      )}

      {model.mode === 'raw' && (
        <Editor
          value={model.raw}
          language={model.rawType === 'text' ? 'text' : model.rawType}
          onChange={(v) => set({ raw: v })}
          theme={theme}
          placeholder={model.rawType === 'json' ? '{\n  "key": "value"\n}' : 'Request body'}
        />
      )}

      {model.mode === 'form-data' && (
        <KeyValueEditor
          title="Form Data"
          rows={model.fields || []}
          onChange={(fields) => set({ fields })}
          files
          keyPlaceholder="Field name"
        />
      )}

      {model.mode === 'urlencoded' && (
        <KeyValueEditor
          title="URL Encoded Form"
          rows={model.fields || []}
          onChange={(fields) => set({ fields })}
          keyPlaceholder="Field name"
        />
      )}

      {model.mode === 'file' && (
        <div className="empty-note">
          {model.src ? (
            <>
              <div className="mono" style={{ marginBottom: 10, color: 'var(--text)' }}>
                {model.src}
              </div>
              <button className="btn btn-sm" onClick={chooseFile}>
                Choose a different file
              </button>{' '}
              <button className="btn btn-sm" onClick={() => set({ src: '' })}>
                Clear
              </button>
            </>
          ) : (
            <>
              Send the raw contents of a file as the request body.
              <br />
              <br />
              <button className="btn btn-sm" onClick={chooseFile}>
                Select file
              </button>
            </>
          )}
        </div>
      )}

      {model.mode === 'graphql' && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 2, display: 'flex', flexDirection: 'column', minWidth: 0, borderRight: '1px solid var(--border)' }}>
            <div className="section-head">
              <span className="section-title">Query</span>
            </div>
            <Editor
              value={model.graphql?.query ?? ''}
              language="javascript"
              theme={theme}
              placeholder={'query {\n  viewer {\n    id\n  }\n}'}
              onChange={(v) => set({ graphql: { ...model.graphql, query: v } })}
            />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div className="section-head">
              <span className="section-title">Variables</span>
            </div>
            <Editor
              value={model.graphql?.variables ?? ''}
              language="json"
              theme={theme}
              placeholder={'{\n  "id": 1\n}'}
              onChange={(v) => set({ graphql: { ...model.graphql, variables: v } })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

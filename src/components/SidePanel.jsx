import { useEffect, useState } from 'react';
import { useStore, api, findRequest } from '../store.js';
import Editor from './Editor.jsx';
import { IconCode, IconInfo, IconCopy, IconClose } from './Icons.jsx';

/**
 * Right-hand rail on a request, like Postman's: icons that open side panels.
 *   Code — the request as cURL, fetch or Python, with a copy button
 *   Info — ids, timestamps and where the request lives
 */
export const SIDE_PANELS = [
  { id: 'code', label: 'Code snippet', Icon: IconCode },
  { id: 'info', label: 'Request info', Icon: IconInfo },
];

export function SideRail({ active, onSelect }) {
  return (
    <div className="side-rail">
      {SIDE_PANELS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={`side-rail-btn ${active === id ? 'active' : ''}`}
          title={label}
          aria-pressed={active === id}
          onClick={() => onSelect(active === id ? null : id)}
        >
          <Icon width={15} height={15} />
        </button>
      ))}
    </div>
  );
}

export function SidePanel({ panel, request, theme, onClose }) {
  const title = SIDE_PANELS.find((p) => p.id === panel)?.label;
  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <span>{title}</span>
        <div className="grow" />
        <button className="icon-btn" title="Close" onClick={onClose}>
          <IconClose width={12} height={12} />
        </button>
      </div>
      {panel === 'code' && <CodePanel request={request} theme={theme} />}
      {panel === 'info' && <InfoPanel request={request} />}
    </div>
  );
}

function CodePanel({ request, theme }) {
  const showToast = useStore((s) => s.showToast);
  const patchUi = useStore((s) => s.patchUi);
  // Remember the chosen language and resolve setting across requests.
  const language = useStore((s) => s.state?.ui?.codeLanguage || 'curl');
  const resolve = useStore((s) => !!s.state?.ui?.codeResolve);
  const envName = useStore((s) => s.state?.environments.find((e) => e.id === s.state.activeEnvironmentId)?.name);
  const [languages, setLanguages] = useState([{ id: 'curl', label: 'cURL' }]);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    api.codeLanguages().then(setLanguages);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Short debounce: the snippet follows your typing without regenerating per key.
    const t = setTimeout(async () => {
      const out = await api.generateCode(request, { language, resolve });
      if (cancelled) return;
      if (out.ok) {
        setCode(out.code);
        setError(null);
      } else setError(out.error);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [request, language, resolve]);

  const copy = async () => {
    await api.copyToClipboard(code);
    showToast(`Copied as ${languages.find((l) => l.id === language)?.label || language}`);
  };

  return (
    <div className="code-panel">
      <div className="code-panel-bar">
        <select className="text-input code-lang" value={language} onChange={(e) => patchUi({ codeLanguage: e.target.value })}>
          {languages.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" title="Copy snippet" onClick={copy}>
          <IconCopy width={12} height={12} /> Copy
        </button>
      </div>
      <label className="code-resolve" title="Fill {{variables}} from the active environment, the collection and globals">
        <input type="checkbox" checked={resolve} onChange={(e) => patchUi({ codeResolve: e.target.checked })} />
        Fill in variables{envName ? ` from “${envName}”` : ''}
      </label>
      {error ? (
        <div className="error-box">{error}</div>
      ) : (
        <div className="code-panel-editor">
          <Editor value={code} readOnly language={language === 'fetch' ? 'javascript' : 'text'} theme={theme} />
        </div>
      )}
    </div>
  );
}

function InfoPanel({ request }) {
  const state = useStore((s) => s.state);
  const showToast = useStore((s) => s.showToast);
  const hit = findRequest(state, request.id);

  const path = [];
  if (hit) {
    // Walk down from the collection to find the folders on the way.
    const trail = (items, acc) => {
      for (const item of items) {
        if (item.id === request.id) return acc;
        if (item.type === 'folder') {
          const found = trail(item.items, [...acc, item.name]);
          if (found) return found;
        }
      }
      return null;
    };
    path.push(hit.collection.name, ...(trail(hit.collection.items, []) || []));
  }

  const rows = [
    ['ID', request.id, true],
    ['Location', path.join(' / ') || '—'],
    ['Created', request.createdAt ? new Date(request.createdAt).toLocaleString() : '—'],
    ['Last edited', request.updatedAt ? new Date(request.updatedAt).toLocaleString() : '—'],
    ['Source sync', request.settings?.syncExempt ? 'Excluded' : 'Included'],
  ];

  return (
    <div className="info-panel">
      {rows.map(([label, value, copyable]) => (
        <div key={label} className="info-row">
          <span className="dim">{label}</span>
          <span className="info-value">
            {value}
            {copyable && (
              <button
                className="icon-btn"
                title="Copy"
                onClick={() => {
                  api.copyToClipboard(value);
                  showToast(`${label} copied`);
                }}
              >
                <IconCopy width={11} height={11} />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, api, findRequest } from '../store.js';
import Editor from './Editor.jsx';
import { IconCode, IconInfo, IconClock, IconCopy, IconClose, IconChevronDown } from './Icons.jsx';
import { parseTimestamp, describeMoment, searchZones, systemZone, zoneOffset, isZone } from '../lib/epoch.mjs';

/**
 * Right-hand rail on a request, like Postman's: icons that open side panels.
 *   Code — the request as cURL, fetch or Python, with a copy button
 *   Info — ids, timestamps and where the request lives
 *   Time — an epoch timestamp shown in any time zone
 */
export const SIDE_PANELS = [
  { id: 'code', label: 'Code snippet', Icon: IconCode },
  { id: 'info', label: 'Request info', Icon: IconInfo },
  { id: 'time', label: 'Epoch time', Icon: IconClock },
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
      {panel === 'time' && <TimePanel />}
    </div>
  );
}

/**
 * An epoch (or a date) shown in the chosen time zone, so there's no trip to a
 * website. Double-clicking a timestamp in a response fills it in.
 */
function TimePanel() {
  const text = useStore((s) => s.epochText);
  const setText = useStore((s) => s.setEpochText);
  const savedZone = useStore((s) => s.state?.ui?.timeZone);
  const patchUi = useStore((s) => s.patchUi);
  const showToast = useStore((s) => s.showToast);
  // A saved zone this machine doesn't know would throw on every render.
  const zone = savedZone && isZone(savedZone) ? savedZone : systemZone();

  const parsed = useMemo(() => parseTimestamp(text), [text]);
  const moment = useMemo(() => (parsed?.ms === undefined ? null : describeMoment(parsed.ms, zone)), [parsed, zone]);

  const rows = moment && [
    [zone.replace(/_/g, ' '), moment.local],
    ['ISO 8601', moment.iso],
    ['UTC', moment.utc],
    ['Relative', moment.relative],
    ['Epoch milliseconds', moment.millis],
    ['Epoch seconds', moment.seconds],
  ];

  return (
    <div className="time-panel">
      <div className="time-input-row">
        <input
          className="text-input"
          placeholder="Epoch (s, ms, µs) or a date"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <button className="btn btn-sm" title="The current time" onClick={() => setText(String(Date.now()))}>
          Now
        </button>
      </div>
      {parsed?.error ? (
        <div className="time-note error">{parsed.error}</div>
      ) : (
        <div className="time-note">
          {parsed ? `Read as ${parsed.unit === 'date' ? 'a date' : `epoch ${parsed.unit}`}` : 'Or double-click a timestamp in the response.'}
        </div>
      )}

      <ZonePicker value={zone} onChange={(timeZone) => patchUi({ timeZone })} />

      {rows && (
        <div className="info-panel time-rows">
          {rows.map(([label, value]) => (
            <div key={label} className="info-row">
              <span className="dim">{label}</span>
              <span className="info-value mono">
                {value}
                <button
                  className="icon-btn"
                  title="Copy"
                  onClick={() => {
                    api.copyToClipboard(value);
                    showToast(`Copied ${value}`);
                  }}
                >
                  <IconCopy width={11} height={11} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Time zone dropdown with a search box: type a city, a zone's long name or an offset. */
function ZonePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const listRef = useRef(null);
  const matches = useMemo(() => (open ? searchZones(query) : []), [open, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (id) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && matches[active]) {
      choose(matches[active].id);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="zone-picker" ref={ref}>
      <button className="text-input zone-current" onClick={() => setOpen((o) => !o)}>
        <span className="grow">{value.replace(/_/g, ' ')}</span>
        <span className="dim">{zoneOffset(value)}</span>
        <IconChevronDown width={11} height={11} className="dim" />
      </button>
      {open && (
        <div className="dropdown zone-menu">
          <input
            className="text-input"
            placeholder="Search a city, zone or offset (+05:30)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoFocus
          />
          <div className="zone-list" ref={listRef}>
            {matches.length === 0 && <div className="time-note">No time zone matches</div>}
            {matches.map((z, i) => (
              <button
                key={z.id}
                className={`dropdown-item ${i === active ? 'active' : ''} ${z.id === value ? 'selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(z.id)}
              >
                <span className="grow">
                  {z.id.replace(/_/g, ' ')}
                  <span className="zone-long dim">{z.longName}</span>
                </span>
                <span className="dim mono">{z.offset}</span>
              </button>
            ))}
          </div>
        </div>
      )}
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

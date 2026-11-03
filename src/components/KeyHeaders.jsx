import { useEffect, useRef, useState } from 'react';
import { useStore, api, findRequest } from '../store.js';
import { IconBadge, IconCopy } from './Icons.jsx';
import { findKeyHeaders, setHeaderValue, variableScope } from '../lib/keyHeaders.mjs';

/**
 * The sandbox, dealer and tenant headers a request carries, behind one icon
 * beside the sync chip. Hover to see them as they will be sent, click a value
 * to edit it. Reads the live workspace, so a source-cURL sync or an
 * environment change shows up at once. Hidden when the request has none.
 */
export default function KeyHeaders({ requestId }) {
  const request = useStore((s) => s.getRequest(requestId));
  const state = useStore((s) => s.state);
  const patchRequest = useStore((s) => s.patchRequest);
  const showToast = useStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // header row index
  const closeTimer = useRef(null);
  const root = useRef(null);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // While open: a click anywhere else closes the card, and so does the pointer
  // leaving it, after a short grace period to travel from the icon into the
  // card. The pointer is tracked on the page rather than by leave events, which
  // misfire when the edit box under the pointer is swapped back for its value.
  // While a value is being edited the card stays put.
  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    const track = (e) => {
      const inside = [...(root.current?.children || [])].some((el) => {
        const b = el.getBoundingClientRect();
        return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top - 8 && e.clientY <= b.bottom;
      });
      if (inside || editing !== null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      } else if (!closeTimer.current) closeTimer.current = setTimeout(() => setOpen(false), 200);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('mousemove', track);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('mousemove', track);
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    };
  }, [open, editing]);

  const collection = findRequest(state, requestId)?.collection ?? null;
  const env = (state?.environments || []).find((e) => e.id === state?.activeEnvironmentId);
  const headers = findKeyHeaders(request, variableScope(state, collection));
  if (!headers.length) return null;

  const unresolved = headers.some((h) => h.missing.length);
  const show = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };

  // A click elsewhere already closes the card; Enter leaves it open.
  const commit = (index, value) => {
    setEditing(null);
    if (value !== request.headers[index]?.value) patchRequest(requestId, { headers: setHeaderValue(request, index, value) });
  };

  return (
    <div className="key-headers" ref={root} onMouseEnter={show}>
      <button
        className={'key-headers-btn' + (unresolved ? ' warn' : '')}
        aria-label="Key headers"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconBadge width={14} height={14} />
        <span className="key-headers-count">{headers.length}</span>
      </button>
      {open && (
        <div className="key-headers-card" onKeyDown={(e) => e.key === 'Escape' && editing === null && setOpen(false)}>
          <div className="key-headers-title">
            <span>Key headers</span>
            <span className="key-headers-env">{env ? `env: ${env.name}` : 'no environment'}</span>
          </div>
          {headers.map((h) => (
            <div className="key-headers-row" key={h.index}>
              <span className="key-headers-name">{h.name}</span>
              {editing === h.index ? (
                <input
                  className="key-headers-input"
                  autoFocus
                  defaultValue={h.raw}
                  spellCheck={false}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => commit(h.index, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                />
              ) : (
                <button
                  className={'key-headers-value' + (h.missing.length ? ' warn' : '')}
                  title={
                    h.missing.length
                      ? `No value for ${h.missing.map((n) => `{{${n}}}`).join(', ')} in this environment. Click to edit.`
                      : h.raw !== h.value
                        ? `${h.raw}\n\nClick to edit.`
                        : 'Click to edit.'
                  }
                  onClick={() => setEditing(h.index)}
                >
                  {h.value || <span className="key-headers-empty">empty</span>}
                </button>
              )}
              <button
                className="icon-btn key-headers-copy"
                title={`Copy ${h.name}`}
                onClick={async () => {
                  await api.copyToClipboard(h.value);
                  showToast(`Copied ${h.name}`);
                }}
              >
                <IconCopy width={12} height={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

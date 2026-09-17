import { useEffect, useRef, useState } from 'react';

/** Click-to-open menu that closes on outside click or Escape. */
export default function Dropdown({ trigger, children, align = 'left', className = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={className} style={{ position: 'relative', display: 'flex' }}>
      {trigger(() => setOpen((v) => !v), open)}
      {open && (
        <div
          className={`dropdown ${align === 'right' ? 'dropdown-right' : ''}`}
          onClick={(e) => {
            // Let item handlers run, then dismiss.
            if (e.target.closest('.dropdown-item')) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function Item({ children, onClick, danger, icon }) {
  return (
    <button className={`dropdown-item ${danger ? 'danger' : ''}`} onClick={onClick}>
      {icon}
      <span className="grow">{children}</span>
    </button>
  );
}

export function Separator() {
  return <div className="dropdown-sep" />;
}

import { useEffect, useState } from 'react';
import { useStore, api } from '../store.js';

/**
 * Shows whether a request still matches the active environment's source cURL,
 * and offers a one-click refresh when it doesn't.
 *
 * Hidden entirely when the active environment has no source, so the chip only
 * appears for people actually using the feature.
 */
export default function SyncIndicator({ requestId }) {
  const status = useStore((s) => s.syncStates[requestId]);
  const syncRequest = useStore((s) => s.syncRequest);
  const [detail, setDetail] = useState([]);
  const [busy, setBusy] = useState(false);

  const state = status?.state ?? 'no-source';

  // Pull the human-readable diff for the tooltip, only while drifted.
  useEffect(() => {
    let cancelled = false;
    if (state === 'drifted') {
      api.describeSync(requestId).then((lines) => {
        if (!cancelled) setDetail(lines || []);
      });
    } else {
      setDetail([]);
    }
    return () => {
      cancelled = true;
    };
  }, [state, requestId, status?.changes?.join(',')]);

  if (state === 'no-source') return null;

  if (state === 'exempt') {
    return (
      <span className="sync-chip sync-exempt" title="This request is excluded from source syncing. Toggle it in the ⋯ menu.">
        <span className="sync-dot" />
        Not synced
      </span>
    );
  }

  if (state === 'synced') {
    return (
      <span className="sync-chip sync-ok" title="Headers and host match the environment's source cURL.">
        <span className="sync-dot" />
        In sync
      </span>
    );
  }

  const tooltip = detail.length
    ? `Out of sync with the source cURL:\n\n${detail.map((d) => '• ' + d).join('\n')}\n\nClick to update.`
    : 'Out of sync with the source cURL. Click to update.';

  return (
    <button
      className="sync-chip sync-drift"
      title={tooltip}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await syncRequest(requestId);
        setBusy(false);
      }}
    >
      {busy ? <span className="spinner" style={{ borderTopColor: 'var(--warn)' }} /> : <span className="sync-dot" />}
      Out of sync
    </button>
  );
}

/** Small dot used in the sidebar tree, where there is no room for a chip. */
export function SyncDot({ requestId }) {
  const status = useStore((s) => s.syncStates[requestId]);
  if (status?.state !== 'drifted') return null;
  return <span className="sync-dot drift-dot" title="Out of sync with the source cURL" />;
}

import { useStore } from '../store.js';
import Dropdown, { Item, Separator } from './Dropdown.jsx';
import { IconMore, IconDoc, IconRecord, IconStop, IconPause, IconPlay, IconTrash, IconCopy, IconDownload, IconCamera } from './Icons.jsx';
import { relativeTime } from '../lib/format.js';

/** Sidebar list of test docs, with the recording controls on top. */
export default function DocsPanel() {
  const docs = useStore((s) => s.docs);
  const recording = useStore((s) => s.recording);
  const openModal = useStore((s) => s.openModal);
  const activeTabId = useStore((s) => s.state?.ui?.activeTabId);
  const openTab = useStore((s) => s.openTab);

  return (
    <>
      <div className="sidebar-toolbar">
        <span className="section-title grow" style={{ paddingLeft: 4 }}>Test docs</span>
        {!recording && (
          <button className="btn btn-sm rec-start" onClick={() => openModal({ type: 'startRecording' })}>
            <span className="rec-dot" /> Record
          </button>
        )}
      </div>

      {recording && <RecordingBanner />}

      <div className="tree">
        {docs.length === 0 && (
          <div className="tree-empty">
            Press <b>Record</b> before you start testing a feature. The requests you send are written down in order, ready to
            review and share.
          </div>
        )}
        {docs.map((doc) => (
          <DocRow
            key={doc.id}
            doc={doc}
            active={activeTabId === doc.id}
            isRecording={recording?.docId === doc.id}
            onOpen={() => openTab(doc.id)}
          />
        ))}
      </div>
    </>
  );
}

function RecordingBanner() {
  const recording = useStore((s) => s.recording);
  const docCall = useStore((s) => s.docCall);
  const stopRecording = useStore((s) => s.stopRecording);
  const openTab = useStore((s) => s.openTab);

  return (
    <div className={`rec-banner ${recording.paused ? 'paused' : ''}`}>
      <div className="rec-banner-top" onClick={() => openTab(recording.docId)} title="Open this doc">
        <span className={`rec-dot ${recording.paused ? '' : 'pulse'}`} />
        <span className="grow ellipsis">
          <b>{recording.paused ? 'Paused' : 'Recording'}</b> · {recording.name}
        </span>
      </div>
      <div className="rec-banner-bottom">
        <span className="dim">
          {recording.stepCount} step{recording.stepCount === 1 ? '' : 's'} ·{' '}
          <button
            className="link-btn"
            title="Switch recording mode"
            onClick={() => docCall('setRecording', { mode: recording.mode === 'auto' ? 'manual' : 'auto' })}
          >
            {recording.mode === 'auto' ? 'Auto' : 'Manual'}
          </button>
        </span>
        <div className="grow" />
        <button
          className="icon-btn"
          title={recording.paused ? 'Resume' : 'Pause'}
          onClick={() => docCall('setRecording', { paused: !recording.paused })}
        >
          {recording.paused ? <IconPlay width={12} height={12} /> : <IconPause width={13} height={13} />}
        </button>
        <button className="icon-btn rec-stop" title="Stop recording" onClick={stopRecording}>
          <IconStop width={12} height={12} />
        </button>
      </div>
    </div>
  );
}

function DocRow({ doc, active, isRecording, onOpen }) {
  const openModal = useStore((s) => s.openModal);
  const docCall = useStore((s) => s.docCall);
  const deleteDoc = useStore((s) => s.deleteDoc);
  const openTab = useStore((s) => s.openTab);
  const recording = useStore((s) => s.recording);

  return (
    <div
      className={`tree-row ${active ? 'active' : ''}`}
      style={{ paddingLeft: 10, height: 'auto', paddingTop: 6, paddingBottom: 6 }}
      onClick={onOpen}
    >
      <span className="doc-icon">{isRecording ? <span className="rec-dot pulse" /> : <IconDoc width={14} height={14} />}</span>
      <div className="tree-label" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span className="ellipsis">{doc.name}</span>
        <span className="dim" style={{ fontSize: 10.5 }}>
          {doc.stepCount} step{doc.stepCount === 1 ? '' : 's'}
          {doc.counts.pass > 0 && <span className="doc-pass"> · {doc.counts.pass} pass</span>}
          {doc.counts.fail > 0 && <span className="doc-fail"> · {doc.counts.fail} fail</span>}
          {' · '}
          {relativeTime(doc.updatedAt)}
        </span>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Download" onClick={() => openModal({ type: 'exportDoc', id: doc.id })}>
          <IconDownload width={13} height={13} />
        </button>
        <Dropdown
          align="right"
          trigger={(open) => (
            <button className="icon-btn" onClick={open} title="More actions">
              <IconMore width={13} height={13} />
            </button>
          )}
        >
          <Item onClick={() => openTab(doc.id)} icon={<IconDoc width={12} height={12} />}>View</Item>
          <Item onClick={() => openModal({ type: 'renameDoc', id: doc.id, name: doc.name })}>Rename</Item>
          {!isRecording && (
            <Item onClick={() => openModal({ type: 'startRecording', docId: doc.id })} icon={<IconRecord width={12} height={12} />}>
              {recording ? 'Record into this doc instead' : 'Resume recording'}
            </Item>
          )}
          <Item onClick={() => openModal({ type: 'exportDoc', id: doc.id })} icon={<IconDownload width={12} height={12} />}>
            Download…
          </Item>
          <Item onClick={() => docCall('duplicate', doc.id)} icon={<IconCopy width={12} height={12} />}>Duplicate</Item>
          <Separator />
          <Item
            danger
            icon={<IconTrash width={12} height={12} />}
            onClick={() =>
              openModal({
                type: 'confirm',
                title: 'Delete doc',
                message: `Delete "${doc.name}" and its ${doc.stepCount} step${doc.stepCount === 1 ? '' : 's'}? This cannot be undone.`,
                onConfirm: () => deleteDoc(doc.id),
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

/** Top-bar control: a Record button, or the live recording chip. */
export function RecordControl() {
  const recording = useStore((s) => s.recording);
  const openModal = useStore((s) => s.openModal);
  const docCall = useStore((s) => s.docCall);
  const stopRecording = useStore((s) => s.stopRecording);
  const openTab = useStore((s) => s.openTab);

  if (!recording) {
    return (
      <button
        className="btn btn-sm rec-start"
        title="Document a test run: record the requests you send, in order"
        onClick={() => openModal({ type: 'startRecording' })}
      >
        <span className="rec-dot" /> Record
      </button>
    );
  }

  return (
    <>
      <button
        className="icon-btn shot-btn"
        title={`Add a screenshot to "${recording.name}" (${navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl'}+Shift+S, works from any app)`}
        onClick={() => openModal({ type: 'screenshot' })}
      >
        <IconCamera width={15} height={15} />
      </button>
      <Dropdown
        align="right"
        trigger={(open) => (
          <button className={`rec-chip ${recording.paused ? 'paused' : ''}`} onClick={open} title="Recording controls">
            <span className={`rec-dot ${recording.paused ? '' : 'pulse'}`} />
            <span className="ellipsis" style={{ maxWidth: 160 }}>{recording.name}</span>
            <span className="rec-count">{recording.stepCount}</span>
          </button>
        )}
      >
        <Item onClick={() => openTab(recording.docId)} icon={<IconDoc width={12} height={12} />}>Open doc</Item>
        <Item onClick={() => docCall('setRecording', { paused: !recording.paused })} icon={recording.paused ? <IconPlay width={12} height={12} /> : <IconPause width={12} height={12} />}>
          {recording.paused ? 'Resume' : 'Pause'}
        </Item>
        <Item onClick={() => docCall('setRecording', { mode: recording.mode === 'auto' ? 'manual' : 'auto' })}>
          {recording.mode === 'auto' ? 'Switch to manual (add responses yourself)' : 'Switch to auto (record every send)'}
        </Item>
        <Separator />
        <Item danger onClick={stopRecording} icon={<IconStop width={12} height={12} />}>Stop recording</Item>
      </Dropdown>
    </>
  );
}

/** "+ Add to doc" on a response, shown while a recording is running. */
export function AddToDocButton({ requestId }) {
  const recording = useStore((s) => s.recording);
  const added = useStore((s) => s.addedToDoc[requestId]);
  const addResponseToDoc = useStore((s) => s.addResponseToDoc);
  if (!recording || !requestId) return null;
  if (added) {
    return (
      <span className="doc-added" title={`This response is in "${recording.name}"`}>
        ✓ In doc
      </span>
    );
  }
  return (
    <button className="btn btn-sm add-to-doc" title={`Add this request and response to "${recording.name}"`} onClick={() => addResponseToDoc(requestId)}>
      + Add to doc
    </button>
  );
}

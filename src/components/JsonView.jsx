import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { useStore, api, registerLiveJson } from '../store.js';
import Dropdown, { Item, Separator } from './Dropdown.jsx';
import {
  IconBraces, IconClose, IconPlus, IconSparkle, IconWrap, IconCopy, IconDownload, IconMore, IconTrash,
  IconSearch, IconChevronRight, IconExpandAll, IconCollapseAll, IconFolderOpen,
} from './Icons.jsx';
import { prettyBytes } from '../lib/format.js';
import {
  parseJson, formatJson, nodeAt, nodeStart, stateKey, findByKey, jsonPath, keyName, countLabel,
  previewText, visibleNodes, filterTree, copyText, embeddedJson, beautifyIfValid,
} from '../lib/jsonTree.mjs';
import {
  createJsonState, configureJsonView, revealRange, placeCursor, stashJsonState, takeJsonState, pruneJsonStates,
  fromTree, setErrorAt,
} from '../lib/jsonEditor.js';

/**
 * The JSON viewer: a tab per file, and in each a structured outline on the
 * left and the raw text on the right, kept in step both ways. Pick a value in
 * the outline and its whole text is highlighted; move the cursor in the text
 * and the outline follows.
 */
export default function JsonWorkbench({ theme }) {
  const activeId = useStore((s) => s.state?.ui?.jsonActiveId);
  const files = useStore((s) => s.jsonFiles);
  const loaded = useStore((s) => s.jsonLoaded);
  const addDroppedJsonFiles = useStore((s) => s.addDroppedJsonFiles);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  const active = activeId ? files.find((f) => f.id === activeId) : null;

  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(files.map((f) => f.id));
    pruneJsonStates(ids);
    for (const id of fileMemory.keys()) if (!ids.has(id)) fileMemory.delete(id);
  }, [files, loaded]);

  // Dropped files open as new files. Caught on the way down, so the editor
  // doesn't paste a dropped file's text into the open one instead.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const dragProps = {
    onDragEnterCapture: (e) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDropping(true);
    },
    onDragOverCapture: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation(); // no drop caret in the editor: the file won't be pasted there
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeaveCapture: (e) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropping(false);
    },
    onDropCapture: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDropping(false);
      addDroppedJsonFiles([...e.dataTransfer.files]);
    },
  };

  return (
    <div className="json-workbench" {...dragProps}>
      <JsonTabBar />
      {!loaded ? (
        <div className="response-placeholder">Loading…</div>
      ) : active ? (
        <JsonFileView key={active.id} file={active} theme={theme} />
      ) : (
        <JsonEmptyState />
      )}
      {dropping && (
        <div className="json-drop">
          <IconBraces width={28} height={28} />
          Drop JSON files to open them
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- tab bar */

function JsonTabBar() {
  const tabs = useStore((s) => s.state?.ui?.jsonTabs || []);
  const activeId = useStore((s) => s.state?.ui?.jsonActiveId);
  const files = useStore((s) => s.jsonFiles);
  const openJsonFile = useStore((s) => s.openJsonFile);
  const closeJsonTab = useStore((s) => s.closeJsonTab);
  const createJsonFile = useStore((s) => s.createJsonFile);
  const openModal = useStore((s) => s.openModal);
  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const bar = useRef(null);

  // Keep the active tab in sight when there are more tabs than fit.
  useLayoutEffect(() => {
    bar.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  // A plain mouse wheel scrolls the tabs sideways.
  useEffect(() => {
    const el = bar.current;
    const onWheel = (e) => {
      if (e.deltaY && !e.deltaX && el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="tabbar" ref={bar}>
      {tabs.map((id) => {
        const file = byId.get(id);
        if (!file) return null;
        return (
          <div
            key={id}
            className={`tab ${id === activeId ? 'active' : ''}`}
            onClick={() => openJsonFile(id)}
            onAuxClick={(e) => e.button === 1 && closeJsonTab(id)}
            onDoubleClick={() => openModal({ type: 'renameJson', id, name: file.name })}
            title={`${file.name} · ${prettyBytes(file.size)} — double-click to rename`}
          >
            <IconBraces width={13} height={13} className="json-tab-icon" />
            <span className="tab-name">{file.name}</span>
            <button
              className="tab-close"
              title="Close (the file stays in the list)"
              onClick={(e) => {
                e.stopPropagation();
                closeJsonTab(id);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <IconClose width={11} height={11} />
            </button>
          </div>
        );
      })}
      <button className="tab-add" title="New JSON file" onClick={() => createJsonFile()}>
        <IconPlus width={13} height={13} />
      </button>
    </div>
  );
}

/* ----------------------------------------------------------- empty state */

function JsonEmptyState() {
  const createJsonFile = useStore((s) => s.createJsonFile);
  const importJsonFiles = useStore((s) => s.importJsonFiles);
  const showToast = useStore((s) => s.showToast);
  const hasFiles = useStore((s) => s.jsonFiles.length > 0);
  const mod = navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl';

  const pasteAsFile = async () => {
    const text = await api.readClipboard();
    if (!text?.trim()) return showToast('The clipboard is empty');
    await createJsonFile({ content: beautifyIfValid(text, useStore.getState().state?.ui?.jsonIndent ?? 2) });
  };

  return (
    <div className="json-empty">
      <div className="json-empty-mark">
        <IconBraces width={26} height={26} />
      </div>
      <div className="json-empty-title">JSON viewer</div>
      <p>Paste JSON into a file to beautify it and explore it as a tree, next to the raw text.</p>
      <div className="json-empty-actions">
        <button className="btn btn-primary" onClick={() => createJsonFile()}>
          <IconPlus width={13} height={13} /> New file
        </button>
        <button className="btn" onClick={pasteAsFile}>Paste from clipboard</button>
        <button className="btn" onClick={importJsonFiles}>
          <IconFolderOpen width={13} height={13} /> Open file…
        </button>
      </div>
      <div className="json-empty-tips">
        {hasFiles && <div>Or open one of your files from the list on the left.</div>}
        <div>You can also drop .json files here.</div>
        <div>
          <span className="kbd">{mod}</span> <span className="kbd">N</span> new file · <span className="kbd">{mod}</span>{' '}
          <span className="kbd">Shift</span> <span className="kbd">F</span> beautify · <span className="kbd">{mod}</span>{' '}
          <span className="kbd">J</span> back to requests
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- one file */

// What each file's page looked like when you left it: open rows, the
// selection, the filter, the outline's scroll position.
const fileMemory = new Map();
const MAX_REMEMBERED = 40;
const DEFAULT_EXPAND = { base: 'auto', open: new Set(), closed: new Set() };

/**
 * Is a container open, given the expand state? 'auto' opens everything in
 * small documents and the top levels in big ones. The node's key is only
 * worked out when some row was opened or closed by hand.
 */
function openIn(expand, node, text, autoDepth) {
  if (expand.open.size || expand.closed.size) {
    const key = stateKey(text, node);
    if (expand.closed.has(key)) return false;
    if (expand.open.has(key)) return true;
  }
  if (expand.base === 'all') return true;
  if (expand.base === 'none') return node.depth === 0;
  return node.depth < autoDepth;
}

const autoDepthFor = (count) => (count <= 5000 ? Infinity : count <= 50000 ? 2 : 1);

function JsonFileView({ file, theme }) {
  const fileId = file.id;
  const wrap = useStore((s) => !!s.state?.ui?.jsonWrap);
  const indent = useStore((s) => s.state?.ui?.jsonIndent ?? 2);
  const savedWidth = useStore((s) => s.state?.ui?.jsonOutlineWidth);
  const patchUi = useStore((s) => s.patchUi);
  const showToast = useStore((s) => s.showToast);
  const openModal = useStore((s) => s.openModal);
  const createJsonFile = useStore((s) => s.createJsonFile);
  const duplicateJsonFile = useStore((s) => s.duplicateJsonFile);
  const deleteJsonFile = useStore((s) => s.deleteJsonFile);
  const saveJsonToDisk = useStore((s) => s.saveJsonToDisk);

  const memory = useRef(fileMemory.get(fileId)).current;
  const [loaded, setLoaded] = useState(null); // { text } once read, { missing: true } if gone
  const [parsed, setParsed] = useState(null); // { version, text, result, good: { text, root, count } | null }
  const [selectedKey, setSelectedKey] = useState(memory?.selectedKey ?? null);
  const [expand, setExpand] = useState(memory?.expand ?? DEFAULT_EXPAND);
  const [query, setQuery] = useState(memory?.query ?? '');
  const [filterQuery, setFilterQuery] = useState(memory?.query ?? '');
  const [filterOpen, setFilterOpen] = useState(() => new Set());
  const [cursor, setCursor] = useState({ line: 1, column: 1, lines: 1 });
  const [scrollRequest, setScrollRequest] = useState(0);
  const [menu, setMenu] = useState(null); // { x, y, node }
  const [width, setWidth] = useState(savedWidth ?? 340);
  const [resizing, setResizing] = useState(false);

  const viewRef = useRef(null);
  const parsedRef = useRef(null);
  const parseMs = useRef(0); // how long the last parse took
  const versionRef = useRef(0); // bumped on every edit; a parse is current when it has the same number
  const dirty = useRef(false);
  const pendingSync = useRef(false);
  const timers = useRef({}); // timeouts
  const cursorFrame = useRef(0);
  const treeScroll = useRef(memory?.treeScroll ?? 0);
  const splitRef = useRef(null);
  const latest = useRef({});
  latest.current = { expand, selectedKey, query, filterOpen };

  useEffect(() => {
    let cancelled = false;
    api.json('get', fileId).then((f) => {
      if (!cancelled) setLoaded(f ? { text: f.content } : { missing: true });
    });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // Remember this page for when you come back to the file.
  useEffect(
    () => () => {
      const { expand: e, selectedKey: k, query: q } = latest.current;
      fileMemory.delete(fileId);
      fileMemory.set(fileId, { expand: e, selectedKey: k, query: q, treeScroll: treeScroll.current });
      while (fileMemory.size > MAX_REMEMBERED) fileMemory.delete(fileMemory.keys().next().value);
    },
    [fileId]
  );

  // The filter follows typing after a short pause; matches open fresh each time.
  useEffect(() => {
    const t = setTimeout(() => setFilterQuery(query), 180);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => setFilterOpen(new Set()), [filterQuery]);

  // A window closing with an edit still waiting to be saved.
  useEffect(() => {
    const onUnload = () => {
      if (dirty.current && viewRef.current) {
        dirty.current = false;
        api.jsonFlushSync(fileId, viewRef.current.state.doc.toString());
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [fileId]);

  useEffect(
    () => () => {
      Object.values(timers.current).forEach((t) => clearTimeout(t));
      cancelAnimationFrame(cursorFrame.current);
    },
    []
  );

  /* ---------------------------------------------------- the text side */

  const good = parsed?.good || null;
  const autoDepth = autoDepthFor(good?.count ?? 0);

  const saveNow = async () => {
    clearTimeout(timers.current.save);
    const view = viewRef.current;
    if (!dirty.current || !view) return;
    dirty.current = false;
    const out = await api.json('update', fileId, { content: view.state.doc.toString() });
    // No answer for a file that still exists means the text is over the size limit.
    if (!out && useStore.getState().jsonFiles.some((f) => f.id === fileId)) {
      showToast('This file is too big to save — the limit is 50 MB');
    }
  };

  /**
   * Parse the editor's text now (`known` is that text, when the caller has it).
   * The tree keeps the last valid version while the text has an error.
   */
  const runParse = (known) => {
    clearTimeout(timers.current.parse);
    const view = viewRef.current;
    if (!view) return parsedRef.current;
    const started = performance.now();
    const text = typeof known === 'string' ? known : view.state.doc.toString();
    const result = parseJson(text);
    parseMs.current = performance.now() - started;
    const previous = parsedRef.current?.good || null;
    const entry = {
      version: versionRef.current,
      text,
      result,
      good: result.ok ? { text, root: result.root, count: result.count } : result.empty ? null : previous,
    };
    parsedRef.current = entry;
    setParsed(entry);
    view.dispatch({ effects: setErrorAt.of(result.error ? result.error.offset : null) });
    if (pendingSync.current) {
      pendingSync.current = false;
      syncTreeToCursor();
    }
    return entry;
  };

  /** The parse for the text as it is right now. */
  const currentParse = () => (parsedRef.current?.version === versionRef.current ? parsedRef.current : runParse());

  /** Open every container above a node, so its row is visible. */
  const reveal = (node, text) => {
    const { expand: e } = latest.current;
    const depthRule = autoDepthFor(parsedRef.current?.good?.count ?? 0);
    const keys = [];
    for (let p = node.parent; p; p = p.parent) {
      if (!openIn(e, p, text, depthRule)) keys.push(stateKey(text, p));
    }
    if (!keys.length) return;
    setExpand((prev) => {
      const open = new Set(prev.open);
      const closed = new Set(prev.closed);
      for (const key of keys) {
        closed.delete(key);
        open.add(key);
      }
      return { ...prev, open, closed };
    });
  };

  /** The cursor moved in the text: pick the value it is in. */
  const syncTreeToCursor = () => {
    const view = viewRef.current;
    const p = parsedRef.current;
    if (!view || !p) return;
    if (p.version !== versionRef.current) {
      pendingSync.current = true; // the parse in flight will call back
      return;
    }
    if (!p.result.ok) return;
    const node = nodeAt(p.result.root, view.state.selection.main.head);
    reveal(node, p.text);
    setSelectedKey(stateKey(p.text, node));
    setScrollRequest((n) => n + 1);
  };

  const onEditorUpdate = (update) => {
    if (update.docChanged) {
      versionRef.current++;
      dirty.current = true;
      // Parsing and saving a huge document takes a moment of the window's
      // time, so it waits for a longer pause in the typing.
      const size = update.state.doc.length;
      clearTimeout(timers.current.save);
      timers.current.save = setTimeout(saveNow, size > 5_000_000 ? 1500 : 500);
      clearTimeout(timers.current.parse);
      const wait = size < 200_000 ? 120 : size < 2_000_000 ? 350 : 800;
      timers.current.parse = setTimeout(runParse, Math.min(5000, Math.max(wait, parseMs.current * 2)));
    }
    if (update.docChanged || update.selectionSet) {
      cancelAnimationFrame(cursorFrame.current);
      cursorFrame.current = requestAnimationFrame(() => {
        const view = viewRef.current;
        if (!view) return;
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        setCursor({ line: line.number, column: head - line.from + 1, lines: view.state.doc.lines });
      });
    }
    if (update.selectionSet && !update.transactions.some((tr) => tr.annotation(fromTree))) {
      clearTimeout(timers.current.sync);
      timers.current.sync = setTimeout(syncTreeToCursor, 60);
    }
  };

  const attach = (view) => {
    viewRef.current = view;
    runParse();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    setCursor({ line: line.number, column: head - line.from + 1, lines: view.state.doc.lines });
    // A new, empty file is waiting for a paste.
    if (view.state.doc.length === 0) view.focus();
  };

  const detach = (view) => {
    if (dirty.current) {
      dirty.current = false;
      api.json('update', fileId, { content: view.state.doc.toString() });
    }
    Object.values(timers.current).forEach((t) => clearTimeout(t));
    cancelAnimationFrame(cursorFrame.current);
    viewRef.current = null;
  };

  // Things that run later (timers, the editor's listener, the store) go
  // through this, so they always see the current render.
  const ctl = useRef({});
  Object.assign(ctl.current, { onEditorUpdate, attach, detach, saveNow });

  useEffect(
    () =>
      registerLiveJson({
        id: fileId,
        flush: () => ctl.current.saveNow(),
        head: (max) => viewRef.current?.state.doc.sliceString(0, max) ?? '',
        length: () => viewRef.current?.state.doc.length ?? 0,
      }),
    [fileId]
  );

  /* ---------------------------------------------------- the tree side */

  // A menu belongs to the parse it was opened on.
  useEffect(() => setMenu(null), [good]);

  const filter = useMemo(
    () => (good ? filterTree(good.text, good.root, filterQuery) : null),
    [good, filterQuery]
  );

  const isOpen = useMemo(() => {
    if (!good) return () => false;
    if (filter) return filterOpen.size ? (node) => filterOpen.has(stateKey(good.text, node)) : () => false;
    return (node) => openIn(expand, node, good.text, autoDepth);
  }, [good, filter, filterOpen, expand, autoDepth]);

  const rows = useMemo(() => (good ? visibleNodes(good.root, isOpen, filter) : []), [good, isOpen, filter]);

  const selectedNode = useMemo(
    () => (good && selectedKey != null ? findByKey(good.text, good.root, selectedKey) : null),
    [good, selectedKey]
  );

  const toggle = (node) => {
    if (!good || !node.children?.length) return;
    const key = stateKey(good.text, node);
    if (filter) {
      if (filter.leadsTo.has(node)) return; // the way to a match stays open while filtering
      setFilterOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      });
      return;
    }
    const wasOpen = isOpen(node);
    setExpand((prev) => {
      const open = new Set(prev.open);
      const closed = new Set(prev.closed);
      if (wasOpen) {
        open.delete(key);
        closed.add(key);
      } else {
        closed.delete(key);
        open.add(key);
      }
      return { ...prev, open, closed };
    });
  };

  const expandAll = () => {
    if (filter) {
      setFilterOpen(new Set([...filter.matches].filter((n) => n.children?.length).map((n) => stateKey(good.text, n))));
    } else {
      setExpand({ base: 'all', open: new Set(), closed: new Set() });
    }
  };

  const collapseAll = () => {
    if (filter) setFilterOpen(new Set());
    else setExpand({ base: 'none', open: new Set(), closed: new Set() });
  };

  /** Pick a value in the tree: highlight it in the text (or select it there, with focus). */
  const selectFromTree = (node, { focus = false, scroll = false } = {}) => {
    const shown = parsedRef.current?.good;
    if (!shown) return;
    const key = stateKey(shown.text, node);
    setSelectedKey(key);
    if (scroll) setScrollRequest((n) => n + 1);
    const view = viewRef.current;
    if (!view) return;
    const current = currentParse();
    // While the text has an error the tree shows the last valid version, which no longer lines up.
    if (!current.result.ok) return;
    const target = current.result.root === shown.root ? node : findByKey(current.text, current.result.root, key);
    if (!target) return;
    revealRange(view, nodeStart(target), target.to, { select: focus });
    if (focus) view.focus();
  };

  /* -------------------------------------------------------- formatting */

  const goToError = () => {
    const view = viewRef.current;
    const error = currentParse()?.result.error;
    if (!view || !error) return;
    placeCursor(view, error.offset);
    view.focus();
  };

  const reformat = (mode) => {
    const view = viewRef.current;
    if (!view) return;
    const p = currentParse();
    if (p.result.empty) return showToast('Nothing to format yet — paste some JSON first');
    if (!p.result.ok) {
      goToError();
      return showToast(`Fix this first: line ${p.result.error.line}, column ${p.result.error.column} — ${p.result.error.message}`);
    }
    let out;
    try {
      out = formatJson(p.text, p.result.root, { indent, minify: mode === 'minify', sortKeys: mode === 'sort' });
    } catch (err) {
      return showToast(err instanceof RangeError ? 'This JSON is nested too deeply to format' : `Could not format: ${err.message}`);
    }
    if (out === p.text) {
      return showToast(mode === 'minify' ? 'Already minified' : mode === 'sort' ? 'Keys are already sorted' : 'Already beautified');
    }
    // Stay on the same value through the reformat.
    const keyAtCursor = stateKey(p.text, nodeAt(p.result.root, view.state.selection.main.head));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: out }, userEvent: 'input.format' });
    const next = runParse(out);
    if (!next.result.ok) return;
    const node = findByKey(next.text, next.result.root, keyAtCursor) || next.result.root;
    placeCursor(view, nodeStart(node), { center: true });
  };

  /* ------------------------------------------------------------ copying */

  const copy = async (text, what) => {
    await api.copyToClipboard(text);
    showToast(`${what} copied`);
  };

  const copyValue = (node) => {
    if (!good) return;
    copy(copyText(good.text, node, { indent }), node.children ? (node.type === 'array' ? 'Array' : 'Object') : 'Value');
  };

  /** A value (or the JSON inside a string value) as a file of its own. */
  const openAsFile = async (node, inner) => {
    const base = file.name.replace(/\.json$/i, '');
    const label = node.parent ? (node.keyFrom >= 0 ? keyName(good.text, node) : `${node.index}`) : 'root';
    let content;
    try {
      content = inner != null ? beautifyIfValid(inner, indent) : formatJson(good.text, node, { indent });
    } catch {
      return showToast('This value is nested too deeply to open on its own');
    }
    await createJsonFile({ name: `${base} - ${label}.json`, content });
  };

  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      reformat('beautify');
    }
  };

  /* ------------------------------------------------------------ resize */

  const startResize = (e) => {
    e.preventDefault();
    const rect = splitRef.current.getBoundingClientRect();
    let next = width;
    setResizing(true);
    const onMove = (ev) => {
      next = Math.round(Math.min(rect.width - 260, Math.max(200, ev.clientX - rect.left)));
      setWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      patchUi({ jsonOutlineWidth: next });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (loaded?.missing) {
    return <div className="response-placeholder">This file no longer exists.</div>;
  }

  const result = parsed?.result;
  const stale = !!(good && result && !result.ok);

  return (
    <div className="json-view" onKeyDown={onKeyDown}>
      <div className="json-toolbar">
        <button className="btn btn-sm btn-primary" title={`Beautify (${navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl'}+Shift+F)`} onClick={() => reformat('beautify')}>
          <IconSparkle width={12} height={12} /> Beautify
        </button>
        <button className="btn btn-sm" title="Remove all the whitespace" onClick={() => reformat('minify')}>
          Minify
        </button>
        <button className="btn btn-sm" title="Sort the keys of every object A to Z, and beautify" onClick={() => reformat('sort')}>
          Sort keys
        </button>
        <select
          className="select json-indent"
          title="Indentation used by Beautify"
          value={String(indent)}
          onChange={(e) => patchUi({ jsonIndent: e.target.value === 'tab' ? 'tab' : Number(e.target.value) })}
        >
          <option value="2">2 spaces</option>
          <option value="4">4 spaces</option>
          <option value="tab">Tabs</option>
        </select>
        <div className="grow" />
        <button
          className={`icon-btn ${wrap ? 'on' : ''}`}
          title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
          aria-pressed={wrap}
          onClick={() => patchUi({ jsonWrap: !wrap })}
        >
          <IconWrap />
        </button>
        <button className="icon-btn" title="Copy all" onClick={() => viewRef.current && copy(viewRef.current.state.doc.toString(), 'JSON')}>
          <IconCopy />
        </button>
        <button className="icon-btn" title="Save to a file…" onClick={() => saveJsonToDisk(fileId)}>
          <IconDownload />
        </button>
        <Dropdown
          align="right"
          trigger={(open) => (
            <button className="icon-btn" title="More" onClick={open}>
              <IconMore />
            </button>
          )}
        >
          <Item onClick={() => openModal({ type: 'renameJson', id: fileId, name: file.name })}>Rename…</Item>
          <Item onClick={() => duplicateJsonFile(fileId)} icon={<IconCopy width={12} height={12} />}>
            Duplicate
          </Item>
          <Item onClick={() => saveJsonToDisk(fileId)} icon={<IconDownload width={12} height={12} />}>
            Save to a file…
          </Item>
          <Separator />
          <Item
            danger
            icon={<IconTrash width={12} height={12} />}
            onClick={() =>
              openModal({
                type: 'confirm',
                title: 'Delete file',
                message: `Delete "${file.name}"? This cannot be undone.`,
                onConfirm: () => deleteJsonFile(fileId),
              })
            }
          >
            Delete
          </Item>
        </Dropdown>
      </div>

      <div className={`json-split ${resizing ? 'resizing' : ''}`} ref={splitRef}>
        <div className="json-outline" style={{ width }}>
          <div className="json-outline-head">
            <div className="search-box">
              <IconSearch width={12} height={12} className="dim" />
              <input
                value={query}
                placeholder="Filter keys and values"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              />
              {query && (
                <button className="icon-btn json-filter-clear" title="Clear the filter" onClick={() => setQuery('')}>
                  <IconClose width={10} height={10} />
                </button>
              )}
            </div>
            <button className="icon-btn" title="Expand all" onClick={expandAll} disabled={!good}>
              <IconExpandAll />
            </button>
            <button className="icon-btn" title="Collapse all" onClick={collapseAll} disabled={!good}>
              <IconCollapseAll />
            </button>
          </div>

          {stale && (
            <div className="json-stale">
              The text has an error, so this is the last valid version.{' '}
              <button className="link-btn" onClick={goToError}>
                Show error
              </button>
            </div>
          )}
          {filter && (
            <div className="json-filter-count">
              {filter.matches.size === 0 ? 'No matches' : `${filter.matches.size} match${filter.matches.size === 1 ? '' : 'es'}`}
            </div>
          )}

          {!parsed ? (
            <div className="json-outline-note">Loading…</div>
          ) : good ? (
            <JsonTree
              text={good.text}
              rows={rows}
              stale={stale}
              selectedNode={selectedNode}
              scrollRequest={scrollRequest}
              initialScroll={treeScroll.current}
              onScrollTop={(top) => (treeScroll.current = top)}
              isOpen={isOpen}
              filter={filter}
              onToggle={toggle}
              onSelect={selectFromTree}
              onCopy={copyValue}
              onContextMenu={(node, x, y) => {
                selectFromTree(node);
                setMenu({ x, y, node });
              }}
            />
          ) : result?.error ? (
            <div className="json-outline-note error">
              <b>Not valid JSON yet</b>
              <span>
                Line {result.error.line}, column {result.error.column}: {result.error.message}
              </span>
              <button className="btn btn-sm" onClick={goToError}>Show me</button>
            </div>
          ) : (
            <div className="json-outline-note">
              Paste or type JSON on the right.
              <br />
              Its structure shows up here.
            </div>
          )}
        </div>

        <div className="resizer" onMouseDown={startResize} title="Drag to resize" />

        <div className="json-raw">
          {loaded ? (
            <JsonEditorPane fileId={fileId} text={loaded.text} theme={theme} wrap={wrap} ctl={ctl} />
          ) : (
            <div className="response-placeholder">Loading…</div>
          )}
        </div>
      </div>

      <div className="json-status">
        {!result ? (
          <span />
        ) : result.ok ? (
          <span className="json-ok">✓ Valid JSON</span>
        ) : result.empty ? (
          <span className="dim">Empty</span>
        ) : (
          <button className="json-err" title="Go to the error" onClick={goToError}>
            ✕ Line {result.error.line}, column {result.error.column}: {result.error.message}
          </button>
        )}
        {selectedNode && good && (
          <span className="json-path" title="The selected value's path">
            <code>{jsonPath(good.text, selectedNode)}</code>
            <button className="icon-btn" title="Copy path" onClick={() => copy(jsonPath(good.text, selectedNode), 'Path')}>
              <IconCopy width={11} height={11} />
            </button>
          </span>
        )}
        <span className="grow" />
        <span className="dim">
          Ln {cursor.line}, Col {cursor.column} · {cursor.lines} {cursor.lines === 1 ? 'line' : 'lines'} · {prettyBytes(file.size)}
        </span>
      </div>

      {menu && good && (
        <NodeMenu
          menu={menu}
          text={good.text}
          onClose={() => setMenu(null)}
          onCopyValue={() => copyValue(menu.node)}
          onCopyPath={() => copy(jsonPath(good.text, menu.node), 'Path')}
          onCopyKey={() => copy(keyName(good.text, menu.node), 'Key')}
          onOpenAsFile={(inner) => openAsFile(menu.node, inner)}
          onShowInText={() => selectFromTree(menu.node, { focus: true })}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------- raw editor */

/**
 * The CodeMirror pane. It owns the text from the moment it mounts: edits go
 * out through the update listener, and nothing pushes the text back in, so a
 * big document is never copied on every keystroke.
 */
function JsonEditorPane({ fileId, text, theme, wrap, ctl }) {
  const host = useRef(null);
  const viewRef = useRef(null);

  useEffect(() => {
    const options = { theme, wrap, onUpdate: (update) => ctl.current.onEditorUpdate(update) };
    const cached = takeJsonState(fileId, text);
    const view = new EditorView({ state: cached ? cached.state : createJsonState(text, options), parent: host.current });
    if (cached) {
      configureJsonView(view, options);
      if (cached.scroll) view.dispatch({ effects: cached.scroll });
    }
    viewRef.current = view;
    ctl.current.attach(view);
    return () => {
      ctl.current.detach(view);
      stashJsonState(fileId, view);
      view.destroy();
      viewRef.current = null;
    };
    // `text` is only where the editor starts; it is not followed afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  useEffect(() => {
    if (viewRef.current) configureJsonView(viewRef.current, { theme, wrap });
  }, [theme, wrap]);

  return <div className="json-editor" ref={host} />;
}

/* ------------------------------------------------------------ the tree */

const ROW_HEIGHT = 22;
const OVERSCAN = 12;
// Browsers can't lay out an element much taller than ~33 million px. Past
// this height the scrollbar is scaled: it covers the whole list, and each
// pixel of it moves the list by more than a pixel.
const MAX_SCROLL_HEIGHT = 10_000_000;

/** How the scroll position maps onto the list, for a list of `count` rows in a viewport of `height`. */
function scrollGeometry(count, height) {
  const total = count * ROW_HEIGHT;
  const inner = Math.min(total, MAX_SCROLL_HEIGHT);
  const range = Math.max(0, total - height); // how far the list itself moves
  const scrollRange = Math.max(0, inner - height); // how far the scrollbar moves
  const scale = scrollRange > 0 && total > MAX_SCROLL_HEIGHT ? range / scrollRange : 1;
  return { inner, scale };
}

/**
 * The outline. Only the rows in view are rendered, so a document with a
 * million values scrolls as easily as a small one.
 */
function JsonTree({
  text, rows, stale, selectedNode, scrollRequest, initialScroll, onScrollTop, isOpen, filter,
  onToggle, onSelect, onCopy, onContextMenu,
}) {
  const scroller = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const restored = useRef(false);
  const handledRequest = useRef(scrollRequest);

  useLayoutEffect(() => {
    const el = scroller.current;
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Come back to where the outline was scrolled, once there are rows to scroll.
  useLayoutEffect(() => {
    if (restored.current || rows.length === 0) return;
    restored.current = true;
    if (initialScroll) {
      scroller.current.scrollTop = initialScroll;
      setViewport({ top: scroller.current.scrollTop, height: scroller.current.clientHeight });
    }
  }, [rows.length, initialScroll]);

  const selectedIndex = useMemo(() => (selectedNode ? rows.indexOf(selectedNode) : -1), [rows, selectedNode]);

  const { inner, scale } = scrollGeometry(rows.length, viewport.height);

  // Bring the selected row into view when asked (the cursor moved, or the keyboard did).
  useLayoutEffect(() => {
    if (scrollRequest === handledRequest.current) return;
    handledRequest.current = scrollRequest;
    if (selectedIndex < 0) return;
    const el = scroller.current;
    const at = scrollGeometry(rows.length, el.clientHeight).scale;
    const listTop = el.scrollTop * at; // where the list is scrolled to, in rows' pixels
    const top = selectedIndex * ROW_HEIGHT;
    if (top < listTop) el.scrollTop = top / at;
    else if (top + ROW_HEIGHT > listTop + el.clientHeight) el.scrollTop = (top + ROW_HEIGHT - el.clientHeight) / at;
  }, [scrollRequest, selectedIndex, rows.length]);

  const select = (index) => {
    const node = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (node) onSelect(node, { scroll: true });
  };

  // Copy the selected value. Ctrl+C arrives as a key press on Windows and
  // Linux, but on a Mac the Edit menu turns Cmd+C into a copy event first.
  const lastCopy = useRef(0);
  const copySelected = () => {
    const node = rows[selectedIndex];
    if (!node || Date.now() - lastCopy.current < 200) return !!node;
    lastCopy.current = Date.now();
    onCopy(node);
    return true;
  };
  const copyRef = useRef(copySelected);
  copyRef.current = copySelected;
  useEffect(() => {
    const onDocCopy = (e) => {
      if (document.activeElement !== scroller.current) return;
      if (copyRef.current()) e.preventDefault();
    };
    document.addEventListener('copy', onDocCopy, true);
    return () => document.removeEventListener('copy', onDocCopy, true);
  }, []);

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
      if (copySelected()) e.preventDefault();
      return;
    }
    if (!rows.length || e.altKey || e.ctrlKey || e.metaKey) return;
    const node = rows[selectedIndex];
    const page = Math.max(1, Math.floor(scroller.current.clientHeight / ROW_HEIGHT) - 1);
    const handled = {
      ArrowDown: () => select(selectedIndex + 1),
      ArrowUp: () => select(selectedIndex < 0 ? 0 : selectedIndex - 1),
      PageDown: () => select(selectedIndex + page),
      PageUp: () => select(selectedIndex - page),
      Home: () => select(0),
      End: () => select(rows.length - 1),
      ArrowRight: () => {
        if (!node) return select(0);
        if (node.children?.length && !isOpen(node) && !filter?.leadsTo.has(node)) onToggle(node);
        else if (node.children?.length) select(selectedIndex + 1);
      },
      ArrowLeft: () => {
        if (!node) return select(0);
        // Close an open container (the way to a filter match can't close), else go up a level.
        if (node.children?.length && isOpen(node) && !filter?.leadsTo.has(node)) onToggle(node);
        else if (node.parent) select(rows.indexOf(node.parent));
      },
      Enter: () => node && onSelect(node, { focus: true }),
      ' ': () => node && onToggle(node),
    }[e.key];
    if (!handled) return;
    e.preventDefault();
    handled();
  };

  // Rows are placed relative to the scroll position, so this works with a scaled scrollbar too.
  const listTop = viewport.top * scale;
  const first = Math.max(0, Math.floor(listTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((listTop + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const shown = [];
  for (let i = first; i < last; i++) {
    const node = rows[i];
    const key = stateKey(text, node);
    shown.push(
      <TreeRow
        key={key}
        text={text}
        node={node}
        top={viewport.top + i * ROW_HEIGHT - listTop}
        open={!!node.children?.length && (filter?.leadsTo.has(node) || isOpen(node))}
        selected={i === selectedIndex}
        query={filter?.query}
        posinset={i + 1}
        setsize={rows.length}
        onToggle={onToggle}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
      />
    );
  }

  return (
    <div
      className={`json-tree ${stale ? 'stale' : ''}`}
      ref={scroller}
      tabIndex={0}
      role="tree"
      aria-label="JSON outline"
      onScroll={(e) => {
        setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight });
        onScrollTop(e.currentTarget.scrollTop);
      }}
      onKeyDown={onKeyDown}
      onFocus={() => {
        // A selection left behind in the editor would otherwise be what Copy copies.
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !scroller.current.contains(sel.anchorNode)) sel.removeAllRanges();
      }}
    >
      <div className="json-tree-inner" style={{ height: inner }}>
        {shown}
      </div>
    </div>
  );
}

function TreeRow({ text, node, top, open, selected, query, posinset, setsize, onToggle, onSelect, onContextMenu }) {
  const container = !!node.children;
  const expandable = container && node.children.length > 0;
  const isMember = node.keyFrom >= 0;

  return (
    <div
      className={`jt-row ${selected ? 'selected' : ''}`}
      style={{ top, paddingLeft: 4 + node.depth * 16 }}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-expanded={expandable ? open : undefined}
      aria-posinset={posinset}
      aria-setsize={setsize}
      onClick={() => onSelect(node)}
      onDoubleClick={() => onSelect(node, { focus: true })}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(node, e.clientX, e.clientY);
      }}
    >
      <span
        className={`jt-caret ${expandable ? '' : 'none'} ${open ? 'open' : ''}`}
        onClick={(e) => {
          if (!expandable) return;
          e.stopPropagation();
          onToggle(node);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {expandable && <IconChevronRight width={11} height={11} />}
      </span>
      <span className={`jt-dot jt-${node.type}`} />
      {isMember && <span className="jt-key">{marked(keyName(text, node), query)}</span>}
      {!isMember && node.parent && <span className="jt-index">{node.index}</span>}
      {container ? (
        <>
          <span className="jt-brace">{node.type === 'object' ? '{}' : '[]'}</span>
          <span className="jt-count">{countLabel(node)}</span>
        </>
      ) : (
        <span className={`jt-value jt-${node.type}`} title={node.to - node.from > 60 ? previewText(text, node, 2000) : undefined}>
          {marked(previewText(text, node), query)}
        </span>
      )}
    </div>
  );
}

/** Text with the filter's matches marked. */
function marked(label, query) {
  if (!query) return label;
  const lower = label.toLowerCase();
  if (lower.length !== label.length) return label; // positions wouldn't line up
  const parts = [];
  let at = 0;
  for (let hit = lower.indexOf(query); hit !== -1 && parts.length < 20; hit = lower.indexOf(query, at)) {
    if (hit > at) parts.push(label.slice(at, hit));
    parts.push(<mark key={hit}>{label.slice(hit, hit + query.length)}</mark>);
    at = hit + query.length;
  }
  if (!parts.length) return label;
  parts.push(label.slice(at));
  return parts;
}

/* -------------------------------------------------------- context menu */

function NodeMenu({ menu, text, onClose, onCopyValue, onCopyPath, onCopyKey, onOpenAsFile, onShowInText }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  const { node } = menu;
  const inner = useMemo(() => embeddedJson(text, node), [text, node]);

  useLayoutEffect(() => {
    const rect = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4)),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const dismiss = () => close.current();
    const onDown = (e) => !ref.current?.contains(e.target) && dismiss();
    const onKey = (e) => e.key === 'Escape' && dismiss();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
    };
  }, []);

  const run = (fn) => () => {
    onClose();
    fn();
  };

  return (
    <div ref={ref} className="dropdown json-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      <Item onClick={run(onCopyValue)} icon={<IconCopy width={12} height={12} />}>
        Copy value
      </Item>
      <Item onClick={run(onCopyPath)}>Copy path</Item>
      {node.keyFrom >= 0 && <Item onClick={run(onCopyKey)}>Copy key</Item>}
      <Separator />
      <Item onClick={run(onShowInText)}>Select in text</Item>
      {node.children?.length > 0 && <Item onClick={run(() => onOpenAsFile(null))}>Open in a new file</Item>}
      {inner && <Item onClick={run(() => onOpenAsFile(inner))}>Open the JSON inside this string</Item>}
    </div>
  );
}

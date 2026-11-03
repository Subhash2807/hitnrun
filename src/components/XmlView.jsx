import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { xml } from '@codemirror/lang-xml';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { EditorView } from '@codemirror/view';
import { useStore, api } from '../store.js';
import { IconSparkle, IconWrap, IconCopy, IconDownload, IconFolderOpen, IconTrash, IconCode } from './Icons.jsx';
import { prettyBytes } from '../lib/format.js';
import { parseXml, formatXml, countElements } from '../lib/xmlFormat.mjs';

/**
 * The XML formatter: paste or open XML, beautify or minify it, and see at a
 * glance whether it is well formed, and if not, where. The text is kept
 * between runs, like a scratch pad.
 */
export default function XmlWorkbench({ theme }) {
  const text = useStore((s) => s.xmlText);
  const setXmlText = useStore((s) => s.setXmlText);
  const indentSetting = useStore((s) => s.state?.ui?.xmlIndent ?? 2);
  const wrap = useStore((s) => s.state?.ui?.xmlWrap ?? false);
  const patchUi = useStore((s) => s.patchUi);
  const showToast = useStore((s) => s.showToast);
  const viewRef = useRef(null);
  const fileInput = useRef(null);
  const [dropping, setDropping] = useState(false);

  const indent = indentSetting === 'tab' ? '\t' : Number(indentSetting) || 2;
  const mod = navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl';

  // Checked as you type; a big document is only checked after a pause.
  const [checkedText, setCheckedText] = useState(text);
  useEffect(() => {
    if (text.length < 200_000) return setCheckedText(text);
    const t = setTimeout(() => setCheckedText(text), 300);
    return () => clearTimeout(t);
  }, [text]);
  const check = useMemo(() => {
    if (!checkedText.trim()) return null;
    const { nodes, error } = parseXml(checkedText);
    return { error, elements: nodes ? countElements(nodes) : 0 };
  }, [checkedText]);

  const extensions = useMemo(() => [xml(), ...(wrap ? [EditorView.lineWrapping] : [])], [wrap]);

  const replaceAll = (out) => {
    const view = viewRef.current;
    if (!view) return setXmlText(out);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: out }, userEvent: 'input.format' });
  };

  const reformat = (minify) => {
    if (!text.trim()) return showToast('Nothing to format yet — paste some XML first');
    let out;
    try {
      out = formatXml(text, { indent, minify });
    } catch (err) {
      if (err.line) goTo(err.line, err.col);
      return showToast(`Could not format: ${err.message}`);
    }
    if (out === text) return showToast(minify ? 'Already minified' : 'Already beautified');
    replaceAll(out);
  };

  const goTo = (line, col) => {
    const view = viewRef.current;
    if (!view) return;
    const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    const pos = Math.min(l.from + Math.max(0, col - 1), l.to);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  };

  const copyAll = async () => {
    await api.copyToClipboard(text);
    showToast('XML copied');
  };

  const save = async () => {
    const saved = await api.saveFile({ defaultPath: 'document.xml', filters: [{ name: 'XML', extensions: ['xml'] }], content: text });
    if (saved) showToast('Saved to ' + saved);
  };

  const loadFile = async (file) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return showToast('That file is over 20 MB, too big to open here');
    const content = await file.text();
    let out = content;
    try {
      out = formatXml(content, { indent });
    } catch { /* not well formed: open it as it is, and the status bar says why */ }
    replaceAll(out);
    showToast(`Opened ${file.name}`);
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      reformat(false);
    }
  };

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const dragProps = {
    onDragOverCapture: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDropping(true);
    },
    onDragLeaveCapture: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setDropping(false);
    },
    onDropCapture: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(false);
      loadFile(e.dataTransfer.files[0]);
    },
  };

  return (
    <div className="json-workbench xml-workbench" {...dragProps}>
      <div className="json-view" onKeyDown={onKeyDown}>
        <div className="json-toolbar">
          <span className="xml-title">
            <IconCode width={13} height={13} className="accent" /> XML formatter
          </span>
          <button className="btn btn-sm btn-primary" title={`Beautify (${mod}+Shift+F)`} onClick={() => reformat(false)}>
            <IconSparkle width={12} height={12} /> Beautify
          </button>
          <button className="btn btn-sm" title="Remove the whitespace between tags" onClick={() => reformat(true)}>
            Minify
          </button>
          <select
            className="select json-indent"
            title="Indentation used by Beautify"
            value={String(indentSetting)}
            onChange={(e) => patchUi({ xmlIndent: e.target.value === 'tab' ? 'tab' : Number(e.target.value) })}
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
            onClick={() => patchUi({ xmlWrap: !wrap })}
          >
            <IconWrap />
          </button>
          <button className="icon-btn" title="Open an .xml file" onClick={() => fileInput.current?.click()}>
            <IconFolderOpen />
          </button>
          <button className="icon-btn" title="Copy all" onClick={copyAll} disabled={!text}>
            <IconCopy />
          </button>
          <button className="icon-btn" title="Save to a file…" onClick={save} disabled={!text}>
            <IconDownload />
          </button>
          <button className="icon-btn" title="Clear" onClick={() => replaceAll('')} disabled={!text}>
            <IconTrash />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".xml,.xsd,.xsl,.xslt,.svg,.wsdl,.plist,.config,text/xml,application/xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              loadFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        <div className="cm-wrap xml-editor">
          <CodeMirror
            value={text}
            height="100%"
            theme={theme === 'light' ? vscodeLight : vscodeDark}
            extensions={extensions}
            placeholder={`Paste XML here, or drop an .xml file, then Beautify (${mod}+Shift+F)`}
            basicSetup={{ lineNumbers: true, foldGutter: true, bracketMatching: true, searchKeymap: true }}
            onCreateEditor={(view) => {
              viewRef.current = view;
            }}
            onChange={setXmlText}
          />
        </div>

        <div className="json-status">
          {!check ? (
            <span className="dim">Empty</span>
          ) : check.error ? (
            <button className="json-err" title="Go to the problem" onClick={() => goTo(check.error.line, check.error.col)}>
              ✕ Line {check.error.line}, column {check.error.col}: {check.error.message}
            </button>
          ) : (
            <span className="json-ok">✓ Well-formed XML</span>
          )}
          <div className="grow" />
          {check && check.elements > 0 && (
            <span className="dim">
              {check.elements.toLocaleString()} element{check.elements === 1 ? '' : 's'}
            </span>
          )}
          {text && <span className="dim">{prettyBytes(new TextEncoder().encode(text).length)}</span>}
        </div>
      </div>
      {dropping && (
        <div className="json-drop">
          <IconCode width={28} height={28} />
          Drop an XML file to open it
        </div>
      )}
    </div>
  );
}

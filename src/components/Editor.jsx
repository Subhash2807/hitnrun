import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { EditorView } from '@codemirror/view';

/**
 * Shared CodeMirror wrapper. Used for request bodies, scripts, and the
 * (read-only) response viewer.
 */
export default function Editor({
  value,
  onChange,
  language = 'text',
  readOnly = false,
  placeholder = '',
  wrap = true,
  theme = 'dark',
  height = '100%',
}) {
  const extensions = useMemo(() => {
    const ext = [];
    if (language === 'json') ext.push(json());
    else if (language === 'javascript') ext.push(javascript());
    else if (language === 'html') ext.push(html());
    else if (language === 'xml') ext.push(xml());
    if (wrap) ext.push(EditorView.lineWrapping);
    return ext;
  }, [language, wrap]);

  return (
    <div className="cm-wrap">
      <CodeMirror
        value={value ?? ''}
        height={height}
        theme={theme === 'light' ? vscodeLight : vscodeDark}
        extensions={extensions}
        editable={!readOnly}
        readOnly={readOnly}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: !readOnly,
          bracketMatching: true,
          closeBrackets: !readOnly,
          searchKeymap: true,
        }}
        onChange={onChange}
      />
    </div>
  );
}

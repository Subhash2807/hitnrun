import { useState } from 'react';
import { api } from '../store.js';

/**
 * A small Markdown renderer for chat replies.
 *
 * It builds React elements directly and never sets raw HTML: the text comes
 * from a model, and this window can reach the app's IPC bridge. Covers what
 * assistants actually write: headings, paragraphs, lists, quotes, tables,
 * fenced code, rules, and inline code / bold / italic / strike / links.
 * An unclosed fence (mid-stream) renders as code up to the end.
 */
export default function Markdown({ text }) {
  return <div className="md">{blocks(String(text || ''))}</div>;
}

function blocks(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      const close = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++; // closing fence (or past the end)
      out.push(<CodeBlock key={key++} lang={fence[2]} code={body.join('\n')} />);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const Tag = `h${Math.min(6, heading[1].length + 2)}`;
      out.push(<Tag key={key++}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }

    // Table: a header row followed by a |---|---| separator
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div className="md-table" key={key++}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key++}>{blocks(quoted.join('\n'))}</blockquote>);
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (bullet.test(line)) {
      const ordered = /\d/.test(line.match(bullet)[2]);
      const items = [];
      while (i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(bullet);
        if (m) items.push({ depth: Math.floor(m[1].length / 2), text: m[3] });
        else items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={key++}>
          {items.map((it, j) => (
            <li key={j} style={it.depth ? { marginLeft: it.depth * 16 } : undefined}>
              {inline(it.text)}
            </li>
          ))}
        </List>
      );
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    if (!para.length) para.push(lines[i++]);
    out.push(
      <p key={key++}>
        {para.map((l, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {inline(l)}
          </span>
        ))}
      </p>
    );
  }
  return out;
}

function cells(row) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

// Earliest match wins; code spans first so nothing inside them is formatted.
const INLINE = [
  { re: /`([^`]+)`/, render: (m, k) => <code key={k}>{m[1]}</code> },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, render: (m, k) => <Link key={k} href={m[2]}>{inline(m[1])}</Link> },
  { re: /\*\*([^*]+)\*\*|__([^_]+)__/, render: (m, k) => <strong key={k}>{inline(m[1] ?? m[2])}</strong> },
  { re: /~~([^~]+)~~/, render: (m, k) => <del key={k}>{inline(m[1])}</del> },
  { re: /(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<!\w)_([^_\s][^_]*?)_(?!\w)/, render: (m, k) => <em key={k}>{inline(m[1] ?? m[2])}</em> },
  { re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, render: (m, k) => <Link key={k} href={m[0]}>{m[0]}</Link> },
];

function inline(text) {
  const out = [];
  let rest = String(text);
  let k = 0;
  while (rest) {
    let best = null;
    for (const rule of INLINE) {
      const m = rest.match(rule.re);
      if (m && (best === null || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
    out.push(best.rule.render(best.m, k++));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

function Link({ href, children }) {
  const safe = /^https?:\/\//i.test(href);
  return (
    <a
      href={safe ? href : undefined}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (safe) api.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || 'text'}</span>
        <button
          className="md-code-copy"
          onClick={() => {
            api.copyToClipboard(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

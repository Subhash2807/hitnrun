/**
 * XML formatting for the XML formatter and for XML response bodies: read a
 * document into a light tree, check that it is well formed, and write it back
 * beautified or minified. ES module so the Node tests can import it.
 *
 * Nothing is lost on the way through: comments, CDATA, processing
 * instructions, the DOCTYPE, attribute values and text are written back as
 * they were. Only the whitespace between tags changes, and not even that
 * inside an element marked xml:space="preserve".
 */

/** Line and column (both from 1) of an offset into the text. */
export function lineCol(text, offset) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last };
}

class XmlError extends Error {
  constructor(message, offset) {
    super(message);
    this.offset = offset;
  }
}

const NAME = /^[^\s/>!?<"'=]+/;

/**
 * Read a document. Returns { nodes, error }: the top-level nodes, and the
 * first problem found ({ message, offset, line, col, fatal }) or null.
 *
 * A fatal error (a tag left open, a mismatched closing tag, an unterminated
 * comment) leaves no tree to format. The others (two root elements, text
 * outside the root) make the document invalid XML but can still be formatted,
 * which is handy for fragments.
 */
export function parseXml(text) {
  const src = String(text ?? '');
  try {
    const { nodes, warning } = build(src);
    return { nodes, error: warning ? describe(src, warning, false) : null };
  } catch (err) {
    if (!(err instanceof XmlError)) throw err;
    return { nodes: null, error: describe(src, err, true) };
  }
}

function describe(src, err, fatal) {
  return { message: err.message, offset: err.offset, ...lineCol(src, err.offset), fatal };
}

function build(src) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const until = (marker, from, what) => {
    const end = src.indexOf(marker, from);
    if (end === -1) throw new XmlError(`${what} is never closed`, i);
    return end + marker.length;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt !== i) {
      const end = lt === -1 ? src.length : lt;
      top().children.push({ type: 'text', text: src.slice(i, end), start: i });
      i = end;
      continue;
    }

    if (src.startsWith('<!--', i)) {
      const end = until('-->', i + 4, 'A comment');
      top().children.push({ type: 'comment', raw: src.slice(i, end), start: i });
      i = end;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = until(']]>', i + 9, 'A CDATA section');
      top().children.push({ type: 'cdata', raw: src.slice(i, end), start: i });
      i = end;
    } else if (src.startsWith('<?', i)) {
      const end = until('?>', i + 2, 'A processing instruction');
      top().children.push({ type: 'pi', raw: src.slice(i, end), start: i });
      i = end;
    } else if (src.startsWith('<!', i)) {
      const end = scanDeclaration(src, i);
      top().children.push({ type: 'doctype', raw: src.slice(i, end), start: i });
      i = end;
    } else if (src.startsWith('</', i)) {
      const name = NAME.exec(src.slice(i + 2))?.[0];
      const close = src.indexOf('>', i);
      if (!name || close === -1 || src.slice(i + 2 + name.length, close).trim()) {
        throw new XmlError('A closing tag is malformed', i);
      }
      const open = top();
      if (open.type !== 'element') throw new XmlError(`</${name}> closes nothing that is open`, i);
      if (open.name !== name) throw new XmlError(`Expected </${open.name}> but found </${name}>`, i);
      open.end = close + 1;
      stack.pop();
      i = close + 1;
    } else {
      const name = NAME.exec(src.slice(i + 1))?.[0];
      if (!name) throw new XmlError('A "<" that does not start a tag: write it as &lt;', i);
      const close = scanTag(src, i);
      const selfClosing = src[close - 1] === '/';
      const attrs = src.slice(i + 1 + name.length, selfClosing ? close - 1 : close);
      checkAttributes(attrs, i);
      const el = {
        type: 'element',
        name,
        open: compactTag(src.slice(i, close + 1)),
        selfClosing,
        preserve: /\sxml:space\s*=\s*["']preserve["']/.test(attrs),
        children: [],
        start: i,
        end: close + 1,
      };
      top().children.push(el);
      if (!selfClosing) stack.push(el);
      i = close + 1;
    }
  }

  if (stack.length > 1) {
    const open = top();
    throw new XmlError(`<${open.name}> is never closed`, open.start);
  }

  // Well formed, but is it one document?
  let warning = null;
  let elements = 0;
  for (const node of root.children) {
    if (node.type === 'text' && node.text.trim()) {
      warning ??= new XmlError('Text outside the root element', node.start + node.text.search(/\S/));
    } else if (node.type === 'element' && ++elements === 2) {
      warning ??= new XmlError('More than one root element', node.start);
    }
  }
  if (!elements && src.trim()) warning ??= new XmlError('No root element', 0);
  return { nodes: root.children, warning };
}

/** The end of a tag: the offset of its ">", skipping any inside quoted attribute values. */
function scanTag(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    } else if (c === '<') {
      throw new XmlError('A tag is never closed', start);
    }
  }
  throw new XmlError(quote ? 'An attribute value is never closed' : 'A tag is never closed', start);
}

/** The end of <!DOCTYPE ...>, which can hold a [...] internal subset. */
function scanDeclaration(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 2; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  throw new XmlError('A declaration is never closed', start);
}

function checkAttributes(attrs, offset) {
  const seen = new Set();
  const re = /\s*([^\s=/>"']+)\s*=\s*("[^"]*"|'[^']*')|\s*(\S+)/g;
  let m;
  while ((m = re.exec(attrs))) {
    if (m[3]) {
      throw new XmlError(
        /=/.test(m[3]) ? `The value of ${m[3].split('=')[0]} must be in quotes` : `"${m[3]}" needs a value, like ${m[3]}="…"`,
        offset
      );
    }
    if (seen.has(m[1])) throw new XmlError(`The attribute ${m[1]} is there twice`, offset);
    seen.add(m[1]);
  }
}

/** A tag on one line: runs of whitespace outside quoted values become one space. */
function compactTag(tag) {
  let out = '';
  let quote = null;
  for (let i = 0; i < tag.length; i++) {
    const c = tag[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (/\s/.test(c)) {
      if (!/\s$/.test(out)) out += ' ';
    } else {
      out += c;
    }
  }
  return out.replace(/\s+(\/?>)$/, '$1');
}

/**
 * Write a document back out. `indent` is a number of spaces or '\t'; `minify`
 * removes the whitespace between tags instead. Throws an Error with `line`
 * and `col` when the document is not well formed enough to format.
 */
export function formatXml(text, { indent = 2, minify = false } = {}) {
  const src = String(text ?? '');
  const { nodes, error } = parseXml(src);
  if (!nodes) {
    const err = new Error(`${error.message} (line ${error.line}, column ${error.col})`);
    Object.assign(err, error);
    throw err;
  }
  const pad = indent === '\t' ? '\t' : ' '.repeat(Math.max(0, Math.min(8, Number(indent) || 0)));
  const out = minify ? nodes.map((n) => writeMin(src, n)).join('') : writePretty(src, nodes, 0, pad).join('\n');
  return minify ? out : out + (src.endsWith('\n') ? '\n' : '');
}

const isBlank = (node) => node.type === 'text' && !node.text.trim();

function closeTag(node) {
  return node.selfClosing ? '' : `</${node.name}>`;
}

function writeMin(src, node) {
  if (node.type === 'text') return node.text.trim() ? node.text : '';
  if (node.type !== 'element') return node.raw;
  if (node.preserve) return src.slice(node.start, node.end);
  return node.open + node.children.map((c) => writeMin(src, c)).join('') + closeTag(node);
}

function writePretty(src, nodes, depth, pad) {
  const lines = [];
  const at = pad.repeat(depth);
  for (const node of nodes) {
    if (isBlank(node)) continue;
    if (node.type === 'text') {
      lines.push(at + node.text.trim());
    } else if (node.type !== 'element') {
      lines.push(at + node.raw);
    } else if (node.preserve) {
      lines.push(at + src.slice(node.start, node.end));
    } else if (node.selfClosing) {
      lines.push(at + node.open);
    } else {
      const kids = node.children.filter((c) => !isBlank(c));
      if (kids.every((c) => c.type === 'text' || c.type === 'cdata')) {
        // Only text inside: keep it on the tag's line, exactly as written apart from the ends.
        const inner = node.children.map((c) => (c.type === 'text' ? c.text : c.raw)).join('');
        lines.push(at + node.open + (kids.length ? inner.trim() : '') + closeTag(node));
      } else if (kids.some((c) => c.type === 'text')) {
        // Text and elements mixed, like <p>Hello <b>you</b></p>: new lines would change the text.
        lines.push(at + writeMin(src, node));
      } else {
        lines.push(at + node.open, ...writePretty(src, node.children, depth + 1, pad), at + closeTag(node));
      }
    }
  }
  return lines;
}

/** How many elements a parsed document holds. */
export function countElements(nodes) {
  let n = 0;
  const visit = (list) => {
    for (const node of list || []) {
      if (node.type === 'element') {
        n++;
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return n;
}

/** Beautify when the text is well formed; otherwise hand it back untouched. */
export function prettyXmlOrSame(text, indent = 2) {
  try {
    return formatXml(text, { indent });
  } catch {
    return text;
  }
}

/**
 * The JSON viewer's engine: a strict JSON parser that remembers where every
 * value sits in the text, the formatter built on it, and the helpers the
 * outline tree uses.
 *
 * Positions are what let a click in the tree highlight the same value in the
 * raw text, and the cursor in the text pick out the value in the tree.
 * Formatting from the parse tree (rather than JSON.parse + JSON.stringify)
 * keeps every number and string exactly as written: a 19-digit id stays 19
 * digits, 1.50 stays 1.50, and "é" stays escaped.
 *
 * Kept free of React and CodeMirror so the tests can import it directly.
 *
 * A node is one value:
 *   { type, from, to, keyFrom, keyTo, parent, index, depth, children }
 *   type      'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
 *   from, to  where the value starts and ends (end exclusive)
 *   keyFrom, keyTo  the quoted property name of an object member, else -1
 *   children  the members or items of an object or array, else null
 */

class JsonError extends Error {
  constructor(offset, message) {
    super(message);
    this.offset = offset;
  }
}

// Sticky patterns for the hot paths.
const PLAIN = /[^"\\\u0000-\u001f]*/y; // a run of ordinary characters inside a string
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBERISH = /[-+.0-9A-Za-z_$]+/y; // everything glued to a broken number, for the message
const HEX4 = /[0-9a-fA-F]{4}/y;

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;

/**
 * Parse `text` as JSON (RFC 8259, plus a leading byte order mark).
 *
 * @returns {{ ok: true, root, count, depth }}       the tree, its value count and nesting depth
 *        | {{ ok: false, empty: true }}            nothing but whitespace
 *        | {{ ok: false, error: { message, offset, line, column } }}
 */
export function parseJson(text) {
  const n = text.length;
  let i = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n && isWs(text.charCodeAt(i))) i++;
  if (i >= n) return { ok: false, empty: true };
  try {
    return parse(text, i);
  } catch (err) {
    if (!(err instanceof JsonError)) throw err;
    const { line, column } = lineCol(text, err.offset);
    return { ok: false, empty: false, error: { message: err.message, offset: err.offset, line, column } };
  }
}

// What the parser expects next.
const VALUE = 0;
const VALUE_OR_CLOSE = 1; // just after '['
const KEY = 2;
const KEY_OR_CLOSE = 3; // just after '{'
const AFTER_VALUE = 4;

/**
 * Iterative, so a deeply nested document can't overflow the call stack
 * (JSON.parse copes with them, so this has to as well).
 */
function parse(text, start) {
  const n = text.length;
  let i = start;
  let root = null;
  let parent = null; // the object or array being filled
  let keyFrom = -1;
  let keyTo = -1;
  let count = 0;
  let depth = 0;
  let mode = VALUE;

  for (;;) {
    while (i < n && isWs(text.charCodeAt(i))) i++;

    if (mode === AFTER_VALUE) {
      if (parent === null) {
        if (i < n) {
          throw new JsonError(i, `Unexpected ${quoteChar(text, i)} after the JSON value — only one top-level value is allowed`);
        }
        break;
      }
      if (i >= n) throw unclosed(text, parent, n);
      const c = text.charCodeAt(i);
      if (c === 44 /* , */) {
        let j = i + 1;
        while (j < n && isWs(text.charCodeAt(j))) j++;
        const next = text.charCodeAt(j);
        if (next === 93 || next === 125) {
          throw new JsonError(i, `Trailing comma — remove the ',' before '${String.fromCharCode(next)}'`);
        }
        i++;
        mode = parent.type === 'array' ? VALUE : KEY;
        continue;
      }
      if (c === (parent.type === 'array' ? 93 : 125)) {
        parent.to = ++i;
        parent = parent.parent;
        continue;
      }
      throw afterValueError(text, parent, i, c);
    }

    if (mode === KEY || mode === KEY_OR_CLOSE) {
      if (i >= n) throw unclosed(text, parent, n);
      const c = text.charCodeAt(i);
      if (mode === KEY_OR_CLOSE && c === 125 /* } */) {
        parent.to = ++i;
        parent = parent.parent;
        mode = AFTER_VALUE;
        continue;
      }
      if (c !== 34) throw keyError(text, i, c);
      keyFrom = i;
      i = scanString(text, i);
      keyTo = i;
      while (i < n && isWs(text.charCodeAt(i))) i++;
      if (text.charCodeAt(i) !== 58 /* : */) {
        throw new JsonError(i, i >= n ? 'Unexpected end of JSON — expected \':\' after the property name' : "Expected ':' after the property name");
      }
      i++;
      mode = VALUE;
      continue;
    }

    // A value.
    if (i >= n) {
      throw mode === VALUE_OR_CLOSE ? unclosed(text, parent, n) : new JsonError(n, 'Unexpected end of JSON — expected a value');
    }
    const c = text.charCodeAt(i);
    if (mode === VALUE_OR_CLOSE && c === 93 /* ] */) {
      parent.to = ++i;
      parent = parent.parent;
      mode = AFTER_VALUE;
      continue;
    }

    let type;
    let end = -1;
    if (c === 123) type = 'object';
    else if (c === 91) type = 'array';
    else if (c === 34) {
      type = 'string';
      end = scanString(text, i);
    } else if (c === 45 || (c >= 48 && c <= 57)) {
      type = 'number';
      end = scanNumber(text, i);
    } else if (c === 116 || c === 102 || c === 110) {
      WORD.lastIndex = i;
      const word = WORD.exec(text)[0];
      if (word === 'true' || word === 'false') type = 'boolean';
      else if (word === 'null') type = 'null';
      else throw valueError(text, i, c);
      end = i + word.length;
    } else throw valueError(text, i, c);

    const node = { type, from: i, to: end, keyFrom: -1, keyTo: -1, parent, index: 0, depth: 0, children: null };
    if (parent) {
      if (parent.type === 'object') {
        node.keyFrom = keyFrom;
        node.keyTo = keyTo;
      }
      node.index = parent.children.length;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      root = node;
    }
    count++;

    if (end === -1) {
      // An object or array: fill it next.
      node.children = [];
      if (node.depth > depth) depth = node.depth;
      parent = node;
      mode = type === 'object' ? KEY_OR_CLOSE : VALUE_OR_CLOSE;
      i++;
    } else {
      i = end;
      mode = AFTER_VALUE;
    }
  }

  return { ok: true, empty: false, root, count, depth };
}

/** End of a string starting at the quote at `start`. */
function scanString(text, start) {
  const n = text.length;
  let i = start + 1;
  for (;;) {
    PLAIN.lastIndex = i;
    PLAIN.exec(text);
    i = PLAIN.lastIndex;
    if (i >= n) throw new JsonError(start, 'Unterminated string — the closing quote is missing');
    const c = text.charCodeAt(i);
    if (c === 34) return i + 1;
    if (c === 92 /* \ */) {
      const e = text.charCodeAt(i + 1);
      if (e === 117 /* u */) {
        HEX4.lastIndex = i + 2;
        if (!HEX4.test(text)) throw new JsonError(i, 'Invalid escape — \\u must be followed by 4 hex digits');
        i += 6;
      } else if (e === 34 || e === 92 || e === 47 || e === 98 || e === 102 || e === 110 || e === 114 || e === 116) {
        i += 2;
      } else if (i + 1 >= n) {
        throw new JsonError(start, 'Unterminated string — the closing quote is missing');
      } else {
        const shown = e > 0x20 && e < 0x7f ? `"\\${text[i + 1]}"` : `"\\" followed by ${quoteChar(text, i + 1)}`;
        throw new JsonError(i, `Invalid escape ${shown} in a string — only \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX are allowed`);
      }
      continue;
    }
    // A raw control character. A line break almost always means a missing quote.
    if (c === 10 || c === 13) {
      throw new JsonError(i, 'Unterminated string — a string can\'t contain a line break (write \\n for one)');
    }
    throw new JsonError(i, `${c === 9 ? 'A tab' : `Control character U+${hex4(c)}`} must be escaped inside a string${c === 9 ? ' (write \\t)' : ''}`);
  }
}

function scanNumber(text, start) {
  NUMBER.lastIndex = start;
  const m = NUMBER.exec(text);
  const end = m ? start + m[0].length : start;
  const next = text.charCodeAt(end);
  // A digit, dot, exponent or letter glued on means the number itself is malformed.
  if (!m || (next >= 48 && next <= 57) || next === 46 || next === 43 || next === 45 || isIdentChar(next)) {
    NUMBERISH.lastIndex = start;
    const word = NUMBERISH.exec(text)[0];
    throw new JsonError(start, `Invalid number "${clip(word)}"${numberHint(word)}`);
  }
  return end;
}

function numberHint(word) {
  if (/^-?0[0-9]/.test(word)) return ' — leading zeros are not allowed';
  if (/^-?0[xX]/.test(word)) return ' — hex numbers are not allowed';
  if (/\.([eE]|$)/.test(word)) return ' — a digit is needed after the decimal point';
  if (/[eE][+-]?$/.test(word)) return ' — the exponent needs digits';
  if (/^-?(Infinity|NaN)/.test(word)) return ' — numbers must be finite';
  return '';
}

const isIdentChar = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;

/* --------------------------------------------------------------- messages */

function unclosed(text, container, at) {
  const kind = container.type === 'object' ? `'}' to close the object` : `']' to close the array`;
  return new JsonError(at, `Unexpected end of JSON — missing ${kind} opened on line ${lineCol(text, container.from).line}`);
}

function isComment(text, i) {
  const next = text.charCodeAt(i + 1);
  return text.charCodeAt(i) === 47 && (next === 47 || next === 42);
}

/** A value was expected at `i` but `c` is there. */
function valueError(text, i, c) {
  if (c === 39) return new JsonError(i, 'Strings must use double quotes, not single quotes');
  if (isComment(text, i)) return new JsonError(i, 'Comments are not allowed in JSON');
  if (c === 125 || c === 93 || c === 44 || c === 58) return new JsonError(i, `Expected a value, found '${String.fromCharCode(c)}'`);
  if (c === 43 || c === 46) {
    NUMBERISH.lastIndex = i;
    return new JsonError(i, `Invalid number "${clip(NUMBERISH.exec(text)[0])}" — numbers must start with a digit or '-'`);
  }
  if (isIdentChar(c)) {
    WORD.lastIndex = i;
    const m = WORD.exec(text);
    if (m) return new JsonError(i, wordMessage(m[0]));
  }
  return new JsonError(i, `Unexpected character ${quoteChar(text, i)}`);
}

function wordMessage(word) {
  const lower = word.toLowerCase();
  if (word === 'None') return '"None" is not valid JSON — use null';
  if (lower === 'true' || lower === 'false' || lower === 'null') return `"${word}" is not valid JSON — use ${lower}`;
  if (word === 'undefined') return '"undefined" is not valid JSON — use null';
  if (word === 'NaN' || word === 'Infinity') return `"${word}" is not valid JSON — numbers must be finite`;
  const meant = ['true', 'false', 'null'].find((w) => lower.length >= 2 && w.startsWith(lower));
  if (meant) return `Unexpected "${word}" — did you mean ${meant}?`;
  return `Unexpected "${clip(word)}" — strings must be in double quotes`;
}

/** A property name was expected at `i` but `c` is there. */
function keyError(text, i, c) {
  if (c === 39) return new JsonError(i, 'Property names must use double quotes, not single quotes');
  if (isComment(text, i)) return new JsonError(i, 'Comments are not allowed in JSON');
  if (isIdentChar(c)) return new JsonError(i, 'Property names must be in double quotes');
  return new JsonError(i, `Expected a property name in double quotes, found ${quoteChar(text, i)}`);
}

/** Something other than ',' or the closing bracket follows a value. */
function afterValueError(text, parent, i, c) {
  const close = parent.type === 'array' ? ']' : '}';
  if (isComment(text, i)) return new JsonError(i, 'Comments are not allowed in JSON');
  if (c === 93 || c === 125) {
    return new JsonError(i, `Expected ',' or '${close}', found '${String.fromCharCode(c)}' — the brackets don't match`);
  }
  // The start of another value right after one usually means a forgotten comma.
  const startsValue = c === 34 || c === 123 || c === 91 || c === 45 || (c >= 48 && c <= 57) || c === 116 || c === 102 || c === 110;
  if (startsValue) return new JsonError(i, `Expected ',' or '${close}' — is a comma missing?`);
  const what = parent.type === 'array' ? 'an array item' : 'a property value';
  return new JsonError(i, `Expected ',' or '${close}' after ${what}, found ${quoteChar(text, i)}`);
}

// Characters that sneak in when JSON is copied from a web page, chat or word processor.
const LOOKALIKES = {
  0x00a0: 'a non-breaking space',
  0x200b: 'a zero-width space',
  0xfeff: 'a byte order mark',
  0x201c: 'a curly quote — use a straight "',
  0x201d: 'a curly quote — use a straight "',
  0x2018: 'a curly quote — use a straight "',
  0x2019: 'a curly quote — use a straight "',
};

/** A character as a message shows it: 'x', or its code point and a name when it is invisible or a look-alike. */
function quoteChar(text, i) {
  const c = text.charCodeAt(i);
  if (LOOKALIKES[c]) return `U+${hex4(c)} (${LOOKALIKES[c]})`;
  if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029) return `U+${hex4(c)}`;
  if (c >= 0xd800 && c <= 0xdbff) return `'${text.slice(i, i + 2)}'`;
  return `'${text[i]}'`;
}

const hex4 = (c) => c.toString(16).toUpperCase().padStart(4, '0');
const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

/* ------------------------------------------------------------- positions */

/** 1-based line and column of an offset; lines end at '\n'. */
export function lineCol(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** Where a node starts in the text: at its property name, when it has one. */
export const nodeStart = (node) => (node.keyFrom >= 0 ? node.keyFrom : node.from);

/** The deepest value at `pos`, the way a cursor sees it: a member owns its name too. */
export function nodeAt(root, pos) {
  let node = root;
  for (;;) {
    const kids = node.children;
    if (!kids || kids.length === 0) return node;
    // Last child starting at or before pos.
    let lo = 0;
    let hi = kids.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (nodeStart(kids[mid]) <= pos) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (hit === -1 || pos > kids[hit].to) return node;
    node = kids[hit];
  }
}

/* ------------------------------------------------------------ formatting */

/**
 * Print a node (and everything under it) as JSON.
 *
 * Throws a RangeError when the result would be too big for a string, which
 * only a pathologically deep document gets near when indented.
 *
 * @param {{ indent?: number|'tab', minify?: boolean, sortKeys?: boolean }} options
 */
export function formatJson(text, node, { indent = 2, minify = false, sortKeys = false } = {}) {
  const unit = indent === 'tab' ? '\t' : ' '.repeat(Math.min(8, Math.max(1, Number(indent) || 2)));
  const newline = minify ? '' : '\n';
  const comma = minify ? ',' : ',\n';
  const colon = minify ? ':' : ': ';
  const pads = [''];
  const pad = (depth) => {
    if (minify) return '';
    while (pads.length <= depth) pads.push(pads[pads.length - 1] + unit);
    return pads[depth];
  };
  const membersOf = (n) => (sortKeys && n.type === 'object' ? sortMembers(text, n.children) : n.children);
  const leaf = (n) => (n.children ? (n.type === 'object' ? '{}' : '[]') : text.slice(n.from, n.to));

  if (!node.children || node.children.length === 0) return leaf(node);

  // An explicit stack (three entries per open container), so deep documents
  // format as safely as they parse.
  const out = [node.type === 'object' ? '{' : '['];
  const stack = [];
  let current = node;
  let kids = membersOf(node);
  let next = 0;
  for (;;) {
    const depth = stack.length / 3 + 1;
    if (next < kids.length) {
      const child = kids[next];
      out.push(next === 0 ? newline : comma, pad(depth));
      next++;
      if (current.type === 'object') out.push(text.slice(child.keyFrom, child.keyTo), colon);
      if (child.children && child.children.length) {
        out.push(child.type === 'object' ? '{' : '[');
        stack.push(current, kids, next);
        current = child;
        kids = membersOf(child);
        next = 0;
      } else {
        out.push(leaf(child));
      }
    } else {
      out.push(newline, pad(depth - 1), current.type === 'object' ? '}' : ']');
      if (!stack.length) break;
      next = stack.pop();
      kids = stack.pop();
      current = stack.pop();
    }
  }
  return out.join('');
}

/** Members in key order (by UTF-16 code unit, like RFC 8785). Stable, so duplicate keys keep their order. */
function sortMembers(text, members) {
  return members
    .map((member) => [keyName(text, member), member])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map((pair) => pair[1]);
}

/* ------------------------------------------------------------ inspection */

/** The property name of an object member, decoded; null for anything else. */
export function keyName(text, node) {
  if (node.keyFrom < 0) return null;
  const raw = text.slice(node.keyFrom + 1, node.keyTo - 1);
  return raw.indexOf('\\') === -1 ? raw : JSON.parse(text.slice(node.keyFrom, node.keyTo));
}

/** The value of a node as a JS value. Big numbers lose precision here, as with JSON.parse. */
export function toValue(text, node) {
  return JSON.parse(text.slice(node.from, node.to));
}

/**
 * What "copy value" puts on the clipboard: a string's text without quotes or
 * escapes, a number or literal as written, an object or array as JSON.
 */
export function copyText(text, node, options) {
  if (node.type === 'string') return toValue(text, node);
  if (!node.children) return text.slice(node.from, node.to);
  return formatJson(text, node, options);
}

/** A path to a node in JavaScript / JSONPath style: $.items[0]["first name"]. */
export function jsonPath(text, node) {
  const parts = [];
  for (let n = node; n.parent; n = n.parent) {
    if (n.parent.type === 'array') parts.push(`[${n.index}]`);
    else {
      const key = keyName(text, n);
      parts.push(/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
    }
  }
  return `$${parts.reverse().join('')}`;
}

/** "3 items", "1 key". */
export function countLabel(node) {
  const n = node.children ? node.children.length : 0;
  return node.type === 'array' ? `${n} ${n === 1 ? 'item' : 'items'}` : `${n} ${n === 1 ? 'key' : 'keys'}`;
}

/**
 * A short form of a scalar for one line of the tree: strings keep their
 * quotes, long ones are cut.
 */
export function previewText(text, node, max = 160) {
  if (node.to - node.from <= max) return text.slice(node.from, node.to);
  let end = node.from + max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // don't split a surrogate pair
  return `${text.slice(node.from, end)}…${node.type === 'string' ? '"' : ''}`;
}

/* ------------------------------------------------------- identity / state */

const escapeSegment = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * A stable id for a node, so expanded rows and the selection survive edits
 * and reformatting: a JSON-Pointer-like path made of property names and
 * array indexes ('' is the root). A repeated property name gets a ~2, ~3…
 * suffix; '~' followed by anything but 0 or 1 can't occur in an escaped name,
 * so the suffix never collides with a real one.
 */
export function stateKey(text, node) {
  if (node._key === undefined) {
    const chain = [];
    for (let n = node; n && n._key === undefined; n = n.parent) chain.push(n);
    for (let i = chain.length - 1; i >= 0; i--) assignKey(text, chain[i]);
  }
  return node._key;
}

function assignKey(text, node) {
  if (node._key !== undefined) return;
  const parent = node.parent;
  if (!parent) {
    node._key = '';
    return;
  }
  if (parent.type === 'array') {
    node._key = `${parent._key}/${node.index}`;
    return;
  }
  // Name every member of the object at once, so repeats can be counted.
  const seen = new Map();
  for (const member of parent.children) {
    const name = escapeSegment(text.slice(member.keyFrom + 1, member.keyTo - 1));
    const nth = (seen.get(name) || 0) + 1;
    seen.set(name, nth);
    member._key = `${parent._key}/${name}${nth > 1 ? `~${nth}` : ''}`;
  }
}

/** The node with a given stateKey in a (newer) parse of the document, or null. */
export function findByKey(text, root, key) {
  if (!root || typeof key !== 'string') return null;
  if (key === '') return root;
  let node = root;
  let at = 1; // skip the leading '/'
  while (at <= key.length) {
    const slash = key.indexOf('/', at);
    const segment = key.slice(at, slash === -1 ? key.length : slash);
    at = slash === -1 ? key.length + 1 : slash + 1;
    const kids = node.children;
    if (!kids || kids.length === 0) return null;
    if (node.type === 'array') {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
      node = kids[Number(segment)];
      if (!node) return null;
    } else {
      stateKey(text, kids[0]);
      const want = `${node._key}/${segment}`;
      node = kids.find((kid) => kid._key === want);
      if (!node) return null;
    }
  }
  return node;
}

/* -------------------------------------------------------------- the tree */

/**
 * The rows the outline shows, top to bottom.
 *
 * @param root
 * @param isOpen   (node) => whether a container is expanded
 * @param filter   result of filterTree(), or null. With one, only matches and the
 *                 containers leading to them are listed; those containers are always
 *                 open, and `isOpen` decides the rest.
 */
export function visibleNodes(root, isOpen, filter = null) {
  const out = [];
  if (!root || (filter && !filter.matches.has(root) && !filter.leadsTo.has(root))) return out;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    out.push(node);
    const kids = node.children;
    if (!kids || kids.length === 0) continue;
    if (filter && filter.leadsTo.has(node)) {
      for (let i = kids.length - 1; i >= 0; i--) {
        if (filter.matches.has(kids[i]) || filter.leadsTo.has(kids[i])) stack.push(kids[i]);
      }
    } else if (isOpen(node)) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  return out;
}

/** Does a node's property name, or a scalar's value, contain `query` (lower case)? */
function nodeMatches(text, node, query) {
  if (node.keyFrom >= 0 && keyName(text, node).toLowerCase().includes(query)) return true;
  if (node.children) return false;
  const raw = node.type === 'string' ? text.slice(node.from + 1, node.to - 1) : text.slice(node.from, node.to);
  return raw.toLowerCase().includes(query);
}

/**
 * Which nodes match a filter, and which containers lead to a match.
 * @returns {{ query, matches: Set, leadsTo: Set }} or null for an empty query
 */
export function filterTree(text, root, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !root) return null;
  const matches = new Set();
  const leadsTo = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (nodeMatches(text, node, q)) {
      matches.add(node);
      for (let p = node.parent; p && !leadsTo.has(p); p = p.parent) leadsTo.add(p);
    }
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return { query: q, matches, leadsTo };
}

/**
 * Text as it should land in a new file: beautified when it is valid JSON,
 * untouched (apart from line endings) when it isn't.
 */
export function beautifyIfValid(text, indent = 2) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const parsed = parseJson(normalized);
  if (!parsed.ok) return normalized;
  try {
    return formatJson(normalized, parsed.root, { indent });
  } catch {
    return normalized; // too deep to indent: keep it as it came
  }
}

/**
 * A string value that is itself JSON (an object or array), as often happens
 * with payloads logged or stored as text. Returns the inner text, or null.
 */
export function embeddedJson(text, node) {
  if (node.type !== 'string' || node.to - node.from < 4) return null;
  // Cheap check before decoding: the first character inside the quotes.
  let i = node.from + 1;
  while (i < node.to - 1 && /[\s]/.test(text[i])) i++;
  if (text[i] !== '{' && text[i] !== '[') {
    // Escaped whitespace (\n, \t) before the bracket is common in logged JSON.
    if (text[i] !== '\\') return null;
  }
  let inner;
  try {
    inner = toValue(text, node);
  } catch {
    return null;
  }
  const trimmed = inner.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  return parseJson(inner).ok ? inner : null;
}

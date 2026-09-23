/**
 * Labels for folded JSON: "3 items" for an array, "5 keys" for an object.
 * Kept free of CodeMirror so the tests can import it directly.
 */

/** Count the top-level entries in the text between a pair of brackets. */
export function countEntries(text) {
  let depth = 0;
  let inString = false;
  let commas = 0;
  let any = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      any = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
      any = true;
    } else if (ch === '}' || ch === ']') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      commas++;
    } else if (!/\s/.test(ch)) {
      any = true;
    }
  }
  return any ? commas + 1 : 0;
}

export function describeFold(open, inner) {
  const n = countEntries(inner);
  if (open === '[') return `${n} ${n === 1 ? 'item' : 'items'}`;
  if (open === '{') return `${n} ${n === 1 ? 'key' : 'keys'}`;
  return '…';
}

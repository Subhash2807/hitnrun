/**
 * Row <-> bulk-text conversion for the key/value grids.
 *
 * Text format (same convention Postman uses):
 *   Content-Type:application/json      an enabled row
 *   //X-Debug:1                        a disabled row
 *   Authorization:                     an enabled row with an empty value
 *
 * Round-tripping is lossy only for descriptions, which have no text form —
 * so descriptions are carried over by key when converting back.
 */

export const blankRow = () => ({ key: '', value: '', description: '', enabled: true });

export function rowsToBulk(rows = []) {
  return rows
    .filter((r) => r.key || r.value)
    .map((r) => `${r.enabled === false ? '//' : ''}${r.key}:${r.value ?? ''}`)
    .join('\n');
}

export function bulkToRows(text, previous = []) {
  // Descriptions are invisible in bulk mode; restore them by key afterwards.
  const descriptions = new Map();
  for (const row of previous) {
    if (row.key && row.description) descriptions.set(row.key, row.description);
  }

  const rows = [];
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    let enabled = true;
    let content = line;
    if (content.trimStart().startsWith('//')) {
      enabled = false;
      content = content.trimStart().slice(2);
    }

    const idx = content.indexOf(':');
    const key = (idx === -1 ? content : content.slice(0, idx)).trim();
    const value = idx === -1 ? '' : content.slice(idx + 1).trim();
    if (!key && !value) continue;

    rows.push({ key, value, description: descriptions.get(key) || '', enabled });
  }
  return rows;
}

/** Grids always show one empty row at the bottom to type into. */
export function withTrailingBlank(rows = []) {
  const cleaned = rows.filter((r, i) => r.key || r.value || r.description || i < rows.length);
  const last = cleaned[cleaned.length - 1];
  if (!last || last.key || last.value || last.description) return [...cleaned, blankRow()];
  return cleaned;
}

/** Strip the trailing placeholder before persisting. */
export function stripBlanks(rows = []) {
  return rows.filter((r) => r.key || r.value);
}

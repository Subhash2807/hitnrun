/**
 * Searching the Collections tree. ES module so the Node tests can import it.
 *
 * A request matches when every word of the query is found in its name, URL,
 * method, or the name of a folder or collection it sits in. So "users post"
 * finds the POST requests in a Users folder, and a folder's name finds
 * everything inside it.
 */

/** The words of a query, lower-cased. Empty for a blank query. */
export function queryWords(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Search the collections. Returns null for a blank query, otherwise
 * { requests, containers }: the ids of the matching requests, and the ids of
 * every collection and folder with a match somewhere inside it (the ones to
 * show, expanded, while searching).
 */
export function searchTree(collections, query) {
  const words = queryWords(query);
  if (!words.length) return null;

  const requests = new Set();
  const containers = new Set();

  // `path` is the names of the containers above, lower-cased.
  const visit = (items, path) => {
    let found = false;
    for (const item of items || []) {
      if (!item) continue;
      if (item.type === 'folder') {
        if (visit(item.items, `${path} ${String(item.name ?? '').toLowerCase()}`)) {
          containers.add(item.id);
          found = true;
        }
      } else {
        const text = `${path} ${item.name ?? ''} ${item.url ?? ''} ${item.method ?? ''}`.toLowerCase();
        if (words.every((w) => text.includes(w))) {
          requests.add(item.id);
          found = true;
        }
      }
    }
    return found;
  };

  for (const collection of collections || []) {
    if (visit(collection.items, String(collection.name ?? '').toLowerCase())) containers.add(collection.id);
  }
  return { requests, containers };
}

/** The ids of the collection and folders that hold an item, outermost first. Empty if it isn't found. */
export function ancestorsOf(collections, id) {
  const walk = (items, trail) => {
    for (const item of items || []) {
      if (!item) continue;
      if (item.id === id) return trail;
      if (item.type === 'folder') {
        const hit = walk(item.items, [...trail, item.id]);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const collection of collections || []) {
    const hit = walk(collection.items, [collection.id]);
    if (hit) return hit;
  }
  return [];
}

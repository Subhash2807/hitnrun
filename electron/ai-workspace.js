'use strict';

/**
 * The AI workspace.
 *
 * Kept in its own file (`ai-workspace.json`) rather than as a section of the
 * user's workspace. That makes the safety property structural: even a bug in
 * this module cannot corrupt the user's saved requests, because it never holds
 * a handle to them for writing.
 *
 * Shape:
 *   each AI session gets one collection in this workspace ("session folder").
 *   In `shared` mode every session writes into a single collection instead.
 *
 * Flow:
 *   AI creates its own requests here, or COPIES a folder out of the user
 *   workspace to work on. Nothing it does is visible in the user's tree until
 *   the user promotes it, which is a user-initiated action only.
 */

const { Workspace, defaultRequest, uid } = require('./workspace');

const SHARED_SESSION_ID = 'shared';

class AiWorkspace {
  /**
   * @param {string} filePath      where ai-workspace.json lives
   * @param {() => object} readUser  returns the user's workspace state (READ ONLY)
   */
  constructor(filePath, readUser) {
    this.store = new Workspace(filePath);
    this.readUser = readUser;
  }

  load() {
    this.store.load();
    const state = this.store.getState();
    // A fresh AI workspace starts with no collections; sessions create them.
    if (!state.sessions) state.sessions = [];
    if (state.collections.length === 1 && state.collections[0].items.length === 0) {
      // Drop the default "My Requests" collection the base Workspace seeds.
      state.collections = [];
    }
    return state;
  }

  on(...args) {
    return this.store.on(...args);
  }
  getState() {
    return this.store.getState();
  }
  saveNow() {
    return this.store.saveNow();
  }

  /* -------------------------------------------------------------- sessions */

  /**
   * Register an AI session and give it somewhere to work.
   * In `shared` mode all sessions land in one collection.
   */
  startSession({ client = 'unknown', label = '', mode = 'per-session' } = {}) {
    const state = this.getState();

    if (mode === 'shared') {
      let collection = state.collections.find((c) => c.sessionId === SHARED_SESSION_ID);
      if (!collection) {
        collection = this._createCollection('Shared AI workspace', SHARED_SESSION_ID);
      }
      const existing = state.sessions.find((s) => s.id === SHARED_SESSION_ID);
      if (existing) {
        existing.lastSeenAt = Date.now();
        existing.connections = (existing.connections || 1) + 1;
      } else {
        state.sessions.push({
          id: SHARED_SESSION_ID,
          collectionId: collection.id,
          client,
          label: 'Shared',
          startedAt: Date.now(),
          lastSeenAt: Date.now(),
          connections: 1,
        });
      }
      this.store.touch('ai:session');
      return { sessionId: SHARED_SESSION_ID, collectionId: collection.id, mode };
    }

    const sessionId = uid('ses');
    const stamp = new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const name = label || `${client} · ${stamp}`;
    const collection = this._createCollection(name, sessionId);

    state.sessions.push({
      id: sessionId,
      collectionId: collection.id,
      client,
      label: name,
      startedAt: Date.now(),
      lastSeenAt: Date.now(),
      connections: 1,
    });
    this.store.touch('ai:session');
    return { sessionId, collectionId: collection.id, mode };
  }

  _createCollection(name, sessionId) {
    const collection = {
      id: uid('col'),
      name,
      description: '',
      variables: [],
      auth: { type: 'none' },
      items: [],
      sessionId,
      createdAt: Date.now(),
    };
    this.getState().collections.push(collection);
    return collection;
  }

  touchSession(sessionId) {
    const session = this.getState().sessions.find((s) => s.id === sessionId);
    if (session) {
      session.lastSeenAt = Date.now();
      this.store.scheduleSave();
    }
    return session || null;
  }

  sessionCollection(sessionId) {
    const session = this.getState().sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    return this.getState().collections.find((c) => c.id === session.collectionId) || null;
  }

  listSessions() {
    const state = this.getState();
    return state.sessions.map((s) => {
      const collection = state.collections.find((c) => c.id === s.collectionId);
      return {
        ...s,
        collectionName: collection?.name ?? '(missing)',
        requestCount: collection ? countRequests(collection.items) : 0,
      };
    });
  }

  /** Remove a session and everything it created. */
  discardSession(sessionId) {
    const state = this.getState();
    const idx = state.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return false;
    const [session] = state.sessions.splice(idx, 1);
    state.collections = state.collections.filter((c) => c.id !== session.collectionId);
    this.store.touch('ai:session-discard', sessionId);
    return true;
  }

  /** Remove every session and everything the AI created. */
  discardAll() {
    const state = this.getState();
    state.sessions = [];
    state.collections = [];
    this.store.touch('ai:session-discard-all');
    return true;
  }

  /** Delete one folder or request inside the AI workspace. */
  deleteNode(id) {
    if (this.store.findRequest(id)) return this.store.deleteRequest(id);
    return this.store.deleteFolder(id);
  }

  /* -------------------------------------------------------------- editing */

  /** Resolve a container id, refusing anything outside this workspace. */
  _container(sessionId, containerId) {
    const collection = this.sessionCollection(sessionId);
    if (!collection) return null;
    if (!containerId || containerId === collection.id) return collection;

    // Only allow folders that live under this session's collection.
    const found = findFolder(collection.items, containerId);
    return found || collection;
  }

  createRequest(sessionId, fields = {}, containerId = null) {
    const container = this._container(sessionId, containerId);
    if (!container) return null;
    const request = defaultRequest(fields);
    request.type = 'request';
    container.items.push(request);
    this.store.touch('ai:request-create', request.id);
    return request;
  }

  createFolder(sessionId, name = 'New Folder', containerId = null) {
    const container = this._container(sessionId, containerId);
    if (!container) return null;
    const folder = { id: uid('fld'), type: 'folder', name, items: [] };
    container.items.push(folder);
    this.store.touch('ai:folder-create', folder.id);
    return folder;
  }

  findRequest(id) {
    return this.store.findRequest(id);
  }

  updateRequest(id, patch) {
    return this.store.updateRequest(id, patch);
  }

  deleteRequest(id) {
    // Deleting inside the AI workspace is safe: it is the AI's own scratch space.
    return this.store.deleteRequest(id);
  }

  /* ---------------------------------------------------------- copy in/out */

  /**
   * Copy a request, folder or collection OUT of the user workspace and into an
   * AI session. The user's originals are read and cloned, never referenced.
   */
  copyFromUser(sessionId, sourceId) {
    const target = this.sessionCollection(sessionId);
    if (!target) return { ok: false, error: 'Unknown AI session' };

    const userState = this.readUser();
    const node = findAnyNode(userState, sourceId);
    if (!node) return { ok: false, error: `Nothing found in your workspace with id ${sourceId}` };

    // Deep clone with fresh ids, so nothing links back to the user's copy.
    const clone = reId(JSON.parse(JSON.stringify(node.value)));

    if (node.kind === 'collection') {
      // A collection becomes a folder inside the session.
      const folder = { id: uid('fld'), type: 'folder', name: `${clone.name} (copy)`, items: clone.items || [] };
      target.items.push(folder);
      this.store.touch('ai:copy', folder.id);
      return { ok: true, kind: 'folder', id: folder.id, name: folder.name, requests: countRequests(folder.items) };
    }

    if (clone.type === 'folder') clone.name = `${clone.name} (copy)`;
    target.items.push(clone);
    this.store.touch('ai:copy', clone.id);
    return {
      ok: true,
      kind: clone.type,
      id: clone.id,
      name: clone.name,
      requests: clone.type === 'folder' ? countRequests(clone.items) : 1,
    };
  }

  /**
   * Export an AI node so the USER can promote it. Returns a detached clone with
   * fresh ids; the caller writes it into the user workspace.
   */
  exportForPromotion(nodeId) {
    const state = this.getState();
    const node = findAnyNode(state, nodeId);
    if (!node) return null;
    const clone = reId(JSON.parse(JSON.stringify(node.value)));
    if (node.kind === 'collection') {
      return { kind: 'folder', value: { id: uid('fld'), type: 'folder', name: clone.name, items: clone.items || [] } };
    }
    return { kind: clone.type, value: clone };
  }
}

/* ------------------------------------------------------------- helpers */

function countRequests(items) {
  let n = 0;
  for (const item of items || []) {
    if (item.type === 'folder') n += countRequests(item.items);
    else if (item.type === 'request') n++;
  }
  return n;
}

function findFolder(items, id) {
  for (const item of items || []) {
    if (item.type !== 'folder') continue;
    if (item.id === id) return item;
    const nested = findFolder(item.items, id);
    if (nested) return nested;
  }
  return null;
}

/** Find a collection, folder or request anywhere in a workspace state. */
function findAnyNode(state, id) {
  for (const collection of state.collections || []) {
    if (collection.id === id) return { kind: 'collection', value: collection };
    const hit = walkFor(collection.items, id);
    if (hit) return hit;
  }
  return null;
}

function walkFor(items, id) {
  for (const item of items || []) {
    if (item.id === id) return { kind: item.type, value: item };
    if (item.type === 'folder') {
      const nested = walkFor(item.items, id);
      if (nested) return nested;
    }
  }
  return null;
}

/** Give a cloned subtree brand-new ids so it is fully detached. */
function reId(node) {
  if (node.type === 'request') node.id = uid('req');
  else if (node.type === 'folder') node.id = uid('fld');
  else if (node.items) node.id = uid('col');
  for (const child of node.items || []) reId(child);
  return node;
}

module.exports = { AiWorkspace, countRequests, findAnyNode, SHARED_SESSION_ID };

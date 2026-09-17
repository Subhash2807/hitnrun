'use strict';

/**
 * The workspace is the single source of truth and lives in the main process.
 * Both the UI (over IPC) and the agent control server mutate it through the
 * same methods, so an edit made by an agent shows up in the window immediately.
 *
 * Everything auto-saves: mutations mark the file dirty and a debounced writer
 * flushes to disk. There is no "Save" button anywhere in this app by design.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

const emptyRow = () => ({ key: '', value: '', description: '', enabled: true });

function defaultRequest(overrides = {}) {
  const now = Date.now();
  return {
    id: uid('req'),
    type: 'request',
    name: 'New Request',
    method: 'GET',
    url: '',
    params: [],
    pathVars: [],
    headers: [],
    auth: { type: 'inherit' },
    body: { mode: 'none', raw: '', rawType: 'json', fields: [], src: '', graphql: { query: '', variables: '' } },
    scripts: { pre: '', test: '' },
    settings: { followRedirects: true, sslVerify: true, timeout: null },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function defaultState() {
  const collectionId = uid('col');
  return {
    version: 1,
    collections: [{ id: collectionId, name: 'My Requests', description: '', variables: [], auth: { type: 'none' }, items: [] }],
    environments: [],
    globals: [],
    activeEnvironmentId: null,
    history: [],
    settings: {
      theme: 'dark',
      timeout: 0,
      followRedirects: true,
      maxRedirects: 10,
      sslVerify: true,
      historyLimit: 500,
      controlServer: { enabled: true, port: 47600 },
      autoParseCurl: true,
    },
    ui: { tabs: [], activeTabId: null, sidebarWidth: 280, sidebarTab: 'collections' },
  };
}

class Workspace extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.state = defaultState();
    this._saveTimer = null;
    this._loaded = false;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.state = { ...defaultState(), ...parsed };
        this.state.settings = { ...defaultState().settings, ...(parsed.settings || {}) };
        this.state.ui = { ...defaultState().ui, ...(parsed.ui || {}) };
      }
    } catch (err) {
      // A corrupt workspace should never block startup — keep a backup and start clean.
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.corrupt-' + Date.now());
      } catch { /* best effort */ }
      this.state = defaultState();
      this.emit('error', err);
    }
    this._loaded = true;
    return this.state;
  }

  /** Debounced write. Called after every mutation — this is the auto-save. */
  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath); // atomic-ish: never leave a half-written workspace
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Mark changed: persist + tell every listener (renderer window, control server). */
  touch(reason, detail) {
    this.scheduleSave();
    this.emit('changed', { reason, detail, state: this.state });
  }

  getState() {
    return this.state;
  }

  /* ------------------------------------------------------------ traversal */

  /** Walk every request in the workspace, yielding { request, parent, collection }. */
  *walk() {
    for (const collection of this.state.collections) {
      yield* this._walkItems(collection.items, collection, collection);
    }
  }

  *_walkItems(items, parent, collection) {
    for (const item of items) {
      if (item.type === 'folder') {
        yield { folder: item, parent, collection };
        yield* this._walkItems(item.items, item, collection);
      } else {
        yield { request: item, parent, collection };
      }
    }
  }

  findRequest(id) {
    for (const hit of this.walk()) {
      if (hit.request && hit.request.id === id) return hit;
    }
    return null;
  }

  findContainer(id) {
    if (!id) return null;
    for (const collection of this.state.collections) {
      if (collection.id === id) return collection;
    }
    for (const hit of this.walk()) {
      if (hit.folder && hit.folder.id === id) return hit.folder;
    }
    return null;
  }

  /* ------------------------------------------------------------ mutations */

  createCollection(name = 'New Collection') {
    const collection = { id: uid('col'), name, description: '', variables: [], auth: { type: 'none' }, items: [] };
    this.state.collections.push(collection);
    this.touch('collection:create', collection.id);
    return collection;
  }

  updateCollection(id, patch) {
    const collection = this.state.collections.find((c) => c.id === id);
    if (!collection) return null;
    Object.assign(collection, patch, { id: collection.id, items: collection.items });
    this.touch('collection:update', id);
    return collection;
  }

  deleteCollection(id) {
    const idx = this.state.collections.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    const [removed] = this.state.collections.splice(idx, 1);
    this._closeTabsFor(removed);
    this.touch('collection:delete', id);
    return true;
  }

  createFolder(containerId, name = 'New Folder') {
    const container = this.findContainer(containerId) || this.state.collections[0];
    if (!container) return null;
    const folder = { id: uid('fld'), type: 'folder', name, items: [] };
    container.items.push(folder);
    this.touch('folder:create', folder.id);
    return folder;
  }

  createRequest(containerId, fields = {}) {
    let container = this.findContainer(containerId);
    if (!container) {
      container = this.state.collections[0] || this.createCollection('My Requests');
    }
    const request = defaultRequest(fields);
    request.type = 'request';
    container.items.push(request);
    this.touch('request:create', request.id);
    return request;
  }

  /** Partial update. Unknown keys are ignored; `id`/`type`/`createdAt` are protected. */
  updateRequest(id, patch) {
    const hit = this.findRequest(id);
    if (!hit) return null;
    const request = hit.request;
    const allowed = [
      'name', 'method', 'url', 'params', 'pathVars', 'headers',
      'auth', 'body', 'scripts', 'settings', 'description',
    ];
    for (const key of allowed) {
      if (key in patch) request[key] = patch[key];
    }
    request.updatedAt = Date.now();
    this.touch('request:update', id);
    return request;
  }

  duplicateRequest(id) {
    const hit = this.findRequest(id);
    if (!hit) return null;
    const clone = JSON.parse(JSON.stringify(hit.request));
    clone.id = uid('req');
    clone.name = nextCopyName(hit.request.name, hit.parent.items);
    clone.createdAt = Date.now();
    clone.updatedAt = Date.now();
    const idx = hit.parent.items.indexOf(hit.request);
    hit.parent.items.splice(idx + 1, 0, clone);
    this.touch('request:duplicate', clone.id);
    return clone;
  }

  deleteRequest(id) {
    const hit = this.findRequest(id);
    if (!hit) return false;
    const idx = hit.parent.items.indexOf(hit.request);
    hit.parent.items.splice(idx, 1);
    this._closeTabsFor(hit.request);
    this.touch('request:delete', id);
    return true;
  }

  moveRequest(id, targetContainerId, index = -1) {
    const hit = this.findRequest(id);
    const target = this.findContainer(targetContainerId);
    if (!hit || !target) return false;
    hit.parent.items.splice(hit.parent.items.indexOf(hit.request), 1);
    if (index < 0 || index > target.items.length) target.items.push(hit.request);
    else target.items.splice(index, 0, hit.request);
    this.touch('request:move', id);
    return true;
  }

  /* --------------------------------------------------------- environments */

  createEnvironment(name = 'New Environment', values = []) {
    const env = { id: uid('env'), name, values };
    this.state.environments.push(env);
    this.touch('environment:create', env.id);
    return env;
  }

  updateEnvironment(id, patch) {
    const env = this.state.environments.find((e) => e.id === id);
    if (!env) return null;
    Object.assign(env, patch, { id: env.id });
    this.touch('environment:update', id);
    return env;
  }

  deleteEnvironment(id) {
    const idx = this.state.environments.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.state.environments.splice(idx, 1);
    if (this.state.activeEnvironmentId === id) this.state.activeEnvironmentId = null;
    this.touch('environment:delete', id);
    return true;
  }

  setActiveEnvironment(id) {
    this.state.activeEnvironmentId = id || null;
    this.touch('environment:activate', id);
    return this.state.activeEnvironmentId;
  }

  setGlobals(values) {
    this.state.globals = values;
    this.touch('globals:update');
    return this.state.globals;
  }

  /** Used by test scripts (`pm.environment.set`) and by agents. */
  setVariable(scope, key, value) {
    if (scope === 'globals') {
      const row = this.state.globals.find((v) => v.key === key);
      if (row) row.value = value;
      else this.state.globals.push({ key, value, enabled: true });
      this.touch('globals:update');
      return true;
    }
    const env = this.state.environments.find((e) => e.id === this.state.activeEnvironmentId);
    if (!env) return false;
    const row = env.values.find((v) => v.key === key);
    if (row) row.value = value;
    else env.values.push({ key, value, enabled: true });
    this.touch('environment:update', env.id);
    return true;
  }

  /* -------------------------------------------------------------- history */

  addHistory(entry) {
    const record = { id: uid('his'), at: Date.now(), ...entry };
    this.state.history.unshift(record);
    const limit = this.state.settings.historyLimit || 500;
    if (this.state.history.length > limit) this.state.history.length = limit;
    this.touch('history:add', record.id);
    return record;
  }

  clearHistory() {
    this.state.history = [];
    this.touch('history:clear');
  }

  /* ------------------------------------------------------------------- ui */

  patchUi(patch) {
    Object.assign(this.state.ui, patch);
    this.touch('ui:update');
    return this.state.ui;
  }

  patchSettings(patch) {
    Object.assign(this.state.settings, patch);
    this.touch('settings:update');
    return this.state.settings;
  }

  _closeTabsFor(node) {
    const ids = new Set();
    const collect = (n) => {
      if (!n) return;
      if (n.type === 'request') ids.add(n.id);
      for (const child of n.items || []) collect(child);
    };
    collect(node);
    // A tab is just a request id — see the renderer store.
    const tabs = this.state.ui.tabs || [];
    this.state.ui.tabs = tabs.filter((id) => !ids.has(id));
    if (!this.state.ui.tabs.includes(this.state.ui.activeTabId)) {
      this.state.ui.activeTabId = this.state.ui.tabs.at(-1) ?? null;
    }
  }
}

function nextCopyName(name, siblings) {
  const base = name.replace(/ Copy( \d+)?$/, '');
  const taken = new Set(siblings.map((s) => s.name));
  let candidate = `${base} Copy`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base} Copy ${n++}`;
  return candidate;
}

module.exports = { Workspace, defaultRequest, defaultState, emptyRow, uid };

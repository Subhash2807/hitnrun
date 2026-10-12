import { create } from 'zustand';
import { composeUrl } from './lib/url.js';
import { beautifyIfValid } from './lib/jsonTree.mjs';
import { responsePageName } from './lib/responseJson.mjs';

/**
 * Renderer-side store.
 *
 * The main process owns the workspace. This store mirrors it and layers local
 * "drafts" on top so typing feels instant. Drafts are flushed to main on a
 * short debounce — that debounce *is* the auto-save, which is why this app has
 * no Save button.
 *
 * When an agent edits a request through the control server, main broadcasts
 * `workspace:changed`. We accept the new value for every request except ones
 * with an in-flight local write, so an agent edit and your typing never fight.
 */

const api = window.api;
const SAVE_DEBOUNCE_MS = 300;
const saveTimers = new Map();
// Mirrors MAX_BYTES in electron/json-files.js.
const JSON_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The JSON file open in the viewer registers here. Its text lives in the
 * editor and is saved on a debounce, so anything that reads the file back
 * from the main process (duplicate, save to disk, the chat context) asks it to
 * write out first.
 */
let liveJson = null; // { id, flush: () => Promise, head: (max) => string, length: () => number }

export function registerLiveJson(entry) {
  liveJson = entry;
  return () => {
    if (liveJson === entry) liveJson = null;
  };
}

async function flushLiveJson(id) {
  if (liveJson && (!id || liveJson.id === id)) await liveJson.flush();
}

/**
 * The viewer page made from each response, so opening the same response
 * again shows that page instead of adding a copy. Keyed by the result object:
 * sending again replaces it, and the new response gets a page of its own.
 */
const responsePages = new WeakMap(); // result -> file id, or the promise of the file while it's being made

/** Depth-first walk of every request in the workspace. */
export function* walkRequests(state) {
  if (!state) return;
  const visit = function* (items, collection, parent) {
    for (const item of items) {
      if (item.type === 'folder') yield* visit(item.items, collection, item);
      else yield { request: item, collection, parent };
    }
  };
  for (const collection of state.collections) {
    yield* visit(collection.items, collection, collection);
  }
}

export function findRequest(state, id) {
  for (const hit of walkRequests(state)) {
    if (hit.request.id === id) return hit;
  }
  return null;
}

export const useStore = create((set, get) => ({
  state: null,
  ready: false,
  drafts: {},
  pending: {},
  responses: {},
  sending: {},
  progress: {},
  // requestId -> { state: 'synced'|'drifted'|'exempt'|'no-source', changes: [] }
  // Computed in the main process and pushed with every workspace change.
  syncStates: {},
  // The AI's separate workspace — never merged into `state`.
  ai: { collections: [], sessions: [] },
  control: { running: false, port: null, error: null },
  // Test docs: summaries for the sidebar, plus the recording in progress.
  docs: [],
  recording: null,
  // Bumped per doc on every change so an open doc view knows to refetch.
  docVersions: {},
  // requestId -> true once the response on screen has been added to the doc.
  addedToDoc: {},
  // In-app AI chat (beta). Chats live in the main process; this mirrors the
  // list and the open conversation.
  chats: [],
  chat: null,
  chatProviders: [],
  chatDetected: null,
  chatDraft: '',
  // JSON viewer: the files (names and sizes, no text), once loaded.
  jsonFiles: [],
  jsonLoaded: false,
  toast: null,
  modal: null,
  // In-app updates: { status, current, latest, progress, error, canInstall }.
  update: null,

  /* ------------------------------------------------------------- lifecycle */

  async init() {
    const state = await api.getState();
    set({ state, ready: true });

    api.controlStatus().then((control) => set({ control }));
    api.syncStates().then((syncStates) => set({ syncStates }));
    api.aiGetState().then((ai) => set({ ai }));

    api.onAiChanged((ai) => set({ ai }));

    api.updateState().then((update) => set({ update }));
    api.onUpdateChanged((update) => set({ update }));

    // A deleted doc can't stay open in a tab.
    const closeStaleDocTabs = (docs) => {
      const known = new Set(docs.map((d) => d.id));
      const stale = (get().state?.ui?.tabs || []).filter((t) => t.startsWith('doc_') && !known.has(t));
      stale.forEach((t) => get().closeTab(t, { skipFlush: true }));
    };
    api.docsList().then(({ docs, recording }) => {
      set({ docs, recording });
      closeStaleDocTabs(docs);
    });
    api.onDocsChanged(({ docs, recording, docId }) => {
      set((s) => ({
        docs,
        recording,
        docVersions: docId ? { ...s.docVersions, [docId]: (s.docVersions[docId] || 0) + 1 } : s.docVersions,
      }));
      closeStaleDocTabs(docs);
    });

    // A deleted JSON file can't stay open either.
    const closeStaleJsonTabs = (files) => {
      const ui = get().state?.ui;
      const tabs = ui?.jsonTabs || [];
      const known = new Set(files.map((f) => f.id));
      if (tabs.every((t) => known.has(t))) return;
      const kept = tabs.filter((t) => known.has(t));
      let active = ui.jsonActiveId;
      if (!kept.includes(active)) {
        const idx = Math.max(0, tabs.indexOf(active));
        active = kept[Math.min(idx, kept.length - 1)] ?? null;
      }
      get().patchUi({ jsonTabs: kept, jsonActiveId: active });
    };
    api.json('list').then((files) => {
      set({ jsonFiles: files, jsonLoaded: true });
      closeStaleJsonTabs(files);
    });
    api.onJsonChanged(({ files }) => {
      set({ jsonFiles: files, jsonLoaded: true });
      closeStaleJsonTabs(files);
    });

    api.onWorkspaceChanged(({ state: next, syncStates }) => {
      if (syncStates) set({ syncStates });
      const { pending, drafts } = get();
      // Drop drafts that have already been written through; keep the ones still
      // waiting on a debounce so an incoming broadcast can't undo live typing.
      const keptDrafts = {};
      for (const [id, draft] of Object.entries(drafts)) {
        if (pending[id]) keptDrafts[id] = draft;
      }
      set({ state: next, drafts: keptDrafts });
    });

    api.onControlEvent((event) => {
      if (event.type === 'request:created' && event.open) {
        get().openTab(event.requestId);
        get().showToast('Request created by agent');
      } else if (event.type === 'ui:open' && event.requestId) {
        if (get().docs.some((d) => d.id === event.requestId)) {
          get().openTab(event.requestId);
        } else if (findRequest(get().state, event.requestId)) {
          get().openTab(event.requestId);
        } else {
          // The AI's own requests live in the AI tab, not in a request tab.
          get().patchUi({ sidebarTab: 'ai', view: 'requests' });
          get().showToast('Claude wants you to look at something in the AI tab');
        }
      } else if (event.type === 'request:updated') {
        get().showToast('Request updated by agent');
      } else if (event.type === 'request:result' && event.requestId) {
        set((s) => ({ responses: { ...s.responses, [event.requestId]: event.result } }));
      }
    });

    api.chatList().then((chats) => set({ chats }));
    api.chatProviders().then((chatProviders) => set({ chatProviders }));
    api.onChatList((chats) => set({ chats }));
    api.onChatChanged((chat) => {
      if (get().chat?.id === chat.id) set({ chat });
    });
    const openChatId = state.ui?.chatId;
    if (openChatId) api.chatGet(openChatId).then((chat) => chat && set({ chat }));
    if (state.ui?.chatOpen) get().detectChatProviders();

    api.onRequestProgress((p) => {
      set((s) => ({ progress: { ...s.progress, [p.requestId]: p } }));
    });
  },

  showToast(message, tone = 'info') {
    set({ toast: { message, tone, at: Date.now() } });
    setTimeout(() => {
      if (Date.now() - (get().toast?.at ?? 0) >= 2400) set({ toast: null });
    }, 2500);
  },

  /** From the menu: report the answer, since nothing else would show it. */
  async checkForUpdates() {
    const update = await api.updateCheck();
    set({ update });
    if (update.status === 'available') get().openModal({ type: 'update' });
    else if (update.status === 'latest') get().showToast(`hitnrun ${update.current} is the latest version`);
    else if (update.error) get().showToast(update.error, 'error');
  },

  openModal(modal) {
    set({ modal });
  },
  closeModal() {
    set({ modal: null });
  },

  /* -------------------------------------------------------------- requests */

  /** The request as the user currently sees it: draft if one exists, else stored. */
  getRequest(id) {
    const { drafts, state } = get();
    if (drafts[id]) return drafts[id];
    return findRequest(state, id)?.request ?? null;
  },

  /** Apply a partial edit locally, then auto-save on a debounce. */
  patchRequest(id, patch) {
    const current = get().getRequest(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: Date.now() };

    set((s) => ({
      drafts: { ...s.drafts, [id]: next },
      pending: { ...s.pending, [id]: true },
    }));

    if (saveTimers.has(id)) clearTimeout(saveTimers.get(id));
    saveTimers.set(
      id,
      setTimeout(async () => {
        saveTimers.delete(id);
        const draft = get().drafts[id];
        if (!draft) return;
        const { id: _id, type, createdAt, ...fields } = draft;
        await api.call('updateRequest', id, fields);
        set((s) => {
          const pending = { ...s.pending };
          delete pending[id];
          return { pending };
        });
      }, SAVE_DEBOUNCE_MS)
    );
  },

  /** Force any queued write out now — used before sending or closing a tab. */
  async flush(id) {
    if (saveTimers.has(id)) {
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
    }
    const draft = get().drafts[id];
    if (!draft) return;
    const { id: _id, type, createdAt, ...fields } = draft;
    await api.call('updateRequest', id, fields);
    set((s) => {
      const pending = { ...s.pending };
      delete pending[id];
      return { pending };
    });
  },

  async createRequest(containerId, fields = {}) {
    const created = await api.call('createRequest', containerId ?? null, fields);
    const state = await api.getState();
    set({ state });
    get().openTab(created.id);
    return created;
  },

  async duplicateRequest(id) {
    await get().flush(id);
    const clone = await api.call('duplicateRequest', id);
    const state = await api.getState();
    set({ state });
    if (clone) {
      get().openTab(clone.id);
      get().showToast('Request duplicated');
    }
    return clone;
  },

  async deleteRequest(id) {
    await api.call('deleteRequest', id);
    get().closeTab(id, { skipFlush: true });
    const state = await api.getState();
    set((s) => {
      const drafts = { ...s.drafts };
      const responses = { ...s.responses };
      delete drafts[id];
      delete responses[id];
      return { state, drafts, responses };
    });
  },

  async renameRequest(id, name) {
    get().patchRequest(id, { name });
  },

  /* ------------------------------------------------------------------ tabs */

  openTab(requestId) {
    const ui = get().state?.ui;
    if (!ui || typeof requestId !== 'string') return;
    const tabs = ui.tabs.includes(requestId) ? ui.tabs : [...ui.tabs, requestId];
    // Opening a request or doc (from the AI, a recording, a shortcut) brings
    // you back from the JSON viewer, or you would never see it open.
    get().patchUi({ tabs, activeTabId: requestId, ...(ui.view === 'json' ? { view: 'requests' } : {}) });
  },

  async closeTab(requestId, { skipFlush = false } = {}) {
    if (!skipFlush) await get().flush(requestId);
    const ui = get().state?.ui;
    if (!ui) return;
    const tabs = ui.tabs.filter((t) => t !== requestId);
    let activeTabId = ui.activeTabId;
    if (activeTabId === requestId) {
      const idx = ui.tabs.indexOf(requestId);
      activeTabId = tabs[Math.min(idx, tabs.length - 1)] ?? null;
    }
    get().patchUi({ tabs, activeTabId });
  },

  closeOtherTabs(requestId) {
    get().patchUi({ tabs: [requestId], activeTabId: requestId });
  },

  setActiveTab(requestId) {
    get().patchUi({ activeTabId: requestId });
  },

  cycleTab(direction) {
    const ui = get().state?.ui;
    if (!ui || ui.tabs.length < 2) return;
    const idx = ui.tabs.indexOf(ui.activeTabId);
    const next = (idx + direction + ui.tabs.length) % ui.tabs.length;
    get().setActiveTab(ui.tabs[next]);
  },

  patchUi(patch) {
    // Optimistic: the UI should never wait on a disk write to switch tabs.
    set((s) => ({ state: { ...s.state, ui: { ...s.state.ui, ...patch } } }));
    api.call('patchUi', patch);
  },

  /* -------------------------------------------------------------- sending */

  async send(requestId) {
    await get().flush(requestId);
    set((s) => ({ sending: { ...s.sending, [requestId]: true } }));
    try {
      const result = await api.send(requestId);
      set((s) => ({
        responses: { ...s.responses, [requestId]: result },
        sending: { ...s.sending, [requestId]: false },
        // Auto mode already recorded it; otherwise the button starts fresh.
        addedToDoc: { ...s.addedToDoc, [requestId]: !!result?.docStepId },
      }));
      return result;
    } catch (err) {
      const result = { ok: false, error: { message: err?.message || String(err) } };
      set((s) => ({
        responses: { ...s.responses, [requestId]: result },
        sending: { ...s.sending, [requestId]: false },
      }));
      return result;
    }
  },

  /* ------------------------------------------------------- ai workspace */

  /** Copy AI work into the user's workspace. Only ever triggered from the UI. */
  async promoteFromAi(nodeId, targetCollectionId) {
    const result = await api.aiPromote(nodeId, targetCollectionId);
    if (!result.ok) {
      get().showToast(result.error || 'Could not add that');
      return result;
    }
    await get().refresh();
    get().showToast(`Added "${result.name}" to ${result.into}`);
    return result;
  },

  async discardAiSession(sessionId) {
    await api.aiDiscardSession(sessionId);
    set({ ai: await api.aiGetState() });
    get().showToast('AI session discarded');
  },

  async discardAllAiSessions() {
    await api.aiDiscardAll();
    set({ ai: await api.aiGetState() });
    get().showToast('All AI sessions discarded');
  },

  async deleteAiNode(nodeId) {
    await api.aiDeleteNode(nodeId);
    set({ ai: await api.aiGetState() });
  },

  /* -------------------------------------------------- source cURL syncing */

  /** Paste a fresh browser cURL onto an environment. Empty text clears it. */
  async setSource(envId, curlText) {
    const result = await api.setSource(envId, curlText);
    if (!result.ok) {
      get().showToast(result.error || 'Could not parse that cURL command');
      return result;
    }
    await get().refresh();
    set({ syncStates: await api.syncStates() });
    get().showToast(result.source ? `Source set — ${result.source.origin}` : 'Source cURL cleared');
    return result;
  },

  /** Sync one request. Flush first so a pending edit isn't overwritten. */
  async syncRequest(requestId) {
    await get().flush(requestId);
    const result = await api.syncRequest(requestId);
    if (!result.ok) {
      get().showToast(result.error);
      return result;
    }
    await get().refresh();
    set({ syncStates: await api.syncStates() });
    get().showToast(result.synced ? 'Synced with source cURL' : 'Already in sync');
    return result;
  },

  /** Sync every request inside a collection or folder. */
  async syncContainer(containerId) {
    for (const id of Object.keys(get().drafts)) await get().flush(id);
    const result = await api.syncContainer(containerId);
    if (!result.ok) {
      get().showToast(result.error);
      return result;
    }
    await get().refresh();
    set({ syncStates: await api.syncStates() });

    const bits = [`${result.synced} synced`];
    if (result.alreadyInSync) bits.push(`${result.alreadyInSync} already current`);
    if (result.exempt) bits.push(`${result.exempt} exempt`);
    get().showToast(bits.join(', '));
    return result;
  },

  /* -------------------------------------------------------------- test docs */

  async docCall(method, ...args) {
    return api.docs(method, ...args);
  },

  async startRecording({ name, mode, description, docId }) {
    const rec = await api.docs('startRecording', { name, mode, description, docId });
    if (rec) {
      get().patchUi({ sidebarTab: 'docs' });
      get().showToast(`Recording "${rec.name}" — ${rec.mode === 'auto' ? 'every send is added' : 'add responses with + Add to doc'}`);
    }
    return rec;
  },

  async stopRecording() {
    const rec = get().recording;
    await api.docs('stopRecording');
    if (rec) get().showToast(`Stopped recording "${rec.name}" — ${rec.stepCount} step${rec.stepCount === 1 ? '' : 's'}`);
  },

  /** Capture a screen or window (id from the picker) into the recording. */
  async takeShot(sourceId) {
    const out = await api.shotTake(sourceId);
    if (out.permission) return get().openModal({ type: 'screenshot' });
    get().showToast(out.ok ? `Screenshot added as step ${out.index}` : out.error || 'Could not take the screenshot');
    return out;
  },

  async pasteShot() {
    const out = await api.shotPaste();
    get().showToast(out.ok ? `Pasted image added as step ${out.index}` : out.error);
    return out;
  },

  /** The "+ Add to doc" button on a response. */
  async addResponseToDoc(requestId) {
    const result = get().responses[requestId];
    if (!result) return;
    const out = await api.docsAddResult(result, { requestId });
    if (!out.ok) return get().showToast(out.error);
    set((s) => ({ addedToDoc: { ...s.addedToDoc, [requestId]: true } }));
    get().showToast(`Added to "${out.docName}"`);
  },

  async deleteDoc(docId) {
    await api.docs('remove', docId);
    get().closeTab(docId, { skipFlush: true });
  },

  async exportDoc(docId, format, mask = true) {
    const out = await api.docsExport(docId, format, { mask });
    if (out.canceled) return out;
    if (!out.ok) {
      get().showToast(out.error || 'Could not save the doc');
      return out;
    }
    get().showToast(`Saved ${out.path.split(/[\\/]/).pop()}`);
    return out;
  },

  /** File → Import Postman Collection, and the sidebar's + menu. */
  async importPostman() {
    const out = await api.importPostman();
    if (out.canceled) return out;
    if (!out.ok) {
      get().showToast(out.error || 'Could not import that file');
      return out;
    }
    await get().refresh();
    get().patchUi({ sidebarTab: 'collections', view: 'requests' });
    get().showToast(`Imported "${out.name}"`);
    return out;
  },

  /* ------------------------------------------------------- JSON viewer */

  /** 'requests' or 'json': which half of the app fills the window. */
  setView(view) {
    if (get().state?.ui?.view !== view) get().patchUi({ view });
  },

  toggleView() {
    get().setView(get().state?.ui?.view === 'json' ? 'requests' : 'json');
  },

  openJsonFile(id) {
    const ui = get().state?.ui;
    if (!ui || typeof id !== 'string') return;
    const tabs = ui.jsonTabs || [];
    get().patchUi({ view: 'json', jsonTabs: tabs.includes(id) ? tabs : [...tabs, id], jsonActiveId: id });
  },

  /** Close a file's tab. The file itself stays in the list. */
  async closeJsonTab(id) {
    await flushLiveJson(id);
    const ui = get().state?.ui;
    if (!ui) return;
    const tabs = ui.jsonTabs || [];
    const kept = tabs.filter((t) => t !== id);
    let active = ui.jsonActiveId;
    if (active === id) active = kept[Math.min(tabs.indexOf(id), kept.length - 1)] ?? null;
    get().patchUi({ jsonTabs: kept, jsonActiveId: active });
  },

  cycleJsonTab(direction) {
    const ui = get().state?.ui;
    const tabs = ui?.jsonTabs || [];
    if (tabs.length < 2) return;
    const idx = tabs.indexOf(ui.jsonActiveId);
    get().patchUi({ jsonActiveId: tabs[(idx + direction + tabs.length) % tabs.length] });
  },

  /** A new file, opened in a tab. `fields` may carry a name and content. */
  async createJsonFile(fields = {}) {
    const file = await api.json('create', fields);
    if (!file) {
      get().showToast('That is too big to open — the limit is 50 MB');
      return null;
    }
    get().openJsonFile(file.id);
    return file;
  },

  /** "Open in JSON Viewer" on a response: its body as a new page, beautified when it's valid. */
  async openResponseInJson(requestId, text) {
    const result = get().responses[requestId];
    if (!result) return null;
    const made = responsePages.get(result);
    if (made instanceof Promise) return made; // a click that's still on its way
    const page = made && get().jsonFiles.find((f) => f.id === made);
    if (page) {
      get().openJsonFile(page.id);
      get().showToast(`This response is already in "${page.name}"`);
      return page;
    }
    const name = responsePageName(get().getRequest(requestId)?.name ?? result.request?.name, result.request?.url);
    const creating = get().createJsonFile({
      name,
      content: beautifyIfValid(text, get().state?.ui?.jsonIndent ?? 2),
      unique: true,
    });
    responsePages.set(result, creating);
    let file = null;
    try {
      file = await creating;
    } finally {
      if (file) responsePages.set(result, file.id);
      else responsePages.delete(result);
    }
    if (file) get().showToast(`Opened "${file.name}" — ${navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl'}+J to come back`);
    return file;
  },

  /** File → open .json files from disk. */
  async importJsonFiles() {
    const out = await api.jsonOpen();
    if (out.canceled) return out;
    for (const file of out.files || []) get().openJsonFile(file.id);
    if (out.errors?.length) get().showToast(out.errors.length === 1 ? out.errors[0] : `${out.errors.length} files could not be opened: ${out.errors[0]}`);
    else if (out.files?.length > 1) get().showToast(`Opened ${out.files.length} files`);
    return out;
  },

  /** Files dropped on the viewer. */
  async addDroppedJsonFiles(fileList) {
    const opened = [];
    const errors = [];
    for (const file of fileList) {
      if (file.size > JSON_MAX_BYTES) {
        errors.push(`${file.name} is bigger than 50 MB`);
        continue;
      }
      let text;
      try {
        text = await file.text();
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
        continue;
      }
      if (text.slice(0, 8192).includes('\u0000')) {
        errors.push(`${file.name} is not a text file`);
        continue;
      }
      const created = await get().createJsonFile({ name: file.name, content: text.replace(/^\uFEFF/, '') });
      if (created) opened.push(created);
    }
    if (errors.length) get().showToast(errors[0]);
    else if (opened.length > 1) get().showToast(`Opened ${opened.length} files`);
  },

  async renameJsonFile(id, name) {
    if (name?.trim()) await api.json('update', id, { name });
  },

  async duplicateJsonFile(id) {
    await flushLiveJson(id);
    const copy = await api.json('duplicate', id);
    if (copy) {
      get().openJsonFile(copy.id);
      get().showToast(`Duplicated as "${copy.name}"`);
    }
    return copy;
  },

  async deleteJsonFile(id) {
    await api.json('remove', id);
  },

  /** Save a copy of a file to disk. */
  async saveJsonToDisk(id) {
    await flushLiveJson(id);
    const out = await api.jsonSave(id);
    if (out.canceled) return out;
    get().showToast(out.ok ? `Saved ${out.path.split(/[\\/]/).pop()}` : out.error || 'Could not save the file');
    return out;
  },

  /* ------------------------------------------------------ AI chat (beta) */

  /** Open or close the chat panel. `prompt` prefills the input; `send` sends it straight away. */
  async toggleChat(open, { prompt, send = false } = {}) {
    const next = open ?? !get().state?.ui?.chatOpen;
    get().patchUi({ chatOpen: next });
    if (!next) return;
    if (!get().chatDetected) get().detectChatProviders();
    if (!get().chat) {
      const id = get().state.ui.chatId;
      const existing = id && (await api.chatGet(id));
      if (existing) set({ chat: existing });
    }
    if (prompt != null) {
      if (send) {
        // An "Ask" button starts a fresh chat unless the open one is still empty.
        if (!get().chat || get().chat.messages.length) await get().newChat();
        await get().sendChat(prompt);
      } else {
        set({ chatDraft: prompt });
      }
    }
  },

  async detectChatProviders(force = false) {
    set({ chatDetected: await api.chatDetect(force) });
  },

  async newChat(options = {}) {
    const chat = await api.chatCreate(options);
    set({ chat });
    get().patchUi({ chatId: chat.id, chatView: 'chat' });
    return chat;
  },

  async openChat(id) {
    const chat = await api.chatGet(id);
    if (!chat) return;
    set({ chat });
    get().patchUi({ chatId: id, chatView: 'chat' });
  },

  async deleteChat(id) {
    await api.chatRemove(id);
    if (get().chat?.id === id) {
      set({ chat: null });
      get().patchUi({ chatId: null });
    }
  },

  /** Switch CLI or model. The choice also becomes the default for new chats. */
  async configureChat(options) {
    const chat = get().chat;
    const defaults = get().chatDefaults();
    if (!chat || chat.messages.length === 0) {
      const provider = options.provider || chat?.provider || defaults.provider;
      const patch = { provider };
      if (options.model != null) patch.models = { [provider]: options.model };
      await get().saveChatSettings(patch);
    }
    if (!chat) return;
    const out = await api.chatConfigure(chat.id, options);
    if (!out.ok) return get().showToast(out.error);
    set({ chat: out.chat });
    if (chat.messages.length) {
      await get().saveChatSettings({ provider: out.chat.provider, models: { [out.chat.provider]: out.chat.model } });
    }
  },

  chatDefaults() {
    const settings = get().state?.settings?.chat || {};
    const provider = settings.provider || 'claude';
    return { provider, model: settings.models?.[provider] || '', customCommand: settings.customCommand || '' };
  },

  async saveChatSettings(patch) {
    await api.chatSettings(patch);
    await get().refresh();
    if ('customCommand' in patch) get().detectChatProviders(true);
  },

  /** Describe what is open in the app, so "why is this failing?" needs no pasting. */
  chatContext() {
    const { state, responses } = get();
    if (state?.ui?.view === 'json') return get().jsonChatContext();
    const active = state?.ui?.activeTabId;
    if (!active) return null;
    const env = state.environments.find((e) => e.id === state.activeEnvironmentId);
    const lines = [];
    let label = null;
    if (active.startsWith('doc_')) {
      const doc = get().docs.find((d) => d.id === active);
      if (!doc) return null;
      label = doc.name;
      lines.push(`Open test doc: "${doc.name}" (id ${doc.id}). Read it with get_doc.`);
    } else {
      const request = get().getRequest(active);
      const hit = findRequest(state, active);
      if (!request) return null;
      label = request.name;
      lines.push(`Open request: "${request.name}" (id ${request.id})${hit ? ` in collection "${hit.collection.name}"` : ''}`);
      // Query params live in their own grid; put them back the way the URL bar shows them.
      const shown = composeUrl(request.url, request.params || []);
      lines.push(`${request.method} ${shown}`);
      if (request.body?.mode === 'raw' && request.body.raw?.trim()) {
        lines.push(`Request body (${request.body.rawType || 'text'}):
${request.body.raw.slice(0, 2000)}`);
      } else if (request.body?.mode && request.body.mode !== 'none') {
        lines.push(`Request body: ${request.body.mode}`);
      }
      const result = responses[active];
      const sent = result?.request?.fullUrl || result?.request?.url;
      if (sent && sent !== shown) lines.push(`URL actually sent (variables filled in): ${sent}`);
      const failure = result?.error || result?.response?.error;
      if (failure) {
        lines.push(`Last send failed: ${failure.message}${failure.code ? ` (${failure.code})` : ''}`);
      } else if (result?.response) {
        const r = result.response;
        lines.push(`Last response: ${r.status} ${r.statusText || ''} in ${Math.round(r.timeMs ?? 0)} ms`);
        const body = decodeBody(r.bodyBase64);
        if (body) lines.push(`Response body${body.length > 3000 ? ' (first 3000 characters)' : ''}:\n${body.slice(0, 3000)}`);
        const tests = result.tests || [];
        if (tests.length) lines.push(`Tests: ${tests.filter((t) => t.passed).length}/${tests.length} passed`);
      }
    }
    if (env) lines.push(`Active environment: ${env.name}`);
    return { label, text: `<hitnrun-context>\n${lines.join('\n')}\n</hitnrun-context>` };
  },

  /**
   * The JSON file on screen, for the chat. The chat panel asks for the label
   * on every store change, so the text is only read when a message is sent.
   */
  jsonChatContext() {
    const id = get().state?.ui?.jsonActiveId;
    const file = id && get().jsonFiles.find((f) => f.id === id);
    if (!file) return null;
    const live = liveJson?.id === id ? liveJson : null;
    return {
      label: file.name,
      get text() {
        const length = live ? live.length() : 0;
        const head = live ? live.head(6000) : '';
        const lines = [`Open in hitnrun's JSON viewer: "${file.name}".`];
        if (head.trim()) {
          lines.push(`Its content${length > 6000 ? ` (the first 6000 of ${length} characters)` : ''}:\n${head}`);
        } else {
          lines.push('The file is empty.');
        }
        return `<hitnrun-context>\n${lines.join('\n')}\n</hitnrun-context>`;
      },
    };
  },

  async sendChat(text, { includeContext = true } = {}) {
    let chat = get().chat;
    if (!chat) chat = await get().newChat();
    const context = includeContext ? get().chatContext() : null;
    const out = await api.chatSend(chat.id, { text, context: context?.text, contextLabel: context?.label });
    if (!out.ok) {
      get().showToast(out.error || 'Could not send that');
      return out;
    }
    set({ chatDraft: '' });
    return out;
  },

  async stopChat() {
    const chat = get().chat;
    if (chat) await api.chatStop(chat.id);
  },

  /* ------------------------------------------------------ collections etc. */

  async refresh() {
    set({ state: await api.getState() });
  },

  async call(method, ...args) {
    const result = await api.call(method, ...args);
    set({ state: await api.getState() });
    return result;
  },
}));

/** A base64 response body as text; binary bodies come back empty. */
function decodeBody(b64) {
  if (!b64) return '';
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

export { api };

import { create } from 'zustand';
import { composeUrl } from './lib/url.js';

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
  toast: null,
  modal: null,

  /* ------------------------------------------------------------- lifecycle */

  async init() {
    const state = await api.getState();
    set({ state, ready: true });

    api.controlStatus().then((control) => set({ control }));
    api.syncStates().then((syncStates) => set({ syncStates }));
    api.aiGetState().then((ai) => set({ ai }));

    api.onAiChanged((ai) => set({ ai }));

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
          get().patchUi({ sidebarTab: 'ai' });
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
    get().patchUi({ tabs, activeTabId: requestId });
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
    get().patchUi({ sidebarTab: 'collections' });
    get().showToast(`Imported "${out.name}"`);
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

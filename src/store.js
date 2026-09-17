import { create } from 'zustand';

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
  control: { running: false, port: null, error: null },
  toast: null,
  modal: null,

  /* ------------------------------------------------------------- lifecycle */

  async init() {
    const state = await api.getState();
    set({ state, ready: true });

    api.controlStatus().then((control) => set({ control }));

    api.onWorkspaceChanged(({ state: next }) => {
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
        get().openTab(event.requestId);
      } else if (event.type === 'request:updated') {
        get().showToast('Request updated by agent');
      } else if (event.type === 'request:result' && event.requestId) {
        set((s) => ({ responses: { ...s.responses, [event.requestId]: event.result } }));
      }
    });

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
    if (!ui) return;
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

export { api };

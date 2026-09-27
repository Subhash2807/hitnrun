'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu, globalShortcut, Notification, nativeImage, protocol, net,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { Workspace, defaultRequest, uid } = require('./workspace');
const { AiWorkspace } = require('./ai-workspace');
const { normalizePolicy } = require('./guardrails');
const { execute } = require('./runner');
const { parseCurl, toCurl, looksLikeCurl } = require('./curl');
const { ControlServer } = require('./control-server');
const { parseSource, buildPatch, syncState, describeChanges } = require('./sync');
const { DocStore } = require('./docs');
const docExport = require('./doc-export');
const { importPostman } = require('./postman');
const codegen = require('./codegen');
const { ChatManager } = require('./chat');
const { PROVIDERS } = require('./chat-providers');
const screenshots = require('./screenshots');

// Screenshot steps are shown from their files through this scheme, so the page
// never needs file:// access. Must be declared before the app is ready.
const SHOT_SCHEME = 'hitnrun-shot';
protocol.registerSchemesAsPrivileged([{ scheme: SHOT_SCHEME, privileges: { standard: true, secure: true } }]);

// Only `npm run dev` sets this. Running unpackaged (`electron .`) still loads the
// built bundle, so the window is never blank just because Vite isn't up.
const isDev = process.env.NODE_ENV === 'development';

let mainWindow = null;
let workspace = null;
let aiWorkspace = null;
let docs = null;
let chats = null;
let controlServer = null;
let controlStatus = { running: false, port: null, error: null };

/* ------------------------------------------------------------------ window */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1b1b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Zoom is handled here rather than by the menu roles: the zoomIn role's
  // accelerator is Ctrl+Plus, which on most keyboards needs Shift, so plain
  // Ctrl+= did nothing. Zoom is also remembered across restarts.
  mainWindow.webContents.on('did-finish-load', () => {
    const level = workspace.getState().settings.zoomLevel;
    if (typeof level === 'number') mainWindow.webContents.setZoomLevel(level);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key;
    if (key === '=' || key === '+' || input.code === 'NumpadAdd') {
      zoomBy(0.5);
      event.preventDefault();
    } else if (key === '-' || key === '_' || input.code === 'NumpadSubtract') {
      zoomBy(-0.5);
      event.preventDefault();
    } else if (key === '0' || input.code === 'Numpad0') {
      zoomBy(null);
      event.preventDefault();
    }
  });

  const bundle = path.join(__dirname, '..', 'dist', 'index.html');

  if (isDev) {
    // If the dev server isn't up yet, fall back to the last build rather than
    // showing an error page.
    mainWindow.loadURL('http://localhost:5173').catch(() => mainWindow.loadFile(bundle));
  } else {
    mainWindow.loadFile(bundle);
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[window] failed to load ${failedUrl}: ${description} (${code})`);
    if (failedUrl.startsWith('http://localhost:5173')) mainWindow.loadFile(bundle);
  });

  // Links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Step the zoom by `delta` levels, or reset with null. Clamped to -3..+5. */
function zoomBy(delta) {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const next = delta == null ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + delta));
  wc.setZoomLevel(next);
  workspace.patchSettings({ zoomLevel: next });
}

/* -------------------------------------------------------------------- menu */

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const emit = (command) => () => mainWindow?.webContents.send('menu:command', command);

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Request', accelerator: 'CmdOrCtrl+N', click: emit('request:new') },
        { label: 'New Collection', accelerator: 'CmdOrCtrl+Shift+N', click: emit('collection:new') },
        { type: 'separator' },
        { label: 'Duplicate Request', accelerator: 'CmdOrCtrl+D', click: emit('request:duplicate') },
        { label: 'Copy as cURL', accelerator: 'CmdOrCtrl+Shift+C', click: emit('request:copyCurl') },
        { label: 'Import cURL from Clipboard', accelerator: 'CmdOrCtrl+Shift+V', click: emit('request:importCurl') },
        { label: 'Import Postman Collection…', click: emit('collection:import') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: emit('tab:close') },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Request',
      submenu: [
        { label: 'Send', accelerator: 'CmdOrCtrl+Return', click: emit('request:send') },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Alt+Right', click: emit('tab:next') },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Alt+Left', click: emit('tab:prev') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'AI Assistant (Beta)', accelerator: 'CmdOrCtrl+L', click: emit('chat:toggle') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Shown for discoverability; the keys themselves are caught in before-input-event.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => zoomBy(null) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => zoomBy(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => zoomBy(-0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --------------------------------------------------------------- migration */

// Electron derives userData from productName, so renaming the app moves the
// data directory and strands whatever was saved under the old name. Names we
// have shipped under before, newest first.
const LEGACY_PRODUCT_NAMES = ['API Client'];

/**
 * One-time adoption of a previous release's data directory.
 * Only runs when this build has no workspace of its own, so it can never
 * overwrite newer data, and the originals are copied rather than moved.
 */
function migrateLegacyUserData(dir) {
  const target = path.join(dir, 'workspace.json');
  if (fs.existsSync(target)) return null;

  const parent = path.dirname(dir);
  for (const name of LEGACY_PRODUCT_NAMES) {
    const legacyDir = path.join(parent, name);
    const legacyWorkspace = path.join(legacyDir, 'workspace.json');
    if (!fs.existsSync(legacyWorkspace)) continue;

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(legacyWorkspace, target);

      const legacyAi = path.join(legacyDir, 'ai-workspace.json');
      if (fs.existsSync(legacyAi)) {
        fs.copyFileSync(legacyAi, path.join(dir, 'ai-workspace.json'));
      }
      console.log(`[migration] adopted saved data from "${name}"`);
      return legacyDir;
    } catch (err) {
      console.error('[migration] failed:', err.message);
      return null;
    }
  }
  return null;
}

/* ----------------------------------------------------------------- startup */

async function startControlServer() {
  const settings = workspace.getState().settings.controlServer || {};
  if (controlServer) await controlServer.stop();

  if (!settings.enabled) {
    controlStatus = { running: false, port: null, error: null };
    return controlStatus;
  }

  controlServer = new ControlServer({
    workspace,
    aiWorkspace,
    docs,
    environmentName: activeEnvironmentName,
    // Guardrail and permission questions from the in-app chat are asked there.
    approve: (question) => (chats ? chats.requestApproval(question) : Promise.resolve(false)),
    onEvent: (event) => {
      mainWindow?.webContents.send('control:event', event);
      if (event.focus && mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    },
  });

  const result = await controlServer.start(settings.port || 47600);
  controlStatus = { running: result.ok, port: result.port ?? null, error: result.error ?? null };
  return controlStatus;
}

app.whenReady().then(async () => {
  migrateLegacyUserData(app.getPath('userData'));

  workspace = new Workspace(path.join(app.getPath('userData'), 'workspace.json'));
  workspace.load();
  workspace.ensureDefaultEnvironment();

  // Separate file on purpose — the AI never holds a writable handle to the
  // user's requests, so isolation survives bugs in the AI code paths.
  aiWorkspace = new AiWorkspace(
    path.join(app.getPath('userData'), 'ai-workspace.json'),
    () => workspace.getState()
  );
  aiWorkspace.load();
  aiWorkspace.on('changed', () => {
    mainWindow?.webContents.send('ai:changed', {
      collections: aiWorkspace.getState().collections,
      sessions: aiWorkspace.listSessions(),
    });
  });

  docs = new DocStore(path.join(app.getPath('userData'), 'docs.json'));
  docs.load();
  docs.on('changed', ({ reason, docId }) => {
    mainWindow?.webContents.send('docs:changed', { reason, docId, ...docsSnapshot() });
    syncShotShortcut();
  });
  docs.on('error', (err) => console.error('[docs]', err));

  chats = new ChatManager({
    file: path.join(app.getPath('userData'), 'chats.json'),
    workRoot: path.join(app.getPath('userData'), 'chat-sessions'),
    mcp: mcpLaunchSpec,
    settings: () => workspace.getState().settings.chat || {},
  });
  chats.load();
  chats.on('chat', (chat) => mainWindow?.webContents.send('chat:changed', chat));
  chats.on('list', (list) => mainWindow?.webContents.send('chat:list', list));
  chats.on('error', (err) => console.error('[chat]', err));

  // Every mutation — from the UI or from an agent — refreshes the window.
  // Sync states ride along so the indicators never need a second round trip.
  workspace.on('changed', ({ reason, detail, state }) => {
    mainWindow?.webContents.send('workspace:changed', {
      reason,
      detail,
      state,
      syncStates: computeSyncStates(),
    });
  });
  workspace.on('error', (err) => console.error('[workspace]', err));

  protocol.handle(SHOT_SCHEME, (req) => {
    const full = docs.shotPath(decodeURIComponent(new URL(req.url).pathname.slice(1)));
    return full ? net.fetch(pathToFileURL(full).href) : new Response('Not found', { status: 404 });
  });

  registerIpc();
  syncShotShortcut();
  buildMenu();
  createWindow();
  await startControlServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  workspace?.saveNow(); // flush any pending debounced write
  aiWorkspace?.saveNow();
  docs?.saveNow();
  chats?.shutdown();
  controlServer?.stop();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

/* --------------------------------------------------------------------- ipc */

/**
 * How to start hitnrun's MCP server: used by the setup instructions and by the
 * in-app chat, which hands it to the CLI it runs.
 */
function mcpLaunchSpec() {
  const settings = workspace.getState().settings;
  const port = settings.controlServer?.port || 47600;
  const token = settings.controlServer?.token || '';

  // Packaged builds run a single esbuild bundle. Shipping the raw source
  // instead would mean unpacking its whole transitive dependency tree from the
  // asar, and any dep missed there fails only in the installed copy.
  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'mcp', 'server.bundle.js')
    : path.join(__dirname, '..', 'mcp', 'server.js');

  // An installed copy cannot assume Node exists on the machine. Electron ships
  // a Node runtime, and ELECTRON_RUN_AS_NODE makes our own binary behave as
  // one — so the MCP server runs with zero extra prerequisites.
  const runtime = app.isPackaged ? process.execPath : 'node';
  const env = {
    HITNRUN_PORT: String(port),
    ...(token ? { HITNRUN_TOKEN: token } : {}),
    ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  return { command: runtime, args: [serverPath], env, port, token };
}

// Only these workspace methods are reachable from the renderer.
const ALLOWED_WS_METHODS = new Set([
  'createCollection', 'updateCollection', 'deleteCollection',
  'createFolder', 'updateFolder', 'deleteFolder', 'createRequest', 'updateRequest', 'duplicateRequest',
  'deleteRequest', 'moveRequest',
  'createEnvironment', 'updateEnvironment', 'deleteEnvironment',
  'setActiveEnvironment', 'setGlobals', 'setVariable',
  'addHistory', 'clearHistory', 'patchUi', 'patchSettings',
  'findRequest',
]);

// Only these doc-store methods are reachable from the renderer.
const ALLOWED_DOC_METHODS = new Set([
  'get', 'create', 'update', 'remove', 'duplicate',
  'startRecording', 'setRecording', 'stopRecording',
  'updateStep', 'deleteStep', 'moveStep',
]);

function docsSnapshot() {
  return { docs: docs.list(), recording: docs.recording() };
}

function activeEnvironmentName() {
  const state = workspace.getState();
  return state.environments.find((e) => e.id === state.activeEnvironmentId)?.name || null;
}

/** Offer a finished send to the recording. Only lands if recording in auto mode, or forced. */
function recordToDocs(result, meta = {}) {
  if (!docs || !result) return null;
  return docs.capture(result, { environment: activeEnvironmentName(), ...meta });
}

/* ------------------------------------------------------------ screenshots */

const SHOT_SHORTCUT = 'CommandOrControl+Shift+S';
let shotShortcutOn = false;

/**
 * The screenshot shortcut works from any app, but only while recording, so it
 * never takes Ctrl+Shift+S away from other apps the rest of the time.
 */
function syncShotShortcut() {
  const want = !!docs?.recording();
  if (want === shotShortcutOn) return;
  if (want) shotShortcutOn = globalShortcut.register(SHOT_SHORTCUT, onShotShortcut);
  else {
    globalShortcut.unregister(SHOT_SHORTCUT);
    shotShortcutOn = false;
  }
}

async function onShotShortcut() {
  // In hitnrun you get the picker; from another app, the screen you're on.
  if (mainWindow?.isFocused()) return mainWindow.webContents.send('menu:command', 'shot:pick');
  const out = await takeShot('screen:cursor');
  if (!Notification.isSupported()) return;
  const body = out.ok
    ? `Added as step ${out.index} in "${out.docName}"`
    : out.permission
      ? 'hitnrun needs Screen Recording permission. Open hitnrun to allow it.'
      : out.error;
  new Notification({ title: out.ok ? 'Screenshot added' : 'Screenshot failed', body, silent: true }).show();
}

/** Capture a screen or window into the recording doc. */
async function takeShot(sourceId) {
  const rec = docs.recording();
  if (!rec) return { ok: false, error: 'Start a recording first' };
  const shot = await screenshots.capture(sourceId, mainWindow);
  if (!shot.ok) return shot;
  return addShotStep(rec, shot.png, shot);
}

function addShotStep(rec, png, meta) {
  const step = docs.addShot(rec.docId, png, meta);
  if (!step) return { ok: false, error: 'Could not save the screenshot' };
  return { ok: true, stepId: step.id, docName: rec.name, index: docs.get(rec.docId).steps.length };
}

/** Where a Markdown download puts its images: a folder named after the .md file. */
function markdownImageDir(mdPath) {
  return `${path.basename(mdPath).replace(/\.md$/i, '')} images`;
}

/** Render a doc for download. PDF prints the fully expanded HTML in a hidden window. */
async function renderDoc(doc, format, mask, { imageDir } = {}) {
  const image = (file) => docs.readShot(file);
  if (format === 'markdown') return Buffer.from(docExport.toMarkdown(doc, { mask, imageDir }), 'utf8');
  if (format === 'html') return Buffer.from(docExport.toHtml(doc, { mask, image }), 'utf8');
  if (format === 'postman') return Buffer.from(docExport.toPostman(doc, { mask }), 'utf8');
  if (format === 'pdf') {
    const html = docExport.toHtml(doc, { mask, expandAll: true, image });
    const tmp = path.join(app.getPath('temp'), `hitnrun-doc-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      await win.loadFile(tmp);
      return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    } finally {
      win.destroy();
      fs.rm(tmp, { force: true }, () => {});
    }
  }
  throw new Error(`Unknown format "${format}"`);
}

/** Sync state for every request in the workspace, against the active environment. */
function computeSyncStates() {
  const source = workspace.activeSource();
  const map = {};
  for (const hit of workspace.walk()) {
    if (hit.request) map[hit.request.id] = syncState(hit.request, source);
  }
  return map;
}

/** Apply the source cURL to a list of requests. Returns a per-request outcome. */
function syncRequests(requests) {
  const source = workspace.activeSource();
  if (!source) return { ok: false, error: 'The active environment has no source cURL' };

  const results = { ok: true, synced: 0, alreadyInSync: 0, exempt: 0, details: [] };
  for (const request of requests) {
    const before = syncState(request, source);
    if (before.state === 'exempt') {
      results.exempt++;
      results.details.push({ id: request.id, name: request.name, outcome: 'exempt' });
      continue;
    }
    if (before.state === 'synced') {
      results.alreadyInSync++;
      results.details.push({ id: request.id, name: request.name, outcome: 'already-in-sync' });
      continue;
    }
    const changes = describeChanges(request, source);
    workspace.applySyncPatch(request.id, buildPatch(request, source));
    results.synced++;
    results.details.push({ id: request.id, name: request.name, outcome: 'synced', changes });
  }
  return results;
}

function registerIpc() {
  ipcMain.handle('ws:getState', () => workspace.getState());
  ipcMain.handle('sync:states', () => computeSyncStates());

  ipcMain.handle('sync:setSource', (_e, envId, curlText) => {
    if (!curlText || !String(curlText).trim()) {
      workspace.setEnvironmentSource(envId, null);
      return { ok: true, source: null };
    }
    const parsed = parseSource(curlText);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    workspace.setEnvironmentSource(envId, parsed.source);
    return { ok: true, source: parsed.source };
  });

  ipcMain.handle('sync:request', (_e, requestId) => {
    const hit = workspace.findRequest(requestId);
    if (!hit) return { ok: false, error: 'Request not found' };
    return syncRequests([hit.request]);
  });

  ipcMain.handle('sync:container', (_e, containerId) => {
    const requests = workspace.requestsIn(containerId);
    if (!requests.length) return { ok: false, error: 'Nothing to sync in there' };
    return syncRequests(requests);
  });

  ipcMain.handle('sync:describe', (_e, requestId) => {
    const hit = workspace.findRequest(requestId);
    if (!hit) return [];
    return describeChanges(hit.request, workspace.activeSource());
  });

  ipcMain.handle('ws:call', (_e, method, args = []) => {
    if (!ALLOWED_WS_METHODS.has(method)) {
      throw new Error(`Workspace method "${method}" is not exposed to the renderer`);
    }
    const result = workspace[method](...args);
    // findRequest returns objects with parent back-references — strip them.
    if (method === 'findRequest' && result) {
      return { request: result.request, collectionId: result.collection.id };
    }
    return result;
  });

  ipcMain.handle('req:send', async (_e, requestId, overrides) => {
    const hit = workspace.findRequest(requestId);
    if (!hit) return { ok: false, error: { message: 'Request not found', code: 'ERR_NOT_FOUND' } };
    // Overrides let the UI run unsaved edits without a round-trip save first.
    const request = overrides ? { ...hit.request, ...overrides } : hit.request;
    const result = await execute(workspace, request, {
      collection: hit.collection,
      onProgress: (p) => mainWindow?.webContents.send('req:progress', { requestId, ...p }),
    });
    const step = recordToDocs(result, { source: 'user', requestId });
    return step ? { ...result, docStepId: step.id } : result;
  });

  ipcMain.handle('req:sendAdHoc', async (_e, request) => {
    const result = await execute(workspace, defaultRequest(request), { collection: null });
    recordToDocs(result, { source: 'user' });
    return result;
  });

  /* ------------------------------------------------------------ code panel */

  ipcMain.handle('code:languages', () => codegen.LANGUAGES);
  ipcMain.handle('code:generate', (_e, request, options = {}) => {
    const hit = request?.id ? workspace.findRequest(request.id) : null;
    try {
      return {
        ok: true,
        code: codegen.generate(request, {
          state: workspace.getState(),
          collection: hit?.collection || null,
          language: options.language,
          resolve: !!options.resolve,
        }),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ------------------------------------------------------------------ docs */

  ipcMain.handle('docs:list', () => docsSnapshot());
  ipcMain.handle('docs:call', (_e, method, args = []) => {
    if (!ALLOWED_DOC_METHODS.has(method)) throw new Error(`Doc method "${method}" is not exposed to the renderer`);
    return docs[method](...args);
  });

  /** The "Add to doc" button: records the response on screen into the recording doc. */
  ipcMain.handle('docs:addResult', (_e, result, meta = {}) => {
    const rec = docs.recording();
    if (!rec) return { ok: false, error: 'Start a recording first' };
    const step = docs.addStep(rec.docId, result, {
      environment: activeEnvironmentName(),
      source: 'user',
      requestId: meta.requestId,
    });
    return step ? { ok: true, stepId: step.id, docName: rec.name } : { ok: false, error: 'Nothing to add' };
  });

  ipcMain.handle('docs:export', async (_e, docId, format, { mask = true } = {}) => {
    const doc = docs.get(docId);
    if (!doc) return { ok: false, error: 'Doc not found' };
    const spec = docExport.FORMATS[format];
    if (!spec) return { ok: false, error: `Unknown format "${format}"` };
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${docExport.safeFileName(doc.name)}.${spec.ext}`,
      filters: [spec.filter],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const withImages = format === 'markdown' && docExport.hasShots(doc);
      const imageDir = withImages ? markdownImageDir(result.filePath) : null;
      fs.writeFileSync(result.filePath, await renderDoc(doc, format, mask, { imageDir }));
      if (withImages) {
        const dir = path.join(path.dirname(result.filePath), imageDir);
        fs.mkdirSync(dir, { recursive: true });
        for (const step of doc.steps) {
          const from = step.kind === 'shot' && docs.shotPath(step.shot.file);
          if (from) fs.copyFileSync(from, path.join(dir, docExport.shotFileName(step)));
        }
      }
      return { ok: true, path: result.filePath, imageDir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shots:sources', () => screenshots.listSources(mainWindow));
  ipcMain.handle('shots:take', (_e, sourceId) => takeShot(sourceId));
  /** Paste an image you copied (Win+Shift+S, Cmd+Ctrl+Shift+4, or from any app) as a step. */
  ipcMain.handle('shots:paste', () => {
    const rec = docs.recording();
    if (!rec) return { ok: false, error: 'Start a recording first' };
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false, error: 'There is no image on the clipboard' };
    const { width, height } = img.getSize();
    return addShotStep(rec, img.toPNG(), { width, height, source: 'Clipboard' });
  });
  ipcMain.handle('shots:copy', (_e, file) => {
    const full = docs.shotPath(file);
    if (!full) return false;
    clipboard.writeImage(nativeImage.createFromPath(full));
    return true;
  });
  ipcMain.handle('shots:open', (_e, file) => {
    const full = docs.shotPath(file);
    return full ? shell.openPath(full) : 'Screenshot file is missing';
  });
  ipcMain.handle('shots:settings', () => screenshots.openPermissionSettings());

  ipcMain.handle('docs:reveal', (_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });

  /* ------------------------------------------------------ postman import */

  ipcMain.handle('collection:importPostman', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a Postman collection',
      properties: ['openFile'],
      filters: [{ name: 'Postman collection', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    let text;
    try {
      text = fs.readFileSync(picked.filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const parsed = importPostman(text);
    if (!parsed.ok) return parsed;
    workspace.importCollection(parsed.collection);
    return { ok: true, id: parsed.collection.id, name: parsed.collection.name };
  });

  ipcMain.handle('curl:parse', (_e, text) => parseCurl(text));
  ipcMain.handle('curl:generate', (_e, request, options) => toCurl(request, options || {}));
  ipcMain.handle('curl:detect', (_e, text) => looksLikeCurl(text));

  ipcMain.handle('dialog:pickFile', async (_e, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: options.filters,
      title: options.title,
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_e, options = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    if (result.canceled || !result.filePath) return null;
    if (options.contentBase64 != null) {
      require('node:fs').writeFileSync(result.filePath, Buffer.from(options.contentBase64, 'base64'));
    } else if (options.content != null) {
      require('node:fs').writeFileSync(result.filePath, options.content, 'utf8');
    }
    return result.filePath;
  });

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  /* ---------------------------------------------------------- ai workspace */

  ipcMain.handle('ai:getState', () => ({
    collections: aiWorkspace.getState().collections,
    sessions: aiWorkspace.listSessions(),
  }));

  /**
   * Promote AI work into the user's workspace. This only ever runs from the UI —
   * there is no control-server route for it, so an agent cannot promote its own
   * output. The user decides what crosses the wall.
   */
  ipcMain.handle('ai:promote', (_e, nodeId, targetCollectionId) => {
    const exported = aiWorkspace.exportForPromotion(nodeId);
    if (!exported) return { ok: false, error: 'Nothing found to promote' };

    let target = workspace.getState().collections.find((c) => c.id === targetCollectionId);
    if (!target) target = workspace.getState().collections[0] || workspace.createCollection('From AI');

    const node = exported.value;
    if (node.type === 'request') {
      target.items.push(node);
    } else {
      target.items.push({ ...node, type: 'folder' });
    }
    workspace.touch('ai:promoted', node.id);
    return { ok: true, id: node.id, name: node.name, into: target.name };
  });

  ipcMain.handle('ai:discardSession', (_e, sessionId) => aiWorkspace.discardSession(sessionId));
  ipcMain.handle('ai:discardAll', () => aiWorkspace.discardAll());
  ipcMain.handle('ai:deleteNode', (_e, nodeId) => aiWorkspace.deleteNode(nodeId));

  /**
   * Everything needed to point an MCP client at this app.
   *
   * When packaged, mcp/ is kept OUTSIDE the asar archive (see build.asarUnpack)
   * because Node cannot execute a script from inside one.
   */
  ipcMain.handle('ai:setupInfo', () => {
    const { command: runtime, args: [serverPath], env, port, token } = mcpLaunchSpec();

    const envFlags = Object.entries(env)
      .map(([k, v]) => `--env ${k}=${v}`)
      .join(' ');

    const quoted = (p) => (p.includes(' ') ? `"${p}"` : p);

    // PowerShell's own `--` handling swallows the separator before the CLI sees
    // it, so Windows users need the cmd-shim form instead of the bash form.
    const bashCommand = `claude mcp add hitnrun --scope user ${envFlags} -- ${quoted(runtime)} "${serverPath}"`;
    const powershellCommand = `claude.cmd --% mcp add hitnrun --scope user ${envFlags} -- ${quoted(runtime)} "${serverPath}"`;

    return {
      serverPath,
      runtime,
      port,
      hasToken: !!token,
      packaged: app.isPackaged,
      needsNode: !app.isPackaged,
      claudeCodeCommand: bashCommand,
      powershellCommand,
      configJson: JSON.stringify(
        { mcpServers: { hitnrun: { command: runtime, args: [serverPath], env } } },
        null,
        2
      ),
    };
  });

  ipcMain.handle('ai:setPolicy', (_e, policy) => {
    const normalized = normalizePolicy(policy);
    workspace.patchSettings({ aiPolicy: normalized });
    return normalized;
  });

  /* ------------------------------------------------------ AI chat (beta) */

  // Static facts about each CLI; which ones are installed comes from chat:detect.
  ipcMain.handle('chat:providers', () =>
    Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      experimental: !!p.experimental,
      install: p.install || null,
      login: p.login || null,
      models: p.models,
      caps: p.caps,
    }))
  );
  ipcMain.handle('chat:detect', (_e, force) => chats.detect(!!force));
  ipcMain.handle('ai:connectClaudeCode', () => chats.connectClaudeCode(mcpLaunchSpec()));
  ipcMain.handle('chat:list', () => chats.list());
  ipcMain.handle('chat:get', (_e, id) => chats.get(id));
  ipcMain.handle('chat:create', (_e, options) => chats.create(options));
  ipcMain.handle('chat:rename', (_e, id, title) => chats.rename(id, title));
  ipcMain.handle('chat:remove', (_e, id) => chats.remove(id));
  ipcMain.handle('chat:stop', (_e, id) => chats.stop(id));
  ipcMain.handle('chat:approve', (_e, approvalId, answer) => chats.answerApproval(approvalId, answer));
  ipcMain.handle('chat:configure', (_e, id, options) => {
    try {
      return { ok: true, chat: chats.configure(id, options) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('chat:send', async (_e, id, message) => {
    // The chat's MCP server talks to the control server, so it has to be up.
    if (!controlStatus.running) {
      return { ok: false, error: 'The agent control server is off. Turn it on in Settings so the assistant can reach the app.' };
    }
    try {
      return await chats.send(id, message);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('chat:settings', (_e, patch = {}) => {
    const current = workspace.getState().settings.chat || {};
    const next = { ...current, ...patch, models: { ...current.models, ...patch.models } };
    workspace.patchSettings({ chat: next });
    if ('customCommand' in patch) chats.detect(true);
    return next;
  });

  ipcMain.handle('control:status', () => controlStatus);
  ipcMain.handle('control:restart', async (_e, config) => {
    if (config) workspace.patchSettings({ controlServer: { ...workspace.getState().settings.controlServer, ...config } });
    return startControlServer();
  });
}

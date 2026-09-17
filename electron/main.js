'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu } = require('electron');
const path = require('node:path');

const { Workspace, defaultRequest } = require('./workspace');
const { execute } = require('./runner');
const { parseCurl, toCurl, looksLikeCurl } = require('./curl');
const { ControlServer } = require('./control-server');

// Only `npm run dev` sets this. Running unpackaged (`electron .`) still loads the
// built bundle, so the window is never blank just because Vite isn't up.
const isDev = process.env.NODE_ENV === 'development';

let mainWindow = null;
let workspace = null;
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
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  workspace = new Workspace(path.join(app.getPath('userData'), 'workspace.json'));
  workspace.load();

  // Every mutation — from the UI or from an agent — refreshes the window.
  workspace.on('changed', ({ reason, detail, state }) => {
    mainWindow?.webContents.send('workspace:changed', { reason, detail, state });
  });
  workspace.on('error', (err) => console.error('[workspace]', err));

  registerIpc();
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
  controlServer?.stop();
});

/* --------------------------------------------------------------------- ipc */

// Only these workspace methods are reachable from the renderer.
const ALLOWED_WS_METHODS = new Set([
  'createCollection', 'updateCollection', 'deleteCollection',
  'createFolder', 'createRequest', 'updateRequest', 'duplicateRequest',
  'deleteRequest', 'moveRequest',
  'createEnvironment', 'updateEnvironment', 'deleteEnvironment',
  'setActiveEnvironment', 'setGlobals', 'setVariable',
  'addHistory', 'clearHistory', 'patchUi', 'patchSettings',
  'findRequest',
]);

function registerIpc() {
  ipcMain.handle('ws:getState', () => workspace.getState());

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
    return execute(workspace, request, {
      collection: hit.collection,
      onProgress: (p) => mainWindow?.webContents.send('req:progress', { requestId, ...p }),
    });
  });

  ipcMain.handle('req:sendAdHoc', async (_e, request) => {
    return execute(workspace, defaultRequest(request), { collection: null });
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

  ipcMain.handle('control:status', () => controlStatus);
  ipcMain.handle('control:restart', async (_e, config) => {
    if (config) workspace.patchSettings({ controlServer: { ...workspace.getState().settings.controlServer, ...config } });
    return startControlServer();
  });
}

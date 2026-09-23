'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the renderer and Node. contextIsolation stays on and
 * nodeIntegration stays off — the renderer never touches fs, net, or require.
 */
contextBridge.exposeInMainWorld('api', {
  /* workspace ------------------------------------------------------------ */
  getState: () => ipcRenderer.invoke('ws:getState'),
  call: (method, ...args) => ipcRenderer.invoke('ws:call', method, args),

  /* execution ------------------------------------------------------------ */
  send: (requestId, overrides) => ipcRenderer.invoke('req:send', requestId, overrides),
  sendAdHoc: (request) => ipcRenderer.invoke('req:sendAdHoc', request),
  cancel: (runId) => ipcRenderer.invoke('req:cancel', runId),

  /* cURL ----------------------------------------------------------------- */
  parseCurl: (text) => ipcRenderer.invoke('curl:parse', text),
  toCurl: (request, options) => ipcRenderer.invoke('curl:generate', request, options),
  looksLikeCurl: (text) => ipcRenderer.invoke('curl:detect', text),

  /* source-cURL sync ------------------------------------------------------ */
  syncStates: () => ipcRenderer.invoke('sync:states'),
  setSource: (envId, curlText) => ipcRenderer.invoke('sync:setSource', envId, curlText),
  syncRequest: (requestId) => ipcRenderer.invoke('sync:request', requestId),
  syncContainer: (containerId) => ipcRenderer.invoke('sync:container', containerId),
  describeSync: (requestId) => ipcRenderer.invoke('sync:describe', requestId),

  /* AI workspace ---------------------------------------------------------- */
  aiGetState: () => ipcRenderer.invoke('ai:getState'),
  aiPromote: (nodeId, targetCollectionId) => ipcRenderer.invoke('ai:promote', nodeId, targetCollectionId),
  aiDiscardSession: (sessionId) => ipcRenderer.invoke('ai:discardSession', sessionId),
  aiDiscardAll: () => ipcRenderer.invoke('ai:discardAll'),
  aiDeleteNode: (nodeId) => ipcRenderer.invoke('ai:deleteNode', nodeId),
  aiSetPolicy: (policy) => ipcRenderer.invoke('ai:setPolicy', policy),
  aiSetupInfo: () => ipcRenderer.invoke('ai:setupInfo'),
  onAiChanged: (cb) => subscribe('ai:changed', cb),

  /* test docs ------------------------------------------------------------- */
  docsList: () => ipcRenderer.invoke('docs:list'),
  docs: (method, ...args) => ipcRenderer.invoke('docs:call', method, args),
  docsAddResult: (result, meta) => ipcRenderer.invoke('docs:addResult', result, meta),
  docsExport: (docId, format, options) => ipcRenderer.invoke('docs:export', docId, format, options),
  docsReveal: (filePath) => ipcRenderer.invoke('docs:reveal', filePath),
  onDocsChanged: (cb) => subscribe('docs:changed', cb),

  /* code panel / import --------------------------------------------------- */
  codeLanguages: () => ipcRenderer.invoke('code:languages'),
  generateCode: (request, options) => ipcRenderer.invoke('code:generate', request, options),
  importPostman: () => ipcRenderer.invoke('collection:importPostman'),

  /* system --------------------------------------------------------------- */
  pickFile: (options) => ipcRenderer.invoke('dialog:pickFile', options),
  saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  /* control server -------------------------------------------------------- */
  controlStatus: () => ipcRenderer.invoke('control:status'),
  controlRestart: (config) => ipcRenderer.invoke('control:restart', config),

  /* events ---------------------------------------------------------------- */
  onWorkspaceChanged: (cb) => subscribe('workspace:changed', cb),
  onControlEvent: (cb) => subscribe('control:event', cb),
  onMenuCommand: (cb) => subscribe('menu:command', cb),
  onRequestProgress: (cb) => subscribe('req:progress', cb),
});

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getCaps: (force) => ipcRenderer.invoke('caps:get', !!force),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  addPaths: (paths) => ipcRenderer.invoke('jobs:add', paths),
  removeJob: (id) => ipcRenderer.invoke('jobs:remove', id),
  clearDone: () => ipcRenderer.invoke('jobs:clearDone'),
  retryJob: (id) => ipcRenderer.invoke('jobs:retry', id),
  start: () => ipcRenderer.invoke('queue:start'),
  stop: () => ipcRenderer.invoke('queue:stop'),
  openFilesDialog: () => ipcRenderer.invoke('dialog:openFiles'),
  chooseOutputDir: () => ipcRenderer.invoke('dialog:outputDir'),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  // Electron >= 32 removed File.path; this is the sanctioned way to get it.
  pathForFile: (file) => webUtils.getPathForFile(file),
  onJobUpdate: (cb) => ipcRenderer.on('job:update', (_e, job) => cb(job)),
  onQueueState: (cb) => ipcRenderer.on('queue:state', (_e, s) => cb(s)),
  onCapsReady: (cb) => ipcRenderer.on('caps:ready', (_e, c) => cb(c)),
});

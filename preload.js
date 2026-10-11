const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('maxauth', {
  chooseDatabaseFile: (mode) => ipcRenderer.invoke('choose-database-file', mode),
  testConnection: (config) => ipcRenderer.invoke('test-connection', config),
  inspectSource: (request) => ipcRenderer.invoke('inspect-source', request),
  buildPreview: (request) => ipcRenderer.invoke('build-preview', request),
  migrate: (request) => ipcRenderer.invoke('migrate', request),
  exportSql: (request) => ipcRenderer.invoke('export-sql', request),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('migration-progress', listener);
    return () => ipcRenderer.removeListener('migration-progress', listener);
  }
});

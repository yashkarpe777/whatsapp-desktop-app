const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  restartBackend: () => ipcRenderer.invoke('backend:restart'),
  env: {
    ADMIN_API_BASE_URL: process.env.ADMIN_API_BASE_URL || '',
    CORE_API_BASE_URL: `http://127.0.0.1:${process.env.PORT || '3000'}`
  }
});

const { contextBridge, ipcRenderer } = require('electron');

// Note what is deliberately NOT exposed here: no raw access/refresh tokens,
// no Discord OAuth data. The renderer only ever gets a public user profile
// and plain ok/error results.
contextBridge.exposeInMainWorld('bridge', {
  getAuthStatus: () => ipcRenderer.invoke('auth:getStatus'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  whoami: () => ipcRenderer.invoke('api:whoami'),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sgn', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (opts) => ipcRenderer.invoke('save-dialog', opts),
  micPermission: () => ipcRenderer.invoke('mic-permission'),
  readLame: () => ipcRenderer.invoke('read-lame'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd, arg) => cb(cmd, arg)),
});

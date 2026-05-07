const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  supervisorStart: () => ipcRenderer.invoke('supervisor:start'),
  supervisorStop: () => ipcRenderer.invoke('supervisor:stop'),
  supervisorStatus: () => ipcRenderer.invoke('supervisor:status'),
  onSupervisorOutput: (callback) => ipcRenderer.on('supervisor:output', callback),
  onSupervisorError: (callback) => ipcRenderer.on('supervisor:error', callback),
  onSupervisorExit: (callback) => ipcRenderer.on('supervisor:exit', callback),
});

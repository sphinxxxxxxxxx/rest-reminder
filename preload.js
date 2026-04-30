const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    uploadMedia: (isSecondary) => ipcRenderer.invoke('upload-media', isSecondary),
    startWork: (config) => ipcRenderer.send('start-work', config),
    previewMode: (config) => ipcRenderer.send('preview-mode', config),
    
    updateLayout: (data) => ipcRenderer.send('update-layout', data),
    exitAdjustMode: () => ipcRenderer.send('exit-adjust-mode'),
    
    endRestEarly: () => ipcRenderer.send('end-rest-early'),
    hideWindow: () => ipcRenderer.send('hide-window'),
    minWindow: () => ipcRenderer.send('min-window'),
    restartWork: () => ipcRenderer.send('restart-work'),
    
    onTimerUpdate: (callback) => ipcRenderer.on('timer-update', (event, time) => callback(time)),
    onMainTimerTick: (callback) => ipcRenderer.on('main-timer-tick', (event, time) => callback(time)),
    onStateSync: (callback) => ipcRenderer.on('state-sync', (event, data) => callback(data)),
    onCleanup: (callback) => ipcRenderer.on('cleanup-before-destroy', () => callback())
});

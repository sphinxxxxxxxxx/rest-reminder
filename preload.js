const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    uploadMedia: () => ipcRenderer.invoke('upload-media'),
    startWork: (config) => ipcRenderer.send('start-work', config),
    previewMode: (config) => ipcRenderer.send('preview-mode', config),
    saveLayout: (layout) => ipcRenderer.send('save-layout', layout),
    endRestEarly: () => ipcRenderer.send('end-rest-early'),
    
    // 监听事件
    onTimerUpdate: (callback) => ipcRenderer.on('timer-update', (event, time) => callback(time)),
    onCleanup: (callback) => ipcRenderer.on('cleanup-before-destroy', () => callback())
});
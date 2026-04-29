const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    uploadMedia: () => ipcRenderer.invoke('upload-media'),
    startWork: (config) => ipcRenderer.send('start-work', config),
    previewMode: (config) => ipcRenderer.send('preview-mode', config),
    saveLayout: (layout) => ipcRenderer.send('save-layout', layout),
    endRestEarly: () => ipcRenderer.send('end-rest-early'),
    
    // 新增：工作面板控制
    hideWindow: () => ipcRenderer.send('hide-window'),
    minWindow: () => ipcRenderer.send('min-window'),
    restartWork: () => ipcRenderer.send('restart-work'),
    
    // 监听事件
    onTimerUpdate: (callback) => ipcRenderer.on('timer-update', (event, time) => callback(time)),
    onMainTimerTick: (callback) => ipcRenderer.on('main-timer-tick', (event, time) => callback(time)),
    onStateSync: (callback) => ipcRenderer.on('state-sync', (event, data) => callback(data)),
    onCleanup: (callback) => ipcRenderer.on('cleanup-before-destroy', () => callback())
});

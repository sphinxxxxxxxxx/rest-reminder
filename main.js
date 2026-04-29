const { app, BrowserWindow, ipcMain, Tray, Menu, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null; 
let restWindows = [];
let timerState = 'idle'; // idle, working, resting
let timeLeft = 0;
let timerInterval = null;

let userConfig = {
  workTime: 45, restTime: 5,  
  mediaPath: '', mediaType: '', 
  layout: { x: 50, y: 50, width: 400, height: 300 }
};

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getIconPath() {
  const packagedPath = path.join(process.resourcesPath, 'icon.png');
  const devPath = path.join(__dirname, 'build', 'icon.png');
  if (app.isPackaged && fs.existsSync(packagedPath)) return packagedPath;
  if (fs.existsSync(devPath)) return devPath;
  return null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 760, height: 480,
    transparent: true, // 开启全局透明
    frame: false,      // 移除系统边框以实现完美的玻璃质感
    hasShadow: true,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
  
  // 每次打开窗口时，向前端同步当前状态和倒计时
  mainWindow.on('show', () => {
    mainWindow.webContents.send('state-sync', { state: timerState, timeLeft });
  });

  mainWindow.on('close', (e) => {
    if (timerState !== 'idle') {
      e.preventDefault();
      mainWindow.hide(); 
    }
  });
}

function initTray() {
  const iconPath = getIconPath();
  if (!iconPath) return;
  try {
    if (tray) tray.destroy();
    tray = new Tray(iconPath); 
    const contextMenu = Menu.buildFromTemplate([
      { label: '打开控制面板', click: () => { if (mainWindow) mainWindow.show(); } },
      { label: '立即休息', click: () => startTimer('resting') },
      { type: 'separator' },
      { label: '退出程序', click: () => { timerState = 'idle'; app.exit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip('Rest Reminder');
    tray.on('click', () => {
        if (mainWindow) mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    });
  } catch (error) { console.error(error); }
}

function updateTray() {
  if (!tray) return;
  const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
  const s = (timeLeft % 60).toString().padStart(2, '0');
  let hoverText = 'Rest Reminder - 待机中';
  if (timerState === 'working') hoverText = `专注中: 还剩 ${m}:${s}`;
  if (timerState === 'resting') hoverText = `休息中: 还剩 ${m}:${s}`;
  tray.setToolTip(hoverText);
}

function showRestWindows(isAdjustMode = false) {
  // 【关键 Bug 修复】永远在创建新窗口前，彻底清空所有旧的打断层，防止重叠
  destroyRestWindows(); 
  
  const displays = screen.getAllDisplays();
  displays.forEach((display) => {
    let win = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y,
      width: display.bounds.width, height: display.bounds.height,
      transparent: true, frame: false, resizable: false, movable: false, thickFrame: false,      
      alwaysOnTop: !isAdjustMode, skipTaskbar: true, fullscreen: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });

    if (!isAdjustMode) win.setAlwaysOnTop(true, 'screen-saver'); 

    const query = new URLSearchParams({
      mode: isAdjustMode ? 'adjust' : 'rest',
      mediaPath: userConfig.mediaPath, mediaType: userConfig.mediaType,
      x: userConfig.layout.x, y: userConfig.layout.y,
      w: userConfig.layout.width, h: userConfig.layout.height,
      isMain: true
    });
    win.loadFile('rest.html', { search: query.toString() });
    restWindows.push(win);
  });
}

function destroyRestWindows() {
  restWindows.forEach(win => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('cleanup-before-destroy'); 
      win.destroy(); 
    }
  });
  restWindows = [];
}

function startTimer(type) {
  if (timerInterval) clearInterval(timerInterval);
  timerState = type;
  
  if (type === 'working') {
    timeLeft = userConfig.workTime * 60;
    if (mainWindow) mainWindow.hide();
    destroyRestWindows();
  } else if (type === 'resting') {
    timeLeft = userConfig.restTime * 60;
    showRestWindows(false);
  }
  
  updateTray();
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTray();
    
    // 【新增逻辑】如果主窗口可见且在工作中，向主窗口发送秒表跳动
    if (timerState === 'working') {
        if (mainWindow && mainWindow.isVisible()) {
            mainWindow.webContents.send('main-timer-tick', timeLeft);
        }
    } else if (timerState === 'resting') {
       restWindows.forEach(w => {
           if (w && !w.isDestroyed()) w.webContents.send('timer-update', timeLeft);
       });
    }
    
    if (timeLeft <= 0) {
      startTimer(timerState === 'working' ? 'resting' : 'working');
    }
  }, 1000);
}

// --- IPC 接口与窗口控制 ---
ipcMain.on('hide-window', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('min-window', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('restart-work', () => { startTimer('working'); });

ipcMain.handle('upload-media', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'MediaFiles', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm'] }],
    properties: ['openFile']
  });
  if (canceled) return null;
  const sourcePath = filePaths[0];
  const ext = path.extname(sourcePath).toLowerCase();
  const mediaDir = path.join(app.getPath('userData'), 'media_cache');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  else {
    const files = fs.readdirSync(mediaDir);
    for (const file of files) fs.unlinkSync(path.join(mediaDir, file));
  }
  const destPath = path.join(mediaDir, `custom_media${ext}`);
  fs.copyFileSync(sourcePath, destPath);
  userConfig.mediaPath = destPath;
  userConfig.mediaType = (ext === '.mp4' || ext === '.webm') ? 'video' : 'image';
  return userConfig;
});

ipcMain.on('start-work', (e, config) => { userConfig = { ...userConfig, ...config }; startTimer('working'); });

ipcMain.on('preview-mode', (e, config) => { 
  userConfig = { ...userConfig, ...config }; 
  // 【关键 Bug 修复】进入调整模式时，强制清除计时器，防止倒计时引发重叠冲突
  if (timerInterval) clearInterval(timerInterval);
  timerState = 'idle';
  showRestWindows(true); 
});

ipcMain.on('save-layout', (e, layout) => { userConfig.layout = layout; destroyRestWindows(); });
ipcMain.on('end-rest-early', () => { startTimer('working'); });

app.whenReady().then(() => {
  createMainWindow();
  setTimeout(initTray, 800); 
});

process.on('uncaughtException', (err) => { console.error(err); });

const { app, BrowserWindow, ipcMain, Tray, Menu, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 1. 强制单例锁 (防多开)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let restWindows = []; // 支持多显示器，保存所有休息窗口的实例
let tray = null;

// 状态控制
let timerState = 'idle'; // idle, working, resting
let timeLeft = 0;
let timerInterval = null;
let userConfig = {
  workTime: 45, // 分钟
  restTime: 5,  // 分钟
  mediaPath: '',
  mediaType: '', // 'image' | 'video'
  layout: { x: 50, y: 50, width: 400, height: 300 }
};

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,  // 【修改】主窗口加宽，以展示横版UI
    height: 520, // 【修改】主窗口变矮，避免多余空白
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools(); // 调试时可开启
  mainWindow.on('close', (e) => {
    if (timerState !== 'idle') {
      e.preventDefault();
      mainWindow.hide(); // 工作时仅隐藏到托盘
    }
  });
}

// 2. 媒体缓存与磁盘管理
ipcMain.handle('upload-media', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Media', extensions: ['png', 'gif', 'mp4'] }],
    properties: ['openFile']
  });
  
  if (canceled || filePaths.length === 0) return null;

  const sourcePath = filePaths[0];
  const ext = path.extname(sourcePath).toLowerCase();
  const mediaDir = path.join(app.getPath('userData'), 'media_cache');
  
  // 严格要求：清空旧文件，防垃圾文件堆积
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  } else {
    const files = fs.readdirSync(mediaDir);
    for (const file of files) {
      fs.unlinkSync(path.join(mediaDir, file));
    }
  }

  const destPath = path.join(mediaDir, `custom_media${ext}`);
  fs.copyFileSync(sourcePath, destPath);

  userConfig.mediaPath = destPath;
  userConfig.mediaType = ext === '.mp4' ? 'video' : 'image';
  return userConfig;
});

// 3. 休息窗口管理（多显示器支持与严格防作弊拦截）
function showRestWindows(isAdjustMode = false) {
  const displays = screen.getAllDisplays();
  
  displays.forEach((display, index) => {
    
    let win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,      // 100% 透明背景
      frame: false,           // 无边框
      resizable: false,       // 禁止拉伸调整窗口大小
      movable: false,         // 禁止拖动窗口
      thickFrame: false,      // 彻底移除 Windows 下透明窗口的隐形拖拽边框
      alwaysOnTop: !isAdjustMode, // 调整模式下不强制置顶
      skipTaskbar: true,
      fullscreen: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js')
      }
    });

    // 强制全局最高层级 (阻断作用)
    if (!isAdjustMode) win.setAlwaysOnTop(true, 'screen-saver'); 

    // 【修改】将媒体数据传递给所有屏幕，强制所有屏幕的 isMain 均为 true
    const query = new URLSearchParams({
      mode: isAdjustMode ? 'adjust' : 'rest',
      mediaPath: userConfig.mediaPath,
      mediaType: userConfig.mediaType,
      x: userConfig.layout.x,
      y: userConfig.layout.y,
      w: userConfig.layout.width,
      h: userConfig.layout.height,
      isMain: true 
    });

    win.loadFile('rest.html', { search: query.toString() });
    restWindows.push(win);
  });
}

function destroyRestWindows() {
  restWindows.forEach(win => {
    if (!win.isDestroyed()) {
      // 严格要求：销毁前通知前端清除视频引用，防止内存泄漏
      win.webContents.send('cleanup-before-destroy'); 
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy(); // 彻底销毁而非 hide
      }, 100);
    }
  });
  restWindows = [];
}

// 定时器控制
function startTimer(type) {
  clearInterval(timerInterval);
  timerState = type;
  
  if (type === 'working') {
    timeLeft = userConfig.workTime * 60;
    if(mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    destroyRestWindows();
  } else if (type === 'resting') {
    timeLeft = userConfig.restTime * 60;
    showRestWindows(false);
  }

  updateTray();
  
  timerInterval = setInterval(() => {
    timeLeft--;
    updateTray();
    
    if (timerState === 'resting') {
       restWindows.forEach(w => w.webContents.send('timer-update', timeLeft));
    }

    if (timeLeft <= 0) {
      if (timerState === 'working') startTimer('resting');
      else if (timerState === 'resting') startTimer('working');
    }
  }, 1000);
}

// 4. 系统托盘
function initTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  // 加入容错保护
  if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath); 
      updateTray();
  } else {
      console.log('提示：由于没有检测到 build/icon.png，系统托盘图标将不会显示。你可以后续补充图片。');
  }
}

function updateTray() {
  if (!tray) return;
  const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
  const s = (timeLeft % 60).toString().padStart(2, '0');
  
  let hoverText = 'Rest Reminder - 待机中';
  if (timerState === 'working') hoverText = `工作倒计时 ${m}:${s}`;
  if (timerState === 'resting') hoverText = `休息中 ${m}:${s}`;
  
  tray.setToolTip(hoverText);

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => mainWindow.show() },
    { label: '立即休息', click: () => startTimer('resting') },
    { type: 'separator' },
    { label: '退出程序', click: () => {
        timerState = 'idle'; // 允许关闭
        app.quit();
    }}
  ]);
  tray.setContextMenu(contextMenu);
}

// IPC 接口监听
ipcMain.on('start-work', (e, config) => {
  userConfig = { ...userConfig, ...config };
  startTimer('working');
});

ipcMain.on('preview-mode', (e, config) => {
  userConfig = { ...userConfig, ...config };
  showRestWindows(true);
});

ipcMain.on('save-layout', (e, layout) => {
  userConfig.layout = layout;
  destroyRestWindows(); // 退出调整模式
});

ipcMain.on('end-rest-early', () => {
  startTimer('working');
});

app.whenReady().then(() => {
  createMainWindow();
  initTray();
});
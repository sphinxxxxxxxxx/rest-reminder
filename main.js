const { app, BrowserWindow, ipcMain, Tray, Menu, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// --- 1. 核心变量全局化，防止被垃圾回收 ---
let mainWindow = null;
let tray = null; 
let restWindows = [];
let timerState = 'idle'; 
let timeLeft = 0;
let timerInterval = null;

let userConfig = {
  workTime: 45, 
  restTime: 5,  
  mediaPath: '',
  mediaType: '', 
  layout: { x: 50, y: 50, width: 400, height: 300 }
};

// 2. 强制单例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 520,
    // 如果存在图标就设置，不存在也不要崩溃
    icon: fs.existsSync(path.join(__dirname, 'build/icon.png')) ? path.join(__dirname, 'build/icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
  
  mainWindow.on('close', (e) => {
    if (timerState !== 'idle') {
      e.preventDefault();
      mainWindow.hide(); 
    }
  });
}

// 3. 增强版托盘初始化
function initTray() {
  // 智能寻找图标路径
  const iconPath = path.join(__dirname, 'build/icon.png');

  console.log('正在尝试加载托盘图标:', iconPath);

  if (!fs.existsSync(iconPath)) {
    console.error('❌ 错误：在 build 目录下没找到 icon.png！请确认文件夹名字是 build 且图片名是 icon.png');
    return;
  }

  try {
    // 重新实例化前确保旧的被销毁（虽然这里只会运行一次）
    if (tray) tray.destroy();

    tray = new Tray(iconPath); 
    const contextMenu = Menu.buildFromTemplate([
      { label: '打开控制面板', click: () => {
          if (mainWindow) mainWindow.show();
      }},
      { label: '立即休息', click: () => startTimer('resting') },
      { type: 'separator' },
      { label: '退出程序', click: () => {
          timerState = 'idle';
          app.exit(); // 强制退出所有进程
      }}
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip('Rest Reminder - 运行中');

    // Windows 托盘点击事件
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
        }
    });

    console.log('✅ 托盘图标已成功挂载！');
  } catch (error) {
    console.error('❌ 托盘创建过程中发生崩溃:', error);
  }
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

// 4. 休息窗口逻辑
function showRestWindows(isAdjustMode = false) {
  const displays = screen.getAllDisplays();
  restWindows = []; // 清空数组
  
  displays.forEach((display) => {
    let win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,      
      frame: false,           
      resizable: false,       
      movable: false,         
      thickFrame: false,      
      alwaysOnTop: !isAdjustMode, 
      skipTaskbar: true,
      fullscreen: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });

    if (!isAdjustMode) win.setAlwaysOnTop(true, 'screen-saver'); 

    const query = new URLSearchParams({
      mode: isAdjustMode ? 'adjust' : 'rest',
      mediaPath: userConfig.mediaPath,
      mediaType: userConfig.mediaType,
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
    if (timerState === 'resting') {
       restWindows.forEach(w => {
           if (w && !w.isDestroyed()) w.webContents.send('timer-update', timeLeft);
       });
    }
    if (timeLeft <= 0) {
      startTimer(timerState === 'working' ? 'resting' : 'working');
    }
  }, 1000);
}

// IPC 接口
ipcMain.handle('upload-media', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Media', extensions: ['png', 'gif', 'mp4'] }],
    properties: ['openFile']
  });
  if (canceled) return null;
  const sourcePath = filePaths[0];
  const ext = path.extname(sourcePath).toLowerCase();
  const mediaDir = path.join(app.getPath('userData'), 'media_cache');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  const destPath = path.join(mediaDir, `custom_media${ext}`);
  fs.copyFileSync(sourcePath, destPath);
  userConfig.mediaPath = destPath;
  userConfig.mediaType = ext === '.mp4' ? 'video' : 'image';
  return userConfig;
});

ipcMain.on('start-work', (e, config) => { userConfig = { ...userConfig, ...config }; startTimer('working'); });
ipcMain.on('preview-mode', (e, config) => { userConfig = { ...userConfig, ...config }; showRestWindows(true); });
ipcMain.on('save-layout', (e, layout) => { userConfig.layout = layout; destroyRestWindows(); });
ipcMain.on('end-rest-early', () => { startTimer('working'); });

// 5. 启动流程
app.whenReady().then(() => {
  createMainWindow();
  // 在 Windows 上稍微延迟一下启动托盘，增加稳定性
  setTimeout(initTray, 500); 
});

// 防止程序因为小错误崩溃退出
process.on('uncaughtException', (err) => {
  console.error('发现未捕获的错误:', err);
});

const { app, BrowserWindow, ipcMain, Tray, Menu, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null, tray = null, restWindows = [], timerState = 'idle';
let timeLeft = 0, timerInterval = null, targetEndTime = 0; 
let isQuitting = false;

// 初始化默认配置与存档路径
let userConfig = { workTime: 45, restTime: 5, mediaPath: '', mediaPath2: '', mediaType: '', layouts: {} };
const configPath = path.join(app.getPath('userData'), 'user_config.json');

function loadConfig() { 
    if (fs.existsSync(configPath)) { 
        try { userConfig = { ...userConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } 
        catch(e) { console.error('加载存档失败:', e); } 
    } 
}
function saveConfig() { fs.writeFileSync(configPath, JSON.stringify(userConfig)); }

// 单例锁：防止用户疯狂点击打开无数个软件
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();
else app.on('second-instance', () => { if (mainWindow) { mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

function getIconPath() {
  const p = path.join(process.resourcesPath, 'icon.png'), d = path.join(__dirname, 'build', 'icon.png');
  return (app.isPackaged && fs.existsSync(p)) ? p : (fs.existsSync(d) ? d : null);
}

// 动态托盘权限控制
function updateTrayMenu() {
  if (!tray) return;
  const isResting = timerState === 'resting';
  
  const contextMenu = Menu.buildFromTemplate([
    { label: '控制面板', enabled: !isResting, click: () => mainWindow.show() }, 
    { label: isResting ? '🚫 休息中严禁退出' : '彻底退出', enabled: !isResting, click: () => { isQuitting = true; app.exit(); } }
  ]);
  tray.setContextMenu(contextMenu);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800, height: 540, transparent: true, frame: false, hasShadow: true, icon: getIconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('show', () => mainWindow.webContents.send('state-sync', { 
      state: timerState, timeLeft, hasPrimary: !!userConfig.mediaPath, hasSecondary: !!userConfig.mediaPath2,
      workTime: userConfig.workTime, restTime: userConfig.restTime
  }));
  mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } });
}

function showRestWindows(isAdjustMode = false) {
  destroyRestWindows(); 
  
  screen.getAllDisplays().forEach((display) => {
    let win = new BrowserWindow({
      x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
      transparent: true, frame: false, resizable: false, movable: false, thickFrame: false,      
      alwaysOnTop: !isAdjustMode, skipTaskbar: true, fullscreen: true, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    
    // 非调整模式下开启最高级别置顶
    if (!isAdjustMode) win.setAlwaysOnTop(true, 'screen-saver'); 
    
    const layout = userConfig.layouts[display.id] || { x: 50, y: 50, width: 400, height: 300 };
    const query = new URLSearchParams({
      mode: isAdjustMode ? 'adjust' : 'rest', displayId: display.id,
      path1: userConfig.mediaPath, path2: userConfig.mediaPath2, type: userConfig.mediaType,
      x: layout.x, y: layout.y, w: layout.width, h: layout.height
    });
    win.loadFile('rest.html', { search: query.toString() });
    restWindows.push(win);
  });
}

function destroyRestWindows() {
  restWindows.forEach(win => { 
      if (win && !win.isDestroyed()) { 
          win.webContents.send('cleanup-before-destroy'); 
          setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 50); 
      } 
  });
  restWindows = [];
}

// 核心：基于绝对时间戳的精准计时算法
function startTimer(type) {
  if (timerInterval) clearInterval(timerInterval);
  timerState = type;
  updateTrayMenu(); // 状态改变，同步锁死或解锁托盘
  
  const durationInSeconds = (type === 'working' ? userConfig.workTime : userConfig.restTime) * 60;
  targetEndTime = Date.now() + durationInSeconds * 1000; 
  
  if (type === 'working') { if (mainWindow) mainWindow.hide(); destroyRestWindows(); }
  else { showRestWindows(false); }
  
  timerInterval = setInterval(() => {
    timeLeft = Math.max(0, Math.round((targetEndTime - Date.now()) / 1000));
    
    if (timerState === 'working' && mainWindow?.isVisible()) mainWindow.webContents.send('main-timer-tick', timeLeft);
    else if (timerState === 'resting') restWindows.forEach(w => { if (!w.isDestroyed()) w.webContents.send('timer-update', timeLeft); });
    
    if (timeLeft <= 0) startTimer(timerState === 'working' ? 'resting' : 'working');
  }, 1000);
}

// 文件上传与自动粉碎旧垃圾逻辑
ipcMain.handle('upload-media', async (e, isSecondary) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm'] }], properties: ['openFile'] });
  if (canceled) return null;
  const ext = path.extname(filePaths[0]).toLowerCase();
  const mediaDir = path.join(app.getPath('userData'), 'media_cache');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  
  const filePrefix = isSecondary ? 'loop_media' : 'intro_media';
  fs.readdirSync(mediaDir).forEach(f => { if (f.startsWith(filePrefix)) fs.unlinkSync(path.join(mediaDir, f)); });
  const destPath = path.join(mediaDir, `${filePrefix}${ext}`);
  fs.copyFileSync(filePaths[0], destPath);
  
  if (isSecondary) { userConfig.mediaPath2 = destPath; } 
  else { userConfig.mediaPath = destPath; userConfig.mediaType = (ext === '.mp4' || ext === '.webm') ? 'video' : 'image'; userConfig.mediaPath2 = ''; }
  saveConfig();
  return { path: destPath, isSecondary, hasSecondary: !!userConfig.mediaPath2 };
});

// 前端操作信号监听
ipcMain.on('hide-window', () => mainWindow?.hide());
ipcMain.on('min-window', () => mainWindow?.minimize());
ipcMain.on('restart-work', () => startTimer('working'));
ipcMain.on('end-rest-early', () => startTimer('working'));
ipcMain.on('start-work', (e, config) => { userConfig = { ...userConfig, ...config }; saveConfig(); startTimer('working'); });
ipcMain.on('preview-mode', (e, config) => { 
    userConfig = { ...userConfig, ...config }; saveConfig(); 
    if (timerInterval) clearInterval(timerInterval); 
    timerState = 'idle'; updateTrayMenu(); 
    showRestWindows(true); 
});
ipcMain.on('update-layout', (e, { displayId, layout }) => { userConfig.layouts[displayId] = layout; saveConfig(); });
ipcMain.on('exit-adjust-mode', () => { destroyRestWindows(); });

// 程序主入口
app.whenReady().then(() => {
  loadConfig(); 
  createMainWindow();
  setTimeout(() => {
      const icon = getIconPath();
      if (icon) {
        try {
            tray = new Tray(icon);
            updateTrayMenu(); 
            tray.setToolTip('Rest Reminder');
            // 休息期间彻底无视鼠标左键
            tray.on('click', () => { if (timerState !== 'resting') mainWindow.show(); });
        } catch(err) { console.error('托盘初始化失败:', err); }
      }
  }, 500);
});

process.on('uncaughtException', (err) => { console.error('系统崩溃拦截:', err); });

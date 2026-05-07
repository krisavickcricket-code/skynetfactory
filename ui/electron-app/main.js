const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let supervisorProcess = null;

function getRootDir() {
  // main.js is in ui/electron-app/
  return path.resolve(__dirname, '..', '..');
}

function getSupervisorPath() {
  return path.resolve(__dirname, '..', '..', 'supervisor', 'dist', 'api-server', 'main.js');
}

ipcMain.handle('supervisor:start', async () => {
  if (supervisorProcess) {
    return { success: false, error: 'Supervisor already running' };
  }
  const supervisorPath = getSupervisorPath();
  const rootDir = getRootDir();
  supervisorProcess = spawn('node', [supervisorPath], {
    cwd: rootDir,
    env: { ...process.env, SKYNET_FACTORY_ROOT: rootDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  supervisorProcess.stdout.on('data', (data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('supervisor:output', data.toString());
    }
  });

  supervisorProcess.stderr.on('data', (data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('supervisor:error', data.toString());
    }
  });

  supervisorProcess.on('exit', (code) => {
    supervisorProcess = null;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('supervisor:exit', code);
    }
  });

  return { success: true, pid: supervisorProcess.pid };
});

ipcMain.handle('supervisor:stop', async () => {
  if (!supervisorProcess) {
    return { success: false, error: 'Supervisor not running' };
  }
  supervisorProcess.kill('SIGTERM');
  return { success: true };
});

ipcMain.handle('supervisor:status', async () => {
  return { running: supervisorProcess !== null, pid: supervisorProcess?.pid ?? null };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'SkyNetFactory',
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (supervisorProcess) {
    supervisorProcess.kill('SIGTERM');
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

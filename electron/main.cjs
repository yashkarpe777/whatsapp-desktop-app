// Electron main process (CommonJS) that starts the local backend and opens the UI
// Secure defaults: sandboxed renderer, contextIsolation on, nodeIntegration off

const { app, BrowserWindow, dialog, shell, ipcMain, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const http = require('http');
const crypto = require('crypto');

let win = null;
let backend = null;
let isQuitting = false;
let log = (msg) => {};
let logFile = null;
const PORT = process.env.PORT || '3000';

function isDev() {
  return process.env.ELECTRON_DEV === 'true' || !app.isPackaged;
}

function waitFor(url, timeoutMs = 25000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, res => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('Timeout'));
        setTimeout(tick, 500);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('Timeout'));
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

function resolveProdServerEntry() {
  // Try common locations in production builds
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'src', 'server.js'),
    path.join(process.resourcesPath, 'app.asar', 'backend', 'src', 'server.js'),
    path.join(process.resourcesPath, 'app', 'backend', 'src', 'server.js'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}

function startBackend() {
  const userData = app.getPath('userData');
  let serverEntry;
  if (isDev()) {
    const baseDir = path.resolve(__dirname, '..');
    serverEntry = path.join(baseDir, 'backend', 'src', 'server.js');
  } else {
    serverEntry = resolveProdServerEntry();
  }

  const logsDir = path.join(userData, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  logFile = path.join(logsDir, 'backend.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  log = (msg) => { const line = `[${new Date().toISOString()}] ${msg}\n`; try { logStream.write(line); } catch {} };

  // Ensure CONFIG_DIR exists and persist a stable JWT secret
  const configDir = path.join(userData, 'config');
  try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
  const jwtPath = path.join(configDir, 'jwt_secret.txt');
  let jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    try {
      jwtSecret = fs.readFileSync(jwtPath, 'utf8').trim();
    } catch {
      jwtSecret = crypto.randomBytes(32).toString('hex');
      try { fs.writeFileSync(jwtPath, jwtSecret, { encoding: 'utf8' }); } catch {}
    }
  }

  const env = {
    ...process.env,
    PORT: String(PORT),
    SERVICE_MODE: 'all',
    HEADLESS: 'false',
    WHATSAPP_DATA_PATH: path.join(userData, 'wwebjs_auth'),
    UPLOADS_DIR: path.join(userData, 'uploads'),
    CONFIG_DIR: configDir,
    JWT_SECRET: jwtSecret,
    FAIL_ON_DB_ERROR: 'false',
    CHROME_BIN: process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    PUPPETEER_EXECUTABLE_PATH: process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ADMIN_API_BASE_URL: process.env.ADMIN_API_BASE_URL || 'http://127.0.0.1:3000',
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://app_user:strongpassword@localhost:5432/whatsapp_blast',
    DB_SSL: process.env.DB_SSL || 'false',
  };

  log(`Starting backend: ${serverEntry}`);
  log(`Env PORT=${env.PORT} SERVICE_MODE=${env.SERVICE_MODE}`);
  try { const hasRender = !!env.DATABASE_URL; log(`Render DB configured: ${hasRender ? 'yes' : 'no'}`); } catch {}

  const child = fork(serverEntry, [], { env, stdio: 'pipe', silent: true });
  child.stdout && child.stdout.on('data', (d) => { const t = d.toString(); log(t.trim()); });
  child.stderr && child.stderr.on('data', (d) => { const t = d.toString(); log(`[stderr] ${t.trim()}`); });
  child.on('exit', (code, sig) => log(`Backend exited code=${code} signal=${sig || ''}`));
  backend = child;
  return { logFile };
}

async function createWindow() {
  const lock = app.requestSingleInstanceLock();
  if (!lock) {
    app.quit();
    return;
  }

  startBackend();
  await waitFor(`http://127.0.0.1:${PORT}/health`).catch(async () => {
    const message = `The local API failed to start on port ${PORT}.\n\nA log file was written to:\n${logFile}\n\nPlease open the log and share the last 50 lines.`;
    try { await dialog.showMessageBox({ type: 'error', title: 'Backend failed to start', message, buttons: ['Open Log', 'Close'] }).then(r => { if (r.response === 0) shell.openPath(logFile); }); } catch {}
  });

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    tray = new Tray(image);
    tray.setToolTip('WhatsApp Blast');
    tray.on('click', () => {
      if (win) {
        win.isVisible() ? win.hide() : win.show();
      }
    });
  }

  try {
    if (isDev()) {
      await win.loadURL('http://127.0.0.1:8080');
    } else {
      const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
      await win.loadFile(indexPath);
    }
  } catch (err) {
    dialog.showErrorBox('Startup error', String(err?.message || err));
    app.quit();
  }

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
      return;
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }
});

async function stopBackend(forceAfterMs = 5000) {
  return new Promise((resolve) => {
    if (!backend || backend.killed) return resolve();
    const pid = backend.pid;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    backend.once('exit', () => done());
    try { backend.kill(); } catch {}
    setTimeout(() => {
      try { if (backend && !backend.killed) process.kill(pid); } catch {}
      done();
    }, forceAfterMs);
  });
}

async function restartBackend() {
  log('Restart requested via IPC');
  await stopBackend();
  startBackend();
  try {
    await waitFor(`http://127.0.0.1:${PORT}/health`, 25000);
    return { ok: true, message: 'Backend restarted' };
  } catch (e) {
    return { ok: false, message: `Failed to restart: ${e?.message || e}` };
  }
}

ipcMain.handle('backend:restart', async () => {
  const res = await restartBackend();
  if (!res.ok) {
    try { await dialog.showMessageBox({ type: 'error', title: 'Backend restart', message: res.message, buttons: ['Open Log', 'Close'] }).then(r => { if (r.response === 0 && logFile) shell.openPath(logFile); }); } catch {}
  }
  return res;
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});

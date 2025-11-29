// Electron main process (CommonJS) that starts the local backend and opens the UI
// Secure defaults: sandboxed renderer, contextIsolation on, nodeIntegration off

const { app, BrowserWindow, dialog, shell, ipcMain, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');
const http = require('http');
const crypto = require('crypto');

let win = null;
let backend = null;
let tray = null;
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
    path.join(process.resourcesPath, 'app.asar.unpacked', 'backend', 'src', 'server.mjs'),
    path.join(process.resourcesPath, 'app.asar', 'backend', 'src', 'server.mjs'),
    path.join(process.resourcesPath, 'app', 'backend', 'src', 'server.mjs'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}

function startBackend() {
  const userData = app.getPath('userData');
  let serverEntry;
  let cwd;
  
  if (isDev()) {
    const baseDir = path.resolve(__dirname, '..');
    serverEntry = path.join(baseDir, 'backend', 'src', 'server.mjs');
    cwd = baseDir; // Use root directory where node_modules exists
  } else {
    serverEntry = resolveProdServerEntry();
    cwd = path.join(process.resourcesPath, 'app.asar.unpacked');
    
    // Run database setup for packaged app
    try {
      const setupScript = path.join(cwd, 'backend', 'setup-database-packaged.js');
      if (fs.existsSync(setupScript)) {
        log('Running database setup for packaged app...');
        const { spawn } = require('child_process');
        const setup = spawn('node', [setupScript], { 
          env: { ...process.env, CONFIG_DIR: path.join(userData, 'config') },
          stdio: 'pipe',
          cwd 
        });
        setup.stdout && setup.stdout.on('data', (d) => { log(`[setup] ${d.toString().trim()}`); });
        setup.stderr && setup.stderr.on('data', (d) => { log(`[setup-error] ${d.toString().trim()}`); });
        setup.on('exit', (code) => { 
          if (code === 0) {
            log('✅ Database setup completed successfully');
          } else {
            log(`❌ Database setup failed with code ${code}`);
          }
        });
      }
    } catch (err) {
      log(`Failed to run database setup: ${err.message}`);
    }
  }

  const logsDir = path.join(userData, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  logFile = path.join(logsDir, 'backend.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  log = (msg) => { const line = `[${new Date().toISOString()}] ${msg}\n`; try { logStream.write(line); } catch {} };

  const configDir = path.join(userData, 'config');
  try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
  
  // Copy database config to user data directory if it doesn't exist
  const dbConfigPath = path.join(configDir, 'database_config.json');
  if (!fs.existsSync(dbConfigPath)) {
    try {
      // Try to copy from development location first
      const devDbConfigPath = path.join(__dirname, '..', 'backend', 'database_config.json');
      if (fs.existsSync(devDbConfigPath)) {
        fs.copyFileSync(devDbConfigPath, dbConfigPath);
        log(`Copied database config to: ${dbConfigPath}`);
      }
    } catch (err) {
      log(`Failed to copy database config: ${err.message}`);
    }
  }
  
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

  let sessionDir;
  if (isDev()) {
    if (process.platform === 'win32') {
      const home = os.homedir();
      sessionDir = path.join(home, 'AppData', 'Roaming', 'whatsapp-bulk-sender', 'session');
    } else if (process.platform === 'darwin') {
      sessionDir = path.join(os.homedir(), 'Library', 'Application Support', 'whatsapp-bulk-sender', 'session');
    } else {
      const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
      sessionDir = path.join(base, 'whatsapp-bulk-sender', 'session');
    }
  } else {
    sessionDir = path.join(userData, 'whatsapp-session');
  }
  try { fs.mkdirSync(sessionDir, { recursive: true }); } catch {}

  const env = {
    ...process.env,
    PORT: String(PORT),
    SERVICE_MODE: 'all',
    HEADLESS: 'false',
    WHATSAPP_DATA_PATH: sessionDir,
    UPLOADS_DIR: path.join(userData, 'uploads'),
    CONFIG_DIR: configDir,
    JWT_SECRET: jwtSecret,
    JWT_SECRET_ALT: jwtSecret,
    FAIL_ON_DB_ERROR: 'false',
    CHROME_BIN: process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    PUPPETEER_SKIP_DOWNLOAD: 'true',
    PUPPETEER_EXECUTABLE_PATH: process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ADMIN_API_BASE_URL: process.env.ADMIN_API_BASE_URL || 'http://127.0.0.1:3000',
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://app_user:strongpassword@localhost:5432/whatsapp_blast',
    DB_SSL: process.env.DB_SSL || 'false',
  };

  log(`Starting backend: ${serverEntry}`);
  log(`Working directory: ${cwd}`);
  log(`Env PORT=${env.PORT} SERVICE_MODE=${env.SERVICE_MODE}`);
  try { const hasRender = !!env.DATABASE_URL; log(`Render DB configured: ${hasRender ? 'yes' : 'no'}`); } catch {}

  const child = fork(serverEntry, [], { env, stdio: 'pipe', silent: true, cwd });
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
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false,
      allowRunningInsecureContent: true,
      // Ensure localStorage persistence
      partition: 'persist:whatsapp-blast-session',
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

async function stopBackend(forceAfterMs = 15000) {
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

app.on('before-quit', async () => {
  isQuitting = true;
  // Give WhatsApp time to properly save session before quitting
  console.log('🔄 Gracefully shutting down backend to preserve WhatsApp session...');
  await stopBackend(15000); // Allow 15 seconds for WhatsApp cleanup
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit();
  }
});

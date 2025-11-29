import qrcode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AnonymizeUAPlugin from 'puppeteer-extra-plugin-anonymize-ua';
import Module from 'module';
import { hotPool } from '../db.js';
import { sendLargeVideo } from './videoCompressor.js';
import { enqueueCampaign, pauseCampaign as queuePauseCampaign, resumeCampaign as queueResumeCampaign, stopCampaign as queueStopCampaign, initializeCampaignQueue, recoverCampaigns, registerWhatsAppDependencies } from './campaignQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let client;
let qrCode = null;
let isReady = false;
let isInitializing = false;
let activeNumber = null;
let activePushName = null;
let activeSessionId = null;
let queueInitialized = false;
let sessionTableEnsured = false;

let WhatsAppModule;
let Client;
let LocalAuth;
let MessageMedia;

const DEFAULT_VIEWPORT = {
  width: 1366,
  height: 768,
};

const DEFAULT_USER_AGENT = process.env.WHATSAPP_DESKTOP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let stealthPatched = false;
let modulePatched = false;

function ensureStealthPuppeteer() {
  if (stealthPatched) {
    return puppeteerExtra;
  }

  try {
    const stealth = StealthPlugin();
    // Some evasions break WhatsApp Web audio; disable cautiously
    stealth.enabledEvasions.delete('iframe.contentWindow');
    puppeteerExtra.use(stealth);
    puppeteerExtra.use(AnonymizeUAPlugin({ stripHeadless: true, makeWindows: true }));
    stealthPatched = true;
    console.log('✅ Stealth plugins enabled for Puppeteer');
  } catch (err) {
    console.warn('⚠️ Failed to enable stealth plugins:', err?.message || err);
  }

  return puppeteerExtra;
}

function getStableClientId(dataPath) {
  if (process.env.WHATSAPP_CLIENT_ID) {
    return process.env.WHATSAPP_CLIENT_ID;
  }
  const normalized = path.resolve(dataPath);
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 24);
}

function patchModuleLoader() {
  if (modulePatched) return;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'puppeteer' || request === 'puppeteer-core') {
      return ensureStealthPuppeteer();
    }
    return originalLoad(request, parent, isMain);
  };
  modulePatched = true;
}

async function ensureWhatsAppModules() {
  if (Client && LocalAuth && MessageMedia) {
    return;
  }

  patchModuleLoader();

  const importTarget = await import('whatsapp-web.js');
  const resolved = importTarget.default ?? importTarget;
  WhatsAppModule = resolved;
  Client = resolved.Client;
  LocalAuth = resolved.LocalAuth;
  MessageMedia = resolved.MessageMedia;

  registerWhatsAppDependencies({ MessageMedia });
}

function ensureDirectory(targetPath) {
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    // Verify directory is writable
    const testFile = path.join(targetPath, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('✅ Directory is writable:', targetPath);
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      console.error('❌ Failed to ensure directory', targetPath, err?.message || err);
      throw new Error(`Cannot create or write to directory: ${targetPath}`);
    }
  }
  return targetPath;
}

async function checkDirectoryWritable(targetPath) {
  try {
    const testFile = path.join(targetPath, '.write-test-' + Date.now());
    await fs.promises.writeFile(testFile, 'test');
    await fs.promises.unlink(testFile);
    return true;
  } catch (err) {
    return false;
  }
}

function getWindowsRoamingRoot() {
  const home = (typeof os.homedir === 'function' && os.homedir()) || process.env.USERPROFILE || '';
  if (home) {
    return path.join(home, 'AppData', 'Roaming');
  }
  if (process.env.APPDATA) {
    return process.env.APPDATA;
  }
  return path.join(process.cwd(), 'AppData', 'Roaming');
}

function getAppScopedLocalAuthPath() {
  if (process.platform !== 'win32') return null;
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'whatsapp-bulk-sender', 'session');
}

function copyDirectorySync(source, destination) {
  if (!source || !destination) return;
  if (!fs.existsSync(source)) return;

  let stats;
  try {
    stats = fs.statSync(source);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Source path is not a directory: ${source}`);
  }

  fs.mkdirSync(destination, { recursive: true });
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      try {
        const linkTarget = fs.readlinkSync(srcPath);
        try {
          fs.symlinkSync(linkTarget, destPath);
        } catch {
          fs.copyFileSync(srcPath, destPath);
        }
      } catch {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
  console.log('📁 Successfully copied session directory from', source, 'to', destination);
}

function tryMigrateLocalAuthProfile(source, target) {
  const src = path.resolve(source);
  const dest = path.resolve(target);

  if (src === dest) return false;
  if (!fs.existsSync(src)) return false;

  try {
    copyDirectorySync(src, dest);
    console.log('📁 Migrated WhatsApp session profile to stable path:', dest);
    return true;
  } catch (err) {
    console.warn('⚠️ Failed to migrate WhatsApp session profile from', src, 'to', dest, err?.message || err);
    return false;
  }
}

function resolveDefaultLocalAuthPath() {
  // In production (packaged app), prioritize WHATSAPP_DATA_PATH from Electron main process
  if (process.env.WHATSAPP_DATA_PATH && !process.env.ELECTRON_DEV) {
    return process.env.WHATSAPP_DATA_PATH;
  }

  const platform = process.platform;
  let baseDir;

  if (platform === 'win32') {
    // Always use the user's roaming profile, ignore app-scoped APPDATA so dev, CLI and Electron share the same path
    baseDir = getWindowsRoamingRoot();
  } else if (platform === 'darwin') {
    baseDir = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    baseDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }

  return path.join(baseDir, 'whatsapp-bulk-sender', 'session');
}

function collectLocalAuthCandidates() {
  const set = new Set();
  if (process.env.WHATSAPP_DATA_PATH) {
    set.add(path.resolve(process.env.WHATSAPP_DATA_PATH));
  }
  const defaultPath = resolveDefaultLocalAuthPath();
  set.add(path.resolve(defaultPath));
  const appScopedPath = getAppScopedLocalAuthPath();
  if (appScopedPath) {
    set.add(path.resolve(appScopedPath));
  }
  set.add(path.resolve(process.cwd(), '.wwebjs_auth'));
  set.add(path.resolve(__dirname, '..', '..', '.wwebjs_auth'));
  return Array.from(set);
}

function hasLocalAuthProfile(candidatePath) {
  try {
    const settingsPath = path.join(candidatePath, 'session.settings.json');
    if (fs.existsSync(settingsPath)) {
      return true;
    }

    const levelDbPath = path.join(candidatePath, 'Default', 'Local Storage', 'leveldb');
    if (fs.existsSync(levelDbPath)) {
      const files = fs.readdirSync(levelDbPath);
      return files.some((file) => file.endsWith('.log') || file.endsWith('.ldb'));
    }
  } catch (err) {
    console.warn('⚠️ Failed to inspect LocalAuth path:', candidatePath, err?.message || err);
  }

  return false;
}

function getPrimaryLocalAuthPath() {
  // In production (packaged app), prioritize WHATSAPP_DATA_PATH from Electron main process
  if (process.env.WHATSAPP_DATA_PATH) {
    console.log('📂 Using WHATSAPP_DATA_PATH from environment:', process.env.WHATSAPP_DATA_PATH);
    return process.env.WHATSAPP_DATA_PATH;
  }

  const platform = process.platform;
  let baseDir;

  if (platform === 'win32') {
    // Always use the user's roaming profile for consistency across dev/production
    baseDir = getWindowsRoamingRoot();
  } else if (platform === 'darwin') {
    baseDir = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    baseDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }

  const sessionPath = path.join(baseDir, 'whatsapp-bulk-sender', 'session');
  console.log('📂 Using default session path:', sessionPath);
  return sessionPath;
}

function getLocalAuthCandidates() {
  const primary = getPrimaryLocalAuthPath();
  const others = collectLocalAuthCandidates().filter((candidate) => path.resolve(candidate) !== path.resolve(primary));
  return [primary, ...others];
}

async function pruneExtraLocalAuthProfiles(primaryPath, options = {}) {
  const normalizedPrimary = path.resolve(primaryPath);
  const candidates = collectLocalAuthCandidates();
  const toRemove = candidates.filter((candidate) => path.resolve(candidate) !== normalizedPrimary);

  if (!toRemove.length) {
    return [];
  }

  const outcomes = [];
  for (const candidate of toRemove) {
    const target = path.resolve(candidate);
    try {
      const outcome = await removeDirectoryWithRetries(target, options);
      outcomes.push(outcome);
      if (outcome.removed) {
        console.log('🧹 Removed extra WhatsApp session profile:', target);
      }
    } catch (err) {
      outcomes.push({
        path: target,
        exists: true,
        removed: false,
        attempts: 0,
        soft: false,
        error: err,
      });
      console.warn('⚠️ Failed to remove extra WhatsApp session profile:', target, err?.message || err);
    }
  }

  return outcomes;
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

async function removeDirectoryWithRetries(targetPath, { maxAttempts = 5, delayMs = 750 } = {}) {
  const normalizedPath = path.resolve(targetPath);
  const exists = await pathExists(normalizedPath).catch((err) => {
    console.warn(`⚠️ Failed to access ${normalizedPath}:`, err?.message || err);
    return false;
  });

  const outcome = {
    path: normalizedPath,
    exists,
    removed: false,
    attempts: 0,
    soft: false,
    error: null,
  };

  if (!exists) {
    return outcome;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    outcome.attempts = attempt;
    try {
      await fs.promises.rm(normalizedPath, { recursive: true, force: true });
      outcome.removed = true;
      return outcome;
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT') {
        // Path disappeared between attempts – treat as removed
        outcome.removed = true;
        return outcome;
      }

      const isSoft = code === 'EBUSY' || code === 'EPERM';
      outcome.soft = outcome.soft || isSoft;
      outcome.error = error;

      if (!isSoft || attempt === maxAttempts) {
        return outcome;
      }

      const backoff = delayMs * attempt;
      console.warn(`⚠️ ${code} removing ${normalizedPath}. Retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  return outcome;
}

function getDb() {
  return hotPool;
}

async function ensureSessionTable() {
  if (sessionTableEnsured) return true;
  
  const ddlStatements = [
    `CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(100) UNIQUE NOT NULL,
      phone_number VARCHAR(20),
      push_name VARCHAR(255),
      is_active BOOLEAN DEFAULT TRUE,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_session_id ON whatsapp_sessions(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_active ON whatsapp_sessions(is_active)`
  ];

  try {
    console.log('🔍 Ensuring whatsapp_sessions table exists...');
    for (const stmt of ddlStatements) {
      await hotPool.query(stmt);
      console.log('✅ Executed DDL:', stmt.split('(')[0]);
    }
    sessionTableEnsured = true;
    console.log('✅ whatsapp_sessions table ensured successfully');
    return true;
  } catch (error) {
    console.warn('⚠️ Failed to ensure whatsapp_sessions table:', error.message);
    console.warn('⚠️ Error details:', error.code, error.detail);
    return false;
  }
}

async function cleanupChromeProcesses() {
  if (process.platform !== 'win32') return;
  
  try {
    const { exec } = await import('child_process');
    console.log('🧹 Checking for orphaned Chrome processes...');
    
    // Kill Chrome processes that might be left from previous crashes
    exec('taskkill /f /im chrome.exe /fi "WINDOWTITLE eq*" 2>nul && echo Cleaned up Chrome processes', (error, stdout) => {
      if (!error) {
        console.log('🧹 Chrome process cleanup completed');
      }
    });
  } catch (err) {
    console.warn('⚠️ Chrome cleanup failed:', err.message);
  }
}

async function initWhatsApp(_retry = false) {
  // IMPORTANT: Don't reinitialize if already ready or initializing
  if (isReady) {
    console.log('✅ WhatsApp client already ready');
    return;
  }
  
  if (isInitializing) {
    console.log('⏳ WhatsApp client already initializing');
    return;
  }

  isInitializing = true;

  // Clean up orphaned Chrome processes before starting
  if (!_retry) {
    await cleanupChromeProcesses();
  }

  // Check for potential conflicts and clean up excess Chrome processes
  try {
    const { exec } = await import('child_process');
    const platform = process.platform;
    
    if (platform === 'win32') {
      exec('tasklist /fi "imagename eq chrome.exe" /fo csv | find /c "chrome.exe"', (error, stdout) => {
        const chromeCount = parseInt(stdout.trim()) || 0;
        if (chromeCount > 10) {
          console.warn(`⚠️ High Chrome process count detected: ${chromeCount}. Attempting to clean up excess processes...`);
          // Kill orphaned Chrome processes to prevent conflicts
          exec('taskkill /f /im chrome.exe /fi "WINDOWTITLE eq*" 2>nul', (killError) => {
            if (!killError) {
              console.log('🧹 Cleaned up excess Chrome processes');
            }
          });
        } else if (chromeCount > 5) {
          console.warn(`⚠️ Moderate Chrome process count: ${chromeCount}. This may cause WhatsApp conflicts.`);
        }
      });
    }
  } catch (err) {
    console.log('Could not check for process conflicts:', err.message);
  }

  try {
    await ensureWhatsAppModules();

    // Only destroy existing client if it's not ready
    if (client && !isReady) {
      try { 
        console.log('🔄 Destroying existing WhatsApp client');
        await client.destroy(); 
      } catch (_) {}
      client = null;
    }

    // Check if we have existing session data to preserve
    const dataPath = getPrimaryLocalAuthPath();
    const hasExistingSession = hasLocalAuthProfile(dataPath);
    if (hasExistingSession) {
      console.log('📱 Found existing WhatsApp session, attempting to restore...');
    }

    const headlessEnv = String(process.env.HEADLESS || 'false').toLowerCase();
    const prefersHeadless = headlessEnv === 'true';
    const headless = _retry ? true : prefersHeadless;

    await pruneExtraLocalAuthProfiles(dataPath, { maxAttempts: 3, delayMs: 500 });
    
    // Ensure the session directory exists and is writable
    ensureDirectory(dataPath);
    
    // Create auth strategy with session persistence
    const authStrategy = new LocalAuth({ 
      dataPath,
      clientId: getStableClientId(dataPath),
    });

    console.log('🔐 Initializing WhatsApp with LocalAuth path:', dataPath);
    console.log('📂 Session directory exists:', fs.existsSync(dataPath));
    console.log('📂 Session directory writable:', await checkDirectoryWritable(dataPath));
    let executablePath = process.env.CHROME_BIN || undefined;
    if (process.platform === 'win32') {
      const candidates = [
        process.env.CHROME_BIN,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      ].filter(Boolean);
      for (const c of candidates) {
        try { if (c && fs.existsSync(c)) { executablePath = c; break; } } catch {}
      }
    }

const baseArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-logging',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--disable-restore-session-state',
      '--single-process', // Run in single process to reduce conflicts
      '--no-zygote', // Prevent multiple process spawning
      '--disable-gpu', // Disable GPU acceleration
      '--disable-software-rasterizer',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--hide-crash-restore-bubble',
      '--no-default-browser-check',
      '--disable-hang-monitor'
    ];

    console.log('📂 Using WhatsApp LocalAuth path:', dataPath);
    console.log('🔍 Session files check:', {
      path: dataPath,
      exists: fs.existsSync(dataPath),
      hasSettings: fs.existsSync(path.join(dataPath, 'session.settings.json')),
      hasLocalStorage: fs.existsSync(path.join(dataPath, 'Default', 'Local Storage'))
    });

client = new Client({
      authStrategy,
      puppeteer: {
        headless,
        executablePath,
        args: baseArgs,
        defaultViewport: DEFAULT_VIEWPORT,
        timeout: 30000, // Reduce puppeteer timeout
        slowMo: 0 // Remove slow motion delays
      },
      userAgent: DEFAULT_USER_AGENT,
      takeoverOnConflict: false, // IMPORTANT: Don't auto-takeover to prevent logout
      qrMaxRetries: 3, // Reduce QR retries to prevent hanging
      authTimeoutMs: 60000, // Reduce to 1 minute to prevent long hangs
      restartOnAuthFail: false, // IMPORTANT: Don't auto-restart to prevent logout
      takeoverTimeoutMs: 30000, // Reduce takeover timeout
      browserName: 'Chrome',
      deviceName: process.env.WHATSAPP_DEVICE_NAME || 'Desktop WhatsApp Blast',
    });

    const patchedPuppeteer = ensureStealthPuppeteer();
    if (client?.options?.puppeteer && !client.options.puppeteer.puppeteer) {
      client.options.puppeteer.puppeteer = patchedPuppeteer;
    }

    const authenticatedListener = () => {
      console.log('🔐 WhatsApp authentication event received.');
    };

    client.on('authenticated', authenticatedListener);

client.on('qr', async (qr) => {
      console.log('📱 QR code received - scan with WhatsApp mobile app');
      try {
        qrCode = await qrcode.toDataURL(qr);
        // Don't clear session info on QR - user might be reconnecting
      } catch (qrError) {
        console.error('Error generating QR code:', qrError);
        qrCode = null;
      }
    });

client.on('ready', async () => {
      console.log('✅ WhatsApp client is ready');
      isReady = true;
      qrCode = null;
      isInitializing = false;
      try {
        const info = client.info;

        const wid = info?.wid?._serialized || '';
        activeNumber = wid ? wid.replace('@c.us', '') : null;
        activePushName = info?.pushname || null;
        activeSessionId = wid;

        console.log(`📱 WhatsApp ready for user: ${activePushName} (${activeNumber})`);
        console.log('💾 WhatsApp session successfully restored and active');
        console.log('📂 Session data path:', dataPath);

        // Save session info to database with retry
        try {
          await saveSessionInfo(wid, activeNumber, activePushName);
        } catch (saveError) {
          console.warn('⚠️ Failed to save session info on first attempt, retrying...', saveError.message);
          // Wait a bit and retry
          setTimeout(async () => {
            try {
              await saveSessionInfo(wid, activeNumber, activePushName);
              console.log('✅ Session info saved on retry');
            } catch (retryError) {
              console.error('❌ Failed to save session info on retry:', retryError.message);
            }
          }, 3000);
        }

        // Initialize campaign queue processor
        if (!queueInitialized) {
          initializeCampaignQueue(client);
          queueInitialized = true;
          console.log('✅ Campaign queue initialized');

          // Recover any campaigns that were running before crash
          setTimeout(() => {
            recoverCampaigns().catch(err => {
              console.error('❌ Campaign recovery failed:', err);
            });
          }, 2000);
        }
      } catch (err) {
        console.error('❌ Error in ready handler:', err);
        activeNumber = null;
        activePushName = null;
        activeSessionId = null;
      }
    });

client.on('disconnected', async (reason) => {
      console.log(`❌ WhatsApp client disconnected. Reason: ${reason}`);
      
      // Check if this is a LOGOUT (session invalidation) vs temporary disconnect
      const isLogout = String(reason).toUpperCase() === 'LOGOUT';
      
      if (isLogout) {
        console.log('🚪 WhatsApp session was logged out - session data is invalid');
        // Clear session data on logout to force fresh QR scan
        try {
          const dataPath = getPrimaryLocalAuthPath();
          console.log('🗑️ Clearing corrupted session data at:', dataPath);
          await removeDirectoryWithRetries(dataPath, { maxAttempts: 3, delayMs: 500 });
        } catch (err) {
          console.warn('⚠️ Failed to clear session data:', err.message);
        }
      } else {
        console.log('📱 Temporary disconnect - preserving session');
      }
      
      const currentClient = client;

      if (currentClient) {
        try {
          await currentClient.destroy();
        } catch (err) {
          console.warn('⚠️ Failed to destroy client cleanly:', err?.message || err);
        }
      }

      // Clear client state
      client = null;
      isReady = false;
      isInitializing = false;
      queueInitialized = false;

      // For logout, clear session info to force fresh login
      if (isLogout) {
        activeNumber = null;
        activePushName = null;
        activeSessionId = null;
        console.log('🔄 Session cleared - will require QR scan on reconnect');
      }

      // In production builds, wait longer before reconnect to avoid rapid reconnection loops
      const reconnectDelay = process.env.ELECTRON_DEV === 'true' ? 3000 : (isLogout ? 10000 : 8000);
      
      console.log(`🔄 Attempting to reconnect in ${reconnectDelay/1000} seconds...`);
      
      setTimeout(() => {
        console.log('🔄 Reconnecting WhatsApp...');
        initWhatsApp().catch(err => {
          console.error('❌ Reconnection failed:', err);
          // Try again with longer delay
          setTimeout(() => {
            console.log('🔄 Retrying WhatsApp reconnection...');
            initWhatsApp().catch(err2 => {
              console.error('❌ WhatsApp reconnection failed after retry:', err2);
              // Final retry with even longer delay
              setTimeout(() => {
                console.log('🔄 Final WhatsApp reconnection attempt...');
                initWhatsApp().catch(err3 => {
                  console.error('❌ All WhatsApp reconnection attempts failed:', err3);
                });
              }, reconnectDelay * 3);
            });
          }, reconnectDelay * 2);
        });
      }, reconnectDelay);

      console.log(`📱 Session ${isLogout ? 'cleared' : 'preserved'} for reconnection`);
    });

client.on('auth_failure', (message) => {
      console.log('❌ WhatsApp authentication failed:', message);
      console.log('🔄 NOT clearing session - will attempt reconnection');
      isInitializing = false;
      
      // IMPORTANT: Don't clear session data on auth failure
      // This preserves the session for automatic recovery
      qrCode = null;
      // Keep session data to allow recovery
      // activeNumber = null;
      // activePushName = null;
      // activeSessionId = null;
    });

    // Add initialization timeout
    const initPromise = client.initialize();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('WhatsApp initialization timeout')), 45000);
    });
    
    await Promise.race([initPromise, timeoutPromise]);
    console.log('✅ WhatsApp client initialization completed');
  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp client:', error.message);
    isInitializing = false;
    
    // Clean up on failure
    if (client) {
      try {
        await client.destroy();
      } catch (destroyErr) {
        console.warn('⚠️ Failed to destroy client during cleanup:', destroyErr.message);
      }
      client = null;
    }
    
    if (!_retry && /Target closed|timeout/i.test(String(error?.message || ''))) {
      console.log('🔄 Retrying initialization with headless mode...');
      try {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before retry
        await initWhatsApp(true);
        return;
      } catch (retryErr) {
        console.error('❌ Retry initialization failed:', retryErr.message);
      }
    }
    throw error;
  }
}

async function waitForReady(timeoutMs = 30000) {
  const start = Date.now();
  while (!isReady && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
  }
  return isReady;
}

async function clearLocalAuthProfile(options = {}) {
  const wasReady = isReady;
  const candidates = getLocalAuthCandidates();
  const results = [];

  try {
    if (client) {
      await logoutWhatsApp();
    }
  } catch (err) {
    if (/EBUSY|EPERM/i.test(err?.message || '')) {
      console.warn('⚠️ WhatsApp client busy during logout; continuing with cleanup.');
    } else {
      console.warn('⚠️ Failed to stop WhatsApp client before profile cleanup:', err?.message || err);
    }
  }

  for (const candidate of candidates) {
    try {
      const outcome = await removeDirectoryWithRetries(candidate, options);
      results.push(outcome);
    } catch (err) {
      results.push({
        path: path.resolve(candidate),
        exists: true,
        removed: false,
        attempts: 1,
        soft: false,
        error: err,
      });
    }
  }

  const removedAny = results.some((r) => r.removed);
  const existedAny = results.some((r) => r.exists);
  const failures = results.filter((r) => r.error);
  const softFailure = failures.length > 0 && failures.every((f) => f.soft);
  const sessionRestored = !removedAny && wasReady && (softFailure || failures.length === 0);

  if (sessionRestored) {
    try {
      await ensureClientReady();
      console.log('✅ WhatsApp session restored after cleanup attempt');
    } catch (err) {
      console.warn('⚠️ Failed to restore WhatsApp session after cleanup:', err?.message || err);
    }
  }

  if (removedAny) {
    return {
      success: true,
      requiresReconnect: true,
      message: 'Profile cleared. Scan the QR code again to reconnect.',
      results,
    };
  }

  if (!existedAny) {
    return {
      success: true,
      requiresReconnect: false,
      message: 'No profile data found. You can connect now.',
      results,
    };
  }

  if (softFailure) {
    return {
      success: false,
      softFailure: true,
      requiresReconnect: false,
      message: 'Profile files are currently in use. Close any WhatsApp instances and try again.',
      results,
    };
  }

  return {
    success: false,
    softFailure: false,
    requiresReconnect: false,
    message: 'Failed to clear profile data. Check logs for details.',
    results,
  };
}

async function ensureClientReady() {
  if (isReady) return true;
  await initWhatsApp();
  const ok = await waitForReady(30000);
  if (!ok) throw new Error('WhatsApp client is not ready. Please scan QR code first.');
  return true;
}

async function recoverClient() {
  try {
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        if (!/EBUSY|EPERM/i.test(err?.message || '')) {
          console.warn('⚠️ Destroy client failed:', err?.message || err);
        }
      }
    }
  } catch (_) {}
  client = null;
  isReady = false;
  qrCode = null;
  isInitializing = false;
  await initWhatsApp();
  const ok = await waitForReady(30000);
  return ok;
}

function getWhatsAppStatus() {
  return {
    ready: isReady,
    qr: qrCode,
    initializing: isInitializing,
    number: activeNumber,
    name: activePushName,
    sessionId: activeSessionId
  };
}

async function saveSessionInfo(sessionId, phoneNumber, pushName) {
  try {
    // First ensure the session table exists
    await ensureSessionTable();
    
    await hotPool.query(
      `INSERT INTO whatsapp_sessions (session_id, phone_number, push_name, is_active, last_seen)
       VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id)
       DO UPDATE SET phone_number = $2, push_name = $3, is_active = true, last_seen = CURRENT_TIMESTAMP`,
      [sessionId, phoneNumber, pushName]
    );
    console.log('✅ Session info saved:', sessionId);
  } catch (error) {
    console.warn('⚠️ Could not save session info:', error.message);
    console.warn('⚠️ Session details:', { sessionId, phoneNumber, pushName });
    
    // Try to create table manually if it doesn't exist
    try {
      await ensureSessionTable();
      await hotPool.query(
        `INSERT INTO whatsapp_sessions (session_id, phone_number, push_name, is_active, last_seen)
         VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
         ON CONFLICT (session_id)
         DO UPDATE SET phone_number = $2, push_name = $3, is_active = true, last_seen = CURRENT_TIMESTAMP`,
        [sessionId, phoneNumber, pushName]
      );
      console.log('✅ Session info saved after manual table creation:', sessionId);
    } catch (retryErr) {
      console.error('❌ Failed to save session info after retry:', retryErr.message);
    }
  }
}

async function markSessionInactive(sessionId) {
  try {
    await hotPool.query(
      `UPDATE whatsapp_sessions SET is_active = false, last_seen = CURRENT_TIMESTAMP WHERE session_id = $1`,
      [sessionId]
    );
    console.log('✅ Session marked inactive:', sessionId);
  } catch (error) {
    if (error?.code === '42P01') {
      const ensured = await ensureSessionTable();
      if (ensured) {
        try {
          await hotPool.query(
            `UPDATE whatsapp_sessions SET is_active = false, last_seen = CURRENT_TIMESTAMP WHERE session_id = $1`,
            [sessionId]
          );
          console.log('✅ Session marked inactive after ensuring table:', sessionId);
          return;
        } catch (retryErr) {
          console.warn('⚠️ Retry mark session inactive failed:', retryErr.message);
        }
      }
    }
    console.warn('⚠️ Could not mark session inactive:', error.message);
  }
}

function getClient() {
  return client;
}

function getActiveSessionId() {
  return activeSessionId;
}

export async function sendCampaign(campaignId, authHeader = '') {
  console.log(`🚀 [sendCampaign] Starting campaign ${campaignId} using queue system`);

  // Ensure WhatsApp client is ready
  await ensureClientReady();

  // Use the new queue system instead of direct sending
  try {
    const result = await enqueueCampaign(campaignId, authHeader);
    console.log(`✅ Campaign ${campaignId} enqueued: ${result.queued} messages`);
    return result;
  } catch (error) {
    console.error(`❌ Failed to enqueue campaign ${campaignId}:`, error);
    throw error;
  }
}

async function logoutWhatsApp() {
  if (!client && !activeSessionId) {
    return { success: false, message: 'No active WhatsApp session to log out from' };
  }
  
  const currentClient = client;
  const sessionToLogout = activeSessionId;
  
  try {
    // If we have a client, try to log out gracefully
    if (currentClient) {
      try {
        await currentClient.logout();
      } catch (logoutError) {
        console.warn('Error during client.logout(), continuing with session cleanup:', logoutError);
      }
    }
    
    // Clear LocalAuth data to force logout from phone
    const dataPath = getPrimaryLocalAuthPath();
    try {
      await removeDirectoryWithRetries(dataPath, { maxAttempts: 3, delayMs: 500 });
      console.log('🗑️ WhatsApp LocalAuth data cleared - user will need to scan QR again');
    } catch (err) {
      console.warn('⚠️ Failed to clear LocalAuth data:', err?.message || err);
    }
    
    // Mark session as inactive in the database
    if (sessionToLogout) {
      await markSessionInactive(sessionToLogout);
    }
    
    // Clear local state AFTER successful logout
    const currentNumber = activeNumber;
    const currentPushName = activePushName;
    
    client = null;
    isReady = false;
    queueInitialized = false;
    qrCode = null;
    activeNumber = null;
    activePushName = null;
    activeSessionId = null;
    
    return { 
      success: true, 
      message: 'Successfully logged out - please scan QR again to reconnect',
      session: {
        number: currentNumber,
        pushName: currentPushName,
        sessionId: sessionToLogout
      }
    };
  } catch (error) {
    console.error('Error during logout cleanup:', error);
    return { 
      success: false, 
      message: 'Logout failed: ' + error.message,
      session: {
        number: activeNumber,
        pushName: activePushName,
        sessionId: activeSessionId
      }
    };
  }
}

async function disconnectWhatsApp() {
  const currentClient = client;

  if (!currentClient) {
    return {
      success: true,
      message: 'WhatsApp client already stopped',
      session: {
        number: activeNumber,
        pushName: activePushName,
        sessionId: activeSessionId,
      },
    };
  }

  const sessionSnapshot = {
    number: activeNumber,
    pushName: activePushName,
    sessionId: activeSessionId,
  };

  try {
    await currentClient.destroy();
  } catch (error) {
    console.warn('⚠️ Failed to destroy WhatsApp client cleanly during disconnect:', error?.message || error);
  }

  // IMPORTANT: Keep session info for reconnection
  // Only clear client state, not session state
  client = null;
  isReady = false;
  isInitializing = false;
  queueInitialized = false;
  qrCode = null;
  
  // DO NOT clear activeNumber, activePushName, activeSessionId
  // This preserves the session for automatic reconnection

  return {
    success: true,
    message: 'WhatsApp client stopped. Session remains linked – restart to continue.',
    session: sessionSnapshot,
  };
}

// Pause campaign using queue system
export async function pauseCampaignService(campaignId) {
  return await queuePauseCampaign(campaignId);
}

// Resume campaign using queue system
export async function resumeCampaignService(campaignId, authHeader = '') {
  await ensureClientReady();
  return await queueResumeCampaign(campaignId, authHeader);
}

// Stop campaign using queue system
export async function stopCampaignService(campaignId) {
  return await queueStopCampaign(campaignId);
}

export { initWhatsApp, getWhatsAppStatus, logoutWhatsApp, disconnectWhatsApp, getClient, getActiveSessionId, clearLocalAuthProfile };
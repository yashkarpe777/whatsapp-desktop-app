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
let initPromise = null; // Track initialization promise
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

const DEFAULT_USER_AGENT = process.env.WHATSAPP_DESKTOP_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
  // Use a fixed client ID for production to ensure session persistence
  if (process.env.NODE_ENV === 'production' && !process.env.ELECTRON_DEV) {
    return 'whatsapp-blast-prod';
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
    fs.mkdirSync(targetPath, { recursive: true, mode: 0o755 });
    
    // Verify directory is writable
    const testFile = path.join(targetPath, '.session_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    
    console.log('✅ Session directory ensured and writable:', targetPath);
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      console.error('❌ Failed to ensure directory', targetPath, err?.message || err);
      throw err;
    }
  }
  return targetPath;
}

function resolveDefaultLocalAuthPath() {
  // If WHATSAPP_DATA_PATH is set (by Electron), use it directly
  if (process.env.WHATSAPP_DATA_PATH) {
    return process.env.WHATSAPP_DATA_PATH;
  }

  const platform = process.platform;
  let baseDir;

  if (platform === 'win32') {
    baseDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    baseDir = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    baseDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }

  return path.join(baseDir, 'whatsapp-bulk-sender', 'session');
}

function collectLocalAuthCandidates() {
  const set = new Set();
  
  // Always add WHATSAPP_DATA_PATH if available (primary path for both dev and prod)
  if (process.env.WHATSAPP_DATA_PATH) {
    set.add(path.resolve(process.env.WHATSAPP_DATA_PATH));
  }
  
  // In production Electron app, prioritize WHATSAPP_DATA_PATH and avoid conflicting paths
  if (process.env.ELECTRON_DEV === 'false' && process.env.NODE_ENV === 'production') {
    // Only use the WHATSAPP_DATA_PATH in production to avoid conflicts
    console.log('🔧 Production mode: using only WHATSAPP_DATA_PATH for session');
  } else {
    // In development, check additional paths
    set.add(path.resolve(resolveDefaultLocalAuthPath()));
    set.add(path.resolve(process.cwd(), '.wwebjs_auth'));
    set.add(path.resolve(__dirname, '..', '..', '.wwebjs_auth'));
  }
  
  return Array.from(set);
}

function hasLocalAuthProfile(candidatePath) {
  try {
    if (!fs.existsSync(candidatePath)) {
      return false;
    }

    const allFiles = fs.readdirSync(candidatePath);
    console.log('🔍 Checking session directory:', candidatePath, 'files:', allFiles);

    // Check for session.settings.json in root
    const settingsPath = path.join(candidatePath, 'session.settings.json');
    if (fs.existsSync(settingsPath)) {
      console.log('📄 Found session.settings.json at:', settingsPath);
      return true;
    }

    // Check for session-* directories (newer WhatsApp Web.js format)
    const sessionDirs = allFiles.filter(file => file.startsWith('session-'));
    if (sessionDirs.length > 0) {
      for (const sessionDir of sessionDirs) {
        const sessionDirPath = path.join(candidatePath, sessionDir);
        
        try {
          const sessionFiles = fs.readdirSync(sessionDirPath);
          console.log('📁 Checking session subdirectory:', sessionDirPath, 'files:', sessionFiles);
          
          // Check for session.settings.json
          const hasSettings = sessionFiles.includes('session.settings.json');
          if (hasSettings) {
            console.log('📄 Found session.settings.json in:', sessionDirPath);
            return true;
          }
          
          // Check for Chrome profile indicators (more comprehensive)
          const chromeProfileIndicators = [
            'Local Storage',
            'IndexedDB', 
            'leveldb',
            'Preferences',
            'Cookies',
            'Web Data',
            'QuotaManager',
            'Extension State',
            'Network',
            'GPUCache',
            'ShaderCache',
            'Code Cache',
            'Crashpad'
          ];
          
          const hasChromeProfile = chromeProfileIndicators.some(indicator => 
            sessionFiles.some(file => file.includes(indicator))
          );
          
          if (hasChromeProfile) {
            console.log('🌐 Found Chrome profile indicators in:', sessionDirPath);
            return true;
          }
          
          // Check for any .json files
          const hasJsonFiles = sessionFiles.some(f => f.endsWith('.json'));
          if (hasJsonFiles) {
            console.log('📄 Found JSON files in:', sessionDirPath);
            return true;
          }
          
          // If directory has substantial content, consider it a valid session
          if (sessionFiles.length > 10) {
            console.log('📁 Found substantial session data in:', sessionDirPath);
            return true;
          }
        } catch (dirErr) {
          console.warn('⚠️ Could not read session directory:', sessionDirPath, dirErr?.message || dirErr);
        }
      }
    }

    console.log('❌ No valid session profile found in:', candidatePath);
    return false;

  } catch (err) {
    console.warn('⚠️ Failed to inspect LocalAuth path:', candidatePath, err?.message || err);
    return false;
  }
}

function getPrimaryLocalAuthPath() {
  const candidates = collectLocalAuthCandidates();
  console.log('🔍 Checking WhatsApp session candidates:', candidates);
  
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (hasLocalAuthProfile(normalized)) {
      ensureDirectory(normalized);
      if (process.env.WHATSAPP_DATA_PATH !== normalized) {
        process.env.WHATSAPP_DATA_PATH = normalized;
      }
      console.log('📁 Reusing existing WhatsApp session profile at:', normalized);
      return normalized;
    }
  }

  const target = candidates[0] || resolveDefaultLocalAuthPath();
  const ensuredPath = ensureDirectory(target);
  console.log('📁 Creating new WhatsApp session profile at:', ensuredPath);
  return ensuredPath;
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
    for (const stmt of ddlStatements) {
      await hotPool.query(stmt);
    }
    sessionTableEnsured = true;
    console.log('✅ whatsapp_sessions table ensured');
    return true;
  } catch (error) {
    console.warn('⚠️ Failed to ensure whatsapp_sessions table:', error.message);
    return false;
  }
}

async function initWhatsApp(_retry = false) {
  // If already initializing, return the existing promise
  if (initPromise) {
    console.log('🔄 WhatsApp initialization already in progress, returning existing promise');
    return initPromise;
  }

  // If client is ready, no need to initialize
  if (client && isReady) {
    console.log('🔄 WhatsApp client already ready, skipping initialization');
    return;
  }

  console.log('🚀 Starting WhatsApp initialization...');
  isInitializing = true;
  
  initPromise = (async () => {
    try {

  try {
    await ensureWhatsAppModules();

    if (client && !isReady && !isInitializing) {
      try { await client.destroy(); } catch (_) {}
      client = null;
    }

    const headlessEnv = String(process.env.HEADLESS || 'false').toLowerCase();
    const prefersHeadless = headlessEnv === 'true';
    const headless = _retry ? true : prefersHeadless;

    const dataPath = getPrimaryLocalAuthPath();
    console.log('🔧 Final WhatsApp session path:', dataPath);
    console.log('🔧 Client ID:', getStableClientId(dataPath));
    
    // Check if we have existing session data to recover
    const hasExistingSession = hasLocalAuthProfile(dataPath);
    if (hasExistingSession) {
      console.log('🔄 Found existing session data, attempting recovery...');
    }
    
    await pruneExtraLocalAuthProfiles(dataPath, { maxAttempts: 3, delayMs: 500 });
    
    // Double-check the directory exists and is writable before creating client
    try {
      fs.mkdirSync(dataPath, { recursive: true, mode: 0o755 });
      const testFile = path.join(dataPath, '.client_init_test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      console.log('✅ Session directory verified for client initialization:', dataPath);
    } catch (err) {
      console.error('❌ Critical: Cannot access session directory for client initialization:', err?.message || err);
      throw new Error(`Session directory access failed: ${err?.message || err}`);
    }
    
    const authStrategy = new LocalAuth({ 
      dataPath,
      clientId: getStableClientId(dataPath),
    });
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
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--ignore-certificate-errors-spki-list'
    ];

    console.log('📂 Using WhatsApp LocalAuth path:', dataPath);
    console.log('🔧 Environment - ELECTRON_DEV:', process.env.ELECTRON_DEV, 'NODE_ENV:', process.env.NODE_ENV);
    console.log('🔧 WHATSAPP_DATA_PATH:', process.env.WHATSAPP_DATA_PATH);

    client = new Client({
      authStrategy,
      puppeteer: {
        headless,
        executablePath,
        args: baseArgs,
        defaultViewport: DEFAULT_VIEWPORT,
      },
      userAgent: DEFAULT_USER_AGENT,
      takeoverOnConflict: false, // Prevent session conflicts
      takeoverTimeoutMs: 0, // Disable takeover to prevent conflicts
      qrMaxRetries: 1, // Reduce QR retries to prevent loops
      authTimeoutMs: 60000, // 1 minute timeout
      restartOnAuthFail: false, // Don't restart automatically
      browserName: 'Chrome',
      deviceName: process.env.WHATSAPP_DEVICE_NAME || 'Chrome', // Use standard device name
      bypassCSP: true, // Bypass Content Security Policy
      ignoreDefaultArgs: ['--enable-blink-features=IdleDetection'],
      // Add session persistence options
      sessionTimeoutMs: 300000, // 5 minutes session timeout
      keepAlive: true, // Keep session alive
      // Prevent multiple instances
      maxRetries: 0, // No retries to prevent loops
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
      console.log('QR code received');
      try {
        qrCode = await qrcode.toDataURL(qr);
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

        // Verify session files are being saved
        const sessionPath = getPrimaryLocalAuthPath();
        console.log('🔍 Verifying session persistence at:', sessionPath);
        
        // Ensure the session directory exists and is writable
        try {
          fs.mkdirSync(sessionPath, { recursive: true, mode: 0o755 });
          
          // Test write permissions
          const testFile = path.join(sessionPath, '.session_test');
          fs.writeFileSync(testFile, 'test');
          fs.unlinkSync(testFile);
          console.log('✅ Session directory is writable:', sessionPath);
        } catch (err) {
          console.error('❌ Session directory issue:', err?.message || err);
        }
        
        // Wait longer for session files to be written and ensure proper cleanup
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Force session save using dedicated function
        await forceSessionSave();
        
        // Additional wait for async operations
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Check if session files exist
        const settingsFile = path.join(sessionPath, 'session.settings.json');
        const hasSettings = fs.existsSync(settingsFile);
        console.log('📄 Session settings file exists:', hasSettings);
        
        if (hasSettings) {
          try {
            const settingsContent = fs.readFileSync(settingsFile, 'utf8');
            console.log('📄 Session settings content preview:', settingsContent.substring(0, 100));
          } catch (err) {
            console.warn('⚠️ Could not read session settings:', err?.message || err);
          }
        } else {
          console.warn('⚠️ Session settings file not found after ready event - session may not persist properly');
        }
        
        // List all files in session directory
        try {
          const sessionFiles = fs.readdirSync(sessionPath);
          console.log('📁 Session directory contents:', sessionFiles);
          
          // Check session subdirectories
          for (const file of sessionFiles) {
            if (file.startsWith('session-')) {
              const subDirPath = path.join(sessionPath, file);
              const subFiles = fs.readdirSync(subDirPath);
              console.log(`📁 Session subdirectory ${file}:`, subFiles);
              
              // Check for Chrome profile files specifically
              const hasChromeFiles = subFiles.some(f => 
                f.includes('Local Storage') || 
                f.includes('IndexedDB') || 
                f.includes('Cookies') ||
                f.includes('Preferences')
              );
              
              if (hasChromeFiles) {
                console.log('✅ Chrome profile files detected - session should persist');
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ Could not list session directory:', err?.message || err);
        }
        
        if (!hasSettings) {
          console.warn('⚠️ Session settings file not found - checking for alternative session formats');
        }

        // Save session info to database
        await saveSessionInfo(wid, activeNumber, activePushName);

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
      
      // Check if this is a normal logout or session issue
      if (reason === 'LOGOUT') {
        console.log('🔐 User logged out - keeping session for potential recovery');
        // Don't clear session automatically - let user decide
        // This prevents session loss on temporary disconnections
      } else {
        console.log('⚠️  Disconnected, but keeping session active for potential reconnection');
      }

      const sessionToMarkInactive = activeSessionId;
      const currentClient = client;

      // Force session save before disconnecting (but don't wait too long)
      if (currentClient && isReady) {
        try {
          // Use a timeout to prevent hanging
          await Promise.race([
            forceSessionSave(),
            new Promise(resolve => setTimeout(resolve, 3000))
          ]);
        } catch (err) {
          console.warn('⚠️ Failed to force session save on disconnect:', err?.message || err);
        }
      }

      // Use cleanup function for proper client destruction
      await cleanupClient();

      // Only try to reconnect if it's not a user logout and we haven't retried too many times
      if (reason !== 'LOGOUT' && !_retry) {
        // Try to reconnect after a longer delay to allow proper cleanup
        console.log('🔄 Attempting to reconnect in 10 seconds...');
        setTimeout(() => {
          console.log('🔄 Attempting to reconnect...');
          initWhatsApp(true).catch(err => {
            console.error('❌ Reconnection failed:', err);
          });
        }, 10000);
      }

      // Keep the active session info to allow for reconnection
      // activeNumber and activeSessionId are kept to maintain session state
      isInitializing = false;
      queueInitialized = false;

      if (sessionToMarkInactive) {
        try {
          await markSessionInactive(sessionToMarkInactive);
        } catch (err) {
          console.warn('⚠️ Failed to mark session inactive on disconnect:', err?.message || err);
        }
      }
    });

    client.on('auth_failure', () => {
      console.log('❌ WhatsApp authentication failed');
      isInitializing = false;
    });

      await client.initialize();
      console.log('✅ WhatsApp client initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize WhatsApp client:', error.message);
      
      // Don't retry automatically to prevent loops
      if (error.message.includes('Session closed') || error.message.includes('page has been closed')) {
        console.warn('⚠️ Page closed during initialization - this may be normal');
        return;
      }
      
      if (!_retry && /Target closed/i.test(String(error?.message || ''))) {
        try {
          console.log('🔄 Retrying WhatsApp initialization...');
          await initWhatsApp(true);
          return;
        } catch (retryError) {
          console.error('❌ Retry failed:', retryError.message);
        }
      }
      
      throw error;
    } finally {
      isInitializing = false;
      initPromise = null;
    }
  })();
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
    await hotPool.query(
      `INSERT INTO whatsapp_sessions (session_id, phone_number, push_name, is_active, last_seen)
       VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id)
       DO UPDATE SET phone_number = $2, push_name = $3, is_active = true, last_seen = CURRENT_TIMESTAMP`,
      [sessionId, phoneNumber, pushName]
    );
    console.log('✅ Session info saved:', sessionId);
  } catch (error) {
    if (error?.code === '42P01') {
      const ensured = await ensureSessionTable();
      if (ensured) {
        try {
          await hotPool.query(
            `INSERT INTO whatsapp_sessions (session_id, phone_number, push_name, is_active, last_seen)
             VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
             ON CONFLICT (session_id)
             DO UPDATE SET phone_number = $2, push_name = $3, is_active = true, last_seen = CURRENT_TIMESTAMP`,
            [sessionId, phoneNumber, pushName]
          );
          console.log('✅ Session info saved after ensuring table:', sessionId);
          return;
        } catch (retryErr) {
          console.warn('⚠️ Retry save session info failed:', retryErr.message);
        }
      }
    }
    console.warn('⚠️ Could not save session info:', error.message);
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
  const currentNumber = activeNumber;
  const currentPushName = activePushName;
  
  try {
    // If we have a client, try to log out gracefully
    if (currentClient) {
      try {
        await currentClient.logout();
      } catch (logoutError) {
        console.warn('Error during client.logout(), continuing with session cleanup:', logoutError);
      }
    }
    
    // Mark session as inactive in the database
    if (sessionToLogout) {
      await markSessionInactive(sessionToLogout);
    }
    
    // Clean up client properly
    await cleanupClient();
    
    // Clear session state
    activeNumber = null;
    activePushName = null;
    activeSessionId = null;
    queueInitialized = false;
    
    return { 
      success: true, 
      message: 'Successfully logged out',
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
      message: 'Logged out but encountered error during cleanup: ' + error.message,
      session: {
        number: currentNumber,
        pushName: currentPushName,
        sessionId: sessionToLogout
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

  // Use cleanup function for proper client destruction
  await cleanupClient();

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

async function forceSessionSave() {
  if (!client || !isReady) {
    console.warn('⚠️ Cannot force session save - client not ready');
    return false;
  }
  
  try {
    // Access the page to trigger any pending saves
    if (client.pupPage && !client.pupPage.isClosed()) {
      try {
        await client.pupPage.evaluate(() => {
          // Trigger localStorage save
          if (window.localStorage) {
            const testKey = 'session_save_trigger';
            localStorage.setItem(testKey, Date.now().toString());
            localStorage.removeItem(testKey);
          }
          
          // Trigger any pending IndexedDB operations
          if (window.indexedDB) {
            // Just access to ensure any pending operations complete
            indexedDB.databases();
          }
        });
        
        // Wait for operations to complete
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('✅ Session save triggered successfully');
        return true;
      } catch (evalError) {
        if (evalError.message.includes('Session closed') || evalError.message.includes('page has been closed')) {
          console.warn('⚠️ Page closed during session save, session may still persist');
          return true; // Don't treat as failure
        }
        throw evalError;
      }
    } else {
      console.warn('⚠️ Page not available for session save');
      return false;
    }
  } catch (error) {
    if (error.message.includes('Session closed') || error.message.includes('page has been closed')) {
      console.warn('⚠️ Page closed during session save, session may still persist');
      return true; // Don't treat as failure
    }
    console.warn('⚠️ Failed to force session save:', error?.message || error);
    return false;
  }
}

async function validateSession(sessionPath) {
  try {
    if (!fs.existsSync(sessionPath)) {
      return { valid: false, reason: 'Session directory does not exist' };
    }

    const files = fs.readdirSync(sessionPath);
    const sessionDirs = files.filter(file => file.startsWith('session-'));
    
    if (sessionDirs.length === 0) {
      return { valid: false, reason: 'No session directories found' };
    }

    for (const sessionDir of sessionDirs) {
      const sessionDirPath = path.join(sessionPath, sessionDir);
      const sessionFiles = fs.readdirSync(sessionDirPath);
      
      // Check for essential Chrome profile files
      const essentialFiles = ['Local Storage', 'Cookies', 'Preferences'];
      const hasEssentialFiles = essentialFiles.some(file => 
        sessionFiles.includes(file)
      );
      
      if (hasEssentialFiles) {
        return { valid: true, sessionDir };
      }
    }

    return { valid: false, reason: 'Essential session files missing' };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

async function cleanupClient() {
  if (!client) return;
  
  try {
    // Don't wait too long for cleanup
    await Promise.race([
      client.destroy(),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  } catch (error) {
    console.warn('⚠️ Error during client cleanup:', error?.message || error);
  } finally {
    client = null;
    isReady = false;
    isInitializing = false;
    qrCode = null;
    initPromise = null;
  }
}

async function recoverSession() {
  const sessionPath = getPrimaryLocalAuthPath();
  console.log('🔄 Attempting to recover WhatsApp session from:', sessionPath);
  
  const validation = await validateSession(sessionPath);
  
  if (!validation.valid) {
    console.log('❌ Session recovery failed:', validation.reason);
    return { success: false, reason: validation.reason };
  }
  
  console.log('✅ Valid session data found, attempting recovery...');
  
  try {
    // Clean up existing client properly
    await cleanupClient();
    
    // Reinitialize with existing session
    await initWhatsApp();
    
    // Wait for initialization
    const ready = await waitForReady(30000);
    
    if (ready) {
      console.log('✅ Session recovery successful');
      return { success: true, message: 'Session recovered successfully' };
    } else {
      console.log('❌ Session recovery failed - client not ready');
      return { success: false, reason: 'Client failed to initialize' };
    }
  } catch (error) {
    console.error('❌ Session recovery error:', error);
    return { success: false, reason: error.message };
  }
}

export { initWhatsApp, getWhatsAppStatus, logoutWhatsApp, disconnectWhatsApp, getClient, getActiveSessionId, clearLocalAuthProfile, forceSessionSave, validateSession, recoverSession, cleanupClient };
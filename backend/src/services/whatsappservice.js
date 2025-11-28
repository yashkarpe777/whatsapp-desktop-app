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
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      console.warn('⚠️ Failed to ensure directory', targetPath, err?.message || err);
    }
  }
  return targetPath;
}

function getPrimaryLocalAuthPath() {
  if (process.env.WHATSAPP_DATA_PATH) {
    const resolved = path.resolve(process.env.WHATSAPP_DATA_PATH);
    return ensureDirectory(resolved);
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

  const sessionDir = path.join(baseDir, 'whatsapp-bulk-sender', 'session');
  return ensureDirectory(sessionDir);
}

function getLocalAuthCandidates() {
  const candidates = new Set();
  // Primary path actually used by the client
  candidates.add(getPrimaryLocalAuthPath());
  // Backwards-compat / extra locations that may contain old sessions
  if (process.env.WHATSAPP_DATA_PATH) {
    candidates.add(path.resolve(process.env.WHATSAPP_DATA_PATH));
  }
  candidates.add(path.resolve(process.cwd(), '.wwebjs_auth'));
  candidates.add(path.resolve(__dirname, '..', '..', '.wwebjs_auth'));

  return Array.from(candidates);
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
  if (client && (isReady || isInitializing)) return;
  if (isInitializing) return;

  isInitializing = true;

  try {
    await ensureWhatsAppModules();

    if (client && !isReady && !isInitializing) {
      try { await client.destroy(); } catch (_) {}
      client = null;
    }

    const headless = process.env.HEADLESS === 'true';
    const dataPath = getPrimaryLocalAuthPath();
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
      '--disable-renderer-backgrounding'
    ];

    console.log('📂 Using WhatsApp LocalAuth path:', dataPath);

    client = new Client({
      authStrategy,
      puppeteer: {
        headless,
        executablePath,
        args: baseArgs,
        defaultViewport: DEFAULT_VIEWPORT,
      },
      userAgent: DEFAULT_USER_AGENT,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 5000,
      qrMaxRetries: 0,
      authTimeoutMs: 0,
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
      console.log('⚠️  Disconnected, but keeping session active for potential reconnection');

      const sessionToMarkInactive = activeSessionId;
      const currentClient = client;

      if (currentClient) {
        try {
          await currentClient.destroy();
        } catch (err) {
          console.warn('⚠️ Failed to destroy client cleanly:', err?.message || err);
        }
      }

      // Don't destroy the client immediately to allow for reconnection
      client = null;
      isReady = false;
      isInitializing = false;

      // Try to reconnect after a delay
      console.log('🔄 Attempting to reconnect in 5 seconds...');
      setTimeout(() => {
        console.log('🔄 Attempting to reconnect...');
        initWhatsApp().catch(err => {
          console.error('❌ Reconnection failed:', err);
        });
      }, 5000);

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
  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp client:', error.message);
    isInitializing = false;
    if (!_retry && /Target closed/i.test(String(error?.message || ''))) {
      try {
        process.env.HEADLESS = 'true';
        await initWhatsApp(true);
        return;
      } catch (_) {}
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
  
  // Clear local state first
  client = null;
  isReady = false;
  queueInitialized = false;
  qrCode = null;
  const currentNumber = activeNumber;
  const currentPushName = activePushName;
  activeNumber = null;
  activePushName = null;
  activeSessionId = null;
  
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

  try {
    await currentClient.destroy();
  } catch (error) {
    console.warn('⚠️ Failed to destroy WhatsApp client cleanly during disconnect:', error?.message || error);
  }

  client = null;
  isReady = false;
  isInitializing = false;
  queueInitialized = false;
  qrCode = null;

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
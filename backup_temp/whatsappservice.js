// // src/services/whatsappservice.js
// import pkg from 'whatsapp-web.js';
// const { Client, LocalAuth, MessageMedia } = pkg;
// import qrcode from 'qrcode';
// import { hotPool } from '../db.js';
// import { sendLargeVideo } from './videoCompressor.js';
// import {
//   enqueueCampaign,
//   pauseCampaign as queuePauseCampaign,
//   resumeCampaign as queueResumeCampaign,
//   stopCampaign as queueStopCampaign,
//   initializeCampaignQueue,
//   recoverCampaigns
// } from './campaignQueue.js';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import fs from 'fs';

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// // Module-wide state
// let client = null;
// let qrCode = null;
// let isReady = false;
// let isInitializing = false;
// let activeNumber = null;
// let activePushName = null;
// let activeSessionId = null;
// let queueInitialized = false;

// /**
//  * Helper: get DB pool
//  */
// function getDb() {
//   return hotPool;
// }

// /**
//  * Build LocalAuth strategy using WHATSAPP_DATA_PATH if available
//  */
// function buildAuthStrategy() {
//   const dataPath = process.env.WHATSAPP_DATA_PATH;
//   if (dataPath && dataPath.trim()) {
//     // ensure directory exists
//     try {
//       fs.mkdirSync(dataPath, { recursive: true, mode: 0o755 });
//     } catch (_) {}
//     return new LocalAuth({ dataPath });
//   }
//   return new LocalAuth();
// }

// /**
//  * Returns an array of puppeteer args used to launch browser
//  */
// function getPuppeteerArgs() {
//   return [
//     '--no-sandbox',
//     '--disable-setuid-sandbox',
//     '--disable-dev-shm-usage',
//     '--no-first-run',
//     '--no-zygote',
//     '--disable-background-timer-throttling',
//     '--disable-backgrounding-occluded-windows',
//     '--disable-renderer-backgrounding'
//   ];
// }

// /**
//  * Initialize the WhatsApp client.
//  * Safe to call multiple times — uses flags to avoid double initialization.
//  */
// async function initWhatsApp(_retry = false) {
//   // Avoid concurrent inits
//   if (isInitializing) {
//     console.log('🔁 initWhatsApp called while already initializing — returning');
//     return;
//   }
//   if (client && isReady) {
//     console.log('✅ WhatsApp client already initialized and ready');
//     return;
//   }

//   isInitializing = true;

//   try {
//     // If an old client exists but isn't ready, destroy it
//     if (client && !isReady) {
//       try { await client.destroy(); } catch (_) {}
//       client = null;
//     }

//     const headless = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
//     const authStrategy = buildAuthStrategy();

//     // Choose executablePath if provided or on Windows look up candidates
//     let executablePath = process.env.CHROME_BIN || undefined;
//     if (process.platform === 'win32' && !executablePath) {
//       const candidates = [
//         'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
//         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
//         'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
//         'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
//       ];
//       for (const c of candidates) {
//         try { if (c && fs.existsSync(c)) { executablePath = c; break; } } catch (_) {}
//       }
//     }

//     client = new Client({
//       authStrategy,
//       puppeteer: {
//         headless,
//         executablePath,
//         args: getPuppeteerArgs()
//       }
//     });

//     // Events
//     client.on('qr', async (qr) => {
//       console.log('📱 QR received');
//       try {
//         qrCode = await qrcode.toDataURL(qr);
//       } catch (err) {
//         console.warn('⚠️ Failed to generate QR data URL:', err?.message || err);
//         qrCode = null;
//       }
//     });

//     client.on('ready', async () => {
//       try {
//         console.log('✅ WhatsApp client ready');
//         isReady = true;
//         isInitializing = false;
//         qrCode = null;

//         const info = client.info || {};
//         const wid = info?.wid?._serialized || '';
//         activeSessionId = wid || null;
//         activeNumber = wid ? wid.replace('@c.us', '') : null;
//         activePushName = info?.pushname || null;

//         // Save session info to DB (best-effort)
//         try {
//           await saveSessionInfo(activeSessionId, activeNumber, activePushName);
//         } catch (err) {
//           console.warn('⚠️ saveSessionInfo failed:', err?.message || err);
//         }

//         // Initialize campaign queue if not already done
//         if (!queueInitialized) {
//           try {
//             initializeCampaignQueue(client);
//             queueInitialized = true;
//             console.log('✅ Campaign queue initialized');

//             // Recover campaigns that were running before crash (best-effort)
//             setTimeout(() => {
//               recoverCampaigns().catch(err => console.error('❌ recoverCampaigns failed:', err));
//             }, 2000);
//           } catch (err) {
//             console.warn('⚠️ Failed to initialize campaign queue:', err?.message || err);
//           }
//         }
//       } catch (err) {
//         console.error('❌ Error in ready handler:', err);
//         // fallthrough - we keep client but mark not ready
//         isReady = false;
//         isInitializing = false;
//       }
//     });

//     client.on('disconnected', async (reason) => {
//       console.log('❌ WhatsApp client disconnected', reason ? `(reason: ${reason})` : '');
//       // On disconnect, we keep a clean state
//       isReady = false;
//       qrCode = null;
//       activeNumber = null;
//       activePushName = null;
//       activeSessionId = null;
//       isInitializing = false;
//       queueInitialized = false;
//       // attempt to mark session inactive in DB (best-effort)
//       try {
//         if (activeSessionId) await markSessionInactive(activeSessionId);
//       } catch (err) {
//         console.warn('⚠️ markSessionInactive failed during disconnect:', err?.message || err);
//       }
//     });

//     client.on('auth_failure', (msg) => {
//       console.warn('❌ WhatsApp auth_failure:', msg || '');
//       isInitializing = false;
//     });

//     // initialize client (this opens the browser / session)
//     await client.initialize();
//     // initialization returns when the client finished setup (ready event will fire later)
//   } catch (error) {
//     console.error('❌ Failed to initialize WhatsApp client:', error?.message || error);
//     isInitializing = false;
//     // If headless target closed issues occur, attempt a single retry forcing headless
//     if (!_retry && /Target closed/i.test(String(error?.message || ''))) {
//       try {
//         console.log('🔄 Retrying initWhatsApp in headless mode due to Target closed');
//         process.env.HEADLESS = 'true';
//         await initWhatsApp(true);
//         return;
//       } catch (_) {}
//     }
//     throw error;
//   }
// }

// /**
//  * Wait until client is ready (timeoutMs default 30s)
//  */
// async function waitForReady(timeoutMs = 30000) {
//   const start = Date.now();
//   while (!isReady && Date.now() - start < timeoutMs) {
//     await new Promise(r => setTimeout(r, 500));
//   }
//   return isReady;
// }

// /**
//  * Convenience - ensures client is initialized and ready
//  */
// async function ensureClientReady() {
//   if (isReady) return true;
//   await initWhatsApp();
//   const ok = await waitForReady(30000);
//   if (!ok) throw new Error('WhatsApp client is not ready. Please scan QR code first.');
//   return true;
// }

// /**
//  * Attempt a clean recovery by destroying existing client and reinitializing
//  */
// async function recoverClient() {
//   try {
//     if (client) {
//       try { await client.destroy(); } catch (_) {}
//     }
//   } finally {
//     client = null;
//     isReady = false;
//     qrCode = null;
//     isInitializing = false;
//   }
//   await initWhatsApp();
//   const ok = await waitForReady(30000);
//   return ok;
// }

// /**
//  * Save session info to DB (best-effort)
//  */
// async function saveSessionInfo(sessionId, phoneNumber, pushName) {
//   if (!sessionId) return;
//   try {
//     await getDb().query(
//       `INSERT INTO whatsapp_sessions (session_id, phone_number, push_name, is_active, last_seen)
//        VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
//        ON CONFLICT (session_id)
//        DO UPDATE SET phone_number = $2, push_name = $3, is_active = true, last_seen = CURRENT_TIMESTAMP`,
//       [sessionId, phoneNumber, pushName]
//     );
//     console.log('✅ Session info saved:', sessionId);
//   } catch (error) {
//     // don't throw — best effort
//     console.warn('⚠️ Could not save session info:', error?.message || error);
//   }
// }

// /**
//  * Mark session inactive in DB (best-effort)
//  */
// async function markSessionInactive(sessionId) {
//   if (!sessionId) return;
//   try {
//     await getDb().query(
//       `UPDATE whatsapp_sessions SET is_active = false, last_seen = CURRENT_TIMESTAMP WHERE session_id = $1`,
//       [sessionId]
//     );
//     console.log('✅ Session marked inactive:', sessionId);
//   } catch (error) {
//     console.warn('⚠️ Could not mark session inactive:', error?.message || error);
//   }
// }

// /**
//  * Public: return status object
//  */
// function getWhatsAppStatus() {
//   return {
//     ready: isReady,
//     qr: qrCode,
//     initializing: isInitializing,
//     number: activeNumber,
//     name: activePushName,
//     sessionId: activeSessionId
//   };
// }

// /**
//  * Enqueue campaign (public)
//  */
// export async function sendCampaign(campaignId, authHeader = '') {
//   console.log(`🚀 [sendCampaign] enqueue ${campaignId}`);
//   await ensureClientReady();
//   try {
//     const result = await enqueueCampaign(campaignId, authHeader);
//     console.log(`✅ Campaign ${campaignId} enqueued`);
//     return result;
//   } catch (err) {
//     console.error('❌ enqueueCampaign failed:', err?.message || err);
//     throw err;
//   }
// }

// /**
//  * Logout and clear client session from memory. This will call client.logout() then destroy the client.
//  * It does not attempt to delete LocalAuth files from disk.
//  */
// async function logoutWhatsApp() {
//   try {
//     if (client) {
//       try { await client.logout(); } catch (e) { console.warn('⚠️ logout() error:', e?.message || e); }
//       try { await client.destroy(); } catch (e) { console.warn('⚠️ destroy() error:', e?.message || e); }
//     }
//   } finally {
//     client = null;
//     isReady = false;
//     isInitializing = false;
//     qrCode = null;
//     activeNumber = null;
//     activePushName = null;
//     activeSessionId = null;
//     queueInitialized = false;
//   }
//   console.log('✅ WhatsApp logged out and client destroyed');
//   return { success: true };
// }

// /**
//  * Disconnect but keep LocalAuth files intact.
//  * Use this when you want to stop the running instance without removing session files.
//  */
// async function disconnectWhatsApp() {
//   try {
//     if (client) {
//       try { await client.destroy(); } catch (e) { console.warn('⚠️ destroy() error during disconnect:', e?.message || e); }
//     }
//   } finally {
//     client = null;
//     isReady = false;
//     isInitializing = false;
//     qrCode = null;
//     queueInitialized = false;
//     // keep activeSessionId null since client stopped
//     activeNumber = null;
//     activePushName = null;
//     activeSessionId = null;
//   }
//   console.log('🔌 WhatsApp client disconnected (LocalAuth preserved)');
//   return { success: true };
// }

// /**
//  * Pause / resume / stop campaign wrappers
//  */
// export async function pauseCampaignService(campaignId) {
//   return await queuePauseCampaign(campaignId);
// }
// export async function resumeCampaignService(campaignId, authHeader = '') {
//   await ensureClientReady();
//   return await queueResumeCampaign(campaignId, authHeader);
// }
// export async function stopCampaignService(campaignId) {
//   return await queueStopCampaign(campaignId);
// }

// /**
//  * Force a session save by interacting with the page (best-effort).
//  * Returns true if we believe the trigger succeeded.
//  */
// async function forceSessionSave() {
//   if (!client || !isReady) {
//     console.warn('⚠️ forceSessionSave: client not ready');
//     return false;
//   }
//   try {
//     // whatsapp-web.js exposes page in different properties across versions; try both
//     const page = client.pupPage || (client?.browser?.pages ? (await client.browser.pages())[0] : null);
//     if (!page) {
//       console.warn('⚠️ forceSessionSave: page not found');
//       return false;
//     }
//     await page.evaluate(() => {
//       if (window.localStorage) {
//         localStorage.setItem('__session_save_trigger', Date.now().toString());
//         localStorage.removeItem('__session_save_trigger');
//       }
//       if (window.indexedDB && indexedDB.databases) {
//         indexedDB.databases();
//       }
//     });
//     // give short time for writes
//     await new Promise(r => setTimeout(r, 800));
//     console.log('✅ forceSessionSave triggered');
//     return true;
//   } catch (err) {
//     console.warn('⚠️ forceSessionSave failed:', err?.message || err);
//     return false;
//   }
// }

// /**
//  * Validate session folder at WHATSAPP_DATA_PATH (very lightweight)
//  */
// async function validateSession(sessionPath) {
//   try {
//     if (!sessionPath) {
//       return { valid: false, reason: 'no session path provided' };
//     }
//     const resolved = path.resolve(sessionPath);
//     if (!fs.existsSync(resolved)) return { valid: false, reason: 'path does not exist' };
//     const files = fs.readdirSync(resolved);
//     // basic heuristic: must contain some files or session-* dirs
//     if (files.length === 0) return { valid: false, reason: 'empty directory' };
//     return { valid: true, path: resolved };
//   } catch (err) {
//     return { valid: false, reason: err?.message || String(err) };
//   }
// }

// /**
//  * Recover session by reinitializing client using existing LocalAuth files
//  */
// async function recoverSession() {
//   try {
//     await recoverClient();
//     const ok = await waitForReady(30000);
//     return { success: ok };
//   } catch (err) {
//     console.error('❌ recoverSession failed:', err?.message || err);
//     return { success: false, reason: err?.message || String(err) };
//   }
// }

// /**
//  * Clear LocalAuth profile directories (if WHATSAPP_DATA_PATH is set) - best-effort.
//  * WARNING: this will delete files on disk.
//  */
// async function clearLocalAuthProfile({ maxAttempts = 3 } = {}) {
//   const dataPath = process.env.WHATSAPP_DATA_PATH;
//   if (!dataPath) {
//     return { success: false, message: 'WHATSAPP_DATA_PATH not set' };
//   }
//   const resolved = path.resolve(dataPath);
//   try {
//     // destroy running client first
//     if (client) {
//       try { await client.destroy(); } catch (_) {}
//       client = null;
//     }
//     // attempt to remove recursively
//     for (let attempt = 1; attempt <= maxAttempts; attempt++) {
//       try {
//         fs.rmSync(resolved, { recursive: true, force: true });
//         console.log('🧹 Cleared LocalAuth folder:', resolved);
//         return { success: true, removed: true, path: resolved };
//       } catch (err) {
//         console.warn(`⚠️ Attempt ${attempt} to remove ${resolved} failed:`, err?.message || err);
//         await new Promise(r => setTimeout(r, 500 * attempt));
//       }
//     }
//     return { success: false, removed: false, message: 'failed to remove after retries' };
//   } catch (err) {
//     return { success: false, message: err?.message || String(err) };
//   }
// }

// /**
//  * Public getters
//  */
// function getClient() { return client; }
// function getActiveSessionId() { return activeSessionId; }

// export {
//   initWhatsApp,
//   getWhatsAppStatus,
//   logoutWhatsApp,
//   disconnectWhatsApp,
//   recoverSession,
//   validateSession,
//   forceSessionSave,
//   clearLocalAuthProfile,
//   getClient,
//   getActiveSessionId,
//   sendLargeVideo, // re-export if other modules use it
//   sendLargeVideo as compressAndSendVideo // optional alias
// };



// src/services/whatsappservice.js
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import { hotPool } from '../db.js';
import { sendLargeVideo } from './videoCompressor.js';
import {
  enqueueCampaign,
  pauseCampaign as queuePauseCampaign,
  resumeCampaign as queueResumeCampaign,
  stopCampaign as queueStopCampaign,
  initializeCampaignQueue,
  recoverCampaigns
} from './campaignQueue.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Module-wide state
let client = null;
let qrCode = null;
let isReady = false;
let isInitializing = false;
let activeNumber = null;
let activePushName = null;
let activeSessionId = null;
let queueInitialized = false;
let qrGenerated = false; // NEW: Track if QR already generated
let lastQrTime = 0; // NEW: Prevent duplicate QR generation

/**
 * Helper: get DB pool
 */
function getDb() {
  return hotPool;
}

/**
 * Build LocalAuth strategy using WHATSAPP_DATA_PATH if available
 */
function buildAuthStrategy() {
  const dataPath = process.env.WHATSAPP_DATA_PATH;
  if (dataPath && dataPath.trim()) {
    // ensure directory exists
    try {
      fs.mkdirSync(dataPath, { recursive: true, mode: 0o755 });
    } catch (_) {}
    return new LocalAuth({ dataPath });
  }
  return new LocalAuth();
}

/**
 * Returns an array of puppeteer args used to launch browser
 */
function getPuppeteerArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-zygote',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // NEW: WhatsApp Web compatibility fixes
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
    '--disable-blink-features=AutomationControlled'
  ];
}

/**
 * Initialize the WhatsApp client.
 * Safe to call multiple times — uses flags to avoid double initialization.
 */
async function initWhatsApp(_retry = false) {
  // Avoid concurrent inits
  if (isInitializing) {
    console.log('🔁 initWhatsApp called while already initializing — returning');
    return;
  }
  if (client && isReady) {
    console.log('✅ WhatsApp client already initialized and ready');
    return;
  }

  isInitializing = true;
  qrGenerated = false; // Reset QR flag
  lastQrTime = 0;

  try {
    // If an old client exists but isn't ready, destroy it
    if (client && !isReady) {
      try { 
        await client.destroy(); 
        console.log('🗑️ Destroyed previous client');
      } catch (err) {
        console.warn('⚠️ Error destroying previous client:', err?.message);
      }
      client = null;
    }

    const headless = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
    const authStrategy = buildAuthStrategy();

    // Choose executablePath if provided or on Windows look up candidates
    let executablePath = process.env.CHROME_BIN || undefined;
    if (process.platform === 'win32' && !executablePath) {
      const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      ];
      for (const c of candidates) {
        try { 
          if (c && fs.existsSync(c)) { 
            executablePath = c; 
            console.log('✅ Found Chrome at:', c);
            break; 
          } 
        } catch (_) {}
      }
    }

    console.log('🚀 Creating WhatsApp client...');
    client = new Client({
      authStrategy,
      puppeteer: {
        headless,
        executablePath,
        args: getPuppeteerArgs(),
        // NEW: Increase timeout and disable automation detection
        timeout: 60000,
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null
      },
      // NEW: WhatsApp Web version configuration
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
      },
      // NEW: Connection settings
      qrMaxRetries: 15,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 30000,
      restartOnAuthFail: true
    });

    // Events - FIXED VERSION
    client.on('qr', async (qr) => {
      // NEW: Prevent duplicate QR generation
      const now = Date.now();
      if (qrGenerated && (now - lastQrTime) < 5000) {
        console.log('🔄 Skipping duplicate QR generation');
        return;
      }
      
      console.log('📱 QR received');
      qrGenerated = true;
      lastQrTime = now;
      
      try {
        qrCode = await qrcode.toDataURL(qr);
        console.log('✅ QR generated successfully');
      } catch (err) {
        console.warn('⚠️ Failed to generate QR data URL:', err?.message || err);
        qrCode = null;
      }
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`🔄 Loading WhatsApp: ${percent}% - ${message}`);
    });

    client.on('authenticated', () => {
      console.log('🔐 WhatsApp authenticated successfully');
      qrCode = null;
      qrGenerated = false;
    });

    client.on('ready', async () => {
      try {
        console.log('✅ WhatsApp client READY!');
        isReady = true;
        isInitializing = false;
        qrCode = null;
        qrGenerated = false;

        const info = client.info || {};
        console.log('Client info:', JSON.stringify(info, null, 2));
        
        const wid = info?.wid?._serialized || '';
        activeSessionId = wid || null;
        activeNumber = wid ? wid.replace('@c.us', '') : null;
        activePushName = info?.pushname || null;

        console.log('📱 Connected as:', activePushName, '(', activeNumber, ')');

        // Save session info to DB (best-effort) - FIXED
        try {
          if (activeSessionId && activeNumber) {
            await saveSessionInfo(activeSessionId, activeNumber, activePushName);
          } else {
            console.warn('⚠️ Cannot save session: missing session info');
          }
        } catch (err) {
          console.warn('⚠️ saveSessionInfo failed:', err?.message || err);
        }

        // Initialize campaign queue if not already done
        if (!queueInitialized) {
          try {
            initializeCampaignQueue(client);
            queueInitialized = true;
            console.log('✅ Campaign queue initialized');

            // Recover campaigns that were running before crash (best-effort)
            setTimeout(() => {
              recoverCampaigns().catch(err => console.error('❌ recoverCampaigns failed:', err));
            }, 2000);
          } catch (err) {
            console.warn('⚠️ Failed to initialize campaign queue:', err?.message || err);
          }
        }
      } catch (err) {
        console.error('❌ Error in ready handler:', err);
        isReady = false;
        isInitializing = false;
      }
    });

    client.on('disconnected', async (reason) => {
      console.log('❌ WhatsApp client disconnected', reason ? `(reason: ${reason})` : '');
      isReady = false;
      qrCode = null;
      qrGenerated = false;
      activeNumber = null;
      activePushName = null;
      activeSessionId = null;
      isInitializing = false;
      queueInitialized = false;
      
      // attempt to mark session inactive in DB (best-effort)
      try {
        if (activeSessionId) {
          await markSessionInactive(activeSessionId);
        }
      } catch (err) {
        console.warn('⚠️ markSessionInactive failed during disconnect:', err?.message || err);
      }
    });

    client.on('auth_failure', (msg) => {
      console.warn('❌ WhatsApp auth_failure:', msg || '');
      isInitializing = false;
      qrGenerated = false;
    });

    // NEW: Add more event handlers for debugging
    client.on('change_state', (state) => {
      console.log('🔄 WhatsApp state changed:', state);
    });

    client.on('message', (msg) => {
      console.log('💬 Message received:', msg.body?.substring(0, 50));
    });

    // initialize client
    console.log('🔄 Initializing WhatsApp client...');
    await client.initialize();
    console.log('✅ WhatsApp client initialized, waiting for QR/ready...');
    
  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp client:', error?.message || error);
    console.error('Full error:', error);
    isInitializing = false;
    qrGenerated = false;
    
    // If headless target closed issues occur, attempt a single retry forcing headless
    if (!_retry && /Target closed|Failed to launch/i.test(String(error?.message || ''))) {
      try {
        console.log('🔄 Retrying initWhatsApp with headless false...');
        process.env.HEADLESS = 'false';
        await initWhatsApp(true);
        return;
      } catch (retryError) {
        console.error('❌ Retry also failed:', retryError?.message);
        throw error;
      }
    }
    throw error;
  }
}

/**
 * Wait until client is ready (timeoutMs default 30s)
 */
async function waitForReady(timeoutMs = 30000) {
  const start = Date.now();
  while (!isReady && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
  }
  return isReady;
}

/**
 * Convenience - ensures client is initialized and ready
 */
async function ensureClientReady() {
  if (isReady) return true;
  
  // NEW: If QR is showing but not ready, wait longer
  if (qrCode && !isReady) {
    console.log('⌛ QR shown but not ready yet, waiting...');
    const ok = await waitForReady(60000); // Wait 60 seconds for QR scan
    if (!ok) throw new Error('QR code not scanned in time. Please scan the QR code.');
    return true;
  }
  
  await initWhatsApp();
  const ok = await waitForReady(30000);
  if (!ok) throw new Error('WhatsApp client is not ready. Please scan QR code first.');
  return true;
}

/**
 * Attempt a clean recovery by destroying existing client and reinitializing
 */
async function recoverClient() {
  try {
    if (client) {
      try { 
        await client.destroy(); 
        console.log('🗑️ Destroyed client for recovery');
      } catch (_) {}
    }
  } finally {
    client = null;
    isReady = false;
    qrCode = null;
    isInitializing = false;
    qrGenerated = false;
  }
  await initWhatsApp();
  const ok = await waitForReady(30000);
  return ok;
}

/**
 * Save session info to DB (best-effort) - FIXED VERSION
 */
async function saveSessionInfo(sessionId, phoneNumber, pushName) {
  if (!sessionId || !phoneNumber) {
    console.warn('⚠️ Cannot save session: missing sessionId or phoneNumber');
    return;
  }
  
  try {
    console.log('💾 Saving session to database...');
    await getDb().query(
      `INSERT INTO whatsapp_sessions (session_id, phone_number, push_name, is_active, last_seen)
       VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id)
       DO UPDATE SET 
         phone_number = EXCLUDED.phone_number, 
         push_name = EXCLUDED.push_name, 
         is_active = true, 
         last_seen = CURRENT_TIMESTAMP`,
      [sessionId, phoneNumber, pushName || 'Unknown']
    );
    console.log('✅ Session info saved to DB:', sessionId);
  } catch (error) {
    console.error('❌ Database error saving session:', error?.message || error);
    // Don't throw - best effort
  }
}

/**
 * Mark session inactive in DB (best-effort)
 */
async function markSessionInactive(sessionId) {
  if (!sessionId) return;
  
  try {
    await getDb().query(
      `UPDATE whatsapp_sessions SET is_active = false, last_seen = CURRENT_TIMESTAMP 
       WHERE session_id = $1`,
      [sessionId]
    );
    console.log('✅ Session marked inactive in DB:', sessionId);
  } catch (error) {
    console.warn('⚠️ Could not mark session inactive in DB:', error?.message || error);
  }
}

/**
 * Public: return status object - FIXED VERSION
 */
function getWhatsAppStatus() {
  // NEW: Prevent frequent status calls from affecting QR
  const status = {
    ready: isReady,
    qr: qrCode,
    initializing: isInitializing,
    number: activeNumber,
    name: activePushName,
    sessionId: activeSessionId,
    // NEW: Add debugging info
    timestamp: new Date().toISOString(),
    qrGenerated: qrGenerated
  };
  
  // Don't log every status call to avoid spam
  // console.log('📊 Status checked:', status.ready ? 'READY' : 'NOT READY');
  return status;
}

/**
 * Enqueue campaign (public)
 */
export async function sendCampaign(campaignId, authHeader = '') {
  console.log(`🚀 [sendCampaign] enqueue ${campaignId}`);
  await ensureClientReady();
  try {
    const result = await enqueueCampaign(campaignId, authHeader);
    console.log(`✅ Campaign ${campaignId} enqueued`);
    return result;
  } catch (err) {
    console.error('❌ enqueueCampaign failed:', err?.message || err);
    throw err;
  }
}

/**
 * Logout and clear client session from memory. This will call client.logout() then destroy the client.
 * It does not attempt to delete LocalAuth files from disk.
 */
async function logoutWhatsApp() {
  try {
    if (client) {
      try { 
        await client.logout(); 
        console.log('👋 Logged out from WhatsApp');
      } catch (e) { 
        console.warn('⚠️ logout() error:', e?.message || e); 
      }
      try { 
        await client.destroy(); 
        console.log('🗑️ Client destroyed');
      } catch (e) { 
        console.warn('⚠️ destroy() error:', e?.message || e); 
      }
    }
  } finally {
    client = null;
    isReady = false;
    isInitializing = false;
    qrCode = null;
    qrGenerated = false;
    activeNumber = null;
    activePushName = null;
    activeSessionId = null;
    queueInitialized = false;
  }
  console.log('✅ WhatsApp logged out and client destroyed');
  return { success: true };
}

/**
 * Disconnect but keep LocalAuth files intact.
 * Use this when you want to stop the running instance without removing session files.
 */
async function disconnectWhatsApp() {
  try {
    if (client) {
      try { 
        await client.destroy(); 
        console.log('🔌 Client disconnected');
      } catch (e) { 
        console.warn('⚠️ destroy() error during disconnect:', e?.message || e); 
      }
    }
  } finally {
    client = null;
    isReady = false;
    isInitializing = false;
    qrCode = null;
    qrGenerated = false;
    queueInitialized = false;
    activeNumber = null;
    activePushName = null;
    activeSessionId = null;
  }
  console.log('🔌 WhatsApp client disconnected (LocalAuth preserved)');
  return { success: true };
}

/**
 * Pause / resume / stop campaign wrappers
 */
export async function pauseCampaignService(campaignId) {
  return await queuePauseCampaign(campaignId);
}
export async function resumeCampaignService(campaignId, authHeader = '') {
  await ensureClientReady();
  return await queueResumeCampaign(campaignId, authHeader);
}
export async function stopCampaignService(campaignId) {
  return await queueStopCampaign(campaignId);
}

/**
 * Force a session save by interacting with the page (best-effort).
 * Returns true if we believe the trigger succeeded.
 */
async function forceSessionSave() {
  if (!client || !isReady) {
    console.warn('⚠️ forceSessionSave: client not ready');
    return false;
  }
  try {
    const page = client.pupPage || (client?.browser?.pages ? (await client.browser.pages())[0] : null);
    if (!page) {
      console.warn('⚠️ forceSessionSave: page not found');
      return false;
    }
    await page.evaluate(() => {
      if (window.localStorage) {
        localStorage.setItem('__session_save_trigger', Date.now().toString());
        localStorage.removeItem('__session_save_trigger');
      }
      if (window.indexedDB && indexedDB.databases) {
        indexedDB.databases();
      }
    });
    await new Promise(r => setTimeout(r, 800));
    console.log('✅ forceSessionSave triggered');
    return true;
  } catch (err) {
    console.warn('⚠️ forceSessionSave failed:', err?.message || err);
    return false;
  }
}

/**
 * Validate session folder at WHATSAPP_DATA_PATH (very lightweight)
 */
async function validateSession(sessionPath) {
  try {
    if (!sessionPath) {
      return { valid: false, reason: 'no session path provided' };
    }
    const resolved = path.resolve(sessionPath);
    if (!fs.existsSync(resolved)) return { valid: false, reason: 'path does not exist' };
    const files = fs.readdirSync(resolved);
    if (files.length === 0) return { valid: false, reason: 'empty directory' };
    return { valid: true, path: resolved };
  } catch (err) {
    return { valid: false, reason: err?.message || String(err) };
  }
}

/**
 * Recover session by reinitializing client using existing LocalAuth files
 */
async function recoverSession() {
  try {
    await recoverClient();
    const ok = await waitForReady(30000);
    return { success: ok };
  } catch (err) {
    console.error('❌ recoverSession failed:', err?.message || err);
    return { success: false, reason: err?.message || String(err) };
  }
}

/**
 * Clear LocalAuth profile directories (if WHATSAPP_DATA_PATH is set) - best-effort.
 * WARNING: this will delete files on disk.
 */
async function clearLocalAuthProfile({ maxAttempts = 3 } = {}) {
  const dataPath = process.env.WHATSAPP_DATA_PATH;
  if (!dataPath) {
    return { success: false, message: 'WHATSAPP_DATA_PATH not set' };
  }
  const resolved = path.resolve(dataPath);
  try {
    if (client) {
      try { await client.destroy(); } catch (_) {}
      client = null;
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
        console.log('🧹 Cleared LocalAuth folder:', resolved);
        return { success: true, removed: true, path: resolved };
      } catch (err) {
        console.warn(`⚠️ Attempt ${attempt} to remove ${resolved} failed:`, err?.message || err);
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    return { success: false, removed: false, message: 'failed to remove after retries' };
  } catch (err) {
    return { success: false, message: err?.message || String(err) };
  }
}

/**
 * NEW: Check if session exists in database
 */
async function checkExistingSession() {
  try {
    const result = await getDb().query(
      `SELECT session_id, phone_number, push_name FROM whatsapp_sessions 
       WHERE is_active = true 
       ORDER BY last_seen DESC LIMIT 1`
    );
    
    if (result.rows.length > 0) {
      const session = result.rows[0];
      console.log('📋 Found existing session in DB:', session.session_id);
      return session;
    }
    return null;
  } catch (error) {
    console.warn('⚠️ Error checking existing session:', error?.message);
    return null;
  }
}

/**
 * Public getters
 */
function getClient() { return client; }
function getActiveSessionId() { return activeSessionId; }

export {
  initWhatsApp,
  getWhatsAppStatus,
  logoutWhatsApp,
  disconnectWhatsApp,
  recoverSession,
  validateSession,
  forceSessionSave,
  clearLocalAuthProfile,
  getClient,
  getActiveSessionId,
  sendLargeVideo,
  sendLargeVideo as compressAndSendVideo,
  // NEW: Export check function
  checkExistingSession
};
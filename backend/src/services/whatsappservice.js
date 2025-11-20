import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import { hotPool } from '../db.js';
import { sendLargeVideo } from './videoCompressor.js';
import { enqueueCampaign, pauseCampaign as queuePauseCampaign, resumeCampaign as queueResumeCampaign, stopCampaign as queueStopCampaign, initializeCampaignQueue, recoverCampaigns } from './campaignQueue.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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

function getDb() {
  return hotPool;
}

async function initWhatsApp(_retry = false) {
  if (client && (isReady || isInitializing)) return;
  if (isInitializing) return;

  isInitializing = true;

  try {
  
    if (client && !isReady && !isInitializing) {
      try { await client.destroy(); } catch (_) {}
      client = null;
    }

    const headless = process.env.HEADLESS === 'true';
    const dataPath = process.env.WHATSAPP_DATA_PATH;
    const authStrategy = dataPath ? new LocalAuth({ dataPath }) : new LocalAuth();
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
      '--no-first-run',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ];

    client = new Client({
      authStrategy,
      puppeteer: {
        headless,
        executablePath,
        args: baseArgs
      }
    });

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

    client.on('disconnected', async () => {
      console.log('❌ WhatsApp client disconnected');
      isReady = false;
      qrCode = null;
      activeNumber = null;
      activePushName = null;
      activeSessionId = null;
      isInitializing = false;
      queueInitialized = false;

      // Mark session as inactive
      if (activeSessionId) {
        await markSessionInactive(activeSessionId);
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
      try { await client.destroy(); } catch (_) {}
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
  if (client) {
    try { await client.logout(); } catch (_) {}
    try { await client.destroy(); } catch (_) {}
  }
  client = null;
  isReady = false;
  qrCode = null;
  isInitializing = false;
  activeNumber = null;
  activePushName = null;
  console.log('✅ WhatsApp logged out and destroyed');
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

export { initWhatsApp, getWhatsAppStatus, logoutWhatsApp, getClient, getActiveSessionId };
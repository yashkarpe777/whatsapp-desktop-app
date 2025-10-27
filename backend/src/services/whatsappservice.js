import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import { hotPool } from '../db.js';
import { getBalanceRemote, authorizeCoinsRemote } from './remoteCoins.js';
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

    client.on('ready', () => {
      console.log('✅ WhatsApp client is ready');
      isReady = true;
      qrCode = null;
      isInitializing = false;
      try {
        const info = client.info;

        const wid = info?.wid?._serialized || '';
        activeNumber = wid ? wid.replace('@c.us', '') : null;
        activePushName = info?.pushname || null;
      } catch (_) {
        activeNumber = null;
        activePushName = null;
      }
    });

    client.on('disconnected', () => {
      console.log('❌ WhatsApp client disconnected');
      isReady = false;
      qrCode = null;
      activeNumber = null;
      activePushName = null;
      isInitializing = false;
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
    name: activePushName
  };
}

export async function sendCampaign(campaignId, authHeader = '') {
  const db = getDb();
  try {
    const campaignRes = await db.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    if (campaignRes.rowCount === 0) {
      throw new Error(`Campaign ${campaignId} not found`);
    }
    const campaign = campaignRes.rows[0];
    
    const messageDelaySeconds = parseInt(campaign.message_delay_seconds) || 2;
    const delayMs = messageDelaySeconds * 1000;
    console.log(`[sendCampaign] Using exact message delay: ${messageDelaySeconds}s (no variation)`);

    // Get pending contacts only
    const contactsRes = await db.query(`
      SELECT DISTINCT c.phone, c.id as contact_id, c.name
      FROM contacts c
      JOIN campaign_logs cl ON c.id = cl.contact_id
      WHERE cl.campaign_id = $1 AND cl.status = 'pending'
    `, [campaignId]);
    const contacts = contactsRes.rows;

    console.log(`[sendCampaign] Pending contacts: ${contacts.length}`);

    if (contacts.length === 0) {
      await db.query('UPDATE campaigns SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2', ['completed', campaignId]);
      return { success: true, sent: 0, total: 0 };
    }

    let media = null;
    if (campaign.message || campaign.media_url) {
      console.log(`[sendCampaign] Preparing message. Media: ${campaign.media_url || 'none'}`);
    }

    const mediaField = campaign.media_url || campaign.video_path || null;
    if (mediaField) {
      try {
        const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
        let mediaPath = path.join(uploadsDir, mediaField);
        if (!fs.existsSync(mediaPath)) {
          throw new Error(`Media file not found at: ${mediaPath}`);
        }
        media = MessageMedia.fromFilePath(mediaPath);
      } catch (mediaError) {
        console.error('[sendCampaign] Error loading media:', mediaError);
        throw new Error(`Failed to load media: ${mediaError.message}`);
      }
    }
    
    let successCount = 0;
    const defaultCc = (process.env.DEFAULT_COUNTRY_CODE || '').replace(/\D/g,'');
    const normalize = (raw) => {
      let d = String(raw || '').replace(/\D/g, '');
      if (defaultCc && d.length === 10 && !d.startsWith(defaultCc)) {
        d = `${defaultCc}${d}`;
      }
      return d;
    };

    // Track messages sent in this batch for coin verification
    let messagesSentInBatch = 0;

    for (const contact of contacts) {
      const statusCheck = await db.query('SELECT status FROM campaigns WHERE id = $1', [campaignId]);
      const currentStatus = statusCheck.rows[0]?.status;
      
      if (currentStatus === 'paused' || currentStatus === 'stopped') {
        console.log(`🛑 Campaign ${campaignId} ${currentStatus}, stopping message loop`);
        break;
      }
      
      try {
        // Check coins before EACH message (1 coin = 1 message)
        if (authHeader) {
          try {
            // Check current coin balance from Render DB
            const balanceResult = await getBalanceRemote(authHeader);
            const currentCoins = parseInt(balanceResult?.coins ?? 0);
            
            console.log(`💰 Checking coins before message ${messagesSentInBatch + 1}: ${currentCoins} coins available`);
            
            if (currentCoins < 1) {
              const stopMessage = `⚠️ Campaign stopped: Insufficient coins. Sent ${messagesSentInBatch} messages successfully. Need 1 coin per message but only ${currentCoins} coins available. Call admin for more coins.`;
              console.warn(`⚠️ Insufficient coins during campaign ${campaignId}: have ${currentCoins}, need 1`);
              
              // Mark remaining as failed due to insufficient coins
              await db.query(
                `UPDATE campaign_logs SET status='failed', error_message='Insufficient coins - Campaign stopped' 
                 WHERE campaign_id=$1 AND status='pending'`,
                [campaignId]
              );
              
              // Stop campaign with detailed message
              await db.query(
                `UPDATE campaigns SET status='stopped', error_message=$1, completed_at=CURRENT_TIMESTAMP 
                 WHERE id=$2`,
                [stopMessage, campaignId]
              );
              
              console.log(`🛑 Campaign ${campaignId} stopped: ${stopMessage}`);
              break; // Exit the loop
            }
          } catch (coinError) {
            console.warn('⚠️ Error checking coins, continuing:', coinError.message);
          }
        } else {
          console.warn('⚠️ No auth header for coin check, skipping verification');
        }

        const phoneDigits = normalize(contact.phone);
        const chatId = `${phoneDigits}@c.us`;

        // Quick filter: skip empty after normalization
        if (!phoneDigits) {
          throw new Error('Empty/invalid phone');
        }

        // Optionally verify WhatsApp registration to avoid slow failures
        try {
          const registered = await client.isRegisteredUser(chatId);
          if (!registered) throw new Error('Not a WhatsApp user');
        } catch (chkErr) {
          throw new Error(chkErr?.message || 'Registration check failed');
        }

        const doSend = async () => {
          if (media) {
            await client.sendMessage(chatId, media, { caption: campaign.message || '' });
          } else if (campaign.message) {
            await client.sendMessage(chatId, campaign.message);
          } else {
            throw new Error('No message or media to send');
          }
        };

        try {
          await doSend();
        } catch (innerErr) {
          if (String(innerErr.message || '').includes('Session closed')) {
            const recovered = await recoverClient();
            if (recovered) {
              await doSend();
            } else {
              throw innerErr;
            }
          } else {
            throw innerErr;
          }
        }

        await db.query(
          'UPDATE campaign_logs SET status=$1, sent_at=CURRENT_TIMESTAMP WHERE campaign_id=$2 AND contact_id=$3',
          ['sent', campaignId, contact.contact_id]
        );
        
        // Deduct 1 coin after successful message send
        if (authHeader) {
          try {
            await authorizeCoinsRemote(1, authHeader);
            console.log(`💰 Deducted 1 coin for successful message to ${contact.phone}`);
          } catch (coinError) {
            console.warn('⚠️ Failed to deduct coin, but message was sent:', coinError.message);
          }
        }
        
        successCount++;
        messagesSentInBatch++; // Increment for coin check tracking
      } catch (err) {
        await db.query(
          'UPDATE campaign_logs SET status=$1, error_message=$2 WHERE campaign_id=$3 AND contact_id=$4',
          ['failed', err.message, campaignId, contact.contact_id]
        );
      }

      // Pacing with exact user-configured delay
      console.log(`⏱️ Waiting exactly ${messageDelaySeconds} seconds before next message`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Finalize status based on remaining pending
    const leftRes = await db.query('SELECT COUNT(*)::int AS pending FROM campaign_logs WHERE campaign_id=$1 AND status=\'pending\'', [campaignId]);
    const left = leftRes.rows[0]?.pending || 0;
    const finalStatus = left === 0 ? 'completed' : 'running';
await db.query("UPDATE campaigns SET status=$1::varchar, completed_at = CASE WHEN $1::varchar='completed' THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id=$2", [finalStatus, campaignId]);

    console.log(`[sendCampaign] Done for ${campaignId}: sent=${successCount}, left=${left}`);
    return { success: true, sent: successCount, total: contacts.length };
  } catch (error) {
    console.error('[sendCampaign] Fatal error:', error);
    // Mark campaign failed and pending logs as failed
    try {
      const db = getDb();
      await db.query("UPDATE campaigns SET status='failed', error_message=$1, completed_at=CURRENT_TIMESTAMP WHERE id=$2", [error.message, campaignId]);
      await db.query("UPDATE campaign_logs SET status='failed', error_message=$2 WHERE campaign_id=$1 AND status='pending'", [campaignId, error.message]);
    } catch {}
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

// Note: sendCampaign is already exported on line 178 with 'export async function'
export { initWhatsApp, getWhatsAppStatus, logoutWhatsApp };
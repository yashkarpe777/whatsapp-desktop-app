// import Queue from 'bull'; // Removed - using simple queue instead
import { EventEmitter } from 'events';
import { hotPool } from '../db.js';
import { syncCampaignCoinSpend } from './coinService.js';
import path from 'path';
import fs from 'fs';

let MessageMedia = null;

export function registerWhatsAppDependencies(deps = {}) {
  MessageMedia = deps.MessageMedia || null;
}

const MIN_DELAY_MS = Number(process.env.WHATSAPP_MIN_DELAY_MS || 2000);
const MAX_DELAY_MS = Number(process.env.WHATSAPP_MAX_DELAY_MS || 5000);

function getHumanDelay(delaySeconds = 0) {
  const baseMs = Math.max(Math.floor(delaySeconds * 1000), MIN_DELAY_MS);
  const upperBound = Math.max(baseMs + 750, MAX_DELAY_MS, MIN_DELAY_MS + 1000);
  const jitter = Math.floor(Math.random() * (upperBound - baseMs + 1));
  return baseMs + jitter;
}

function ensureMessageHelpers() {
  if (!MessageMedia) {
    throw new Error('WhatsApp media helpers not registered. Ensure initWhatsApp() has completed.');
  }
}

// Try to import video compressor, but make it optional
let sendLargeVideo = null;
try {
  const videoCompressor = await import('./videoCompressor.js');
  sendLargeVideo = videoCompressor.sendLargeVideo;
  console.log('✅ Video compression available');
} catch (err) {
  console.warn('⚠️ Video compression not available:', err.message);
}

// Simple in-memory queue (no Redis required)
class SimpleQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.processor = null;
    this.paused = false;
    this.concurrency = 1;
    this.activeCount = 0;
  }

  async add(data, options = {}) {
    const normalizedOptions = {
      attempts: Math.max(1, parseInt(options.attempts || 1, 10)),
      backoff: options.backoff || null,
      removeOnComplete: options.removeOnComplete ?? false,
      removeOnFail: options.removeOnFail ?? false,
    };

    const job = {
      id: Date.now() + Math.random(),
      data,
      opts: normalizedOptions,
      status: 'waiting',
      attemptsMade: 0,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _timeout: null,
      remove: async () => {
        this._removeJob(job.id);
      }
    };

    this.jobs.push(job);
    queueMicrotask(() => this._processNext());
    return job;
  }

  process(concurrency, processorFn) {
    this.concurrency = Math.max(1, parseInt(concurrency || 1, 10));
    this.processor = processorFn;
    queueMicrotask(() => this._processNext());
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    queueMicrotask(() => this._processNext());
  }

  async empty() {
    this.jobs = this.jobs.filter(job => job.status === 'active');
  }

  async clean(graceTimeMs = 0, status = 'completed') {
    const now = Date.now();
    this.jobs = this.jobs.filter(job => {
      if (job.status !== status) return true;
      return now - job.updatedAt < graceTimeMs;
    });
  }

  async getJobs(types = []) {
    const requested = Array.isArray(types) ? types : [types];
    return this.jobs.filter(job => requested.includes(job.status));
  }

  async getWaitingCount() {
    return this.jobs.filter(job => job.status === 'waiting').length;
  }

  async getActiveCount() {
    return this.jobs.filter(job => job.status === 'active').length;
  }

  async getCompletedCount() {
    return this.jobs.filter(job => job.status === 'completed').length;
  }

  async getFailedCount() {
    return this.jobs.filter(job => job.status === 'failed').length;
  }

  async getDelayedCount() {
    return this.jobs.filter(job => job.status === 'delayed').length;
  }

  _removeJob(jobId) {
    const idx = this.jobs.findIndex(job => job.id === jobId);
    if (idx >= 0) {
      const [job] = this.jobs.splice(idx, 1);
      if (job?._timeout) {
        clearTimeout(job._timeout);
      }
    }
  }

  _processNext() {
    if (this.paused || !this.processor) {
      return;
    }

    while (this.activeCount < this.concurrency) {
      const job = this.jobs.find(j => j.status === 'waiting');
      if (!job) {
        break;
      }
      this._runJob(job);
    }
  }

  _runJob(job) {
    job.status = 'active';
    job.attemptsMade += 1;
    job.updatedAt = Date.now();
    this.activeCount += 1;

    Promise.resolve()
      .then(() => this.processor(job))
      .then((result) => {
        job.updatedAt = Date.now();
        job.status = 'completed';
        this.emit('completed', job, result);
        if (job.opts.removeOnComplete) {
          this._removeJob(job.id);
        }
      })
      .catch((error) => {
        job.error = error;
        job.updatedAt = Date.now();

        if (job.attemptsMade < job.opts.attempts) {
          const delay = this._computeBackoff(job);
          job.status = delay > 0 ? 'delayed' : 'waiting';
          if (delay > 0) {
            job._timeout = setTimeout(() => {
              job._timeout = null;
              if (job.status === 'delayed') {
                job.status = 'waiting';
                job.updatedAt = Date.now();
                this._processNext();
              }
            }, delay);
          } else {
            queueMicrotask(() => this._processNext());
          }
        } else {
          job.status = 'failed';
          this.emit('failed', job, error);
          if (job.opts.removeOnFail) {
            this._removeJob(job.id);
          }
        }
      })
      .finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        queueMicrotask(() => this._processNext());
      });
  }

  _computeBackoff(job) {
    const { backoff } = job.opts;
    if (!backoff) return 0;

    const baseDelay = parseInt(backoff.delay || 0, 10);
    if (baseDelay <= 0) return 0;

    if (backoff.type === 'exponential') {
      return baseDelay * Math.pow(2, job.attemptsMade - 1);
    }

    return baseDelay;
  }
}

const messageQueue = new SimpleQueue();
console.log('✅ Campaign queue initialized (simple in-memory queue, no Redis required)');

// Store active campaign states in memory and DB
const activeCampaigns = new Map();

async function removeQueuedJobsForCampaign(campaignId) {
  const jobs = await messageQueue.getJobs(['waiting', 'delayed']);
  let removed = 0;
  for (const job of jobs) {
    if (job?.data?.campaignId === campaignId) {
      await job.remove();
      removed += 1;
    }
  }
  if (removed > 0) {
    console.log(`🧹 Removed ${removed} queued jobs for campaign ${campaignId}`);
  }
}

/**
 * Initialize campaign queue processor
 * @param {Object} whatsappClient - WhatsApp client instance
 */
export function initializeCampaignQueue(whatsappClient) {
  // Process messages one at a time to maintain order and delay
  messageQueue.process(1, async (job) => {
    const { campaignId, contactId, phone, message, mediaPath, authHeader, delaySeconds } = job.data;

    console.log(`📤 Processing message for campaign ${campaignId}, contact ${contactId}`);

    try {
      // Check if campaign is paused or stopped
      const campaignState = await getCampaignState(campaignId);
      if (campaignState.status === 'paused' || campaignState.status === 'stopped') {
        console.log(`⏸️ Campaign ${campaignId} is ${campaignState.status}, stopping queue`);
        // Mark job as skipped and stop processing
        return { skipped: true, reason: campaignState.status };
      }

      // Verify WhatsApp client is ready
      if (!whatsappClient || !whatsappClient.info) {
        throw new Error('WhatsApp client not ready');
      }

      // Skip connection state check - it causes crashes with large files
      // WhatsApp will auto-reconnect if needed during sendMessage

      // Get current session info
      const currentSession = whatsappClient.info.wid._serialized;

      // Verify session lock
      const sessionLock = await getSessionLock(campaignId);
      if (sessionLock && sessionLock !== currentSession) {
        throw new Error(`Session mismatch: Campaign locked to ${sessionLock}, but current session is ${currentSession}`);
      }

      // If no session lock exists, set it
      if (!sessionLock) {
        await setSessionLock(campaignId, currentSession);
      }

      // Normalize phone number
      const defaultCc = (process.env.DEFAULT_COUNTRY_CODE || '').replace(/\D/g, '');
      let phoneDigits = String(phone || '').replace(/\D/g, '');
      if (defaultCc && phoneDigits.length === 10 && !phoneDigits.startsWith(defaultCc)) {
        phoneDigits = `${defaultCc}${phoneDigits}`;
      }

      if (!phoneDigits) {
        throw new Error('Invalid phone number');
      }

      const chatId = `${phoneDigits}@c.us`;

      // Skip registration check - WhatsApp will handle invalid numbers automatically
      // Registration check causes "Session closed" errors when WhatsApp page is inactive

      // Coins are already authorized upfront in startCampaign
      // No need to check per message - just deduct after successful send

      // Load media if provided
      let media = null;
      let mediaFullPath = null;
      if (mediaPath) {
        try {
          ensureMessageHelpers();
          const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
          mediaFullPath = path.join(uploadsDir, mediaPath);
          
          if (fs.existsSync(mediaFullPath)) {
            // Check if this is a video file that needs compression
            const isVideo = /\.(mp4|avi|mov|wmv|flv|mkv|webm)$/i.test(mediaFullPath);

            if (isVideo) {
              const stats = fs.statSync(mediaFullPath);
              const fileSizeMB = stats.size / (1024 * 1024);
              const maxSizeMB = parseInt(process.env.WHATSAPP_MAX_VIDEO_SIZE_MB || '16');
              
              // For very large videos (>50MB), send caption separately to prevent crashes
              if (fileSizeMB > 50) {
                console.log(`📄 Sending very large video (${fileSizeMB.toFixed(2)}MB) - caption sent separately`);
                
                // Send caption first as text message
                if (message) {
                  await whatsappClient.sendMessage(chatId, message);
                  console.log('✅ Caption sent as text message');
                  // Small delay to ensure message order
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
                
                // Then send video as document (without caption to avoid duplicate)
                media = MessageMedia.fromFilePath(mediaFullPath);
                await whatsappClient.sendMessage(chatId, media, { 
                  sendMediaAsDocument: true 
                });
                console.log('✅ Video sent as document');
              } else if (sendLargeVideo && fileSizeMB > maxSizeMB) {
                // Use compression for medium videos (16-50MB)
                await sendLargeVideo(whatsappClient, chatId, mediaFullPath, message || '', maxSizeMB);
              } else {
                // Send small videos directly
                media = MessageMedia.fromFilePath(mediaFullPath);
                await whatsappClient.sendMessage(chatId, media, { caption: message || '' });
              }
            } else {
              // Send media directly (images, documents, PDFs, or videos if compression not available)
              media = MessageMedia.fromFilePath(mediaFullPath);
              await whatsappClient.sendMessage(chatId, media, { caption: message || '' });
              
              if (isVideo && !sendLargeVideo) {
                console.warn('⚠️ Video sent without compression (compression not available)');
              }
            }
          } else {
            throw new Error(`Media file not found: ${mediaPath}`);
          }
        } catch (mediaError) {
          console.warn('⚠️ Media processing failed:', mediaError.message);
          throw mediaError;
        }
      } else if (message) {
        // Send text message
        await whatsappClient.sendMessage(chatId, message);
      } else {
        throw new Error('No message or media to send');
      }

      // Update log as sent
      await hotPool.query(
        'UPDATE campaign_logs SET status=$1, sent_at=CURRENT_TIMESTAMP WHERE campaign_id=$2 AND contact_id=$3',
        ['sent', campaignId, contactId]
      );

      // Track coin usage (coins already authorized upfront)
      console.log(`💰 Message sent successfully (coin already deducted upfront)`);

      // Apply delay before next message
      await new Promise(resolve => setTimeout(resolve, getHumanDelay(delaySeconds)));

      return { success: true, phone, contactId };
    } catch (error) {
      console.error(`❌ Failed to send message to ${phone}:`, error.message);

      // Update log as failed with specific error
      await hotPool.query(
        'UPDATE campaign_logs SET status=$1, error_message=$2 WHERE campaign_id=$3 AND contact_id=$4',
        ['failed', error.message, campaignId, contactId]
      );

      throw error; // Let Bull handle retry logic
    }
  });

  // Handle completed jobs
  messageQueue.on('completed', async (job, result) => {
    console.log(`✅ Message sent successfully:`, result);

    // Check if campaign is complete
    const { campaignId } = job.data;
    await checkCampaignCompletion(campaignId);
  });

  // Handle failed jobs
  messageQueue.on('failed', async (job, err) => {
    console.error(`❌ Message failed:`, err.message);

    const { campaignId } = job.data;
    await checkCampaignCompletion(campaignId);
  });

  console.log('✅ Campaign queue processor initialized');
}

/**
 * Add campaign to queue
 */
export async function enqueueCampaign(campaignId, authHeader = '') {
  const db = hotPool;

  try {
    // Get campaign details
    const campaignRes = await db.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    if (campaignRes.rowCount === 0) {
      throw new Error(`Campaign ${campaignId} not found`);
    }
    const campaign = campaignRes.rows[0];

    const messageDelaySeconds = parseInt(campaign.message_delay_seconds) || 2;

    // Get pending contacts
    const contactsRes = await db.query(`
      SELECT DISTINCT c.phone, c.id as contact_id, c.name
      FROM contacts c
      JOIN campaign_logs cl ON c.id = cl.contact_id
      WHERE cl.campaign_id = $1 AND cl.status = 'pending'
      ORDER BY c.id ASC
    `, [campaignId]);

    const contacts = contactsRes.rows;
    console.log(`📋 Enqueueing ${contacts.length} messages for campaign ${campaignId}`);

    if (contacts.length === 0) {
      await db.query('UPDATE campaigns SET status = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2', ['completed', campaignId]);
      return { success: true, queued: 0 };
    }

    // Store campaign state
    activeCampaigns.set(campaignId, {
      status: 'running',
      totalContacts: contacts.length,
      authHeader
    });

    // Save campaign state to DB
    await saveCampaignState(campaignId, {
      status: 'running',
      totalContacts: contacts.length,
      pendingContacts: contacts.map(c => c.contact_id)
    });

    // Add each contact to queue
    for (const contact of contacts) {
      await messageQueue.add({
        campaignId,
        contactId: contact.contact_id,
        phone: contact.phone,
        message: campaign.message,
        mediaPath: campaign.media_url || campaign.video_path || null,
        authHeader,
        delaySeconds: messageDelaySeconds
      }, {
        attempts: 3, // Retry up to 3 times
        backoff: {
          type: 'exponential',
          delay: 5000 // Start with 5 second delay
        },
        removeOnComplete: true,
        removeOnFail: false
      });
    }

    return { success: true, queued: contacts.length };
  } catch (error) {
    console.error('[enqueueCampaign] Error:', error);
    throw error;
  }
}

/**
 * Pause campaign
 */
export async function pauseCampaign(campaignId) {
  console.log(`⏸️ Pausing campaign ${campaignId}`);

  // Update campaign status in DB
  await hotPool.query(
    "UPDATE campaigns SET status = 'paused' WHERE id = $1",
    [campaignId]
  );

  // Update in-memory state
  const state = activeCampaigns.get(campaignId);
  if (state) {
    activeCampaigns.set(campaignId, { ...state, status: 'paused' });
  }

  // Save state to DB
  await saveCampaignState(campaignId, { status: 'paused' });

  // Remove any queued jobs so they can be re-enqueued on resume
  await removeQueuedJobsForCampaign(campaignId);

  // Note: Jobs remain in queue but will be skipped when processed
  return { success: true, message: 'Campaign paused' };
}

/**
 * Resume campaign
 */
export async function resumeCampaign(campaignId, authHeader = '') {
  console.log(`▶️ Resuming campaign ${campaignId}`);

  // Update campaign status in DB
  await hotPool.query(
    "UPDATE campaigns SET status = 'running' WHERE id = $1",
    [campaignId]
  );

  // Update in-memory state
  const state = activeCampaigns.get(campaignId);
  const effectiveAuthHeader = authHeader || state?.authHeader || '';
  if (state) {
    activeCampaigns.set(campaignId, { ...state, status: 'running', authHeader: effectiveAuthHeader });
  }

  // Save state to DB
  await saveCampaignState(campaignId, { status: 'running' });

  const pendingCountRes = await hotPool.query(
    "SELECT COUNT(*) AS count FROM campaign_logs WHERE campaign_id = $1 AND status = 'pending'",
    [campaignId]
  );
  const pendingCount = parseInt(pendingCountRes.rows?.[0]?.count || '0', 10);

  if (pendingCount === 0) {
    console.log(`ℹ️ No pending contacts for campaign ${campaignId}; nothing to resume.`);
    return { success: true, message: 'No pending contacts to resume' };
  }

  // Re-enqueue pending contacts
  await enqueueCampaign(campaignId, effectiveAuthHeader);

  return { success: true, message: `Campaign resumed with ${pendingCount} pending contacts` };
}

/**
 * Stop campaign
 */
export async function stopCampaign(campaignId) {
  console.log(`🛑 Stopping campaign ${campaignId}`);

  // Update campaign status in DB
  await hotPool.query(
    "UPDATE campaigns SET status = 'stopped', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
    [campaignId]
  );

  // Remove from active campaigns
  activeCampaigns.delete(campaignId);

  // Clear queue jobs for this campaign
  const jobs = await messageQueue.getJobs(['waiting', 'delayed', 'active']);
  for (const job of jobs) {
    if (job.data.campaignId === campaignId) {
      await job.remove();
    }
  }

  // Mark remaining pending logs as failed
  await hotPool.query(
    "UPDATE campaign_logs SET status='failed', error_message='Campaign stopped by user' WHERE campaign_id=$1 AND status='pending'",
    [campaignId]
  );

  try {
    await syncCampaignCoinSpend(campaignId);
  } catch (coinErr) {
    console.warn('⚠️ Coin reconciliation failed after stop:', coinErr.message);
  }

  return { success: true, message: 'Campaign stopped' };
}

/**
 * Get campaign state from DB
 */
async function getCampaignState(campaignId) {
  const result = await hotPool.query(
    'SELECT status FROM campaigns WHERE id = $1',
    [campaignId]
  );

  if (result.rowCount === 0) {
    return { status: 'not_found' };
  }

  return { status: result.rows[0].status };
}

/**
 * Save campaign state to DB for crash recovery
 */
async function saveCampaignState(campaignId, state) {
  try {
    await hotPool.query(
      `INSERT INTO campaign_state (campaign_id, state, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (campaign_id)
       DO UPDATE SET state = $2, updated_at = CURRENT_TIMESTAMP`,
      [campaignId, JSON.stringify(state)]
    );
  } catch (error) {
    // Table might not exist yet, will be created by migration
    console.warn('⚠️ Could not save campaign state:', error.message);
  }
}

/**
 * Get session lock for campaign
 */
async function getSessionLock(campaignId) {
  try {
    const result = await hotPool.query(
      'SELECT whatsapp_session_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    return result.rows[0]?.whatsapp_session_id || null;
  } catch (error) {
    return null;
  }
}

/**
 * Set session lock for campaign
 */
async function setSessionLock(campaignId, sessionId) {
  try {
    await hotPool.query(
      'UPDATE campaigns SET whatsapp_session_id = $1 WHERE id = $2',
      [sessionId, campaignId]
    );
    console.log(`🔒 Locked campaign ${campaignId} to session ${sessionId}`);
  } catch (error) {
    console.warn('⚠️ Could not set session lock:', error.message);
  }
}

/**
 * Check if campaign is complete
 */
async function checkCampaignCompletion(campaignId) {
  try {
    const result = await hotPool.query(
      `SELECT COUNT(*) as pending FROM campaign_logs WHERE campaign_id = $1 AND status = 'pending'`,
      [campaignId]
    );

    const pending = parseInt(result.rows[0]?.pending || 0);

    if (pending === 0) {
      console.log(`✅ Campaign ${campaignId} completed`);
      await hotPool.query(
        "UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
        [campaignId]
      );
      activeCampaigns.delete(campaignId);
      try {
        await syncCampaignCoinSpend(campaignId);
      } catch (coinErr) {
        console.warn('⚠️ Coin reconciliation failed after completion:', coinErr.message);
      }
    }
  } catch (error) {
    console.error('Error checking campaign completion:', error);
  }
}

/**
 * Recover campaigns after crash
 */
export async function recoverCampaigns() {
  if ((process.env.SERVICE_MODE || '').toLowerCase() === 'coins-only') {
    console.log('⏭️  Coins-only mode – campaign recovery skipped');
    return { success: true, recovered: 0 };
  }

  console.log('🔄 Recovering campaigns after restart...');

  try {
    // Check if database is available first
    try {
      await hotPool.query('SELECT 1');
      console.log('✅ Database connection available for campaign recovery');
    } catch (dbError) {
      console.warn('⚠️ Database not available for campaign recovery:', dbError.message);
      return { success: false, error: 'Database not available', recovered: 0 };
    }

    // Find campaigns that were running when app crashed
    const result = await hotPool.query(`
      SELECT id FROM campaigns
      WHERE status = 'running'
        AND EXISTS (SELECT 1 FROM campaign_logs WHERE campaign_id = campaigns.id AND status = 'pending')
      ORDER BY id ASC
    `);

    console.log(`📋 Found ${result.rowCount} campaigns to recover`);

    for (const row of result.rows) {
      const campaignId = row.id;
      console.log(`🔄 Recovering campaign ${campaignId}...`);

      // Re-enqueue pending messages (without auth header for auto-recovery)
      await enqueueCampaign(campaignId, '').catch(err => {
        console.error(`❌ Failed to recover campaign ${campaignId}:`, err.message);
      });
    }

    return { success: true, recovered: result.rowCount };
  } catch (error) {
    console.error('❌ Campaign recovery failed:', error);
    return { success: false, error: error.message };
  }
}


export async function getQueueStats() {
  const waiting = await messageQueue.getWaitingCount();
  const active = await messageQueue.getActiveCount();
  const completed = await messageQueue.getCompletedCount();
  const failed = await messageQueue.getFailedCount();
  const delayed = await messageQueue.getDelayedCount();

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + delayed
  };
}

/**
 * Clean up old completed jobs
 */
export async function cleanupQueue() {
  await messageQueue.clean(24 * 60 * 60 * 1000, 'completed'); // Remove completed jobs older than 24 hours
  await messageQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed'); // Remove failed jobs older than 7 days
  console.log('✅ Queue cleanup completed');
}

export { messageQueue };

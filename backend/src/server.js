import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireLocalDB, checkLocalDB } from '../middleware/dbHealthCheck.js';

// Import routes
import authRoutes from '../routes/authRoutes.js';
import campaignRoutes from '../routes/campaignRoutes.js';
import contactsRoutes from '../routes/contactsRoutes.js';
import whatsappRoutes from '../routes/whatsappRoutes.js';
import adminRoutes from '../routes/adminRoutes.js';
import dashboardRoutes from '../routes/dashboardroutes.js';
import settingsRoutes from '../routes/settingsRoutes.js';
import coinsRoutes from '../routes/coinsRoutes.js';

// Resume engine
import pool, { hostPool, localPool, rebuildPool, isLocalPoolConnected, getLocalPool } from './db.js';
import { sendCampaign, initWhatsApp } from './services/whatsappservice.js';
import { recoverCampaigns, cleanupQueue } from './services/campaignQueue.js';
import { runCleanup } from './services/cleanupService.js';

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from backend/.env regardless of CWD (fallback to process CWD .env)
try {
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch {
  dotenv.config();
}

// Lazy WhatsApp initialization: only trigger on demand via routes or campaign start

const app = express();
const PORT = process.env.PORT || 3000;  

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


const SERVICE_MODE = process.env.SERVICE_MODE || 'all';

if (SERVICE_MODE !== 'coins-only') {
  // Serve static files for media when running full service
  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadsDir));

  // Full feature routes with database health checks
  app.use('/api/auth', authRoutes);
  app.use('/api/campaigns', requireLocalDB, campaignRoutes);
  app.use('/api/contacts', requireLocalDB, contactsRoutes);
  app.use('/api/whatsapp', requireLocalDB, whatsappRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/dashboard', requireLocalDB, dashboardRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/coins', coinsRoutes);
} else {
  // Coins-only mode for Render: restrict surface area
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/coins', coinsRoutes);
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'ok',
      message: 'Server is running',
      service_mode: SERVICE_MODE,
      databases: {
        host: false,
        local: false
      },
      errors: []
    };

    // Check Host database
    if (hostPool) {
      try {
        await hostPool.query('SELECT 1');
        health.databases.host = true;
      } catch (error) {
        health.errors.push(`Host DB: ${error.message}`);
      }
    }

    // Check Local database
    const currentLocalPool = getLocalPool();
    if (currentLocalPool) {
      try {
        const isConnected = await isLocalPoolConnected();
        health.databases.local = isConnected;
        if (!isConnected) {
          health.errors.push('Local DB: Connection failed');
        }
      } catch (error) {
        health.errors.push(`Local DB: ${error.message}`);
      }
    } else {
      health.errors.push('Local DB: Not configured');
    }

    // Determine overall status
    if (SERVICE_MODE === 'coins-only') {
      health.status = health.databases.host ? 'ok' : 'degraded';
    } else {
      health.status = health.databases.local ? 'ok' : 'degraded';
    }

    res.json(health);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(200).json({
      status: 'error',
      message: 'Health check failed',
      service_mode: SERVICE_MODE,
      databases: {
        host: false,
        local: false
      },
      errors: [error.message]
    });
  }
});

// Dev-only debug info (do not enable in production)
if ((process.env.DEBUG_API || '').toLowerCase() === 'true' || (process.env.NODE_ENV || '').startsWith('dev')) {
  app.get('/api/debug/info', async (req, res) => {
    try {
      let dbOk = false;
      try { await (await import('./db.js')).default.query('SELECT 1'); dbOk = true; } catch {}
      const svc = process.env.SERVICE_MODE || 'all';
      const jwtSet = Boolean(process.env.JWT_SECRET);
      const jwtAlt = Boolean(process.env.JWT_SECRET_ALT);
      res.json({ ok: true, service_mode: svc, db_ok: dbOk, jwt_set: jwtSet, jwt_alt_set: jwtAlt });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}

// Do not initialize WhatsApp on server start. Initialization is triggered lazily
// from routes (e.g., /api/whatsapp/qr) or when starting a campaign.

// Start server
app.listen(PORT, () => {
  const svc = process.env.SERVICE_MODE || 'all';
  const emailSet = Boolean(process.env.EMAIL_USER) && Boolean(process.env.EMAIL_PASS);
  const dbUrl = process.env.DATABASE_URL || '';
  let dbHost = 'unknown';
  try {
    const normalized = dbUrl.replace(/^postgres(ql)?:\/\//, 'http://');
    const u = new URL(normalized);
    dbHost = u.hostname || 'unknown';
  } catch {}
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🧩 Service mode: ${svc}`);
  console.log(`🗄️  DB host: ${dbHost}`);
  console.log(`✉️  Email configured: ${emailSet}`);
  if (svc !== 'coins-only') {
    const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
    console.log(`📁 Static files served from: ${uploadsDir}`);
  }

  // Campaign recovery: resume any running campaigns after restart
  setTimeout(async () => {
    console.log('🔄 Starting campaign recovery...');
    try {
      // Don't initialize WhatsApp on startup - only when user explicitly connects
      // This prevents browser opening automatically
      
      // Just recover campaign state without WhatsApp connection
      await recoverCampaigns();
    } catch (error) {
      console.error('❌ Campaign recovery failed:', error.message);
    }
  }, 5000);

  // Run cleanup on startup and then daily
  setTimeout(runCleanup, 10000);

  // Clean up queue periodically
  setInterval(cleanupQueue, 24 * 60 * 60 * 1000); // Daily
});

// Lightweight crash-resume engine using Postgres advisory locks
const inflight = new Set();

async function tryWithPgLock(campaignId, fn) {
  const lockKey = Number(campaignId);
  const lockRes = await pool.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
  const locked = lockRes.rows?.[0]?.locked === true;
  if (!locked) return false;
  try {
    await fn();
  } finally {
    try { await pool.query('SELECT pg_advisory_unlock($1)', [lockKey]); } catch {}
  }
  return true;
}

async function resumeInProgressCampaigns() {
  // This is now handled by the queue system's recoverCampaigns()
  // Keeping this function for backward compatibility
  try {
    await recoverCampaigns();
  } catch (e) {
    console.warn('⚠️ Campaign recovery sweep failed:', e.message);
  }
}

// Periodic resume sweep (as backup to queue system)
setInterval(resumeInProgressCampaigns, 5 * 60 * 1000); // Every 5 minutes

// Daily cleanup at 2 AM
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 2 && now.getMinutes() === 0) {
    runCleanup().catch(console.error);
  }
}, 60 * 1000); // Check every minute

export default app;
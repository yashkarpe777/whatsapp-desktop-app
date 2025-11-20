import dotenv from "dotenv";
import pkg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { databaseConfig } from "./databaseConfig.js";

try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  dotenv.config({ path: path.join(__dirname, "..", ".env"), override: true });
} catch (e) {
  dotenv.config({ override: true });
}

const disableLocalDb = String(process.env.DISABLE_LOCAL_DB || "").toLowerCase() === "true";

const { Pool } = pkg;

function buildHostPool() {
  const useSsl = process.env.DB_SSL === "true";
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.warn("⚠️ No DATABASE_URL for host pool");
    return null;
  }

  console.log('🔄 Building host pool with URL:', connectionString.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));

  const config = {
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    keepAlive: true,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 5000),
  };

  console.log('✅ Host pool config:', { 
    ssl: config.ssl, 
    keepAlive: config.keepAlive,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis
  });

  return new Pool(config);
}

function buildLocalPool() {
  if (disableLocalDb) {
    console.log("🔒 Local database usage disabled by DISABLE_LOCAL_DB flag");
    return null;
  }
  const useSsl = process.env.LOCAL_DB_SSL === "true" ? { rejectUnauthorized: false } : false;
  delete process.env.PGHOST;
  delete process.env.PGPORT;
  delete process.env.PGUSER;
  delete process.env.PGPASSWORD;
  delete process.env.PGDATABASE;
  const localOverride = databaseConfig.getConfig();

  const urlRaw = (localOverride?.connectionString) || "";
  const preferDiscrete = Boolean(localOverride?.host);

  const commonPool = {
    keepAlive: true,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
  };

  if (urlRaw && !preferDiscrete) {
    try {
      const normalized = urlRaw.replace(/^postgres(ql)?:\/\//, 'postgres://');
      const u = new URL(normalized);
      const cfg = {
        host: u.hostname,
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username || ''),
        password: String(decodeURIComponent(u.password || '')),
        database: decodeURIComponent(u.pathname.replace(/^\//, '')),
        ssl: localOverride?.ssl === true ? { rejectUnauthorized: false } : false, // Local DB typically doesn't need SSL
        ...commonPool,
      };
      return new Pool(cfg);
    } catch (e) {
      console.error('✗ Failed to parse local DATABASE_URL:', e?.message || e);
      return new Pool({ connectionString: urlRaw, ssl: useSsl, ...commonPool });
    }
  }
  if (!localOverride || (!urlRaw && !localOverride.host)) {
    if ((process.env.DEBUG_API || '').toLowerCase() === 'true') {
      console.warn('No local database configuration provided; skipping local database pool');
    }
    return null;
  }
  const cfg = {
    host: localOverride?.host || 'localhost',
    port: Number(localOverride?.port || 5432),
    user: localOverride?.user || undefined,
    database: localOverride?.database || undefined,
    ssl: localOverride?.ssl === true ? { rejectUnauthorized: false } : false, // Local DB typically doesn't need SSL
    ...commonPool,
  };
  if (localOverride?.password !== undefined && localOverride?.password !== null && String(localOverride.password).length > 0) {
    cfg.password = String(localOverride.password);
  }
  if (!urlRaw) {
    if (!cfg.host || !cfg.user || !cfg.database) {
      console.warn('Incomplete local database configuration (need host, user, database). Skipping local database pool');
      return null;
    }
  }
  if ((process.env.DEBUG_API || '').toLowerCase() === 'true') {
    try {
      const safe = { ...cfg, password: cfg.password ? `len:${String(cfg.password).length}` : undefined, ssl: !!cfg.ssl };
      console.log('Local DB config ->', safe);
    } catch {}
  }
  return new Pool(cfg);
}

let hostPool = buildHostPool();
let localPool = buildLocalPool();
export function getActivePool() {
  return getLocalPool() || hostPool || null;
}
export const hotPool = {
  async query(...args) {
    const p = getActivePool();
    if (!p) throw new Error('No active database pool');
    return p.query(...args);
  }
};
export const rebuildPool = async () => {
  if (disableLocalDb) {
    console.warn("⚠️  Attempted to rebuild local DB pool while DISABLE_LOCAL_DB is true");
    throw new Error("Local database is disabled");
  }
  console.log('🔄 Rebuilding local database connection...');
  if (localPool) {
    try {
      await localPool.end();
      console.log('✅ Closed existing local pool');
    } catch (error) {
      console.warn('⚠️ Error closing existing pool:', error.message);
     }
  }
  localPool = buildLocalPool();
  
  if (!localPool) {
    console.error('❌ Failed to build local pool - no configuration found');
    throw new Error('No local database configuration found');
  }
  console.log('🔄 Initializing new local database connection...');
  const success = await initializeLocalDatabase(localPool);
  if (!success) {
    console.error('❌ Failed to initialize local database connection');
    throw new Error('Failed to initialize new local database connection');
  }

  console.log('✅ Local database connection rebuilt successfully');
  return localPool;
};
export const getLocalPool = () => localPool;
export const isLocalPoolConnected = async () => {
  if (!localPool) {
    return false;
  }
  
  try {
    await localPool.query('SELECT 1');
    return true;
  } catch (error) {
    console.warn('Local pool connection check failed:', error.message);
    return false;
  }
};
async function ensureHostSchema(poolInstance) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE,
      email VARCHAR(255) UNIQUE,
      phone VARCHAR(20),
      password_hash VARCHAR(255),
      role VARCHAR(20) DEFAULT 'user',
      coins INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`,
    `CREATE TABLE IF NOT EXISTS coin_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      type VARCHAR(50) NOT NULL,
      campaign_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      otp VARCHAR(10) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
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

  const client = await poolInstance.connect();
  try {
    for (const stmt of ddl) {
      await client.query(stmt);
    }
  } finally {
    client.release();
  }
}
async function ensureLocalSchema(poolInstance) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE,
      email VARCHAR(255) UNIQUE,
      phone VARCHAR(20),
      password_hash VARCHAR(255),
      role VARCHAR(20) DEFAULT 'user',
      coins INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`,
    `CREATE TABLE IF NOT EXISTS contact_groups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      total_contacts INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      group_id INTEGER REFERENCES contact_groups(id) ON DELETE CASCADE,
      name VARCHAR(255),
      phone VARCHAR(20) NOT NULL,
      email VARCHAR(255),
      additional_data JSONB,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_group_id ON contacts(group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)`,
    `CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      media_url VARCHAR(500),
      contact_group_id INTEGER REFERENCES contact_groups(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      message_delay_seconds INTEGER DEFAULT 2,
      coins_spent INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      started_at TIMESTAMP,
      completed_at TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS error_message TEXT`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS message_delay_seconds INTEGER DEFAULT 2`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS coins_spent INTEGER DEFAULT 0`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS started_at TIMESTAMP`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`,
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS whatsapp_session_id VARCHAR(255)`,
    `CREATE TABLE IF NOT EXISTS campaign_logs (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      phone VARCHAR(20) NOT NULL DEFAULT '',
      message TEXT,
      media_url VARCHAR(500),
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE campaign_logs ADD COLUMN IF NOT EXISTS phone VARCHAR(20) DEFAULT ''`,
    `ALTER TABLE campaign_logs ADD COLUMN IF NOT EXISTS message TEXT`,
    `ALTER TABLE campaign_logs ADD COLUMN IF NOT EXISTS media_url VARCHAR(500)`,
    `ALTER TABLE campaign_logs ADD COLUMN IF NOT EXISTS error_message TEXT`,
    `ALTER TABLE campaign_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP`,
    `CREATE INDEX IF NOT EXISTS idx_campaign_logs_campaign_id ON campaign_logs(campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_campaign_logs_status ON campaign_logs(status)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_logs_unique ON campaign_logs(campaign_id, contact_id)`,
    `CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      key VARCHAR(100) UNIQUE NOT NULL,
      value TEXT,
      description TEXT,
      updated_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS uploads (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      group_id INTEGER REFERENCES contact_groups(id) ON DELETE CASCADE,
      originalname VARCHAR(255),
      stored_filename VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON uploads(user_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_uploads_stored_filename ON uploads(stored_filename)`,
    `CREATE TABLE IF NOT EXISTS campaign_state (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER UNIQUE NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      state JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_campaign_state_campaign_id ON campaign_state(campaign_id)`,
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
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_active ON whatsapp_sessions(is_active)`,
    `CREATE TABLE IF NOT EXISTS cleanup_logs (
      id SERIAL PRIMARY KEY,
      operation VARCHAR(50) NOT NULL,
      table_name VARCHAR(50) NOT NULL,
      records_deleted INTEGER DEFAULT 0,
      cleanup_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      details TEXT
    )`
  ];

  const client = await poolInstance.connect();
  try {
    for (const stmt of ddl) {
      await client.query(stmt);
    }
  } finally {
    client.release();
  }
}
async function initializeHostDatabase(poolInstance) {
  if (!poolInstance) return true;
  try {
    await poolInstance.query('SELECT NOW()');
    console.log('✅ Host database connected successfully');
    await ensureHostSchema(poolInstance);
    console.log('🗃️  Host database schema ensured');
    return true;
  } catch (error) {
    console.error('❌ Host database connection/schema failed:', error.message);
    return false;
  }
}
async function removeForeignKeyConstraints(poolInstance) {
  if (!poolInstance) return;
  
  const constraints = [
    { table: 'contact_groups', constraint: 'contact_groups_user_id_fkey' },
    { table: 'contacts', constraint: 'contacts_user_id_fkey' },
    { table: 'campaigns', constraint: 'campaigns_user_id_fkey' },
    { table: 'uploads', constraint: 'uploads_user_id_fkey' },
    { table: 'settings', constraint: 'settings_updated_by_fkey' }
  ];
  
  const client = await poolInstance.connect();
  try {
    for (const { table, constraint } of constraints) {
      try {
        await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
        console.log(`✅ Dropped FK constraint: ${constraint}`);
      } catch (err) {
        console.log(`ℹ️  FK constraint ${constraint} does not exist or already dropped`);
      }
    }
  } finally {
    client.release();
  }
}
async function initializeLocalDatabase(poolInstance) {
  if (!poolInstance) return true;
  try {
    await poolInstance.query('SELECT NOW()');
    console.log('✅ Local database connected successfully');
    await removeForeignKeyConstraints(poolInstance);
    await ensureLocalSchema(poolInstance);
    console.log('🗃️  Local database schema ensured');
    return true;
  } catch (error) {
    console.error('❌ Local database connection/schema failed:', error.message);
    if (error.code === '3D000') {
      console.error('   → Database does not exist. Please create it first in PgAdmin.');
      console.error('   → Create a database named "whatsapp_blast" in PgAdmin and try again.');
    } else if (error.code === '28P01') {
      console.error('   → Authentication failed. Please check username/password.');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('   → PostgreSQL server is not running or not accessible.');
      console.error('   → Please start PostgreSQL service and try again.');
    }
    return false;
  }
}

if (hostPool) {
  hostPool.on("connect", () => {
    console.log('🔗 Host database connection established');
  });
  hostPool.on("error", (err) => {
    console.error('❌ Host database pool error:', err.message);
  });
}

if (localPool) {
  localPool.on("connect", () => {
    console.log('🔗 Local database connection established');
  });
  localPool.on("error", (err) => {
    console.error('❌ Local database pool error:', err.message);
  });
}

// Initialize on startup
initializeHostDatabase(hostPool).catch(() => {
  console.warn('⚠️  Host database initialization failed - will retry when accessed');
});

// Initialize local database with retry mechanism
if (!disableLocalDb) {
  const initializeLocalWithRetry = async (retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        await initializeLocalDatabase(localPool);
        console.log('✅ Local database initialized successfully');
        return true;
      } catch (error) {
        console.warn(`⚠️  Local database initialization attempt ${i + 1} failed:`, error.message);
        if (i === retries - 1) {
          console.error('❌ All local database initialization attempts failed');
          return false;
        }
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    return false;
  };

  initializeLocalWithRetry();
} else {
  console.log('⏭️  Skipping local database initialization (disabled)');
}

export const testConnection = async () => {
  try {
    if (hostPool) await hostPool.query('SELECT NOW()');
    if (localPool) await localPool.query('SELECT NOW()');
    console.log('✅ Database connections successful');
  } catch (err) {
    console.error('✗ Database connection failed:', err);
    process.exit(1);
  }
};

export const isLocalDbDisabled = () => disableLocalDb;

export { hostPool, localPool };
export default hostPool;

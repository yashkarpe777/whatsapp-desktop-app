import defaultPool, { rebuildPool, isLocalPoolConnected, getLocalPool, hostPool } from "../src/db.js";
import { databaseConfig } from "../src/databaseConfig.js";
import fs from 'fs';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;

export const getSettings = async (req, res) => {
  try {
    const pool = getLocalPool() || hostPool || defaultPool;
    const keys = ['whatsapp_number', 'profile_name', 'email', 'app_icon'];
    let result;
    try {
      result = await pool.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [keys]);
    } catch (e) {
      // Create settings table on first run if missing
      if (String(e.code) === '42P01') {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS settings (
            id SERIAL PRIMARY KEY,
            key VARCHAR(100) UNIQUE NOT NULL,
            value TEXT,
            description TEXT,
            updated_by INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )`);
        result = await pool.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [keys]);
      } else {
        throw e;
      }
    }

    const map = Object.fromEntries(result.rows.map(r => [r.key, r.value]));
    res.json({
      whatsapp_number: map.whatsapp_number || '',
      profile_name: map.profile_name || '',
      email: map.email || '',
      app_icon: map.app_icon || ''
    });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(200).json({ whatsapp_number: '', profile_name: '', email: '', app_icon: '' });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const pool = getLocalPool() || hostPool || defaultPool;
    const userId = req.user.id;
    const { whatsapp_number, profile_name, email } = req.body;

    let appIconUrl = null;
    if (req.file) {
      appIconUrl = `/uploads/${req.file.filename}`;
    }

    const upserts = [
      whatsapp_number !== undefined ? ['whatsapp_number', whatsapp_number] : null,
      profile_name !== undefined ? ['profile_name', profile_name] : null,
      email !== undefined ? ['email', email] : null,
      appIconUrl ? ['app_icon', appIconUrl] : null,
    ].filter(Boolean);

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT,
        description TEXT,
        updated_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    for (const [key, value] of upserts) {
      await pool.query(
        `INSERT INTO settings (key, value, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [key, value, userId]
      );
    }

    res.json({ success: true, message: 'Settings updated', app_icon: appIconUrl });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ success: false, message: 'Failed to update settings' });
  }
};

// --- Local DB config management ---
function getLocalDbConfigPath() {
  const base = process.env.CONFIG_DIR || process.cwd();
  try { fs.mkdirSync(base, { recursive: true }); } catch {}
  return path.join(base, 'local_db.json');
}

export const testDbConfig = async (req, res) => {
  try {
    const { host, port, user, password, database, connectionString, ssl } = req.body || {};
    // For local DB, default to no SSL unless explicitly requested
    const useSsl = ssl === true ? { rejectUnauthorized: false } : false;
    let testPool;
    if (connectionString) {
      testPool = new Pool({ connectionString, ssl: useSsl, max: 1, connectionTimeoutMillis: 5000 });
    } else {
      if (!host || !user || !database) {
        return res.status(400).json({ ok: false, message: 'host, user, database are required (or provide connectionString)' });
      }
      testPool = new Pool({ host, port: Number(port || 5432), user, password, database, ssl: useSsl, max: 1, connectionTimeoutMillis: 5000 });
    }
    try {
      await testPool.query('SELECT 1 as ok');
      await testPool.end();
      return res.json({ ok: true, message: 'Connection successful' });
    } catch (e) {
      try { await testPool.end(); } catch {}
      return res.status(400).json({ ok: false, message: e?.message || String(e) });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || 'Unexpected error' });
  }
};

export const saveDbConfig = async (req, res) => {
  try {
    const cfg = req.body || {};
    
    // Save configuration using the new database config manager
    const saved = databaseConfig.saveConfig(cfg);
    if (!saved) {
      return res.status(500).json({ ok: false, message: 'Failed to save database configuration' });
    }
    
    // Immediately rebuild the database connection with new settings
    try {
      await rebuildPool();
      console.log('✅ Database connection updated with new settings');
      return res.json({ ok: true, message: 'Database configuration updated successfully!' });
    } catch (rebuildError) {
      console.error('❌ Failed to apply new database settings:', rebuildError);
      return res.json({ ok: true, message: 'Settings saved but failed to reconnect. Please restart the app.' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to save config' });
  }
};

// Test database configuration (for setup modal)
export const testDbConfigSetup = async (req, res) => {
  try {
    const { host, port, user, password, database, connectionString, ssl } = req.body || {};
    // For local DB, default to no SSL unless explicitly requested
    const useSsl = ssl === true ? { rejectUnauthorized: false } : false;
    let testPool;
    if (connectionString) {
      testPool = new Pool({ connectionString, ssl: useSsl, max: 1, connectionTimeoutMillis: 5000 });
    } else {
      if (!host || !user || !database) {
        return res.status(400).json({ ok: false, message: 'host, user, database are required (or provide connectionString)' });
      }
      testPool = new Pool({ host, port: Number(port || 5432), user, password, database, ssl: useSsl, max: 1, connectionTimeoutMillis: 5000 });
    }
    try {
      await testPool.query('SELECT 1 as ok');
      await testPool.end();
      return res.json({ ok: true, message: 'Connection successful' });
    } catch (e) {
      try { await testPool.end(); } catch {}
      return res.status(400).json({ ok: false, message: e?.message || String(e) });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || 'Unexpected error' });
  }
};

// Save database configuration (for setup modal)
export const saveDbConfigSetup = async (req, res) => {
  try {
    const cfg = req.body || {};
    
    // Save configuration using the new database config manager
    const saved = databaseConfig.saveConfig(cfg);
    if (!saved) {
      return res.status(500).json({ message: 'Failed to save database configuration' });
    }
    
    // Immediately rebuild the database connection with new settings
    try {
      await rebuildPool();
      console.log('✅ Database connection updated with new settings');
      return res.json({ message: 'Database configuration saved successfully!' });
    } catch (rebuildError) {
      console.error('❌ Failed to apply new database settings:', rebuildError);
      return res.json({ message: 'Settings saved but failed to reconnect. Please restart the app.' });
    }
  } catch (e) {
    return res.status(500).json({ message: e?.message || 'Failed to save config' });
  }
};

// Check database connection status
export const checkDbStatus = async (req, res) => {
  try {
    const isConnected = await isLocalPoolConnected();
    const hasConfig = databaseConfig.hasConfig();
    
    return res.json({ 
      connected: isConnected,
      configured: hasConfig,
      message: isConnected ? 'Database is connected' : hasConfig ? 'Database is configured but not connected' : 'Database is not configured'
    });
  } catch (e) {
    return res.status(500).json({ 
      connected: false,
      configured: false,
      message: e?.message || 'Failed to check database status' 
    });
  }
};
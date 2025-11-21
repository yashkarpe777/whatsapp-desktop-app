import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getConfigDir() {
  const fromEnv = process.env.CONFIG_DIR && String(process.env.CONFIG_DIR).trim();
  if (fromEnv) {
    try { fs.mkdirSync(fromEnv, { recursive: true }); } catch {}
    return fromEnv;
  }
  const fallback = path.join(__dirname, '..');
  try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  return fallback;
}

class DatabaseConfig {
  constructor() {
    const baseDir = getConfigDir();
    this.configPath = path.join(baseDir, 'database_config.json');
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const config = JSON.parse(data);
        if (config && config.password !== undefined && config.password !== null) {
          config.password = String(config.password);
        }
        return config;
      }
    } catch (error) {
      console.warn('Failed to load database config:', error.message);
    }

    // Fallback to env variables
    if (process.env.LOCAL_DB_HOST && process.env.LOCAL_DB_USER && process.env.LOCAL_DB_NAME) {
      return {
        host: process.env.LOCAL_DB_HOST,
        port: Number(process.env.LOCAL_DB_PORT || 5432),
        user: process.env.LOCAL_DB_USER,
        password: process.env.LOCAL_DB_PASSWORD,
        database: process.env.LOCAL_DB_NAME,
        ssl: process.env.LOCAL_DB_SSL === 'true'
      };
    }

    return null;
  }

  saveConfig(config) {
    try {
      const dir = path.dirname(this.configPath);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const configData = { ...config, password: config.password ? String(config.password) : '', updatedAt: new Date().toISOString() };
      fs.writeFileSync(this.configPath, JSON.stringify(configData, null, 2), 'utf8');
      this.config = configData;
      console.log('✅ Database configuration saved successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to save database config:', error.message);
      return false;
    }
  }

  getConfig() {
    return this.config;
  }

  hasConfig() {
    return this.config && this.config.host && this.config.user && this.config.database;
  }

  clearConfig() {
    try {
      if (fs.existsSync(this.configPath)) fs.unlinkSync(this.configPath);
      this.config = null;
      console.log('✅ Database configuration cleared');
      return true;
    } catch (error) {
      console.error('❌ Failed to clear database config:', error.message);
      return false;
    }
  }
}

export const databaseConfig = new DatabaseConfig();

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
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn('Failed to load database config:', error.message);
    }
    return null;
  }

  saveConfig(config) {
    try {
      const dir = path.dirname(this.configPath);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const configData = {
        ...config,
        updatedAt: new Date().toISOString()
      };
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
      if (fs.existsSync(this.configPath)) {
        fs.unlinkSync(this.configPath);
      }
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




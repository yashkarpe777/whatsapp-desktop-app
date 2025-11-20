import pkg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const { Pool } = pkg;

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Read database config
const configPath = path.join(__dirname, '..', 'database_config.json');
let dbConfig = {};

if (fs.existsSync(configPath)) {
  const configContent = fs.readFileSync(configPath, 'utf8');
  dbConfig = JSON.parse(configContent);
  console.log('✅ Loaded database config from database_config.json');
}

// Create pool
const pool = new Pool({
  host: dbConfig.host || process.env.DB_HOST || 'localhost',
  port: dbConfig.port || process.env.DB_PORT || 5432,
  user: dbConfig.user || process.env.DB_USER || 'postgres',
  password: dbConfig.password || process.env.DB_PASSWORD || 'postgres',
  database: dbConfig.database || process.env.DB_NAME || 'whatsapp_blast',
  ssl: false
});

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Running migrations...\n');
    
    // Get all migration files
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    
    for (const file of files) {
      console.log(`📄 Running migration: ${file}`);
      const sqlPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      
      try {
        await client.query(sql);
        console.log(`✅ ${file} completed successfully\n`);
      } catch (err) {
        console.error(`❌ ${file} failed:`, err.message);
        throw err;
      }
    }
    
    console.log('🎉 All migrations completed successfully!');
    
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

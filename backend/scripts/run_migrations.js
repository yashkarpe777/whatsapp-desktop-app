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

// Resolve connection details without hard-coded fallbacks
const resolvedHost = dbConfig.host ?? process.env.DB_HOST;
const resolvedPort = Number(dbConfig.port ?? process.env.DB_PORT ?? 5432);
const resolvedUser = dbConfig.user ?? process.env.DB_USER;
const resolvedPassword = dbConfig.password ?? process.env.DB_PASSWORD;
const resolvedDatabase = dbConfig.database ?? process.env.DB_NAME;

const missingFields = [];
if (!resolvedHost) missingFields.push('host');
if (!resolvedUser) missingFields.push('user');
if (!resolvedPassword) missingFields.push('password');
if (!resolvedDatabase) missingFields.push('database');

if (missingFields.length > 0) {
  console.error('❌ Missing database configuration values:', missingFields.join(', '));
  console.error('   Provide them via', configPath, 'or environment variables.');
  process.exit(1);
}

// Create pool
const pool = new Pool({
  host: resolvedHost,
  port: resolvedPort,
  user: resolvedUser,
  password: resolvedPassword,
  database: resolvedDatabase,
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

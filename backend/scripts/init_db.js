import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pkg from 'pg';

const { Pool } = pkg;

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Load backend/.env relative to this script
  dotenv.config({ path: path.join(__dirname, '..', '.env') });

  const sqlPath = path.join(__dirname, '..', 'config', 'database.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error(`SQL file not found: ${sqlPath}`);
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Build pool using environment variables (local first)
  const useSsl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
  const url = process.env.DATABASE_URL;

  const commonPool = {
    keepAlive: true,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
  };

  let pool;
  if (url) {
    pool = new Pool({ connectionString: url, ssl: useSsl, ...commonPool });
  } else {
    pool = new Pool({
      host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
      port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
      user: process.env.PGUSER || process.env.DB_USER || 'postgres',
      password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'postgres',
      database: process.env.PGDATABASE || process.env.DB_NAME || 'whatsapp_blast',
      ssl: useSsl,
      ...commonPool,
    });
  }

  console.log('Initializing database ...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Database initialized successfully.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Database initialization failed:', e.message || e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Init script fatal error:', e.message || e);
  process.exit(1);
});

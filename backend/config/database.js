const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
const defaultSsl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;

const poolConfig = connectionString
  ? {
      connectionString,
      ssl: defaultSsl,
      keepAlive: true,
      max: Number(process.env.PGPOOL_MAX || 10),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 5000),
    }
  : {
      user: process.env.DB_USER || 'app_user',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'whatsapp_blast',
      password: process.env.DB_PASSWORD || 'strongpassword',
      port: Number(process.env.DB_PORT || 5432),
      ssl: defaultSsl,
    };

const pool = new Pool(poolConfig);

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL connection error:', err);
});

module.exports = { pool };
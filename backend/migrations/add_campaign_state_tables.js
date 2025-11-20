import { hotPool } from '../src/db.js';

/**
 * Migration: Add campaign state and session tracking tables
 * This enables crash recovery and session locking
 */
export async function up() {
  const client = await hotPool.query('SELECT 1'); // Test connection

  console.log('🔄 Running migration: add_campaign_state_tables');

  const migrations = [
    // Add whatsapp_session_id column to campaigns table
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS whatsapp_session_id VARCHAR(100)`,

    // Create campaign_state table for crash recovery
    `CREATE TABLE IF NOT EXISTS campaign_state (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER UNIQUE NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      state JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Create index for faster lookups
    `CREATE INDEX IF NOT EXISTS idx_campaign_state_campaign_id ON campaign_state(campaign_id)`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_session_id ON campaigns(whatsapp_session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_campaigns_status_session ON campaigns(status, whatsapp_session_id)`,

    // Add session tracking table
    `CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(100) UNIQUE NOT NULL,
      phone_number VARCHAR(20),
      push_name VARCHAR(255),
      is_active BOOLEAN DEFAULT TRUE,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Create index for session lookups
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_session_id ON whatsapp_sessions(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_active ON whatsapp_sessions(is_active)`
  ];

  for (const sql of migrations) {
    try {
      await hotPool.query(sql);
      console.log('✅ Executed:', sql.substring(0, 60) + '...');
    } catch (error) {
      console.error('❌ Migration failed:', error.message);
      throw error;
    }
  }

  console.log('✅ Migration completed: add_campaign_state_tables');
}

/**
 * Rollback migration
 */
export async function down() {
  console.log('🔄 Rolling back migration: add_campaign_state_tables');

  const rollbacks = [
    `DROP INDEX IF EXISTS idx_whatsapp_sessions_active`,
    `DROP INDEX IF EXISTS idx_whatsapp_sessions_session_id`,
    `DROP TABLE IF EXISTS whatsapp_sessions`,
    `DROP INDEX IF EXISTS idx_campaigns_status_session`,
    `DROP INDEX IF EXISTS idx_campaigns_session_id`,
    `DROP INDEX IF EXISTS idx_campaign_state_campaign_id`,
    `DROP TABLE IF EXISTS campaign_state`,
    `ALTER TABLE campaigns DROP COLUMN IF EXISTS whatsapp_session_id`
  ];

  for (const sql of rollbacks) {
    try {
      await hotPool.query(sql);
      console.log('✅ Rolled back:', sql.substring(0, 60) + '...');
    } catch (error) {
      console.warn('⚠️ Rollback warning:', error.message);
    }
  }

  console.log('✅ Rollback completed: add_campaign_state_tables');
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => {
      console.log('✅ Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

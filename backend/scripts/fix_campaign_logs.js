import dotenv from 'dotenv';
import pkg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function fixCampaignLogs() {
  console.log('🔧 Fixing campaign_logs table schema...\n');

  // Connect to local database
  const pool = new Pool({
    host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
    user: process.env.PGUSER || process.env.DB_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'postgres',
    database: process.env.PGDATABASE || process.env.DB_NAME || 'whatsapp_blast',
  });

  try {
    // Check if phone column exists
    const checkColumn = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'campaign_logs' AND column_name = 'phone'
    `);

    if (checkColumn.rows.length === 0) {
      console.log('❌ Column "phone" not found in campaign_logs table');
      console.log('✅ Adding "phone" column...\n');

      // Add phone column
      await pool.query(`
        ALTER TABLE campaign_logs 
        ADD COLUMN IF NOT EXISTS phone VARCHAR(20) NOT NULL DEFAULT ''
      `);

      console.log('✅ Column "phone" added successfully!');
    } else {
      console.log('✅ Column "phone" already exists in campaign_logs table');
    }

    // Verify the fix
    const verify = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'campaign_logs'
      ORDER BY ordinal_position
    `);

    console.log('\n📋 Current campaign_logs schema:');
    console.log('─'.repeat(60));
    verify.rows.forEach(row => {
      console.log(`  ${row.column_name.padEnd(25)} ${row.data_type.padEnd(20)} ${row.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });
    console.log('─'.repeat(60));

    console.log('\n✅ Campaign logs table fixed successfully!');
    console.log('🎉 You can now create campaigns!\n');

  } catch (error) {
    console.error('❌ Error fixing campaign_logs table:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

fixCampaignLogs().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

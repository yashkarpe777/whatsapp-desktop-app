import defaultPool, { getLocalPool, renderPool } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getDb() {
  return getLocalPool() || renderPool || defaultPool;
}

function ensureDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

async function ensureCleanupLogsTable(db) {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS cleanup_logs (
        id SERIAL PRIMARY KEY,
        cleanup_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        operation VARCHAR(100),
        table_name VARCHAR(100),
        records_deleted INTEGER DEFAULT 0,
        details TEXT
      )`);
  } catch {}
}

// Cleanup old campaign logs (older than retention)
export const cleanupOldCampaignLogs = async () => {
  const db = getDb();
  if (!db) {
    console.log('⚠️  No local database pool available for cleanup');
    return;
  }

  try {
    const days = parseInt(process.env.DATA_RETENTION_DAYS_LOGS || process.env.DATA_RETENTION_DAYS || '30', 10);
    const cutoff = ensureDateDaysAgo(isNaN(days) ? 30 : days);

    // Delete old campaign logs
    const result = await db.query(
      `DELETE FROM campaign_logs 
       WHERE created_at < $1 
       AND status IN ('sent', 'failed', 'skipped')`,
      [cutoff]
    );

    const deletedCount = result.rowCount || 0;

    if (deletedCount > 0) {
      // Log the cleanup operation
      await ensureCleanupLogsTable(db);
      await db.query(
        `INSERT INTO cleanup_logs (operation, table_name, records_deleted, details)
         VALUES ($1, $2, $3, $4)`,
        [
          'auto_cleanup',
          'campaign_logs',
          deletedCount,
          `Deleted logs older than ${cutoff.toISOString()}`
        ]
      );

      console.log(`🧹 Cleaned up ${deletedCount} old campaign logs`);
    }

    return deletedCount;
  } catch (error) {
    console.error('❌ Campaign logs cleanup failed:', error.message);
    return 0;
  }
};

// Cleanup old completed campaigns (older than retention)
export const cleanupOldCampaigns = async () => {
  const db = getDb();
  if (!db) {
    console.log('⚠️  No local database pool available for cleanup');
    return;
  }

  try {
    const days = parseInt(process.env.DATA_RETENTION_DAYS_CAMPAIGNS || process.env.DATA_RETENTION_DAYS || '30', 10);
    const cutoff = ensureDateDaysAgo(isNaN(days) ? 30 : days);

    // Find old completed campaigns
    const idsRes = await db.query(
      `SELECT id FROM campaigns 
       WHERE status IN ('completed', 'failed', 'stopped') 
       AND completed_at IS NOT NULL AND completed_at < $1`,
      [cutoff]
    );

    const ids = idsRes.rows.map(r => r.id);
    let deletedCount = 0;

    if (ids.length > 0) {
      // Delete their logs first to avoid FK issues
      await db.query(`DELETE FROM campaign_logs WHERE campaign_id = ANY($1)`, [ids]);
      const result = await db.query(`DELETE FROM campaigns WHERE id = ANY($1)`, [ids]);
      deletedCount = result.rowCount || 0;
    }

    if (deletedCount > 0) {
      // Log the cleanup operation
      await ensureCleanupLogsTable(db);
      await db.query(
        `INSERT INTO cleanup_logs (operation, table_name, records_deleted, details)
         VALUES ($1, $2, $3, $4)`,
        [
          'auto_cleanup',
          'campaigns',
          deletedCount,
          `Deleted campaigns older than ${cutoff.toISOString()}`
        ]
      );

      console.log(`🧹 Cleaned up ${deletedCount} old campaigns`);
    }

    return deletedCount;
  } catch (error) {
    console.error('❌ Campaigns cleanup failed:', error.message);
    return 0;
  }
};

// Cleanup orphaned media files
export const cleanupOrphanedMedia = async () => {
  const db = getDb();
  if (!db) {
    console.log('⚠️  No local database pool available for cleanup');
    return;
  }

  try {
    const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
    
    if (!fs.existsSync(uploadsDir)) {
      return 0;
    }

    // Get all media files referenced in campaigns
    const mediaResult = await db.query(
      `SELECT DISTINCT media_url FROM campaigns WHERE media_url IS NOT NULL`
    );
    
    const referencedFiles = new Set(mediaResult.rows.map(row => row.media_url));

    // Get all files in uploads directory
    const files = fs.readdirSync(uploadsDir);
    let deletedCount = 0;

    for (const file of files) {
      if (!referencedFiles.has(file)) {
        try {
          const filePath = path.join(uploadsDir, file);
          const stats = fs.statSync(filePath);
          
          // Only delete files older than 1 month
          const oneMonthAgo = new Date();
          oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
          
          if (stats.mtime < oneMonthAgo) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        } catch (error) {
          console.warn(`⚠️  Could not delete file ${file}:`, error.message);
        }
      }
    }

    if (deletedCount > 0) {
      // Log the cleanup operation
      await ensureCleanupLogsTable(db);
      await db.query(
        `INSERT INTO cleanup_logs (operation, table_name, records_deleted, details)
         VALUES ($1, $2, $3, $4)`,
        [
          'media_cleanup',
          'uploads',
          deletedCount,
          `Deleted ${deletedCount} orphaned media files`
        ]
      );

      console.log(`🧹 Cleaned up ${deletedCount} orphaned media files`);
    }

    return deletedCount;
  } catch (error) {
    console.error('❌ Media cleanup failed:', error.message);
    return 0;
  }
};

// Cleanup inactive contacts and empty groups older than retention
export const cleanupOldContactsAndGroups = async () => {
  const db = getDb();
  if (!db) {
    console.log('⚠️  No local database pool available for cleanup');
    return 0;
  }
  try {
    const days = parseInt(process.env.DATA_RETENTION_DAYS_CONTACTS || process.env.DATA_RETENTION_DAYS || '30', 10);
    const cutoff = ensureDateDaysAgo(isNaN(days) ? 30 : days);

    // Delete inactive contacts older than cutoff (by updated_at)
    const delContacts = await db.query(
      `DELETE FROM contacts
       WHERE (is_active = FALSE OR is_active IS NULL)
       AND updated_at < $1
       RETURNING id`,
      [cutoff]
    );
    const contactsDeleted = delContacts.rowCount || 0;

    // Delete empty contact groups with no contacts and older than cutoff
    const delGroups = await db.query(
      `DELETE FROM contact_groups cg
       WHERE cg.updated_at < $1
       AND NOT EXISTS (
         SELECT 1 FROM contacts c WHERE c.group_id = cg.id
       )`,
      [cutoff]
    );
    const groupsDeleted = delGroups.rowCount || 0;

    const total = contactsDeleted + groupsDeleted;
    if (total > 0) {
      await ensureCleanupLogsTable(db);
      if (contactsDeleted > 0) {
        await db.query(
          `INSERT INTO cleanup_logs (operation, table_name, records_deleted, details)
           VALUES ($1, $2, $3, $4)`,
          ['auto_cleanup', 'contacts', contactsDeleted, `Deleted inactive contacts older than ${cutoff.toISOString()}`]
        );
      }
      if (groupsDeleted > 0) {
        await db.query(
          `INSERT INTO cleanup_logs (operation, table_name, records_deleted, details)
           VALUES ($1, $2, $3, $4)`,
          ['auto_cleanup', 'contact_groups', groupsDeleted, `Deleted empty groups older than ${cutoff.toISOString()}`]
        );
      }
      console.log(`🧹 Cleaned contacts=${contactsDeleted} groups=${groupsDeleted}`);
    }
    return total;
  } catch (error) {
    console.error('❌ Contacts/groups cleanup failed:', error.message);
    return 0;
  }
};

// Run all cleanup operations
export const runCleanup = async () => {
  console.log('🧹 Starting automatic cleanup...');
  
  const logsDeleted = await cleanupOldCampaignLogs();
  const campaignsDeleted = await cleanupOldCampaigns();
  const mediaDeleted = await cleanupOrphanedMedia();
  const contactsGroupsDeleted = await cleanupOldContactsAndGroups();
  
  const totalDeleted = logsDeleted + campaignsDeleted + mediaDeleted + contactsGroupsDeleted;
  
  if (totalDeleted > 0) {
    console.log(`✅ Cleanup completed: ${totalDeleted} items removed`);
  } else {
    console.log('✅ Cleanup completed: No items to remove');
  }
  
  return totalDeleted;
};

// Get cleanup statistics
export const getCleanupStats = async () => {
  if (!localPool) {
    return { total_cleanups: 0, last_cleanup: null, total_deleted: 0 };
  }

  try {
    const result = await localPool.query(
      `SELECT 
         COUNT(*) as total_cleanups,
         MAX(cleanup_date) as last_cleanup,
         SUM(records_deleted) as total_deleted
       FROM cleanup_logs`
    );

    return result.rows[0] || { total_cleanups: 0, last_cleanup: null, total_deleted: 0 };
  } catch (error) {
    console.error('❌ Failed to get cleanup stats:', error.message);
    return { total_cleanups: 0, last_cleanup: null, total_deleted: 0 };
  }
};


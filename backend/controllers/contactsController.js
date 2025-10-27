import XLSX from 'xlsx';
import { hotPool } from '../src/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = hotPool;

async function resolveLocalUserId(req) {
  const info = req.user || {};
  const userId = info.id || info.userId || null;
  
  if (!userId) {
    throw new Error('User ID not found in token. Please login again.');
  }
  
  return userId;
}

// Upload contacts from Excel or CSV file
export const uploadContacts = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const isPreview = req.query.preview === 'true';
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    
    let jsonData;
    
    // Support both Excel (.xlsx, .xls) and CSV (.csv)
    if (fileExtension === '.csv') {
      // Read CSV file
      const workbook = XLSX.readFile(req.file.path, { type: 'file' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      jsonData = XLSX.utils.sheet_to_json(worksheet);
    } else if (fileExtension === '.xlsx' || fileExtension === '.xls') {
      // Read Excel file
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      jsonData = XLSX.utils.sheet_to_json(worksheet);
    } else {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid file format. Please upload .xlsx, .xls, or .csv file' 
      });
    }

    const validContacts = [];
    const seenPhones = new Set();
    const userId = await resolveLocalUserId(req);

    let duplicatesInFile = 0;
    let invalidRows = 0;

    // Helper: normalize to Indian format for storage (+91XXXXXXXXXX)
    const normalizeIndianForStorage = (raw) => {
      if (!raw) return '';
      let digits = String(raw).replace(/\D/g, '');
      if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
      if (!digits.startsWith('91')) {
        if (digits.length === 10) {
          digits = '91' + digits;
        } else if (digits.length > 10) {
          const last10 = digits.slice(-10);
          digits = '91' + last10;
        }
      }
      return `+${digits}`;
    };

    // First pass: collect and deduplicate valid contacts
    for (const row of jsonData) {
      if (row.number || row.phone) {
        const phone = row.number || row.phone;
        const name = row.name || '';

        const normalized = normalizeIndianForStorage(phone);
        if (!normalized || !/^\+\d{12}$/.test(normalized)) { // +91 + 10 digits
          invalidRows++;
          continue;
        }

        // Skip duplicates within the file
        if (seenPhones.has(normalized)) {
          duplicatesInFile++;
          continue;
        }

        seenPhones.add(normalized);
        const contactData = { phone: normalized, name };
        validContacts.push(contactData);
      }
    }

    let count = 0;

    if (isPreview) {
      // For preview, just return the deduplicated contacts
      res.json({
        success: true,
        preview: validContacts,
        total: validContacts.length,
        duplicates_in_file: duplicatesInFile,
        invalid_rows: invalidRows,
        message: `${validContacts.length} valid unique contacts found (${duplicatesInFile} duplicates removed, ${invalidRows} invalid rows skipped)`
      });
    } else {
      // Only deduplicate within the uploaded file (do NOT remove numbers already in database)
      const toInsert = validContacts;

      // Create a contact group for this upload
      const fileName = req.file.originalname.replace(/\.[^/.]+$/, ""); // Remove extension
      const groupName = `${fileName}_${new Date().toISOString().split('T')[0]}`;

      // Check if contact group with same name and user_id already exists
      const existingGroupResult = await pool.query(
        'SELECT id FROM contact_groups WHERE name = $1 AND user_id = $2',
        [groupName, userId]
      );

      let groupId;
      if (existingGroupResult.rows.length > 0) {
        groupId = existingGroupResult.rows[0].id;
      } else {
        const groupResult = await pool.query(
          'INSERT INTO contact_groups (name, user_id) VALUES ($1, $2) RETURNING id',
          [groupName, userId]
        );
        groupId = groupResult.rows[0].id;
      }

      // Persist metadata mapping this uploaded file to the created group for future deletion
      try {
        if (req.file && req.file.path) {
          const meta = {
            type: 'contacts_upload',
            userId,
            groupId,
            originalname: req.file.originalname,
            storedFilename: path.basename(req.file.path),
            createdAt: new Date().toISOString()
          };
          const metaPath = req.file.path + '.meta.json';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          // Also record linkage in DB for reliable cascade deletion
          try {
            await pool.query(
              `INSERT INTO uploads (user_id, group_id, originalname, stored_filename)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (stored_filename) DO UPDATE SET group_id = EXCLUDED.group_id, originalname = EXCLUDED.originalname`,
              [userId, groupId, req.file.originalname, path.basename(req.file.path)]
            );
          } catch {}
        }
      } catch (e) {
        // Non-fatal: continue even if metadata persistence fails
      }

      // Insert deduplicated contacts (excluding ones already present for this user)
      for (const contact of toInsert) {
        const insertRes = await pool.query(
          'INSERT INTO contacts (user_id, phone, name, group_id) VALUES ($1, $2, $3, $4) RETURNING id',
          [userId, contact.phone, contact.name, groupId]
        );
        const contactId = insertRes.rows[0].id;

        // Link contact to active campaigns of the user
        const activeCampaignsRes = await pool.query(
          "SELECT id FROM campaigns WHERE user_id = $1 AND status IN ('pending', 'running')",
          [userId]
        );
        const activeCampaigns = activeCampaignsRes.rows;

        for (const campaign of activeCampaigns) {
          await pool.query(
            'INSERT INTO campaign_logs (campaign_id, contact_id, status) VALUES ($1, $2, $3)',
            [campaign.id, contactId, 'pending']
          );
        }

        count++;
      }

      res.json({
        success: true,
        count,
        group_id: groupId,
        duplicates_in_file: duplicatesInFile,
        invalid_rows: invalidRows,
        message: `${count} contacts imported into "${groupName}" (${duplicatesInFile} duplicates in file removed, ${invalidRows} invalid skipped)`
      });
    }


  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

// Get paginated contacts with optional search and group filter
export const getContacts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    const groupId = req.query.group_id ? parseInt(req.query.group_id) : null;
    const offset = (page - 1) * limit;
    const userId = await resolveLocalUserId(req);

    let query = 'SELECT id, phone AS number, name, group_id, created_at FROM contacts WHERE user_id = $1';
    let countQuery = 'SELECT COUNT(*) FROM contacts WHERE user_id = $1';
    const params = [userId];
    const countParams = [userId];

    if (groupId) {
      query += ' AND group_id = $' + (params.length + 1);
      countQuery += ' AND group_id = $' + (countParams.length + 1);
      params.push(groupId);
      countParams.push(groupId);
    }

    if (search) {
      query += ' AND (phone ILIKE $' + (params.length + 1) + ' OR name ILIKE $' + (params.length + 1) + ')';
      countQuery += ' AND (phone ILIKE $' + (countParams.length + 1) + ' OR name ILIKE $' + (countParams.length + 1) + ')';
      params.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const result = await pool.query(query, params);
    const totalResult = await pool.query(countQuery, countParams);

    res.json({
      contacts: result.rows,
      total: parseInt(totalResult.rows[0].count),
      page
    });
  } catch (err) {
    console.error('Get contacts error:', err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

// Delete a single contact
export const deleteContact = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);

    const result = await pool.query('DELETE FROM contacts WHERE id = $1 AND user_id = $2', [id, userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Contact not found or not owned by user' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete contact error:', err);
    res.status(500).json({ success: false });
  }
};

// Bulk delete contacts (optional for future)
export const bulkDeleteContacts = async (req, res) => {
  try {
    const { ids } = req.body; // Array of contact ids
    const userId = await resolveLocalUserId(req);

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid ids array' });
    }

    const result = await pool.query('DELETE FROM contacts WHERE id = ANY($1) AND user_id = $2', [ids, userId]);

    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ success: false });
  }
};

// Get contact groups
export const getContactGroups = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);

    const query = `
      SELECT g.id, g.name, COUNT(c.id) AS contact_count
      FROM contact_groups g
      LEFT JOIN contacts c ON g.id = c.group_id AND c.user_id = $1
      GROUP BY g.id, g.name
      HAVING COUNT(c.id) > 0
      ORDER BY g.name
    `;

    const result = await pool.query(query, [userId]);

    res.json({ success: true, groups: result.rows });
  } catch (err) {
    console.error('Get contact groups error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch contact groups' });
  }
};

// Delete an entire contact group (and its contacts and logs)
export const deleteContactGroup = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);
    const groupId = Number(req.params.groupId);
    if (!Number.isFinite(groupId)) return res.status(400).json({ success: false, message: 'Invalid group id' });

    await pool.query('BEGIN');
    try {
      const idsRes = await pool.query('SELECT id FROM contacts WHERE user_id = $1 AND group_id = $2', [userId, groupId]);
      const contactIds = idsRes.rows.map(r => r.id);
      if (contactIds.length > 0) {
        await pool.query('DELETE FROM campaign_logs WHERE contact_id = ANY($1)', [contactIds]);
        await pool.query('DELETE FROM contacts WHERE user_id = $1 AND group_id = $2', [userId, groupId]);
      }
      await pool.query('DELETE FROM contact_groups WHERE id = $1', [groupId]);
      await pool.query('COMMIT');
      if (contactIds.length === 0) {
        return res.status(404).json({ success: false, message: 'Group not found or empty for current user' });
      }
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    res.json({ success: true, message: 'Group and contacts deleted' });
  } catch (err) {
    console.error('Delete group error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete group' });
  }
};

// Delete uploaded contact file
export const deleteContactFile = async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = await resolveLocalUserId(req);

    if (!filename) {
      return res.status(400).json({ success: false, message: 'Filename is required' });
    }

    const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
    const filePath = path.join(uploadsDir, filename);
    if (!filePath) return res.status(404).json({ success: false, message: 'File not found' });

    // Check if file is referenced in any campaigns (as media)
    const campaignResult = await pool.query(
      'SELECT id, title FROM campaigns WHERE media_url = $1 AND user_id = $2',
      [filename, userId]
    );

    if (campaignResult.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete file: It is being used in campaigns',
        campaigns: campaignResult.rows
      });
    }

    // Attempt to load metadata to find associated contact group from this upload
    const metaPath = filePath + '.meta.json';
    let deletedContacts = 0;
    let deletedGroups = 0;
    try {
      if (fs.existsSync(metaPath)) {
        const metaRaw = fs.readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw);
        if (meta && meta.type === 'contacts_upload' && meta.userId === userId) {
          const groupId = Number(meta.groupId);
          if (Number.isFinite(groupId)) {
            // Delete related contacts and campaign logs within a transaction
            await pool.query('BEGIN');
            try {
              const idsRes = await pool.query('SELECT id FROM contacts WHERE user_id = $1 AND group_id = $2', [userId, groupId]);
              const contactIds = idsRes.rows.map(r => r.id);
              if (contactIds.length > 0) {
                await pool.query('DELETE FROM campaign_logs WHERE contact_id = ANY($1)', [contactIds]);
                const delRes = await pool.query('DELETE FROM contacts WHERE user_id = $1 AND group_id = $2', [userId, groupId]);
                deletedContacts = delRes.rowCount;
              }
              const gDel = await pool.query('DELETE FROM contact_groups WHERE id = $1 AND user_id = $2', [groupId, userId]);
              deletedGroups = gDel.rowCount;
              await pool.query('COMMIT');
            } catch (e) {
              await pool.query('ROLLBACK');
              throw e;
            }
          }
        }
      }
    } catch (e) {
      // Continue; metadata may not exist for older uploads
    }

    // DB mapping-based cascade: if an uploads row exists, use it first
    if (deletedContacts === 0 && deletedGroups === 0) {
      try {
        const stored = path.basename(filePath);
        const map = await pool.query('SELECT group_id FROM uploads WHERE stored_filename = $1 AND user_id = $2', [stored, userId]);
        if (map.rowCount > 0) {
          const gid = map.rows[0].group_id;
          await pool.query('BEGIN');
          try {
            const idsRes = await pool.query('SELECT id FROM contacts WHERE user_id = $1 AND group_id = $2', [userId, gid]);
            const contactIds = idsRes.rows.map(r => r.id);
            if (contactIds.length > 0) {
              await pool.query('DELETE FROM campaign_logs WHERE contact_id = ANY($1)', [contactIds]);
              const delRes = await pool.query('DELETE FROM contacts WHERE user_id = $1 AND group_id = $2', [userId, gid]);
              deletedContacts += delRes.rowCount;
            }
            const gDel = await pool.query('DELETE FROM contact_groups WHERE id = $1 AND user_id = $2', [gid, userId]);
            deletedGroups += gDel.rowCount;
            await pool.query('DELETE FROM uploads WHERE stored_filename = $1 AND user_id = $2', [stored, userId]);
            await pool.query('COMMIT');
          } catch (e) {
            await pool.query('ROLLBACK');
            throw e;
          }
        }
      } catch {}
    }

    // Fallback: if still nothing deleted, attempt to parse the Excel file
    // and delete contacts matching numbers contained in the file for the current user.
    if (deletedContacts === 0 && deletedGroups === 0) {
      try {
        const workbook = XLSX.readFile(filePath, { cellDates: true });
        const sheetName = workbook.SheetNames[0];
        if (sheetName) {
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet);

          const normalizeIndianForStorage = (raw) => {
            if (!raw) return '';
            let digits = String(raw).replace(/\D/g, '');
            if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
            if (!digits.startsWith('91')) {
              if (digits.length === 10) {
                digits = '91' + digits;
              } else if (digits.length > 10) {
                const last10 = digits.slice(-10);
                digits = '91' + last10;
              }
            }
            return `+${digits}`;
          };

          const numbers = new Set();
          for (const row of jsonData) {
            const phone = row.number || row.phone || row.Phone || row.contact || row.mobile;
            const normalized = normalizeIndianForStorage(phone);
            if (normalized && /^\+\d{12}$/.test(normalized)) numbers.add(normalized);
          }

          if (numbers.size > 0) {
            const numArray = Array.from(numbers);
            // Delete in a transaction
            await pool.query('BEGIN');
            try {
              const idsRes = await pool.query(
                'SELECT id, group_id FROM contacts WHERE user_id = $1 AND phone = ANY($2)',
                [userId, numArray]
              );
              const contactIds = idsRes.rows.map(r => r.id);
              const affectedGroups = [...new Set(idsRes.rows.map(r => r.group_id).filter(Boolean))];
              if (contactIds.length > 0) {
                await pool.query('DELETE FROM campaign_logs WHERE contact_id = ANY($1)', [contactIds]);
                const delRes = await pool.query('DELETE FROM contacts WHERE id = ANY($1)', [contactIds]);
                deletedContacts += delRes.rowCount;
              }
              // Clean up empty groups
              for (const gid of affectedGroups) {
                const cnt = await pool.query('SELECT COUNT(1) FROM contacts WHERE group_id = $1', [gid]);
                if (parseInt(cnt.rows[0].count) === 0) {
                  const gDel = await pool.query('DELETE FROM contact_groups WHERE id = $1', [gid]);
                  deletedGroups += gDel.rowCount;
                }
              }
              await pool.query('COMMIT');
            } catch (e) {
              await pool.query('ROLLBACK');
              throw e;
            }
          }
        }
      } catch (e) {
        // ignore parsing failures; proceed to delete file only
      }
    }

    // Delete the file and any metadata file
    try { fs.unlinkSync(filePath); } catch {}
    try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}

    res.json({ 
      success: true, 
      message: deletedContacts > 0 || deletedGroups > 0
        ? `File and associated data deleted (contacts: ${deletedContacts}, groups: ${deletedGroups})`
        : 'File deleted successfully',
      deletedFile: filename,
      deletedContacts,
      deletedGroups
    });

  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete file' });
  }
};

// Get uploaded files for user
export const getUploadedFiles = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);
    const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      return res.json({ success: true, files: [] });
    }
    const entries = fs.readdirSync(uploadsDir).filter(f => !f.endsWith('.meta.json'));
    const fileList = [];
    for (const file of entries) {
      const filePath = path.join(uploadsDir, file);
      let stats; try { stats = fs.statSync(filePath); } catch { continue; }
      
      // Check if file is used in any campaigns
      const campaignResult = await pool.query(
        'SELECT id, title FROM campaigns WHERE media_url = $1 AND user_id = $2',
        [file, userId]
      );

      // Load optional metadata
      let originalname = null;
      let groupId = null;
      const metaPath = filePath + '.meta.json';
      try {
        if (fs.existsSync(metaPath)) {
          const metaRaw = fs.readFileSync(metaPath, 'utf8');
          const meta = JSON.parse(metaRaw);
          if (meta && meta.userId === userId) {
            originalname = meta.originalname || null;
            groupId = meta.groupId || null;
          }
        }
      } catch {}

      fileList.push({
        filename: file,
        originalname,
        groupId,
        canCascade: Boolean(groupId),
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        isUsed: campaignResult.rows.length > 0,
        campaigns: campaignResult.rows
      });
    }

    // Sort by modification date (newest first)
    fileList.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({ success: true, files: fileList });

  } catch (error) {
    console.error('Get uploaded files error:', error);
    res.status(500).json({ success: false, message: 'Failed to get uploaded files' });
  }
};

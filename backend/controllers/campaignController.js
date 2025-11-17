import { hotPool } from '../src/db.js';
import { sendCampaign, getWhatsAppStatus, initWhatsApp, logoutWhatsApp, pauseCampaignService, resumeCampaignService, stopCampaignService } from '../src/services/whatsappservice.js';
import { authorizeCoinsRemote, refundCoinsRemote, getBalanceRemote } from '../src/services/remoteCoins.js';

const pool = hotPool;

async function resolveLocalUserId(req) {
  const info = req.user || {};
  const userId = info.id || info.userId || null;

  if (!userId) {
    throw new Error('User ID not found in token. Please login again.');
  }

  return userId;
}

export const createCampaign = async (req, res) => {
  try {
    const { title, message, contact_group_id, message_delay_seconds } = req.body;
    const userId = await resolveLocalUserId(req);

    if (!title || !message) {
      return res.status(400).json({ success: false, message: "Title and message are required" });
    }

    // Validate message delay (1-60 seconds, default 2)
    let delay = parseInt(message_delay_seconds) || 2;
    if (delay < 1) delay = 1;
    if (delay > 60) delay = 60;

    const mediaUrl = req.file ? req.file.filename : null;
    console.log('Received media filename to save in DB:', mediaUrl);

    const result = await pool.query(
      `INSERT INTO campaigns (title, message, media_url, contact_group_id, user_id, message_delay_seconds, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', CURRENT_TIMESTAMP)
       RETURNING *`,
      [title, message, mediaUrl, contact_group_id || null, userId, delay]
    );

    // Auto-create pending logs if group_id provided
    if (contact_group_id) {
      const logResult = await pool.query(
        `INSERT INTO campaign_logs (campaign_id, contact_id, phone, message, media_url, status)
         SELECT $1, c.id, c.phone, $2, $3, 'pending' FROM contacts c WHERE c.group_id = $4 AND c.user_id = $5
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [result.rows[0].id, message, mediaUrl, contact_group_id, userId]
      );
      console.log(`✅ Created ${logResult.rowCount} pending logs for campaign (duplicates skipped)`);
    }

    res.json({ success: true, campaign: result.rows[0] });
  } catch (error) {
    console.error("Create campaign error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to create campaign" });
  }
};

export const startCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);
    console.log(`🚀 [START] Campaign ${id} by user ${userId}`);

    // Ensure WhatsApp is ready; if not, prompt for QR login instead of starting
    try {
      const status = getWhatsAppStatus();
      console.log('📱 WhatsApp status:', status);
      if (!status.ready) {
        await initWhatsApp().catch(() => { });
        const afterInit = getWhatsAppStatus();
        if (!afterInit.ready) {
          return res.json({ success: false, needsLogin: true, qr: afterInit.qr || null, message: 'Please scan the QR code to connect WhatsApp.' });
        }
      }
    } catch (e) {
      // If status retrieval fails, still fall back to QR prompt
      return res.json({ success: false, needsLogin: true, qr: null, message: 'Please scan the QR code to connect WhatsApp.' });
    }

    // Check if campaign exists and belongs to user
    const campaignCheck = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1 AND user_id = $2",
      [id, userId]
    );

    if (campaignCheck.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Campaign not found or unauthorized" });
    }

    const campaign = campaignCheck.rows[0];

    let contactCount = 0;
    if (campaign.contact_group_id) {
      const contactCountRes = await pool.query(
        "SELECT COUNT(*) as count FROM contacts WHERE group_id = $1 AND user_id = $2 AND phone IS NOT NULL",
        [campaign.contact_group_id, userId]
      );
      contactCount = parseInt(contactCountRes.rows[0].count);
    }

    if (contactCount === 0) {
      console.log('❌ No contacts found');
      return res.status(400).json({ success: false, message: 'No valid numbers to run. Please fix contacts (+91XXXXXXXXXX).' });
    }

    console.log(`📊 Contact count: ${contactCount}`);

    const authHeader = req.headers['authorization'] || '';
    let partialCampaignWarning = null;

    try {
      let coinsToAuthorize = contactCount;
      let availableCoins = 0;

      try {
        const bal = await getBalanceRemote(authHeader);
        availableCoins = parseInt(bal?.coins ?? 0);
        console.log(`💰 Available coins: ${availableCoins}`);

        if (availableCoins === 0) {
          console.log('❌ No coins available');
          return res.status(400).json({ success: false, message: `No coins available. Please add coins to start campaign.` });
        }

        if (availableCoins < contactCount) {
          coinsToAuthorize = availableCoins;
          console.warn(`⚠️ Partial campaign: authorizing ${coinsToAuthorize} coins for ${contactCount} contacts`);
        }
      } catch (e) {
        console.error('❌ Coin balance check failed:', e);
      }

      console.log(`🔐 Authorizing ${coinsToAuthorize} coins`);
      await authorizeCoinsRemote(coinsToAuthorize, authHeader, req.user || {});
      console.log('✅ Coins authorized');

      // Track coins reserved for this campaign
      await pool.query(
        'UPDATE campaigns SET coins_spent = $1 WHERE id = $2',
        [coinsToAuthorize, id]
      );

      partialCampaignWarning = coinsToAuthorize < contactCount ? {
        isPartial: true,
        authorizedContacts: coinsToAuthorize,
        totalContacts: contactCount,
        message: `⚠️ Insufficient coins: Campaign will send to ${coinsToAuthorize} contacts. Remaining ${contactCount - coinsToAuthorize} contacts will be skipped.`
      } : null;

      if (partialCampaignWarning) {
        console.warn(partialCampaignWarning.message);
      }
    } catch (e) {
      console.error('❌ Coin authorization failed:', e);
      return res.status(400).json({ success: false, message: e?.message || 'Coin authorization failed' });
    }

    // Update campaign status to running
    console.log('📝 Updating campaign status to running');
    const result = await pool.query(
      "UPDATE campaigns SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId]
    );

    if (campaign.contact_group_id) {
      const existingLogs = await pool.query(
        "SELECT COUNT(*) as count FROM campaign_logs WHERE campaign_id = $1",
        [id]
      );

      const logCount = parseInt(existingLogs.rows[0].count);
      console.log(`📋 Existing logs: ${logCount}`);

      if (logCount === 0) {
        console.log('📝 Creating new campaign logs');
        const logResult = await pool.query(
          `INSERT INTO campaign_logs (campaign_id, contact_id, phone, message, media_url, status)
           SELECT $1, c.id, c.phone, $2, $3, 'pending' FROM contacts c WHERE c.group_id = $4 AND c.user_id = $5 AND c.phone IS NOT NULL
           ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
          [id, campaign.message, campaign.media_url, campaign.contact_group_id, userId]
        );
        console.log(`✅ Created ${logResult.rowCount} pending logs for campaign ${id}`);
      } else {
        console.log(`♻️ Campaign ${id} already has ${logCount} logs, resuming from where it left off`);
      }
    }

    console.log('🚀 Starting sendCampaign background process');
    
    // Start campaign in background
    sendCampaign(id, authHeader).catch(async (error) => {
      console.error("Campaign send error:", error);
      await pool.query(
        "UPDATE campaigns SET status = 'failed', error_message = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2",
        [error.message, id]
      );
      await pool.query(
        "UPDATE campaign_logs SET status = 'failed', error_message = $2 WHERE campaign_id = $1 AND status = 'pending'",
        [id, error.message]
      );
    });

    // Send response immediately, don't wait for campaign to finish
    const response = {
      success: true,
      message: partialCampaignWarning 
        ? `Campaign started with ${partialCampaignWarning.authorizedContacts} of ${partialCampaignWarning.totalContacts} contacts`
        : "Campaign started successfully"
    };

    if (partialCampaignWarning) {
      response.warning = partialCampaignWarning;
    }

    console.log('✅ Campaign started successfully, sending response');
    res.json(response);
  } catch (error) {
    console.error("❌ Start campaign error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to start campaign" });
  }
};

export const deleteCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);

    // Clean up logs first
    await pool.query("DELETE FROM campaign_logs WHERE campaign_id = $1", [id]);

    const result = await pool.query(
      "DELETE FROM campaigns WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Campaign not found or unauthorized" });
    }

    res.json({ success: true, message: "Campaign deleted successfully" });
  } catch (error) {
    console.error("Delete campaign error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to delete campaign" });
  }
};

export const updateCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, message, contact_group_id, message_delay_seconds } = req.body;
    const userId = await resolveLocalUserId(req);

    const mediaFile = req.file ? req.file.filename : null;
    const parsedGroupId = contact_group_id ? parseInt(contact_group_id) : null;

    let delay = null;
    if (message_delay_seconds !== undefined) {
      delay = parseInt(message_delay_seconds) || 2;
      if (delay < 1) delay = 1;
      if (delay > 60) delay = 60;
    }

    const result = await pool.query(
      `UPDATE campaigns
       SET title = COALESCE($1, title),
           message = COALESCE($2, message),
           media_url = COALESCE($3, media_url),
           contact_group_id = COALESCE($4, contact_group_id),
           message_delay_seconds = COALESCE($5, message_delay_seconds)
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [title || null, message || null, mediaFile || null, parsedGroupId, delay, id, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Campaign not found or unauthorized" });
    }

    res.json({ success: true, campaign: result.rows[0] });
  } catch (error) {
    console.error("Update campaign error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to update campaign" });
  }
};

export const getCampaignStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);

    // Fetch campaign ensuring ownership
    const campaignRes = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id) AS total,
              (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'sent') AS sent,
              (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'failed') AS failed,
              (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'pending') AS pending
       FROM campaigns c
       WHERE c.id = $1 AND c.user_id = $2`,
      [id, userId]
    );

    if (campaignRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Campaign not found or unauthorized" });
    }

    const row = campaignRes.rows[0];
    const progress = {
      total: parseInt(row.total) || 0,
      sent: parseInt(row.sent) || 0,
      failed: parseInt(row.failed) || 0,
      pending: parseInt(row.pending) || 0,
    };

    const campaign = {
      id: row.id,
      name: row.title || row.name, // support either column
      title: row.title || row.name,
      message: row.message,
      media_url: row.media_url,
      status: row.status,
      error_message: row.error_message || null, // Include error message for stopped campaigns
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      coins_spent: row.coins_spent || 0,
      total_contacts: progress.total,
      sent: progress.sent,
      failed: progress.failed,
      pending: progress.pending,
      is_active: row.status === 'running'
    };

    res.json({ success: true, campaign, progress });
  } catch (error) {
    console.error("Get campaign status error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to get campaign status" });
  }
};

export const getCampaigns = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);
    const result = await pool.query(
      `SELECT c.*,
       cg.name as group_name,
       (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id) as total_contacts,
       (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'pending') as pending,
       (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'sent') as sent,
       (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'failed') as failed,
       (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'pending') as skipped,
       CASE 
         WHEN (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status IN ('sent', 'failed')) > 0 
         THEN ROUND(
           (SELECT COUNT(*)::numeric FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'sent') * 100.0 / 
           (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status IN ('sent', 'failed'))
         , 2)
         ELSE 0
       END as success_rate
       FROM campaigns c
       LEFT JOIN contact_groups cg ON c.contact_group_id = cg.id
       WHERE c.user_id = $1 
       ORDER BY c.created_at DESC`,
      [userId]
    );

    // Transform the data to match the expected format
    const campaigns = result.rows.map(row => ({
      id: row.id,
      name: row.title, // Map title to name for frontend compatibility
      title: row.title,
      message: row.message,
      media_url: row.media_url,
      video_path: row.media_url, // Map media_url to video_path for frontend compatibility
      status: row.status,
      total_contacts: parseInt(row.total_contacts) || 0,
      sent: parseInt(row.sent) || 0,
      failed: parseInt(row.failed) || 0,
      skipped: parseInt(row.skipped) || 0,
      pending: parseInt(row.pending) || 0,
      success_rate: parseFloat(row.success_rate) || 0,
      coins_spent: row.coins_spent || 0,
      group_name: row.group_name,
      contact_group_id: row.contact_group_id,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      duration_seconds: row.completed_at && row.started_at ?
        Math.floor((new Date(row.completed_at) - new Date(row.started_at)) / 1000) : 0,
      is_active: row.status === 'running'
    }));

    res.json({ success: true, campaigns });
  } catch (error) {
    console.error("Get campaigns error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to get campaigns" });
  }
};

export const getLogs = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT cl.id, cl.campaign_id, cl.status, cl.error_message, cl.sent_at,
              c.title AS campaign_name,
              ct.phone AS contact_number
       FROM campaign_logs cl
       JOIN campaigns c ON cl.campaign_id = c.id
       JOIN contacts ct ON ct.id = cl.contact_id
       WHERE c.user_id = $1
       ORDER BY cl.sent_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    const totalRes = await pool.query(
      `SELECT COUNT(*) AS total
       FROM campaign_logs cl
       JOIN campaigns c ON cl.campaign_id = c.id
       WHERE c.user_id = $1`,
      [userId]
    );
    res.json({ success: true, logs: result.rows, total: parseInt(totalRes.rows[0].total), page });
  } catch (error) {
    console.error("Get logs error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to get logs" });
  }
};

export const getCampaignLogs = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // verify ownership
    const own = await pool.query('SELECT 1 FROM campaigns WHERE id=$1 AND user_id=$2', [id, userId]);
    if (own.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found or unauthorized' });
    }

    const result = await pool.query(
      `SELECT cl.id, cl.campaign_id, cl.status, cl.error_message, cl.sent_at,
              c.title AS campaign_name,
              ct.phone AS contact_number
       FROM campaign_logs cl
       JOIN campaigns c ON cl.campaign_id = c.id
       JOIN contacts ct ON ct.id = cl.contact_id
       WHERE cl.campaign_id = $1
       ORDER BY cl.sent_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );
    const totalRes = await pool.query('SELECT COUNT(*) AS total FROM campaign_logs WHERE campaign_id=$1', [id]);
    res.json({ success: true, logs: result.rows, total: parseInt(totalRes.rows[0].total), page });
  } catch (error) {
    console.error('Get campaign logs error:', error);
    res.status(500).json({ success: false, message: error?.message || 'Failed to get campaign logs' });
  }
};

export const getCampaignLogsCSV = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);
    const { id } = req.params;
    const status = req.query.status;

    // verify ownership
    const own = await pool.query('SELECT 1 FROM campaigns WHERE id=$1 AND user_id=$2', [id, userId]);
    if (own.rowCount === 0) return res.status(404).send('Not found');

    let query = `SELECT c.title AS campaign_name, ct.phone AS contact_number, cl.status, COALESCE(cl.error_message,'') AS error_message, cl.sent_at
                 FROM campaign_logs cl
                 JOIN campaigns c ON c.id = cl.campaign_id
                 JOIN contacts ct ON ct.id = cl.contact_id
                 WHERE cl.campaign_id = $1`;
    const params = [id];
    if (status && ['sent', 'failed', 'skipped', 'pending'].includes(String(status))) {
      query += ' AND cl.status = $2';
      params.push(status);
    }
    query += ' ORDER BY cl.sent_at DESC';

    const result = await pool.query(query, params);
    const rows = result.rows;

    const header = 'campaign_name,contact_number,status,error_message,sent_at\n';
    const csv = header + rows.map(r => [r.campaign_name, r.contact_number, r.status, (r.error_message || '').replace(/\n/g, ' '), r.sent_at ? new Date(r.sent_at).toISOString() : ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=campaign_${id}_logs.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Export campaign logs CSV error:', error);
    res.status(500).send('Failed to export');
  }
};

export const getAllLogsCSV = async (req, res) => {
  try {
    const userId = await resolveLocalUserId(req);
    const status = req.query.status;

    let query = `SELECT c.title AS campaign_name, ct.phone AS contact_number, cl.status, COALESCE(cl.error_message,'') AS error_message, cl.sent_at
                 FROM campaign_logs cl
                 JOIN campaigns c ON c.id = cl.campaign_id
                 JOIN contacts ct ON ct.id = cl.contact_id
                 WHERE c.user_id = $1`;
    const params = [userId];
    if (status && ['sent', 'failed', 'skipped', 'pending'].includes(String(status))) {
      query += ' AND cl.status = $2';
      params.push(status);
    }
    query += ' ORDER BY cl.sent_at DESC';

    const result = await pool.query(query, params);
    const rows = result.rows;

    const header = 'campaign_name,contact_number,status,error_message,sent_at\n';
    const csv = header + rows.map(r => [r.campaign_name, r.contact_number, r.status, (r.error_message || '').replace(/\n/g, ' '), r.sent_at ? new Date(r.sent_at).toISOString() : ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=logs_all_campaigns.csv');
    res.send(csv);
  } catch (error) {
    console.error('Export all logs CSV error:', error);
    res.status(500).send('Failed to export');
  }
};

export const rerunCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);
    const { message, title } = req.body;
    const mediaFile = req.file ? req.file.filename : null;

    // Verify ownership
    const camRes = await pool.query('SELECT * FROM campaigns WHERE id=$1 AND user_id=$2', [id, userId]);
    if (camRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found or unauthorized' });
    }
    const src = camRes.rows[0];

    // Clone campaign with overrides if provided
    const cloneRes = await pool.query(
      `INSERT INTO campaigns (user_id, title, message, media_url, contact_group_id, status, created_at)
       VALUES ($1, COALESCE($2, $5), COALESCE($3, $6), COALESCE($4, $7), $8, 'pending', CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        src.user_id,
        title || null,
        message || null,
        mediaFile || null,
        src.title,
        src.message,
        src.media_url,
        src.contact_group_id
      ]
    );
    const newCampaign = cloneRes.rows[0];

    // Build valid contacts either from the campaign's contact_group_id or from previous logs if group is missing
    let contactIds = [];
    if (src.contact_group_id) {
      const contactsRes = await pool.query(
        `SELECT id FROM contacts WHERE group_id = $1 AND user_id = $2 AND phone IS NOT NULL`,
        [src.contact_group_id, userId]
      );
      contactIds = contactsRes.rows.map(r => r.id);
    } else {
      // Fallback: reuse contacts from existing campaign logs (sent/failed/pending)
      const fromLogs = await pool.query(
        `SELECT DISTINCT c.id AS contact_id
         FROM campaign_logs cl
         JOIN contacts c ON c.id = cl.contact_id
         WHERE cl.campaign_id = $1 AND c.user_id = $2 AND c.phone IS NOT NULL`,
        [id, userId]
      );
      contactIds = fromLogs.rows.map(r => r.contact_id);
    }

    const contactCount = contactIds.length;
    if (contactCount === 0) {
      return res.status(400).json({ success: false, message: 'No valid numbers to run. Please fix contacts (+91XXXXXXXXXX or 10 digits).' });
    }

    // Online coins authorization (Render)
    let coinsAuthorized = 0;
    const authHeader = req.headers['authorization'] || '';
    try {
      await authorizeCoinsRemote(contactCount, authHeader);
      coinsAuthorized = contactCount;
    } catch (e) {
      return res.status(400).json({ success: false, message: e?.message || 'Coin authorization failed' });
    }

    // Create logs, deduct coins, and start
    await pool.query('BEGIN');
    try {
      // Batch insert for better performance
      await pool.query(
        `INSERT INTO campaign_logs (campaign_id, contact_id, phone, message, media_url, status)
         SELECT $1, id, phone, $2, $3, 'pending' FROM contacts WHERE id = ANY($4)
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [newCampaign.id, newCampaign.message, newCampaign.media_url, contactIds]
      );
      await pool.query(
        "UPDATE campaigns SET status='running', started_at=CURRENT_TIMESTAMP, coins_spent=$2 WHERE id=$1",
        [newCampaign.id, coinsAuthorized]
      );
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      if (coinsAuthorized > 0 && authHeader) {
        try { await refundCoinsRemote(coinsAuthorized, authHeader); } catch (refundErr) {
          console.warn('⚠️ Coin refund failed after rerun rollback:', refundErr.message);
        }
      }
      throw e;
    }

    sendCampaign(newCampaign.id, authHeader).catch(async (error) => {
      console.error('Campaign rerun error:', error);

      await pool.query('UPDATE campaigns SET status=\'failed\', error_message=$1, completed_at=CURRENT_TIMESTAMP WHERE id=$2', [error.message, newCampaign.id]);
      await pool.query('UPDATE campaign_logs SET status=\'failed\', error_message=$2 WHERE campaign_id=$1 AND status=\'pending\'', [newCampaign.id, error.message]);
      if (coinsAuthorized > 0 && authHeader) {
        try {
          const sentResult = await pool.query(
            "SELECT COUNT(*) as sent FROM campaign_logs WHERE campaign_id = $1 AND status = 'sent'",
            [newCampaign.id]
          );
          const sentCount = parseInt(sentResult.rows[0]?.sent || 0);
          const toRefund = coinsAuthorized - sentCount;
          if (toRefund > 0) {
            await refundCoinsRemote(toRefund, authHeader);
          }
          await pool.query('UPDATE campaigns SET coins_spent = $1 WHERE id = $2', [sentCount, newCampaign.id]);
        } catch (refundErr) {
          console.warn('⚠️ Failed to refund coins after rerun failure:', refundErr.message);
        }
      }
    });

    res.json({ success: true, message: 'Campaign rerun started', campaign: newCampaign });
  } catch (error) {
    console.error('Rerun campaign error:', error);
    res.status(500).json({ success: false, message: error?.message || 'Failed to rerun campaign' });
  }
};

export const retryFailed = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);

    // Verify ownership
    const camRes = await pool.query('SELECT * FROM campaigns WHERE id=$1 AND user_id=$2', [id, userId]);
    if (camRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Campaign not found or unauthorized' });
    }

    const src = camRes.rows[0];

    // Clone campaign
    const cloneRes = await pool.query(
      `INSERT INTO campaigns (user_id, title, message, media_url, contact_group_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
       RETURNING *`,
      [src.user_id, src.title, src.message, src.media_url, src.contact_group_id]
    );
    const newCampaign = cloneRes.rows[0];

    // Build retry set from failed logs (join to ensure valid phone)
    const failedContacts = await pool.query(
      `SELECT DISTINCT cl.contact_id
       FROM campaign_logs cl
       JOIN contacts c ON c.id = cl.contact_id
       WHERE cl.campaign_id = $1 AND cl.status = 'failed' AND c.user_id = $2 AND c.phone IS NOT NULL`,
      [id, userId]
    );

    const retryCount = failedContacts.rowCount;
    if (retryCount === 0) {
      return res.status(400).json({ success: false, message: 'No failed contacts to retry.' });
    }

    // Online coins authorization (Render)
    const authHeader = req.headers['authorization'] || '';
    let retryCoinsAuthorized = 0;
    try {
      await authorizeCoinsRemote(retryCount, authHeader, req.user || {});
      retryCoinsAuthorized = retryCount;
    } catch (e) {
      return res.status(400).json({ success: false, message: e?.message || 'Coin authorization failed' });
    }

    // Create pending logs for retry contacts
    await pool.query('BEGIN');
    try {
      // Batch insert for better performance
      const failedIds = failedContacts.rows.map(r => r.contact_id);
      await pool.query(
        `INSERT INTO campaign_logs (campaign_id, contact_id, phone, message, media_url, status)
         SELECT $1, id, phone, $2, $3, 'pending' FROM contacts WHERE id = ANY($4)
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [newCampaign.id, newCampaign.message, newCampaign.media_url, failedIds]
      );
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      if (retryCoinsAuthorized > 0 && authHeader) {
        try { await refundCoinsRemote(retryCoinsAuthorized, authHeader); } catch (refundErr) {
          console.warn('⚠️ Coin refund failed after retry rollback:', refundErr.message);
        }
      }
      throw e;
    }

    // Start the new campaign
    await pool.query(
      "UPDATE campaigns SET status='running', started_at=CURRENT_TIMESTAMP, coins_spent=$2 WHERE id=$1",
      [newCampaign.id, retryCoinsAuthorized]
    );
    sendCampaign(newCampaign.id, authHeader).catch(async (error) => {
      console.error('Retry-failed send error:', error);
      await pool.query("UPDATE campaigns SET status='failed', error_message=$1, completed_at=CURRENT_TIMESTAMP WHERE id=$2", [error.message, newCampaign.id]);
      await pool.query("UPDATE campaign_logs SET status='failed', error_message=$2 WHERE campaign_id=$1 AND status='pending'", [newCampaign.id, error.message]);
      if (retryCoinsAuthorized > 0 && authHeader) {
        try {
          const sentResult = await pool.query(
            "SELECT COUNT(*) as sent FROM campaign_logs WHERE campaign_id = $1 AND status = 'sent'",
            [newCampaign.id]
          );
          const sentCount = parseInt(sentResult.rows[0]?.sent || 0);
          const toRefund = retryCoinsAuthorized - sentCount;
          if (toRefund > 0) {
            await refundCoinsRemote(toRefund, authHeader);
          }
          await pool.query('UPDATE campaigns SET coins_spent = $1 WHERE id = $2', [sentCount, newCampaign.id]);
        } catch (refundErr) {
          console.warn('⚠️ Failed to refund coins after retry failure:', refundErr.message);
        }
      }
    });

    res.json({ success: true, message: 'Retry of failed contacts started', campaign: newCampaign });
  } catch (error) {
    console.error('Retry failed error:', error);
    res.status(500).json({ success: false, message: error?.message || 'Failed to retry failed contacts' });
  }
};

export const pauseCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);

    // Verify ownership
    const campaignCheck = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1 AND user_id = $2",
      [id, userId]
    );

    if (campaignCheck.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Campaign not found or unauthorized" });
    }

    const campaign = campaignCheck.rows[0];

    // Use queue-based pause system
    const result = await pauseCampaignService(id);

    // Calculate and refund unused coins
    const authHeader = req.headers['authorization'] || '';
    if (authHeader && campaign.coins_spent > 0) {
      try {
        // Count sent messages
        const sentResult = await pool.query(
          "SELECT COUNT(*) as sent FROM campaign_logs WHERE campaign_id = $1 AND status = 'sent'",
          [id]
        );
        const sentCount = parseInt(sentResult.rows[0].sent || 0);
        const coinsReserved = campaign.coins_spent || 0;
        const coinsToRefund = coinsReserved - sentCount;

        if (coinsToRefund > 0) {
          console.log(`💰 Refunding ${coinsToRefund} unused coins for campaign ${id}`);
          await refundCoinsRemote(coinsToRefund, authHeader);
          
          // Update coins_spent to reflect actual usage
          await pool.query(
            'UPDATE campaigns SET coins_spent = $1 WHERE id = $2',
            [sentCount, id]
          );
        }
      } catch (refundError) {
        console.warn('⚠️ Coin refund failed:', refundError.message);
        // Don't fail the pause operation if refund fails
      }
    }

    // Get updated campaign data
    const updatedCampaign = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1",
      [id]
    );

    console.log(`✅ Campaign ${id} paused successfully`);
    res.json({
      success: true,
      campaign: updatedCampaign.rows[0],
      message: "Campaign paused successfully. Unused coins have been refunded."
    });
  } catch (error) {
    console.error("Pause campaign error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to pause campaign" });
  }
};

export const resumeCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = await resolveLocalUserId(req);

    const campaign = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1 AND user_id = $2",
      [id, userId]
    );

    if (campaign.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Campaign not found" });
    }

    if (campaign.rows[0].status !== 'paused') {
      return res.status(400).json({ success: false, message: "Campaign is not paused" });
    }

    // Ensure WhatsApp is ready
    const status = getWhatsAppStatus();
    if (!status.ready) {
      return res.status(400).json({
        success: false,
        needsLogin: true,
        qr: status.qr || null,
        message: "Please scan QR code to connect WhatsApp before resuming campaign"
      });
    }

    const authHeader = req.headers['authorization'] || '';

    // Use queue-based resume system
    const result = await resumeCampaignService(id, authHeader);

    // Get updated campaign data
    const updatedCampaign = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1",
      [id]
    );

    console.log(`✅ Campaign ${id} resumed successfully`);
    res.json({
      success: true,
      campaign: updatedCampaign.rows[0],
      message: "Campaign resumed successfully. Messages will continue from where they stopped."
    });
  } catch (error) {
    console.error("Resume campaign error:", error);
    res.status(500).json({ success: false, message: error?.message || "Failed to resume campaign" });
  }
};

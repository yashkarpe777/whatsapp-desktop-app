import { hotPool } from "../src/db.js";
import { getUserCoins } from "../src/services/coinService.js";

const pool = hotPool;

async function resolveLocalUserId(req) {
  const info = req.user || {};
  const userId = info.id || info.userId || null;
  
  if (!userId) {
    throw new Error('User ID not found in token. Please login again.');
  }
  
  return userId;
}

export const getDashboardStats = async (req, res) => {
  try {
    const userId = req.user ? await resolveLocalUserId(req) : null;
    
    // If no user, return default stats
    if (!userId) {
      return res.json({
        total_contacts: 0,
        active_campaigns: 0,
        total_sent: 0,
        success_rate: 0,
        recent_campaigns: [],
        completed_campaigns: 0,
        remaining_coins: 0,
        stopped_campaigns: 0,
        in_progress_campaigns: 0
      });
    }

    // Get user-specific stats
    const totalContactsRes = await pool.query(
      "SELECT COUNT(*) FROM contacts WHERE user_id = $1", [userId]
    );
    
    const activeCampaignsRes = await pool.query(
      "SELECT COUNT(*) FROM campaigns WHERE status = 'running' AND user_id = $1", [userId]
    );
    
    const totalSentRes = await pool.query(`
      SELECT COUNT(*) 
      FROM campaign_logs cl 
      JOIN campaigns c ON cl.campaign_id = c.id 
      WHERE cl.status = 'sent' AND c.user_id = $1
    `, [userId]);
    
    const successRateRes = await pool.query(`
      SELECT COALESCE(ROUND(
        (COUNT(*) FILTER (WHERE cl.status = 'sent')::decimal / NULLIF(COUNT(*), 0)) * 100, 2
      ), 0) AS success_rate
      FROM campaign_logs cl
      JOIN campaigns c ON cl.campaign_id = c.id 
      WHERE c.user_id = $1
    `, [userId]);
    
    const recentCampaignsRes = await pool.query(`
      SELECT
        c.id,
        c.title as name,
        c.status,
        c.created_at,
        (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id) AS total_contacts,
        (SELECT COUNT(*) FROM campaign_logs cl WHERE cl.campaign_id = c.id AND cl.status = 'sent') AS sent
      FROM campaigns c
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC
      LIMIT 5
    `, [userId]);

    const completedCampaignsRes = await pool.query(
      "SELECT COUNT(*) FROM campaigns WHERE status = 'completed' AND user_id = $1", [userId]
    );

    const remainingCoins = await getUserCoins(userId);

    const stoppedCampaignsRes = await pool.query(
      "SELECT COUNT(*) FROM campaigns WHERE status = 'failed' AND user_id = $1", [userId]
    );

    const inProgressCampaignsRes = await pool.query(
      "SELECT COUNT(*) FROM campaigns WHERE status = 'paused' AND user_id = $1", [userId]
    );

    const stats = {
      total_contacts: parseInt(totalContactsRes.rows[0].count),
      active_campaigns: parseInt(activeCampaignsRes.rows[0].count),
      total_sent: parseInt(totalSentRes.rows[0].count),
      success_rate: parseFloat(successRateRes.rows[0].success_rate || 0),
      recent_campaigns: recentCampaignsRes.rows,
      completed_campaigns: parseInt(completedCampaignsRes.rows[0].count),
      remaining_coins: remainingCoins,
      stopped_campaigns: parseInt(stoppedCampaignsRes.rows[0].count),
      in_progress_campaigns: parseInt(inProgressCampaignsRes.rows[0].count)
    };

    res.json(stats);
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
};

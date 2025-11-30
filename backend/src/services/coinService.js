import { getActivePool } from "../db.js";

function requirePool() {
  const pool = getActivePool();
  if (!pool) {
    throw new Error("Database connection is not available");
  }
  return pool;
}

async function withTransaction(callback) {
  const pool = requirePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserCoins(userId) {
  const pool = requirePool();
  const res = await pool.query("SELECT coins FROM users WHERE id=$1", [userId]);
  return parseInt(res.rows?.[0]?.coins ?? 0);
}

export async function reserveCampaignCoins(userId, campaignId, requiredCoins) {
  if (!requiredCoins || requiredCoins <= 0) {
    throw new Error("requiredCoins must be greater than zero");
  }

  return withTransaction(async (client) => {
    const res = await client.query(
      "SELECT coins FROM users WHERE id=$1 FOR UPDATE",
      [userId]
    );
    if (res.rowCount === 0) {
      throw new Error("User not found");
    }
    const available = parseInt(res.rows[0]?.coins ?? 0);
    if (available < requiredCoins) {
      throw new Error(
        `Insufficient coins. Required: ${requiredCoins}, Available: ${available}. Please ask admin to add more coins.`
      );
    }

    await client.query("UPDATE users SET coins = coins - $1 WHERE id=$2", [
      requiredCoins,
      userId,
    ]);

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, campaign_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, -requiredCoins, "campaign_reserve", campaignId || null]
    );

    return {
      reserved: requiredCoins,
      remaining: available - requiredCoins,
    };
  });
}

export async function refundCampaignCoins(
  userId,
  amount,
  campaignId = null,
  reason = "campaign_refund"
) {
  if (!amount || amount <= 0) {
    return 0;
  }

  return withTransaction(async (client) => {
    await client.query("UPDATE users SET coins = coins + $1 WHERE id=$2", [
      amount,
      userId,
    ]);

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, campaign_id)
       VALUES ($1, $2, $3, $4)`,
      [userId, amount, reason, campaignId]
    );

    return amount;
  });
}

export async function syncCampaignCoinSpend(campaignId) {
  const pool = requirePool();
  const campaignRes = await pool.query(
    "SELECT id, user_id, coins_spent FROM campaigns WHERE id=$1",
    [campaignId]
  );
  if (campaignRes.rowCount === 0) {
    return null;
  }
  const campaign = campaignRes.rows[0];
  const sentRes = await pool.query(
    "SELECT COUNT(*) AS sent FROM campaign_logs WHERE campaign_id=$1 AND status='sent'",
    [campaignId]
  );
  const sentCount = parseInt(sentRes.rows?.[0]?.sent ?? 0);
  const reserved = parseInt(campaign.coins_spent ?? 0);
  const toRefund = Math.max(0, reserved - sentCount);

  if (toRefund > 0) {
    await refundCampaignCoins(campaign.user_id, toRefund, campaignId);
  }

  if (reserved !== sentCount) {
    await pool.query("UPDATE campaigns SET coins_spent=$1 WHERE id=$2", [
      sentCount,
      campaignId,
    ]);
  }

  return { sent: sentCount, reserved, refunded: toRefund };
}

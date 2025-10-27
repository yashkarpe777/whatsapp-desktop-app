import pool from "../db.js";

export async function getBalance(userId) {
  const res = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
  return res.rows.length ? res.rows[0].coins : 0;
}

async function addCoins(adminId, userId, amount) {
  await pool.query('BEGIN')
  try {
    const adminRes = await pool.query('SELECT role, coins FROM users WHERE id=$1', [adminId])
    if (adminRes.rows.length === 0 || adminRes.rows[0].role !== 'admin') throw new Error('Unauthorized')
    if (adminRes.rows[0].coins < amount) throw new Error('Insufficient admin balance')
    await pool.query('UPDATE users SET coins = coins - $1 WHERE id=$2', [amount, adminId])
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [amount, userId])
    await pool.query(
      'INSERT INTO transactions (sender_id, receiver_id, amount, type) VALUES ($1,$2,$3,$4)',
      [adminId, userId, amount, 'transfer']
    )
    await pool.query('COMMIT')
    return { success: true }
  } catch (err) {
    await pool.query('ROLLBACK')
    return { success: false, error: err.message }
  }
}

export async function deductCoins(userId, amount, campaignId) {
  return new Promise((resolve) => {
    pool.query('BEGIN', async (err) => {
      if (err) return resolve({ success: false, error: err.message });
      try {
        const userRes = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
        if (userRes.rows.length === 0) throw new Error('User not found');
        if (userRes.rows[0].coins < amount) throw new Error('Insufficient balance');
        await pool.query('UPDATE users SET coins = coins - $1 WHERE id=$2', [amount, userId]);
        await pool.query(
          'INSERT INTO coin_transactions (user_id, amount, type) VALUES ($1, $2, $3)',
          [userId, -amount, 'campaign_usage']
        ); // Use coin_transactions table
        await pool.query('COMMIT');
        resolve({ success: true });
      } catch (err) {
        await pool.query('ROLLBACK');
        resolve({ success: false, error: err.message });
      }
    });
  });
}



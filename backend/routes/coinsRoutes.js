import express from 'express';
import { hostPool } from '../src/db.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = express.Router();
const pool = hostPool; 
router.use(authenticateToken);


router.get('/balance', async (req, res) => {
  try {
    const userId = req.user.id;
    const r = await pool.query('SELECT coins FROM users WHERE id=$1', [userId]);
    if (r.rowCount === 0) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, coins: r.rows[0].coins });
  } catch (e) {
    console.error('Balance error:', e);
    res.status(500).json({ success: false, message: 'Failed to get balance' });
  }
});

// Atomically authorize (reserve) coins for a send
router.post('/authorize', async (req, res) => {
  const userId = req.user.id;
  const required = parseInt(req.body.required);
  if (!required || required <= 0) return res.status(400).json({ success: false, message: 'required must be > 0' });

  try {
    await pool.query('BEGIN');
    const sel = await pool.query('SELECT coins FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (sel.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const coins = sel.rows[0].coins || 0;
    if (coins < required) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Insufficient coins. Required: ${required}, Available: ${coins}` });
    }
    await pool.query('UPDATE users SET coins = coins - $1 WHERE id=$2', [required, userId]);
    await pool.query('INSERT INTO coin_transactions (user_id, amount, type) VALUES ($1,$2,$3)', [userId, -required, 'reserve']);
    await pool.query('COMMIT');
    res.json({ success: true, reserved: required });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('Authorize coins error:', e);
    res.status(500).json({ success: false, message: 'Failed to authorize coins' });
  }
});

// Refund coins (e.g., unused)
router.post('/refund', async (req, res) => {
  const userId = req.user.id;
  const amount = parseInt(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'amount must be > 0' });
  try {
    await pool.query('BEGIN');
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [amount, userId]);
    await pool.query('INSERT INTO coin_transactions (user_id, amount, type) VALUES ($1,$2,$3)', [userId, amount, 'refund']);
    await pool.query('COMMIT');
    res.json({ success: true, refunded: amount });
  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('Refund coins error:', e);
    res.status(500).json({ success: false, message: 'Failed to refund coins' });
  }
});

export default router;
import express from "express";
import { hostPool } from "../src/db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import bcrypt from "bcryptjs";
import { getCleanupStats, runCleanup } from "../src/services/cleanupService.js";

const router = express.Router();
const pool = hostPool; // Admin operations always use Host (cloud) DB

// Lightweight diagnostics (no auth) to verify Render configuration
router.get('/check', (req, res) => {
  const svc = process.env.SERVICE_MODE || 'all';
  const emailSet = Boolean(process.env.EMAIL_USER);
  const passSet = Boolean(process.env.EMAIL_PASS);
  const dbUrl = process.env.DATABASE_URL || '';
  let dbHost = 'unknown';
  try {
    // Normalize driver to parseable URL
    const normalized = dbUrl.replace(/^postgres(ql)?:\/\//, 'http://');
    const u = new URL(normalized);
    dbHost = u.hostname || 'unknown';
  } catch {}
  return res.json({
    ok: true,
    service_mode: svc,
    coins_only: svc === 'coins-only',
    email_configured: emailSet && passSet,
    db_host: dbHost,
  });
});

// Bootstrap first admin (no auth) guarded by a secret token
router.post('/bootstrap', async (req, res) => {
  try {
    const secret = process.env.ADMIN_BOOTSTRAP_TOKEN;
    const headerToken = req.headers['x-bootstrap-token'];
    const bodyToken = req.body?.token;
    const token = headerToken || bodyToken;
    if (!secret) return res.status(500).json({ error: 'ADMIN_BOOTSTRAP_TOKEN not configured' });
    if (!token || token !== secret) return res.status(403).json({ error: 'Forbidden' });

    const { email, username, coins = 0, password } = req.body || {};
    if (!email || !username) return res.status(400).json({ error: 'email and username are required' });

    const passwordHash = password ? await bcrypt.hash(String(password), 10) : '';

    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash, role, coins)
       VALUES ($1, $2, $3, 'admin', $4)
       ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username, role = 'admin', password_hash = COALESCE(NULLIF(EXCLUDED.password_hash, ''), users.password_hash)
       RETURNING id, email, username, role, coins`,
      [email, username, passwordHash, coins]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('✗ Bootstrap Admin Error:', err);
    res.status(500).json({ error: 'Failed to bootstrap admin' });
  }
});

// Admin-only route
router.post("/credit", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.sendStatus(403);

    const { userId, amount } = req.body;

    await pool.query("UPDATE users SET coins = coins + $1 WHERE id=$2", [
      amount,
      userId,
    ]);

    await pool.query(
      "INSERT INTO coin_transactions (user_id, amount, type) VALUES ($1, $2, $3)",
      [userId, amount, "admin_grant"]
    );

    res.json({ message: "Coins credited successfully" });
  } catch (err) {
    console.error("✗ Coin Credit Error:", err);
    res.status(500).json({ error: "Coin credit failed" });
  }
});

// Admin get users for coin management
router.get("/users", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.sendStatus(403);

    const result = await pool.query("SELECT id, email, username, role, coins FROM users ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    console.error("✗ Get Users Error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Admin create user (optionally set initial password)
router.post("/users", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.sendStatus(403);

    const { email, username, role = 'user', coins = 0, password } = req.body;
    if (!email || !username) return res.status(400).json({ message: 'email and username are required' });

    const passwordHash = password ? await bcrypt.hash(String(password), 10) : '';

    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash, role, coins)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username, role = EXCLUDED.role, password_hash = COALESCE(NULLIF(EXCLUDED.password_hash, ''), users.password_hash)
       RETURNING id, email, username, role, coins`,
      [email, username, passwordHash, role, coins]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("✗ Create User Error:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Admin: set/reset password for a user
router.post('/users/:id/password', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const userId = Number(req.params.id);
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password is required' });
    const hash = await bcrypt.hash(String(password), 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('✗ Set Password Error:', err);
    res.status(500).json({ error: 'Failed to set password' });
  }
});

// Admin: delete a user
router.delete('/users/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const userId = Number(req.params.id);
    
    // Prevent deleting yourself
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    
    // Delete user
    const result = await pool.query('DELETE FROM users WHERE id=$1 RETURNING id, email, username', [userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true, message: 'User deleted successfully', user: result.rows[0] });
  } catch (err) {
    console.error('✗ Delete User Error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Get cleanup statistics
router.get('/cleanup/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    
    const stats = await getCleanupStats();
    res.json({ success: true, stats });
  } catch (err) {
    console.error('✗ Get Cleanup Stats Error:', err);
    res.status(500).json({ error: 'Failed to get cleanup stats' });
  }
});

// Manually trigger cleanup
router.post('/cleanup/run', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    
    const deletedCount = await runCleanup();
    res.json({ success: true, deletedCount, message: `Cleanup completed: ${deletedCount} items removed` });
  } catch (err) {
    console.error('✗ Manual Cleanup Error:', err);
    res.status(500).json({ error: 'Failed to run cleanup' });
  }
});

export default router;

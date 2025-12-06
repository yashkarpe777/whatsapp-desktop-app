import express from "express";
import jwt from "jsonwebtoken";
import { getLocalPool, hostPool, hotPool } from "../src/db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
import bcrypt from "bcryptjs";

let nodemailer = null;
try {
  nodemailer = (await import("nodemailer")).default;
} catch (err) {
  console.warn('⚠️ nodemailer not available - OTP emails disabled');
}

const router = express.Router();

// Prefer Render DB for auth/coins; automatic fallback to Local/hot on transient errors
function isTransientDbError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    msg.includes('connection terminated') ||
    msg.includes('timeout') ||
    msg.includes('terminat') ||
    msg.includes('getaddrinfo enotfound') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    code === 'etimedout' || code === 'enotfound' || code === 'econnrefused'
  );
}

const AUTH_DB = (process.env.AUTH_DB || 'auto').toLowerCase();

async function queryWithFallback(sql, params) {
  const errors = [];
  
  if (AUTH_DB === 'render') {
    if (!hostPool) throw new Error('Host DB not configured');
    try {
      return await hostPool.query(sql, params);
    } catch (e) {
      console.error('✗ Host DB query failed (explicit mode):', e?.message);
      throw e;
    }
  }
  if (AUTH_DB === 'local') {
    const lp = getLocalPool();
    if (lp) {
      try {
        return await lp.query(sql, params);
      } catch (e) {
        console.error('✗ Local DB query failed (explicit mode):', e?.message);
        throw e;
      }
    }
    try {
      return await hotPool.query(sql, params);
    } catch (e) {
      console.error('✗ Hot pool query failed (local mode fallback):', e?.message);
      throw e;
    }
  }


  if (hostPool) {
    try {
      console.log('🔄 Trying host DB for auth query...');
      return await hostPool.query(sql, params);
    } catch (e) {
      console.warn('⚠️ Host DB failed, trying fallback:', e?.message);
      errors.push(`Host: ${e?.message}`);
      if (!isTransientDbError(e)) {
        console.error('✗ Host DB hard failure, not retrying:', e?.message);
        throw e; 
      }

    }
  }
  
  const lp = getLocalPool();
  if (lp) {
    try {
      console.log('🔄 Trying Local DB for auth query...');
      return await lp.query(sql, params);
    } catch (e) {
      console.warn('⚠️ Local DB failed, trying hot pool:', e?.message);
      errors.push(`Local: ${e?.message}`);
      if (!isTransientDbError(e)) {
        console.error('✗ Local DB hard failure, not retrying:', e?.message);
        throw e;
      }
    }
  }
  
  try {
    console.log('🔄 Trying hot pool for auth query...');
    return await hotPool.query(sql, params);
  } catch (e) {
    console.error('✗ Hot pool failed:', e?.message);
    errors.push(`Hot: ${e?.message}`);
    const allErrors = errors.join('; ');
    throw new Error(`All DB pools failed: ${allErrors}`);
  }
}

const pool = { query: queryWithFallback };


const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false') === 'true';

function buildTransporter(host = SMTP_HOST, port = SMTP_PORT, secure = SMTP_SECURE) {
  if (!nodemailer) throw new Error('nodemailer not available');
  const commonTimeout = {
    connectionTimeout: Number(process.env.SMTP_CONN_TIMEOUT || 15000),
    greetingTimeout: Number(process.env.SMTP_GREET_TIMEOUT || 15000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 20000),
  };
  return nodemailer.createTransport({
    host,
    port,
    secure,
    pool: true,
    maxConnections: 1,
    rateDelta: 1000,
    rateLimit: 5,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, 
    },
    ...(secure ? {} : { requireTLS: true }),
    ...commonTimeout,
  });
}
function getSmtpConfig(profile) {
  const p = String(profile || 'SMTP1').toUpperCase();
  const host = process.env[`${p}_HOST`] || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env[`${p}_PORT`] || process.env.SMTP_PORT || '587');
  const secure = String(process.env[`${p}_SECURE`] || process.env.SMTP_SECURE || 'false') === 'true';
  const user = process.env[`${p}_USER`] || process.env.EMAIL_USER;
  const pass = process.env[`${p}_PASS`] || process.env.EMAIL_PASS;
  return { host, port, secure, user, pass };
}

function buildTransporterFromConfig(cfg) {
  if (!nodemailer) throw new Error('nodemailer not available');
  const commonTimeout = {
    connectionTimeout: Number(process.env.SMTP_CONN_TIMEOUT || 15000),
    greetingTimeout: Number(process.env.SMTP_GREET_TIMEOUT || 15000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 20000),
  };
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    pool: true,
    maxConnections: 1,
    rateDelta: 1000,
    rateLimit: 5,
    auth: { user: cfg.user, pass: cfg.pass },
    ...(cfg.secure ? {} : { requireTLS: true }),
    ...commonTimeout,
  });
}

async function sendViaSmtpProfile(profile, toEmail, subject, text) {
  const cfg = getSmtpConfig(profile);
  const from = process.env.FROM_EMAIL || cfg.user;
  const mail = { from, to: toEmail, subject, text };

  try {
    const t = buildTransporterFromConfig(cfg);
    await t.sendMail(mail);
    console.log(`📧 OTP email sent to ${toEmail} via ${cfg.host}:${cfg.port}${cfg.secure ? ' (SMTPS)' : ''}`);
    return true;
  } catch (e) {
    // Automatic retry on 465 if 587 timed out
    if (e && e.code === 'ETIMEDOUT' && cfg.port === 587) {
      try {
        console.warn(`${cfg.host}:587 timed out; retrying on 465 SMTPS...`);
        const t465 = buildTransporterFromConfig({ ...cfg, port: 465, secure: true });
        await t465.sendMail(mail);
        console.log(`📧 OTP email sent to ${toEmail} via ${cfg.host}:465 (SMTPS)`);
        return true;
      } catch (e2) {
        console.error('✗ SMTP retry failed:', e2);
        throw e2;
      }
    }
    throw e;
  }
}

async function sendViaResend(toEmail, subject, text) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || process.env.EMAIL_USER;
  if (!key) throw new Error('RESEND_API_KEY not set');
  if (!from) throw new Error('FROM_EMAIL/EMAIL_USER not set');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: toEmail, subject, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend failed: ${res.status} ${body}`);
  }
  console.log(`📧 OTP email sent to ${toEmail} via Resend API`);
  return true;
}

async function sendOtpEmail(toEmail, otp) {
  let providers = (process.env.EMAIL_PROVIDERS || 'smtp1')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  if (!process.env.RESEND_API_KEY) {
    providers = providers.filter(p => p !== 'resend');
  }

  if (providers.length === 0) providers = ['smtp1'];

  const subject = 'Your OTP Code';
  const text = `Your OTP is ${otp}. It expires in 5 minutes.`;

  const errors = [];
  for (const p of providers) {
    try {
      if (p === 'resend') {
        await sendViaResend(toEmail, subject, text);
        return;
      }
      if (p.startsWith('smtp')) {
        await sendViaSmtpProfile(p, toEmail, subject, text);
        return;
      }
      console.warn(`Unknown email provider '${p}' in EMAIL_PROVIDERS; skipping`);
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
      console.warn(`Email provider failed (${p}):`, err.code || '', err.message);
    }
  }
  throw new Error(`All email providers failed -> ${errors.join(' | ')}`);
}

// New: Username + Password login (preferred)
router.post("/login-password", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const userRes = await pool.query(
      "SELECT id, email, username, role, coins, password_hash FROM users WHERE (username=$1 OR email=$1) AND role IN ('user','admin')",
      [username]
    );
    if (userRes.rowCount === 0) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const user = userRes.rows[0];
    if (!user.password_hash) {
      return res.status(400).json({ error: "Password not set. Contact admin." });
    }

    const ok = await bcrypt.compare(String(password), String(user.password_hash));
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET
    );

    res.json({
      message: "Login successful",
      token,
      user: { id: user.id, email: user.email, username: user.username, role: user.role, coins: user.coins }
    });
  } catch (err) {
    console.error("✗ Password Login Error:", err);
    console.error("✗ Error details:", {
      message: err?.message,
      code: err?.code,
      stack: err?.stack?.split('\n').slice(0, 3).join('\n')
    });
    res.status(500).json({ 
      error: "Login failed",
      details: process.env.NODE_ENV === 'development' ? err?.message : undefined
    });
  }
});



// Refresh access token without disturbing client work
// Accepts an expired token but with a valid signature (primary or secondary)


// // Temporary bypass for testing
// router.post("/login-password", async (req, res) => {
//   try {
//     const { username, password } = req.body || {};
    
//     if (!username || !password) {
//       return res.status(400).json({ error: "username and password are required" });
//     }



    
//     // HARDCODED TEST CREDENTIALS (Temporary)
//     if (username === 'admin123' && password === 'admin123') {
//       const token = jwt.sign(
//         { id: 1, email: 'admin@example.com', role: 'admin' },
//         process.env.JWT_SECRET
//       );

//       return res.json({
//         message: "Login successful (test mode)",
//         token,
//         user: { 
//           id: 1, 
//           email: 'admin@example.com', 
//           username: 'admin123', 
//           role: 'admin', 
//           coins: 1000 
//         }
//       });
//     }

//     // Rest of your original code...
//     const userRes = await pool.query(
//       "SELECT id, email, username, role, coins, password_hash FROM users WHERE (username=$1 OR email=$1) AND role IN ('user','admin')",
//       [username]
//     );
    
//     // ... rest of code
//   } catch (err) {
//     console.error("✗ Password Login Error:", err.message);
//     res.status(500).json({ 
//       error: "Login failed",
//       details: "Database connection issue"
//     });
//   }
// });
router.post('/refresh', async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'NO_TOKEN' });

    const primary = process.env.JWT_SECRET;
    const secondary = process.env.JWT_SECRET_ALT;
    if (!primary) return res.status(500).json({ error: 'SERVER_MISCONFIGURED' });

    let payload;
    try {
      payload = jwt.verify(token, primary, { ignoreExpiration: true });
    } catch (e1) {
      if (!secondary) return res.status(403).json({ error: 'INVALID_TOKEN' });
      try {
        payload = jwt.verify(token, secondary, { ignoreExpiration: true });
      } catch (e2) {
        return res.status(403).json({ error: 'INVALID_TOKEN' });
      }
    }

    // Optional: ensure user still exists (against preferred DB)
    try {
      const r = await queryWithFallback('SELECT id, email, username, role, coins FROM users WHERE id=$1', [payload.id || payload.userId]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'USER_NOT_FOUND' });
      payload = { id: r.rows[0].id, email: r.rows[0].email, role: r.rows[0].role };
    } catch {}

    const newToken = jwt.sign(payload, primary, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
    return res.json({ token: newToken });
  } catch (err) {
    console.error('✗ Refresh error:', err?.message || err);
    return res.status(500).json({ error: 'REFRESH_FAILED' });
  }
});

// Current token inspection endpoint (unchanged)
router.get('/me', async (req, res) => {
  try {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ message: 'No token' });
    const token = auth.replace('Bearer ', '');
    const jwt = (await import('jsonwebtoken')).default;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userRes = await pool.query('SELECT id, email, username, role, coins FROM users WHERE id=$1', [decoded.id]);
    if (userRes.rowCount === 0) return res.status(404).json({ message: 'User not found' });
    res.json(userRes.rows[0]);
  } catch (e) {
    res.status(401).json({ message: 'Invalid token' });
  }
});

// Legacy email OTP routes retained for backward compatibility (can be removed later)
router.post("/login", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1 AND role IN ('user','admin')",
      [email]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ error: "User not found or not allowed" });

    const user = result.rows[0];

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60000); // 5 min expiry

    await pool.query(
      "INSERT INTO otp_codes (user_id, otp, expires_at) VALUES ($1, $2, $3)",
      [user.id, otp, expiresAt]
    );

    if (process.env.DEV_LOG_OTP === 'true') {
      console.log(`🔐 DEV OTP for ${user.email}: ${otp}`);
      return res.json({ message: "OTP generated (development mode)", dev: true });
    }

    res.json({ message: "OTP is being sent" });

    setImmediate(async () => {
      try {
        await sendOtpEmail(user.email, otp);
      } catch (mailErr) {
        console.error("✗ OTP email send error:", mailErr);
      }
    });
  } catch (err) {
    console.error("✗ OTP Error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    let { email, otp } = req.body;
    if (!email || !otp)
      return res.status(400).json({ error: "Email and OTP are required" });

    otp = String(otp).trim();

    const userResult = await pool.query(
      "SELECT * FROM users WHERE email=$1 AND role IN ('user','admin')",
      [email]
    );
    if (!userResult.rows.length)
      return res.status(400).json({ error: "User not found" });

    const user = userResult.rows[0];

    const otpResult = await pool.query(
      `SELECT * FROM otp_codes
       WHERE user_id=$1 AND otp=$2 AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [user.id, otp]
    );

    if (!otpResult.rows.length)
      return res.status(400).json({ error: "Invalid or expired OTP" });

    await pool.query("DELETE FROM otp_codes WHERE user_id=$1 AND otp=$2", [
      user.id,
      otp,
    ]);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET
    );

    res.json({
      message: "Login successful",
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("✗ Verify OTP Error:", err);
    res.status(500).json({ error: "OTP verification failed" });
  }
});

export default router;

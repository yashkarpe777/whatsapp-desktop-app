import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Ensure env loaded from backend/.env in dev
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch {}

function getBase() {
  let base = process.env.ADMIN_API_BASE_URL || process.env.COINS_API_BASE_URL || '';
  if (!base) return '';
  base = base.replace(/\/$/, '');
  if (!/\/api$/i.test(base)) base += '/api';
  return base;
}

function pathOr(defaultPath, envName) {
  let p = process.env[envName];
  if (!p) return defaultPath;
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

function headersWithToken(authHeader) {
  const h = { 'Content-Type': 'application/json' };
  if (authHeader && String(authHeader).toLowerCase().startsWith('bearer ')) h['Authorization'] = authHeader;
  return h;
}

export async function authorizeCoinsRemote(required, authHeader, userCtx = {}) {
  const base = getBase();
  if (!base) throw new Error('ADMIN_API_BASE_URL not configured');
  const path = pathOr('/coins/authorize', 'COINS_AUTHORIZE_PATH');
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headersWithToken(authHeader),
    body: JSON.stringify({
      required,
      // Provide optional identity fields if available; admin API can ignore if not needed
      email: userCtx?.email,
      userId: userCtx?.id || userCtx?.userId,
    })
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    console.warn(`[coins] authorize failed -> ${url} :: ${res.status} ${body}`);
    throw new Error(`Coins authorize failed: ${res.status} ${body}`);
  }
  return await res.json();
}

export async function refundCoinsRemote(amount, authHeader) {
  const base = getBase();
  if (!base) throw new Error('ADMIN_API_BASE_URL not configured');
  const path = pathOr('/coins/refund', 'COINS_REFUND_PATH');
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headersWithToken(authHeader),
    body: JSON.stringify({ amount })
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    console.warn(`[coins] refund failed -> ${url} :: ${res.status} ${body}`);
    throw new Error(`Coins refund failed: ${res.status} ${body}`);
  }
  return await res.json();
}

export async function getBalanceRemote(authHeader) {
  const base = getBase();
  if (!base) throw new Error('ADMIN_API_BASE_URL not configured');
  const path = pathOr('/coins/balance', 'COINS_BALANCE_PATH');
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: headersWithToken(authHeader),
  });
  if (!res.ok) {
    console.warn(`[coins] balance failed -> ${url} :: ${res.status}`);
    throw new Error(`Coins balance failed: ${res.status}`);
  }
  return await res.json();
}

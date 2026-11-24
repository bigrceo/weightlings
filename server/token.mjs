// The coin, settable at runtime so the CA shows the moment it exists (no redeploy):
//   POST /api/admin/token {token, ticker} with header x-admin: $ADMIN_SECRET
// The env TOKEN / TICKER still work and win once set on Railway.
import crypto from 'node:crypto';
import { kv } from './db.mjs';
export const token = () => process.env.TOKEN || kv.get('token_override', '') || '';
export const ticker = () => process.env.TICKER || kv.get('ticker_override', '') || '';
export function setFromAdmin(req, b) {
  const want = process.env.ADMIN_SECRET || '', got = String(req.headers['x-admin'] || '');
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { status: 403, body: { error: 'forbidden' } };
  if (!/^0x[0-9a-fA-F]{40}$/.test(b.token || '')) return { status: 400, body: { error: 'token must be a 0x address' } };
  kv.set('token_override', b.token);
  if (b.ticker) kv.set('ticker_override', String(b.ticker).replace(/^\$/, '').slice(0, 12));
  return { status: 200, body: { token: token(), ticker: ticker() } };
}

// Receipts. A finished hire is written once as canonical JSON (keys sorted, no whitespace: the same canonical() the round
// commitments use, imported from /cull.v2.js), hashed with SHA-256, the 32 hash bytes signed with the server's Ed25519 key,
// and the hash sent to OpenTimestamps so its existence at that time is anchored in Bitcoin.
//
//   receiptHash = "0x" + hex(sha256(utf8(canonical(receipt))))
//   signature   = Ed25519(serverKey, the 32 raw bytes of receiptHash)       (hex, 64 bytes)
//   public key  = GET /api/hire/key
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonical } from '../../public/cull.v2.js';
import * as ots from '../ots.mjs';
import { db } from '../db.mjs';
import { q } from './store.mjs';

export { canonical };
export const sha256hex = (s) => '0x' + createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');
export const receiptHashOf = (receipt) => sha256hex(canonical(receipt));

// ---------- the signing key: HIRE_SIGNING_KEY (PEM, or a 32-byte seed as hex / base64), else made once in the data dir ----------
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
function loadKey() {
  const env = (process.env.HIRE_SIGNING_KEY || '').trim();
  if (env) {
    if (env.includes('BEGIN')) return createPrivateKey(env.replace(/\\n/g, '\n'));
    const seed = /^(0x)?[0-9a-fA-F]{64}$/.test(env) ? Buffer.from(env.replace(/^0x/, ''), 'hex') : Buffer.from(env, 'base64');
    if (seed.length !== 32) throw new Error('HIRE_SIGNING_KEY must be a PEM private key or a 32-byte Ed25519 seed (hex or base64)');
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  }
  const dir = process.env.DATA_DIR || path.resolve('data'), file = path.join(dir, 'hire-ed25519.pem');
  if (fs.existsSync(file)) return createPrivateKey(fs.readFileSync(file, 'utf8'));
  const { privateKey } = generateKeyPairSync('ed25519');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('[hire] a new receipt signing key was created in the data directory (public key at /api/hire/key)');
  return privateKey;
}
const KEY = loadKey();
const PUB = createPublicKey(KEY);
const PUB_RAW = PUB.export({ format: 'der', type: 'spki' }).subarray(-32);
export const publicKey = {
  alg: 'Ed25519',
  publicKeyHex: '0x' + PUB_RAW.toString('hex'),
  publicKeyPem: PUB.export({ format: 'pem', type: 'spki' }),
  keyId: sha256hex(PUB_RAW).slice(0, 18),
  signs: 'the 32 raw bytes of receiptHash',
  receiptHash: 'sha256 of the UTF-8 canonical JSON of the receipt: object keys sorted, no whitespace, undefined fields dropped (canonical() in /cull.v2.js)',
};

// ---------- every public key ever used, so a receipt signed by an older key still verifies after the key changes ----------
// (receipts name their key: receipt.keyId, inside what is signed). The table only grows; a key is never removed.
db.exec('CREATE TABLE IF NOT EXISTS hire_keys (key_id TEXT PRIMARY KEY, public_key_hex TEXT, public_key_pem TEXT, first_used INTEGER)');
db.prepare('INSERT OR IGNORE INTO hire_keys(key_id, public_key_hex, public_key_pem, first_used) VALUES(?,?,?,?)').run(publicKey.keyId, publicKey.publicKeyHex, publicKey.publicKeyPem, Date.now());
const allKeys = db.prepare('SELECT key_id, public_key_hex, public_key_pem, first_used FROM hire_keys ORDER BY first_used');
// the fingerprint sha256(raw public key) is sent to OpenTimestamps once, so anyone can see since when this key exists
export const keyFingerprint = sha256hex(PUB_RAW);
ots.stampHash(keyFingerprint, 'hire-key', null).catch(() => {});
/** GET /api/hire/key: the current key at the top level (as before) and every key ever used in keys[], current first. */
export function keyDoc() {
  const rows = allKeys.all();
  const keys = rows.map((r) => ({ keyId: r.key_id, alg: 'Ed25519', publicKeyHex: r.public_key_hex, publicKeyPem: r.public_key_pem, firstUsed: r.first_used, current: r.key_id === publicKey.keyId }));
  keys.sort((a, b) => b.current - a.current);
  return { ...publicKey, fingerprint: keyFingerprint, fingerprintTimestamp: `/api/ots/${keyFingerprint}.ots`, keys,
    note: 'A receipt names its key in receipt.keyId (signed). This list is served by the same server that signs: to check a receipt without trusting this site, compare the key with one you got elsewhere (verify-receipt.mjs --key 0x...).' };
}
const pubCache = new Map();
/** Which known key verifies this signature (for receipts written before receipts carried keyId). */
export function keyFor(receiptHash, signature) {
  for (const r of allKeys.all()) {
    let k = pubCache.get(r.key_id); if (!k) { k = createPublicKey(r.public_key_pem); pubCache.set(r.key_id, k); }
    try { if (verify(null, Buffer.from(receiptHash.slice(2), 'hex'), k, Buffer.from(String(signature).replace(/^0x/, ''), 'hex'))) return r.key_id; } catch {}
  }
  return null;
}

export function seal(receipt) {
  const receiptHash = receiptHashOf(receipt);
  const signature = '0x' + sign(null, Buffer.from(receiptHash.slice(2), 'hex'), KEY).toString('hex');
  return { receiptHash, signature, keyId: publicKey.keyId };
}
export const check = (receipt, receiptHash, signature) => receiptHashOf(receipt) === receiptHash && verify(null, Buffer.from(receiptHash.slice(2), 'hex'), PUB, Buffer.from(signature.replace(/^0x/, ''), 'hex'));

// ---------- OpenTimestamps: stamp at once, and retry the last day's receipts that no calendar took ----------
export const stamp = (hash, id) => ots.stampHash(hash, 'hire', id).catch(() => {});
export function otsOf(hash) { const r = q.ots.get(hash); return r ? { stamped: true, at: r.at, calendar: r.calendar, proof: `/api/ots/${hash}.ots` } : { stamped: false, note: 'sent to the OpenTimestamps calendars; retried every two minutes until one answers' }; }
let busy = false;
setInterval(async () => {
  if (busy) return; busy = true;
  try { for (const r of q.unstamped.all(Date.now() - 86400_000)) await stamp(r.receipt_hash, r.id); } catch {} finally { busy = false; }
}, 120_000).unref();

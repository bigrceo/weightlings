// "Build your agent": a wallet founds (or reuses) its lineage and gives it a JOB, a one-sentence specialty that shapes how its
// creatures answer when hired (see persona() in hire/engine.mjs). index.mjs calls handle() once per request, before its /api 404:
//   GET  /api/build/nonce?wallet=0x…   a single-use nonce (10 min) to put in the signed message
//   POST /api/build { wallet, job, name?, nonce, signature }   personal_sign of
//        Weightlings: set the job of my lineage to "<job>" (nonce <n>)
//        verified here with the hand-written secp256k1/keccak of hire/evm.mjs. One job per wallet, editable once per hour.
//   GET  /api/build/:wallet            the job, the lineage's living creature
//   GET  /api/builds?limit=            recent builds with each lineage's living creature and its hire count
import crypto from 'node:crypto';
import { db } from './db.mjs';
import * as sim from './sim.mjs';
import { tierOf } from './models.mjs';
import { keccak256, recoverAddress } from './hire/evm.mjs';

db.exec('CREATE TABLE IF NOT EXISTS builds (wallet TEXT PRIMARY KEY, job TEXT, title TEXT, created INTEGER, updated INTEGER)');
db.exec('CREATE INDEX IF NOT EXISTS builds_updated ON builds(updated)');

export const LIMITS = { job: 160, title: 40, editMs: 3600_000, nonceMs: 600_000 };
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
// short and blunt: links, emails, handles to elsewhere, slurs and the obvious prompt-injection openers
const DENY = [
  /https?:\/\//i, /\bwww\./i, /\b[a-z0-9-]+\.(com|net|org|io|xyz|fun|app|gg|co|me|ru|cn|ly|to|sh|link|site|online)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/, /\bt\.me\b/i, /discord\.gg/i,
  /\bn[i1!]gg/i, /\bf[a@]gg?[o0]t/i, /\bk[i1]ke\b/i, /\bretard/i, /\btr[a@]nny/i, /\bchink\b/i, /\bspic\b/i,
  /\b(kill|rape|murder)\s+(yourself|him|her|them|people|jews|children)\b/i, /\bchild\s*porn|\bcsam\b|\bloli\b/i,
  /\bignore (all |any )?(previous|prior|above|the) (instructions|rules)/i, /\bsystem prompt\b/i, /\bsend (all |your )?(funds|eth|tokens|money)\b/i, /\bseed phrase|private key\b/i,
];
export function checkJob(job, title) {
  job = clean(job); title = clean(title);
  if (job.length < 8) return { error: 'Describe the job in one sentence.' };
  if (job.length > LIMITS.job) return { error: `A job is at most ${LIMITS.job} characters.` };
  if (title.length > LIMITS.title) return { error: `A name for the job is at most ${LIMITS.title} characters.` };
  if (DENY.some((r) => r.test(job) || r.test(title))) return { error: 'That job cannot be used: no links, emails, slurs or instructions aimed at the model.' };
  return { job, title };
}
export const message = (job, nonce) => `Weightlings: set the job of my lineage to "${job}" (nonce ${nonce})`;
/** EIP-191 personal_sign digest of a UTF-8 message */
export const personalDigest = (msg) => { const m = Buffer.from(msg, 'utf8'); return keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`, 'utf8'), m])); };
export function signer(msg, sig) { try { return recoverAddress(personalDigest(msg), sig).toLowerCase(); } catch { return null; } }

const nonces = new Map(); // wallet -> { n, at }
function issue(wallet) { for (const [k, v] of nonces) if (Date.now() - v.at > LIMITS.nonceMs) nonces.delete(k); const n = crypto.randomBytes(8).toString('hex'); nonces.set(wallet, { n, at: Date.now() }); return n; }

const rl = new Map();
function limited(ip, key, max, winMs) { const k = ip + key, t = Date.now(); const a = (rl.get(k) || []).filter((x) => t - x < winMs); if (a.length >= max) return true; a.push(t); rl.set(k, a); return false; }

const get = (w) => db.prepare('SELECT wallet, job, title, created, updated FROM builds WHERE wallet=?').get(w);
/** The job of a creature's lineage, for the hire persona. */
export const jobOf = (wallet) => { try { return get(String(wallet || '').toLowerCase()) || null; } catch { return null; } };
function living(wallet) {
  let best = null; for (const b of sim.L.values()) if (b.w === wallet && (!best || b.gen < best.gen || (b.gen === best.gen && b.id < best.id))) best = b;
  return best;
}
const hires = (id) => { try { return db.prepare('SELECT COUNT(*) n FROM hires WHERE creature_id=?').get(id).n; } catch { return 0; } };
function creature(wallet) {
  const b = living(wallet); if (!b) return null;
  const t = tierOf(b.m.tier);
  return { id: b.id, nick: b.nick, gen: b.gen, model: b.m.id, modelName: b.m.name, lab: b.m.lab, logo: b.m.logo, tier: b.m.tier, tierName: t.name, stars: t.stars, energy: Math.round(b.down > 0 ? 0 : b.e), hires: hires(b.id) };
}
const ids = (wallet) => [...sim.L.values()].filter((b) => b.w === wallet).map((b) => b.id);
const out = (r) => ({ wallet: r.wallet, job: r.job, title: r.title || null, created: r.created, updated: r.updated, editableAt: r.updated + LIMITS.editMs, creature: creature(r.wallet), living: ids(r.wallet) });

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function body(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 4000) throw new Error('too large'); } return JSON.parse(b || '{}'); }

/** opts.holder(addrLower) -> bool decides 'holder' vs 'visitor' founding. Returns true when it answered. */
export async function handle(req, res, u, ip, opts = {}) {
  const p = u.pathname;
  if (req.method === 'GET' && p === '/api/build/nonce') {
    const w = String(u.searchParams.get('wallet') || '').toLowerCase();
    if (!isAddr(w)) return json(res, 400, { error: 'Send ?wallet=0x…' }), true;
    if (limited(ip, 'bnonce', 60, 3600_000)) return json(res, 429, { error: 'Slow down' }), true;
    return json(res, 200, { nonce: issue(w), template: message('<job>', '<nonce>') }), true;
  }
  if (req.method === 'GET' && p === '/api/builds') {
    const lim = Math.max(1, Math.min(200, Math.floor(Number(u.searchParams.get('limit'))) || 30));
    return json(res, 200, { builds: db.prepare('SELECT * FROM builds ORDER BY updated DESC LIMIT ?').all(lim).map(out) }), true;
  }
  const one = req.method === 'GET' && /^\/api\/build\/(0x[0-9a-fA-F]{40})$/.exec(p);
  if (one) { const r = get(one[1].toLowerCase()); return r ? json(res, 200, out(r)) : json(res, 404, { error: 'No job set for this wallet yet.' }), true; }
  if (req.method === 'POST' && p === '/api/build') {
    if (limited(ip, 'build', 12, 3600_000)) return json(res, 429, { error: 'Too many builds from this connection, try later' }), true;
    let b; try { b = await body(req); } catch { return json(res, 400, { error: 'Send JSON.' }), true; }
    const w = String(b.wallet || '').toLowerCase();
    if (!isAddr(w)) return json(res, 400, { error: 'Connect a 0x… wallet.' }), true;
    const c = checkJob(b.job, b.name); if (c.error) return json(res, 400, c), true;
    const ex = get(w), now = Date.now();
    if (ex && now - ex.updated < LIMITS.editMs) return json(res, 429, { error: `This lineage's job can change again at ${new Date(ex.updated + LIMITS.editMs).toISOString().slice(11, 16)} UTC.`, editableAt: ex.updated + LIMITS.editMs }), true;
    const nn = nonces.get(w);
    if (!nn || nn.n !== String(b.nonce || '') || now - nn.at > LIMITS.nonceMs) return json(res, 401, { error: 'The signing request expired. Sign again.' }), true;
    const by = signer(message(c.job, nn.n), b.signature);
    if (by !== w) return json(res, 401, { error: 'The signature does not match this wallet.' }), true;
    nonces.delete(w); // single use, consumed only by a valid signature
    const lin = sim.found(w, opts.holder && opts.holder(w) ? 'holder' : 'visitor');
    if (lin.error && !ex) return json(res, 429, { error: lin.error }), true;
    db.prepare('INSERT INTO builds(wallet, job, title, created, updated) VALUES(?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET job=excluded.job, title=excluded.title, updated=excluded.updated').run(w, c.job, c.title || null, now, now);
    return json(res, 200, out(get(w))), true;
  }
  return false;
}

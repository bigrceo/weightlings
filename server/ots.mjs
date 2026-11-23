// Free outside timestamps. Each commitment hash (before the seed block exists) and each result hash is sent to public
// OpenTimestamps calendars, which anchor it in Bitcoin. We keep the proof as a standard .ots file anyone can verify
// with the OpenTimestamps tools. Runs beside the round logic and never blocks it.
import { db } from './db.mjs';

db.exec('CREATE TABLE IF NOT EXISTS ots (hash TEXT PRIMARY KEY, kind TEXT, n INTEGER, at INTEGER, calendar TEXT, proof BLOB)');
const CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://alice.btc.calendar.opentimestamps.org'];
const MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
const ins = db.prepare('INSERT OR IGNORE INTO ots(hash,kind,n,at,calendar,proof) VALUES(?,?,?,?,?,?)');
const has = db.prepare('SELECT 1 FROM ots WHERE hash=?');

async function stamp(hash, kind, n) {
  const digest = Buffer.from(hash.slice(2), 'hex'); if (digest.length !== 32) return;
  for (const cal of CALENDARS) {
    try {
      const r = await fetch(cal + '/digest', { method: 'POST', headers: { accept: 'application/vnd.opentimestamps.v1', 'content-type': 'application/x-www-form-urlencoded' }, body: digest, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const body = Buffer.from(await r.arrayBuffer()); if (!body.length) continue;
      // detached file: magic, version 1, sha256 op, digest, then the calendar's timestamp
      ins.run(hash, kind, n, Date.now(), cal, Buffer.concat([MAGIC, Buffer.from([0x01, 0x08]), digest, body]));
      return;
    } catch {}
  }
}
let busy = false;
async function sweep() {
  if (busy) return; busy = true;
  try {
    // the two newest rounds only: older ones were never stamped in time and we do not pretend otherwise
    for (const c of db.prepare('SELECT n, hash, recordHash FROM commits ORDER BY seq DESC LIMIT 2').all()) {
      if (c.hash && !has.get(c.hash)) await stamp(c.hash, 'commitment', c.n);
      if (c.recordHash && !has.get(c.recordHash)) await stamp(c.recordHash, 'result', c.n);
    }
  } catch (e) { console.warn('[ots]', e.message); } finally { busy = false; }
}
/** Stamp any 32-byte hash once (hires use kind 'hire' and their id as ref). The round sweep above is unchanged. */
export const stampHash = (hash, kind, ref) => (/^0x[0-9a-f]{64}$/.test(hash) && !has.get(hash) ? stamp(hash, kind, ref) : Promise.resolve());
export const forRound = (n) => db.prepare('SELECT hash, kind, at, calendar FROM ots WHERE n=? ORDER BY at').all(n);
export const file = (hash) => db.prepare('SELECT proof FROM ots WHERE hash=?').get(hash)?.proof || null;
export function start() { setInterval(sweep, 4000); }

// The world. Creatures forage live; every hour a trial kills the weakest; survivors breed and pass on their brain (a real open model),
// with occasional mutations to a neighbouring model. Every number a creature uses comes from its model card. No AI calls.
// The hourly round itself is ONE pure function, cull() in public/cull.js, shared with the public checker at /verify.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { db, kv } from './db.mjs';
import { MODELS, byId, brainFor, tierOf } from './models.mjs';
import { rpc, hex, blockNumber, blocksPerSec } from './rpc.mjs';
import * as market from './market.mjs';
import { cull, canonical, commitment, resultOf, cullModels, familyName, nickOf, TRIAL_ORDER, TRIAL_WEIGHTS, KILL_PCT, SEED_DELAY_MS, VERSION, RULES_FILE } from '../public/cull.js';
import { summaryOf } from '../public/summary.js';

export const W = 56, H = 56;
export const riverJ = (i) => 9 + 4 * Math.sin(i / 6.5) + i * 0.08;
const nearWater = (i, j) => Math.abs(j - riverJ(i)) < 2.6;
const inside = (i, j) => i > 4 && j > 4 && i < W - 4 && j < H - 4 && !nearWater(i, j);
const DT = 0.25, FOOD_E = 34, SHARE_E = 22;
export const ROUND_MS = Number(process.env.ROUND_MIN || 60) * 60000;
const CAP = Number(process.env.POP_CAP || 160);
// founders hatch straight into the meadow, so hatching is bounded: the meadow may stand at most HATCH_MARGIN above the cap between two
// trials, and visitors together may found at most HATCH_PER_HOUR new lineages an hour (holders and seeds are held by the ceiling only)
const HATCH_MARGIN = Math.max(0, Number(process.env.HATCH_MARGIN ?? Math.ceil(CAP / 4)));
const HATCH_PER_HOUR = Math.max(0, Number(process.env.HATCH_PER_HOUR ?? 40));

db.exec(`
CREATE TABLE IF NOT EXISTS beings (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, parent INTEGER, gen INTEGER, model TEXT, mutated INTEGER DEFAULT 0, nick TEXT, source TEXT,
  born INTEGER, rborn INTEGER, died INTEGER, rdied INTEGER, cause TEXT, eaten INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, shares INTEGER DEFAULT 0, survived INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS beings_wallet ON beings(wallet);
CREATE INDEX IF NOT EXISTS beings_alive ON beings(died);
CREATE TABLE IF NOT EXISTS gens (n INTEGER PRIMARY KEY, at INTEGER, trial TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS records (n INTEGER PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS commits (seq INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER, hash TEXT, at INTEGER, scheduledAt INTEGER, prevHash TEXT, prevRecord TEXT,
  status TEXT, recordHash TEXT, seedBlock TEXT, closedAt INTEGER, note TEXT, state TEXT);
CREATE INDEX IF NOT EXISTS commits_n ON commits(n);
`);

// names and descriptions here; the weights that decide a round live in public/cull.js (one source for the server and the checker)
const TRIAL_TEXT = {
  famine: ['Famine', 'Food runs out. Seeing far, choosing well and burning little energy decide who lasts.'],
  storm: ['Storm', 'A storm floods the meadow. Strength and remembering safe ground decide who lasts.'],
  plague: ['Plague', 'A sickness spreads fastest among creatures that share the same brain. Cooperation and judgement help; being common hurts.'],
  maze: ['Maze', 'The meadow folds into a maze. Judgement and memory find the exit.'],
};
export const TRIALS = TRIAL_ORDER.map((key) => ({ key, name: TRIAL_TEXT[key][0], what: TRIAL_TEXT[key][1], w: Object.fromEntries(TRIAL_WEIGHTS[key]) }));

// live foraging dice only (movement, duels, where a newborn lands). The hourly round never reads this stream.
let seed = (Date.now() & 0xffffff) | 1;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const spot = (c, r) => { for (let k = 0; k < 40; k++) { const a = rnd() * 6.283, d = Math.sqrt(rnd()) * r; const i = c[0] + Math.cos(a) * d, j = c[1] + Math.sin(a) * d; if (inside(i, j)) return [i, j]; } return [30, 30]; };
const now = () => Date.now();

const bushes = Array.from({ length: 50 }, () => ({ p: spot([30, 30], 22), next: 0 }));
const food = new Map(); let foodId = 1;
export const L = new Map(); // id -> live being
export const events = [];
let T = 0;
export const clock = { lastTick: 0 };

export const round = { n: kv.get('round_n', 0), next: kv.get('round_next', 0), last: null };
function log(kind, text, who = []) { events.unshift({ at: now(), kind, text, who }); if (events.length > 120) events.pop(); }

function live(row) {
  const [x, y] = spot([30, 30], 18);
  const b = { id: row.id, w: row.wallet, m: byId[row.model], nick: row.nick, gen: row.gen, parent: row.parent, mutated: row.mutated, source: row.source, x, y, tx: x, ty: y, e: 70 + rnd() * 30, act: 'wander', mem: [],
    st: { eaten: row.eaten, wins: row.wins, losses: row.losses, shares: row.shares, survived: row.survived }, rd: { eaten: 0, wins: 0, shares: 0, faints: 0 }, down: 0 };
  L.set(row.id, b); return b;
}
function insertBeing(wallet, parent, gen, model, mutated, source) {
  const id = Number(db.prepare('INSERT INTO beings(wallet,parent,gen,model,mutated,nick,source,born,rborn) VALUES(?,?,?,?,?,?,?,?,?)').run(wallet, parent, gen, model, mutated ? 1 : 0, nickOf(wallet, gen), source, now(), round.n).lastInsertRowid);
  return live(db.prepare('SELECT * FROM beings WHERE id=?').get(id));
}

/** A wallet founds a lineage once. Its founder's brain is drawn from the wallet hash against the rarity odds. */
export function found(wallet, source) {
  wallet = wallet.toLowerCase();
  const ex = db.prepare('SELECT id, source FROM beings WHERE wallet=? AND gen=0').get(wallet);
  if (ex) { if (source === 'holder' && ex.source !== 'holder') { db.prepare("UPDATE beings SET source='holder' WHERE wallet=?").run(wallet); for (const b of L.values()) if (b.w === wallet) b.source = 'holder'; } return lineage(wallet); }
  if (L.size >= CAP + HATCH_MARGIN) return { wallet, refused: 'full', error: 'The meadow is full. New lineages can hatch again after the next trial.' };
  if (source === 'visitor' && db.prepare("SELECT COUNT(*) n FROM beings WHERE gen=0 AND parent IS NULL AND source='visitor' AND born>=?").get(now() - 3600000).n >= HATCH_PER_HOUR)
    return { wallet, refused: 'budget', error: 'Enough lineages were founded this hour. Try again later.' };
  const b = insertBeing(wallet, null, 0, brainFor(wallet), false, source);
  log('hatch', `${b.nick} founded a lineage with a ${b.m.name} brain`, [b.id]);
  return lineage(wallet);
}

// ---------- live foraging ----------
function nearestFood(c, r) { let best = null, bd = r * r; for (const f of food.values()) { const d = (f.x - c.x) ** 2 + (f.y - c.y) ** 2; if (d < bd) { bd = d; best = f; } } return best; }
function eat(c, e, share) { c.e = Math.min(100, c.e + e); c.st.eaten++; c.rd.eaten++; c.act = share ? 'share' : 'eat'; }
function tick() {
  T += DT; clock.lastTick = now();
  for (const b of bushes) if (T >= b.next) { let n = 0; for (const f of food.values()) if (f.b === b) n++; if (n < 2) { const [x, y] = spot(b.p, 1.5); food.set(foodId, { id: foodId++, x, y, b }); } b.next = T + 16 + rnd() * 26; }
  for (const c of L.values()) {
    const s = c.m.stats;
    if (c.down > 0) { c.down -= DT; if (c.down <= 0) { c.e = 55; c.act = 'wander'; } continue; }
    c.e -= DT * 0.55 * s.metabolism;
    if (c.e <= 0) { c.down = 30; c.rd.faints++; c.act = 'faint'; continue; }
    c.mem = c.mem.filter((m) => T - m.t < 20 + 100 * s.memory);
    const d = Math.hypot(c.tx - c.x, c.ty - c.y);
    if (d < 0.15 || (c.act === 'wander' && rnd() < 0.02)) {
      const hungry = c.e < 85, seen = hungry ? nearestFood(c, 3 + 10 * s.perception) : null;
      if (seen && rnd() < s.judgement) { c.tx = seen.x; c.ty = seen.y; c.target = seen.id; c.act = 'forage'; }
      else if (hungry && c.mem.length && rnd() < s.judgement) { const m = c.mem[c.mem.length - 1]; [c.tx, c.ty] = spot([m.x, m.y], 1.2); c.target = null; c.act = 'recall'; }
      else { [c.tx, c.ty] = spot([c.x, c.y], 5); c.target = null; c.act = 'wander'; }
    }
    const sp = (1.1 + 0.6 * s.perception) * DT;
    if (d > 0.01) { c.x += ((c.tx - c.x) / d) * Math.min(d, sp); c.y += ((c.ty - c.y) / d) * Math.min(d, sp); }
    const f = c.target && food.get(c.target);
    if (c.target && !f) { c.target = null; c.tx = c.x; c.ty = c.y; }
    if (f && Math.hypot(f.x - c.x, f.y - c.y) < 0.45) {
      c.mem.push({ x: f.x, y: f.y, t: T }); food.delete(f.id); c.target = null;
      let rival = null; for (const o of L.values()) if (o !== c && o.down <= 0 && o.target === f.id && Math.hypot(o.x - f.x, o.y - f.y) < 1.4) { rival = o; break; }
      if (!rival) { eat(c, FOOD_E); continue; }
      rival.target = null; const rs = rival.m.stats;
      if (rnd() < s.cooperation * rs.cooperation) { eat(c, SHARE_E, 1); eat(rival, SHARE_E, 1); c.st.shares++; rival.st.shares++; c.rd.shares++; rival.rd.shares++; if (rnd() < 0.15) log('share', `${c.nick} (${c.m.name}) shared a berry with ${rival.nick} (${rival.m.name})`, [c.id, rival.id]); }
      else {
        const p = 1 / (1 + Math.exp(-((s.strength - rs.strength) * 4 + (s.judgement - rs.judgement) * 4)));
        const [win, lose] = rnd() < p ? [c, rival] : [rival, c];
        eat(win, FOOD_E); win.st.wins++; win.rd.wins++; lose.st.losses++; lose.e -= 6;
        if (rnd() < 0.25) log('duel', `${win.nick} (${win.m.name}) beat ${lose.nick} (${lose.m.name}) to a berry`, [win.id, lose.id]);
      }
    }
  }
}

// ---------- hourly selection ----------
// What decides a round is cull() in public/cull.v2.js (public/cull.js points at the version in force). This part only does the bookkeeping:
//   1. SEED_DELAY (60 s) before the trial, freeze cull()'s whole input and publish its hash (GET /api/commit). The seed does not exist yet.
//      The hashed input also names the trial second (so the hash fixes the seed block), the first newborn id, the hash of the rules file
//      and the commitment before it.
//   2. The seed is the first Robinhood Chain block whose timestamp is >= scheduledAt + 60 s. If it cannot be read, wait and retry; never fall back.
//   3. Run cull(), write its result to the database and the live meadow, and store the full record so anyone can run it again (/verify).
//      If the result cannot be written, the SAME commitment waits for the SAME block and is tried again, with a growing pause.
//      A round that still cannot be written after VOID_AFTER tries is voided in public: a record keeps its commitment, its seed block
//      and the reason, and its number is used up. A round number is never committed twice.
// Every commitment is a row of `commits`, written before it is shown, never deleted, chained to the one before it (GET /api/commits).
const sha = (v) => '0x' + createHash('sha256').update(canonical(v)).digest('hex');
const RETRY_MS = 15000, RETRY_MAX_MS = 300000;
const VOID_AFTER = Math.max(3, Number(process.env.VOID_AFTER || 12)); // failed writes before a round is voided (about 40 minutes at the default)
const EXTINCT_MAX = Math.max(1, Number(process.env.EXTINCT_MAX || 400)); // extinct lineages a commitment carries at most
// the rules file as it sits on disk when the server starts: its hash goes into every commitment
const RULES = { file: RULES_FILE, sha256: '0x' + createHash('sha256').update(fs.readFileSync(new URL('../public/' + RULES_FILE, import.meta.url))).digest('hex') };
const zero = () => ({ eaten: 0, wins: 0, shares: 0, faints: 0 });
const sealedRow = () => db.prepare("SELECT seq, state FROM commits WHERE status='sealed' ORDER BY seq DESC LIMIT 1").get();
const wake = (row) => (row && row.state ? { ...JSON.parse(row.state), seq: row.seq, retryAt: 0, fails: 0, lastError: null } : null);
let pending = wake(sealedRow()); // the round that is committed and waiting for its seed block (it lives in `commits`, so it survives a restart)
let lastCommit = kv.get('round_commit', null);
let busy = false;

// ---------- the hour survives a restart ----------
// Energy, place, this hour's counts and the lifetime counts of every creature, with the bushes and the berries on the ground, are written
// every SAVE_MS and on shutdown, and read back at start: a restart resumes the meadow where it was saved instead of dealing a fresh one.
// What a restart still costs (the time between the last save and the restart) is counted in hourMeta and goes into the commitment.
const SAVE_MS = 20000;
let hourMeta = { since: now(), restarts: 0, lostMs: 0 };
export function saveState() {
  const c = {};
  for (const b of L.values()) c[b.id] = [+b.e.toFixed(2), +Math.max(0, b.down).toFixed(2), b.rd.eaten, b.rd.wins, b.rd.shares, b.rd.faints, b.st.eaten, b.st.wins, b.st.losses, b.st.shares, +b.x.toFixed(2), +b.y.toFixed(2)];
  const world = { bushes: bushes.map((b) => [+b.p[0].toFixed(3), +b.p[1].toFixed(3), +(b.next - T).toFixed(2)]), food: [...food.values()].map((f) => [+f.x.toFixed(2), +f.y.toFixed(2), bushes.indexOf(f.b)]) };
  kv.set('meadow_state', { at: now(), sealed: pending ? pending.roundN : 0, hour: hourMeta, c, world });
}
function restoreState() {
  const s = kv.get('meadow_state', null), t = now(), sealed = pending ? pending.roundN : 0;
  // a sealed round keeps its frozen counts in the commitment itself
  if (pending) { const F = {}; for (const c of pending.input.snapshot) F[c.id] = c; for (const b of L.values()) { const f = F[b.id]; if (f) b.fz = { eaten: f.eaten, wins: f.wins, shares: f.shares, faints: f.faints }; } }
  if (!s || !s.c) { hourMeta = { since: pending ? pending.committedAt : t, restarts: 0, lostMs: 0 }; return; }
  // saved before the meadow was sealed, read back after: the saved counts are the frozen hour, and the new hour starts empty
  const stale = sealed && s.sealed !== sealed;
  hourMeta = stale ? { since: pending.committedAt, restarts: 1, lostMs: Math.max(0, t - pending.committedAt) }
    : { since: s.hour?.since ?? s.at, restarts: (s.hour?.restarts || 0) + 1, lostMs: (s.hour?.lostMs || 0) + Math.max(0, t - s.at) };
  let n = 0;
  for (const b of L.values()) {
    const a = s.c[b.id]; if (!Array.isArray(a) || a.length < 10) continue;
    n++; b.e = Math.max(0, Math.min(100, Number(a[0]) || 0)); b.down = Math.max(0, Number(a[1]) || 0); if (b.down > 0) b.act = 'faint';
    if (Number.isFinite(a[10]) && Number.isFinite(a[11])) { b.x = b.tx = a[10]; b.y = b.ty = a[11]; }
    if (!stale) b.rd = { eaten: a[2] | 0, wins: a[3] | 0, shares: a[4] | 0, faints: a[5] | 0 };
    // lifetime counts only grow; the database holds them as of the last round, the saved state as of the last save
    b.st.eaten = Math.max(b.st.eaten, a[6] | 0); b.st.wins = Math.max(b.st.wins, a[7] | 0); b.st.losses = Math.max(b.st.losses, a[8] | 0); b.st.shares = Math.max(b.st.shares, a[9] | 0);
  }
  // the same bushes, with the berries that were on the ground and the time each bush still had to wait
  const w = s.world;
  if (w && Array.isArray(w.bushes) && w.bushes.length === bushes.length && w.bushes.every((x) => Array.isArray(x) && x.slice(0, 3).every(Number.isFinite))) {
    w.bushes.forEach((x, i) => { bushes[i].p = [x[0], x[1]]; bushes[i].next = T + Math.max(0, x[2]); });
    food.clear(); for (const f of Array.isArray(w.food) ? w.food : []) if (Array.isArray(f) && bushes[f[2]] && Number.isFinite(f[0]) && Number.isFinite(f[1])) food.set(foodId, { id: foodId++, x: f[0], y: f[1], b: bushes[f[2]] });
  }
  console.log(`[sim] the hour was read back for ${n} of ${L.size} creatures (saved ${Math.round((t - s.at) / 1000)} s ago; ${hourMeta.restarts} restart${hourMeta.restarts === 1 ? '' : 's'} this hour, ${Math.round(hourMeta.lostMs / 1000)} s not counted)`);
}
const saveSoon = () => { try { saveState(); } catch (e) { console.warn('[sim] the hour could not be saved:', e.message); } };

function freeze() {
  const t = now(), n = round.n + 1, trialKey = TRIALS[(n - 1) % TRIALS.length].key;
  if (L.size < 4) { round.next = t + ROUND_MS; kv.set('round_next', round.next); return; }
  // normally the meadow is frozen exactly 60 s before the trial. If we are late (a restart), the trial moves instead: the commit always precedes the seed.
  const due = round.next - SEED_DELAY_MS, scheduledAt = t - due > 30000 ? Math.ceil(t / 1000) * 1000 : due;
  const snapshot = [...L.values()].sort((a, b) => a.id - b.id).map((b) => ({ id: b.id, wallet: b.w, model: b.m.id, gen: b.gen, source: b.source, eaten: b.rd.eaten, wins: b.rd.wins, shares: b.rd.shares, faints: b.rd.faints }));
  const living = new Set(snapshot.map((c) => c.wallet)), src = db.prepare('SELECT source FROM beings WHERE id=?');
  const gone = db.prepare("SELECT wallet, MAX(source='holder') h, MAX(gen) g, MIN(id) first, MAX(id) last, MAX(died) d FROM beings GROUP BY wallet ORDER BY wallet").all().filter((r) => !living.has(r.wallet));
  // a long list is cut to EXTINCT_MAX: holders first, then the lineages that have been gone the longest (the total goes into the commitment too)
  const kept = gone.length <= EXTINCT_MAX ? gone : [...gone].sort((a, b) => b.h - a.h || a.d - b.d || (a.wallet < b.wallet ? -1 : 1)).slice(0, EXTINCT_MAX).sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const extinct = kept.map((r) => ({ wallet: r.wallet, holder: !!r.h, gen: r.g + 1, last: r.last, model: brainFor(r.wallet), source: r.h ? 'holder' : src.get(r.first).source }));
  // newborn ids are fixed now: the round can hatch at most `room` creatures, so that block of ids is set aside and anything hatched
  // during the sealed minute is numbered after it
  const room = Math.max(0, CAP - (snapshot.length - Math.floor((snapshot.length * KILL_PCT) / 100)));
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='beings'").get()?.seq || 0, nextId = seq + 1;
  const last = db.prepare('SELECT n, hash, recordHash FROM commits ORDER BY seq DESC LIMIT 1').get();
  const prev = last ? { roundN: last.n, snapshotHash: last.hash, recordHash: last.recordHash } : null;
  const input = commitment({ roundN: n, trialKey, cap: CAP, scheduledAt, nextId, rules: RULES, prev, hour: { ...hourMeta }, snapshot, extinct, extinctTotal: gone.length, models: cullModels(MODELS) });
  const p = { roundN: n, trial: trialKey, scheduledAt, committedAt: now(), snapshotHash: sha(input), input };
  // written first, shown second: a commitment is on disk, in the log, before anything serves it
  db.exec('BEGIN');
  try {
    p.seq = Number(db.prepare("INSERT INTO commits(n,hash,at,scheduledAt,prevHash,prevRecord,status,state) VALUES(?,?,?,?,?,?,'sealed',?)").run(n, p.snapshotHash, p.committedAt, scheduledAt, prev ? prev.snapshotHash : null, prev ? prev.recordHash : null, JSON.stringify(p)).lastInsertRowid);
    if (room) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='beings'").run(seq + room);
    kv.set('round_next', scheduledAt + SEED_DELAY_MS);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  pending = { ...p, retryAt: 0, fails: 0, lastError: null };
  round.next = scheduledAt + SEED_DELAY_MS;
  // the hour's count is closed: whatever is foraged from now on belongs to the next hour
  for (const b of L.values()) { b.fz = b.rd; b.rd = zero(); }
  hourMeta = { since: t, restarts: 0, lostMs: 0 };
  saveSoon();
  log('seal', `Round ${n} sealed: ${snapshot.length} creatures frozen, commitment ${pending.snapshotHash.slice(0, 10)}… published. The dice are the first Robinhood Chain block at or after ${new Date(round.next).toISOString().slice(11, 19)} UTC.`, []);
  console.log(`[sim] round ${n} committed ${pending.snapshotHash} (${snapshot.length} alive, ${extinct.length} of ${gone.length} extinct lineages, newborn ids from ${nextId}), seed not before ${new Date(round.next).toISOString()}`);
}

const blockAt = async (n) => {
  const b = await rpc('eth_getBlockByNumber', [hex(n), false]);
  if (!b || !b.hash || b.timestamp == null) throw new Error(`block ${n} not served`);
  return { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp) };
};
/** The first block whose timestamp is >= tSec, by a search over block numbers (never 'latest'). null while the chain has not passed that second. Throws if a block cannot be read.
 *  One RPC round trip can take a second, so the bracket is narrowed with up to 8 evenly spaced blocks per round trip instead of one. */
async function firstBlockAt(tSec) {
  let hi = await blockAt(await blockNumber());
  if (hi.timestamp <= tSec) return null;
  let lo = null, back = Math.ceil((hi.timestamp - tSec + 2) * blocksPerSec() * 1.5) + 8;
  while (!lo) {
    if (hi.number === 0) return hi;
    const b = await blockAt(Math.max(0, hi.number - back));
    if (b.timestamp < tSec) lo = b; else { hi = b; back *= 2; }
  }
  // invariant: lo.timestamp < tSec <= hi.timestamp
  while (hi.number - lo.number > 1) {
    const gap = hi.number - lo.number, k = Math.min(8, gap - 1), ns = new Set();
    for (let i = 1; i <= k; i++) ns.add(lo.number + Math.floor((gap * i) / (k + 1)));
    const probes = await Promise.all([...ns].filter((n) => n > lo.number && n < hi.number).map(blockAt));
    for (const m of probes) { if (m.timestamp < tSec) { if (m.number > lo.number) lo = m; } else if (m.number < hi.number) hi = m; }
  }
  return hi;
}

/** One step of the round clock (called every second). */
async function step() {
  if (busy) return; busy = true;
  try {
    if (!pending && now() >= round.next - SEED_DELAY_MS) freeze();
    const p = pending;
    if (!p || now() < Math.max(p.scheduledAt + SEED_DELAY_MS, p.retryAt || 0)) return;
    let blk;
    try { blk = await firstBlockAt(Math.ceil((p.scheduledAt + SEED_DELAY_MS) / 1000)); }
    catch (e) { p.retryAt = now() + RETRY_MS; p.lastError = e.message; console.warn(`[sim] round ${p.roundN}: seed block unreadable (${e.message}). The round waits; next try in ${RETRY_MS / 1000} s.`); return; }
    if (!blk) { p.retryAt = now() + 1000; return; } // the chain has not reached that second yet
    p.lastError = null;
    try { settle(blk); }
    catch (e) {
      // same commitment, same block, tried again later. Nothing was changed: the write is one transaction.
      p.fails = (p.fails || 0) + 1; const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (p.fails - 1)); p.retryAt = now() + wait; p.lastError = 'the result could not be written: ' + e.message;
      console.error(`[sim] round ${p.roundN}: could not write the result (${e.message}), attempt ${p.fails} of ${VOID_AFTER}. The same commitment waits for the same block; next try in ${wait / 1000} s.`);
      if (p.fails >= VOID_AFTER) {
        try { voidRound(p, blk, e.message); }
        catch (e2) { console.error(`[sim] round ${p.roundN}: the void could not be written either (${e2.message}). The round stays sealed.`); }
      }
    }
  } catch (e) { console.error('[sim] round clock', e); }
  finally { busy = false; }
}
export const runRound = step;

/** What a record carries besides its outcome: the whole committed input, flat, so commitment() can be rebuilt from the record alone. */
const recordBase = (p, at) => { const { v, roundN, trial, ...rest } = p.input; return { n: roundN, at, legacy: false, v, trial, scheduledAt: p.scheduledAt, committedAt: p.committedAt, snapshotHash: p.snapshotHash, ...rest }; };
const nextSlot = (p, at) => { let next = p.scheduledAt + SEED_DELAY_MS + ROUND_MS; while (next - SEED_DELAY_MS + 30000 <= at) next += ROUND_MS; return next; }; // a long outage skips the missed slots

function settle(seedBlock) {
  const p = pending, n = p.roundN, at = now(), trial = TRIALS.find((t) => t.key === p.trial), { snapshot, extinct, cap, models: table, nextId } = p.input;
  // newborns are numbered from the committed id, in the order cull() returns them
  const out = cull({ roundN: n, trialKey: p.trial, seedHash: seedBlock.hash, snapshot, extinct, cap, models: table, nextId });
  const result = resultOf(out), recordHash = sha(result);
  const B = (id) => { const b = L.get(id); if (!b) throw new Error(`creature ${id} of the committed snapshot is not in the meadow`); return b; };
  const ranked = out.ranked.map(B), dead = out.dead.map(B), alive = out.survivors.map(B);

  // the summary every page prints is counted from the record itself (public/summary.js; /verify recounts it)
  const sum = summaryOf(snapshot, result);
  const models = sum.models.map((m) => ({ id: m.id, name: byId[m.id].name, lab: byId[m.id].lab, tier: byId[m.id].tier, start: m.start, died: m.died, born: m.born, rate: m.rate }));
  const dom = models.find((m) => m.id === sum.dominant);
  const best = alive[0];
  const ward = {};
  for (const b of ranked) { const k = b.m.tier + '|' + b.m.lab; (ward[k] ||= { start: 0, died: 0 }).start++; }
  for (const b of dead) ward[b.m.tier + '|' + b.m.lab].died++;
  const graves = dead.map((b) => [+b.x.toFixed(1), +b.y.toFixed(1), b.m.id]);
  // lineages that end here: no survivor, no newborn, and no founder hatched since the snapshot
  const judged = new Set(out.ranked), still = new Set([...alive.map((b) => b.w), ...out.births.map((c) => c.wallet)]);
  for (const b of L.values()) if (!judged.has(b.id)) still.add(b.w);
  const lineagesExtinct = new Set(dead.map((b) => b.w).filter((w) => !still.has(w))).size;
  const data = { block: seedBlock, scheduledAt: p.scheduledAt, committedAt: p.committedAt, snapshotHash: p.snapshotHash, recordHash,
    ward, graves, trial: trial.key, trialName: trial.name, what: trial.what, population: sum.population, died: sum.died, born: sum.born, reborn: sum.reborn, mutations: sum.mutations, models, dominant: dom,
    best: best ? { id: best.id, nick: best.nick, model: best.m.name, gen: best.gen } : null,
    fallen: [...dead].sort((a, z) => z.st.survived - a.st.survived || a.id - z.id).slice(0, 12).map((b) => ({ id: b.id, nick: b.nick, model: b.m.id, modelName: b.m.name, tier: b.m.tier, gen: b.gen, survived: b.st.survived })), lineagesExtinct };
  const record = { ...recordBase(p, at), seedBlock, recordHash, result };
  const next = nextSlot(p, at);
  const commit = { seq: p.seq, roundN: n, scheduledAt: p.scheduledAt, committedAt: p.committedAt, snapshotHash: p.snapshotHash, seedBlock, recordHash };

  // one transaction: either the whole round is written or none of it
  const kill = db.prepare('UPDATE beings SET died=?, rdied=?, cause=?, eaten=?, wins=?, losses=?, shares=?, survived=? WHERE id=?');
  const keep = db.prepare('UPDATE beings SET eaten=?, wins=?, losses=?, shares=?, survived=? WHERE id=?');
  const ins = db.prepare('INSERT INTO beings(id,wallet,parent,gen,model,mutated,nick,source,born,rborn) VALUES(?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const b of dead) kill.run(at, n, trial.key, b.st.eaten, b.st.wins, b.st.losses, b.st.shares, b.st.survived, b.id);
    for (const b of alive) keep.run(b.st.eaten, b.st.wins, b.st.losses, b.st.shares, b.st.survived + 1, b.id);
    for (const c of out.births) ins.run(c.id, c.wallet, c.parent, c.gen, c.model, c.mutated ? 1 : 0, nickOf(c.wallet, c.gen), c.source, at, n - 1);
    data.market = market.onRound(data);
    db.prepare('INSERT INTO gens(n,at,trial,data) VALUES(?,?,?,?)').run(n, at, trial.key, JSON.stringify(data));
    db.prepare('INSERT INTO records(n,data) VALUES(?,?)').run(n, JSON.stringify(record));
    db.prepare("UPDATE commits SET status='recorded', recordHash=?, seedBlock=?, closedAt=?, state=NULL WHERE seq=?").run(recordHash, JSON.stringify(seedBlock), at, p.seq);
    kv.set('round_n', n); kv.set('round_next', next); kv.set('round_commit', commit);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // the live meadow follows what was written
  for (const b of dead) L.delete(b.id);
  for (const b of alive) b.st.survived++;
  const row = db.prepare('SELECT * FROM beings WHERE id=?');
  for (const c of out.births) {
    const child = live(row.get(c.id)), pa = c.reborn ? null : L.get(c.parent);
    if (pa) { child.x = pa.x + (rnd() - 0.5); child.y = pa.y + (rnd() - 0.5); child.tx = child.x; child.ty = child.y; }
  }
  for (const b of L.values()) delete b.fz;
  pending = null; lastCommit = commit;
  round.n = n; round.next = next; round.last = gen(n) || data;
  saveSoon();
  log('round', `Round ${n} · ${trial.name}: ${dead.length} died, ${out.births.length} born. ${dom.name} dominates.`, []);
  console.log(`[sim] round ${n} ${trial.key}: ${dead.length} died, ${out.births.length} born, ${data.mutations} mutations, dominant ${dom.name} · seed block ${seedBlock.number} ${seedBlock.hash} · record ${recordHash}`);
  return data;
}

/** A sealed round that cannot be written is closed in public instead of being dropped: the record keeps the commitment, the seed block that
 *  was read (if any) and the reason; the round number is used up; nobody dies and nobody is born. The frozen hour goes back to the creatures. */
function voidRound(p, seedBlock, reason) {
  const n = p.roundN, at = now(), next = nextSlot(p, at);
  const result = { voided: true, roundN: n, snapshotHash: p.snapshotHash, seedBlock: seedBlock || null, reason };
  const recordHash = sha(result);
  const record = { ...recordBase(p, at), voided: true, reason, attempts: p.fails || 0, seedBlock: seedBlock || null, recordHash, result };
  const commit = { seq: p.seq, roundN: n, scheduledAt: p.scheduledAt, committedAt: p.committedAt, snapshotHash: p.snapshotHash, seedBlock: seedBlock || null, recordHash, voided: true, reason };
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO records(n,data) VALUES(?,?)').run(n, JSON.stringify(record));
    db.prepare("UPDATE commits SET status='voided', recordHash=?, seedBlock=?, closedAt=?, note=?, state=NULL WHERE seq=?").run(recordHash, seedBlock ? JSON.stringify(seedBlock) : null, at, reason, p.seq);
    kv.set('round_n', n); kv.set('round_next', next); kv.set('round_commit', commit);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  for (const b of L.values()) if (b.fz) { b.rd.eaten += b.fz.eaten; b.rd.wins += b.fz.wins; b.rd.shares += b.fz.shares; b.rd.faints += b.fz.faints; delete b.fz; }
  if (p.input.hour) hourMeta = { since: p.input.hour.since, restarts: p.input.hour.restarts + hourMeta.restarts, lostMs: p.input.hour.lostMs + hourMeta.lostMs };
  if (pending === p) pending = null;
  lastCommit = commit; round.n = n; round.next = next;
  saveSoon();
  log('void', `Round ${n} was voided: its result could not be written. Nobody was removed and nobody was born. Its commitment ${p.snapshotHash.slice(0, 10)}… and its seed block stay in the log.`, []);
  console.error(`[sim] round ${n} voided (${reason}). Commitment ${p.snapshotHash}, seed block ${seedBlock ? seedBlock.number : 'not read'}; the number is used up, nothing was changed in the meadow.`);
}

/** The commitment for the coming round. Published the moment the snapshot is frozen, a minute before the seed block exists. */
export function commit(full = false) {
  const r = db.prepare('SELECT MIN(n) a, MAX(n) z FROM records').get();
  const base = { v: VERSION, rules: RULES, seedDelayMs: SEED_DELAY_MS, seedRule: 'first Robinhood Chain block with timestamp >= scheduledAt + 60 s', records: { first: r.a, last: r.z }, last: lastCommit, log: '/api/commits' };
  if (!pending) return { roundN: round.n + 1, trial: TRIALS[round.n % TRIALS.length].key, scheduledAt: round.next - SEED_DELAY_MS, snapshotHash: null, committedAt: null, pending: false, seedNotBefore: round.next, ...base };
  return { seq: pending.seq, roundN: pending.roundN, trial: pending.trial, scheduledAt: pending.scheduledAt, snapshotHash: pending.snapshotHash, committedAt: pending.committedAt, pending: true, seedNotBefore: pending.scheduledAt + SEED_DELAY_MS,
    nextId: pending.input.nextId, prev: pending.input.prev, creatures: pending.input.snapshot.length, waiting: pending.lastError || null, attempts: pending.fails || 0, ...(full ? { input: pending.input } : {}), ...base };
}
/** The commitment log: every commitment this server ever published, newest first, with how it ended (sealed, recorded or voided).
 *  With a round number, the entries for that round and its two neighbours. */
export function commits(limit = 50, n = null) {
  const cols = 'seq, n, hash, at, scheduledAt, prevHash, prevRecord, status, recordHash, seedBlock, closedAt, note';
  const rows = Number.isInteger(n) ? db.prepare(`SELECT ${cols} FROM commits WHERE n BETWEEN ? AND ? ORDER BY seq DESC`).all(n - 1, n + 1)
    : db.prepare(`SELECT ${cols} FROM commits ORDER BY seq DESC LIMIT ?`).all(Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50)));
  return rows.map((c) => ({ seq: c.seq, roundN: c.n, snapshotHash: c.hash, committedAt: c.at, scheduledAt: c.scheduledAt, seedNotBefore: c.scheduledAt == null ? null : c.scheduledAt + SEED_DELAY_MS,
    prev: c.prevHash ? { snapshotHash: c.prevHash, recordHash: c.prevRecord } : null, status: c.status, recordHash: c.recordHash, seedBlock: c.seedBlock ? JSON.parse(c.seedBlock) : null, closedAt: c.closedAt, note: c.note || null }));
}
/** The full record of a round: everything needed to run cull() again. Rounds held before records existed are marked legacy; a voided round says so. */
export function record(n) {
  const r = db.prepare('SELECT data FROM records WHERE n=?').get(n);
  if (r) return JSON.parse(r.data);
  const g = db.prepare('SELECT n, at, trial FROM gens WHERE n=?').get(n);
  return g ? { n: g.n, at: g.at, trial: g.trial, legacy: true } : null;
}
/** Live standing: this hour's foraging so far plus current energy. Traits, crowding and the dice are NOT in it, so it is an indication, not the score. */
export function standing() {
  const pop = [...L.values()], hour = (b) => (pending && b.fz) || b.rd, raw = (h) => h.eaten + 2 * h.wins + 2 * h.shares;
  let maxPerf = 1; for (const b of pop) maxPerf = Math.max(maxPerf, raw(hour(b)));
  const rows = pop.map((b) => {
    const h = hour(b), perf = Math.max(-0.5, (raw(h) - 4 * h.faints) / maxPerf), energy = b.down > 0 ? 0 : Math.max(0, Math.min(100, b.e)) / 100;
    return { id: b.id, nick: b.nick, model: b.m.id, tier: b.m.tier, standing: +(100 * (0.75 * perf + 0.25 * energy)).toFixed(1) };
  }).sort((a, z) => z.standing - a.standing || a.id - z.id);
  const nKill = Math.floor((rows.length * KILL_PCT) / 100);
  rows.forEach((r, i) => { r.rank = i + 1; r.inKillZone = i >= rows.length - nKill; });
  return rows;
}
export const seedPending = () => !!pending;

// ---------- views ----------
export function view(b) {
  const t = tierOf(b.m.tier);
  return { id: b.id, w: b.w, nick: b.nick, gen: b.gen, parent: b.parent, mutated: !!b.mutated, model: b.m.id, modelName: b.m.name, lab: b.m.lab, logo: b.m.logo, tier: b.m.tier, tierName: t.name, stars: t.stars,
    source: b.source, energy: Math.round(b.e), down: b.down > 0, act: b.act, ...b.st, round: b.rd };
}
export function snapshot() {
  return { t: now(), round: { n: round.n, next: round.next, trial: TRIALS[round.n % TRIALS.length].key }, graves: round.last?.graves || [], food: [...food.values()].map((f) => [+f.x.toFixed(2), +f.y.toFixed(2)]),
    c: [...L.values()].map((b) => [b.id, +b.x.toFixed(2), +b.y.toFixed(2), b.down > 0 ? -1 : Math.round(b.e), b.act[0], b.m.id, b.nick, b.source === 'holder' ? 1 : 0, b.gen]) };
}
export function lineage(wallet) {
  const rows = db.prepare('SELECT id,parent,gen,model,mutated,nick,born,died,rdied,cause,eaten,wins,shares,survived FROM beings WHERE wallet=? ORDER BY id').all(wallet);
  return { wallet, family: rows[0] ? familyName(wallet) : null, alive: rows.filter((r) => !r.died).length, total: rows.length, generations: rows.reduce((m, r) => Math.max(m, r.gen), 0) + (rows.length ? 1 : 0), beings: rows };
}
export function modelBoard() {
  const agg = {};
  const kept = new Set(db.prepare('SELECT n FROM records').all().map((r) => r.n));
  for (const g of db.prepare('SELECT n, data FROM gens').all()) for (const m of JSON.parse(g.data).models) { const a = (agg[m.id] ||= { exposed: 0, died: 0, born: 0, exposedLegacy: 0, diedLegacy: 0 }); a.exposed += m.start; a.died += m.died; a.born += m.born; if (!kept.has(g.n)) { a.exposedLegacy += m.start; a.diedLegacy += m.died; } }
  const aliveBy = {}; for (const b of L.values()) aliveBy[b.m.id] = (aliveBy[b.m.id] || 0) + 1;
  return MODELS.map((m) => { const a = agg[m.id] || { exposed: 0, died: 0, born: 0, exposedLegacy: 0, diedLegacy: 0 }; return { id: m.id, name: m.name, lab: m.lab, logo: m.logo, tier: m.tier, params: m.params, active: m.active || null, mmlu: m.mmlu, ctx: m.ctx, stats: m.stats, alive: aliveBy[m.id] || 0, exposed: a.exposed, died: a.died, born: a.born, survived: a.exposed - a.died, survival: a.exposed ? (a.exposed - a.died) / a.exposed : null,
      // the part of those counts that comes from rounds held before full records were kept (they cannot be recomputed at /verify)
      exposedLegacy: a.exposedLegacy, diedLegacy: a.diedLegacy,
      // honest rate: one imaginary survivor and one imaginary death are added, so 1 of 1 does not read as 100%. Below 8 entries the page shows no percentage.
      survivalSmoothed: (a.exposed - a.died + 1) / (a.exposed + 2), enough: a.exposed >= 8 }; })
    .sort((a, z) => z.enough - a.enough || z.survivalSmoothed - a.survivalSmoothed || z.alive - a.alive);
}
export const gens = (n = 24) => db.prepare('SELECT n, at, data FROM gens ORDER BY n DESC LIMIT ?').all(n).map((g) => ({ n: g.n, at: g.at, ...JSON.parse(g.data) }));
export const gen = (n) => { const g = db.prepare('SELECT n, at, data FROM gens WHERE n=?').get(n); return g ? { n: g.n, at: g.at, ...JSON.parse(g.data) } : null; };
/** The last round that was actually held (a voided round has a record but no summary). */
const lastGen = () => { const g = db.prepare('SELECT MAX(n) n FROM gens').get(); return g && g.n != null ? gen(g.n) : null; };

// ---------- the dead ----------
const TN = Object.fromEntries(TRIALS.map((t) => [t.key, t.name]));
const pl = (n, w, ws = w + 's') => (n === 1 ? 'one ' + w : n + ' ' + ws);
const lasted = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? pl(m, 'minute') : m < 2880 ? pl(Math.round(m / 60), 'hour') : pl(Math.round(m / 1440), 'day'); };
// one factual sentence per creature, built only from its stored row; the template is picked by its id
const EPI = [
  (r, m, c) => (r.survived ? `Survived ${pl(r.survived, 'trial')}` : 'Did not survive a single trial') + ` on a ${m} brain. Died in the ${c}.`,
  (r) => (r.wins ? `Won ${pl(r.wins, 'duel')}.` : 'Never won a duel.') + (r.shares ? ` Shared ${pl(r.shares, 'berry', 'berries')}.` : ' Never shared a berry.'),
  (r) => (r.gen ? `${r.gen === 1 ? 'One generation' : r.gen + ' generations'} from its founder.` : 'Founder of its line.') + ` Lasted ${lasted(r.died - r.born)}.`,
  (r, m, c) => (r.eaten ? `Ate ${pl(r.eaten, 'berry', 'berries')}.` : 'Never ate a berry.') + ` Removed in round ${r.rdied}, in the ${c}.`,
  (r, m, c) => (r.mutated ? `Born a mutant: a ${m} brain its parent did not carry.` : r.gen ? `Inherited its parent's ${m} brain.` : `Drew a ${m} brain at founding.`) + ` Died in the ${c}.`,
  (r, m) => `Hatched after round ${r.rborn}. Gone in round ${r.rdied}. ${m}.`,
  (r, m, c) => (r.losses ? `Lost ${pl(r.losses, 'duel')}` : 'Never lost a duel') + ` and still did not outlast the ${c}.`,
];
const deadView = (r) => { const m = byId[r.model] || {}, c = TN[r.cause] || r.cause || 'trial';
  return { id: r.id, nick: r.nick, wallet: r.wallet, model: r.model, modelName: m.name || r.model, lab: m.lab || null, logo: m.logo || null, tier: m.tier || null, tierName: tierOf(m.tier)?.name || null, gen: r.gen, rborn: r.rborn, rdied: r.rdied, cause: r.cause, causeName: c,
    survived: r.survived, eaten: r.eaten, wins: r.wins, shares: r.shares, at: r.died, epitaph: EPI[r.id % EPI.length](r, m.name || r.model, c) }; };
export const deadList = (limit = 30) => db.prepare('SELECT * FROM beings WHERE died IS NOT NULL ORDER BY died DESC, id DESC LIMIT ?').all(Math.max(1, Math.min(100, Math.floor(Number(limit)) || 30))).map(deadView);
export function toll() {
  const q = (sql) => db.prepare(sql).get().n || 0;
  let o = null; for (const b of L.values()) if (!o || b.st.survived > o.st.survived || (b.st.survived === o.st.survived && b.id < o.id)) o = b;
  return { alive: L.size, dead: q('SELECT COUNT(*) n FROM beings WHERE died IS NOT NULL'), born: q('SELECT COUNT(*) n FROM beings'), rounds: q('SELECT COUNT(*) n FROM gens'), lineages: q('SELECT COUNT(DISTINCT wallet) n FROM beings'),
    extinct: q('SELECT COUNT(*) n FROM (SELECT wallet FROM beings GROUP BY wallet HAVING SUM(died IS NULL) = 0)'), mutants: q('SELECT COUNT(*) n FROM beings WHERE mutated=1'),
    oldest: o ? { id: o.id, nick: o.nick, modelName: o.m.name, survived: o.st.survived } : null };
}

export function start() {
  for (const r of db.prepare('SELECT * FROM beings WHERE died IS NULL').all()) live(r);
  round.last = lastGen();
  // the commitment log starts with the rounds recorded before it existed (they carry no link to the round before them)
  if (!db.prepare('SELECT 1 FROM commits LIMIT 1').get()) {
    const ins = db.prepare("INSERT INTO commits(n,hash,at,scheduledAt,status,recordHash,seedBlock,closedAt,note) VALUES(?,?,?,?,'recorded',?,?,?,'recorded before the commitment log existed')");
    for (const r of db.prepare('SELECT data FROM records ORDER BY n').all()) { const d = JSON.parse(r.data); if (d.snapshotHash) ins.run(d.n, d.snapshotHash, d.committedAt ?? null, d.scheduledAt ?? null, d.recordHash ?? null, d.seedBlock ? JSON.stringify(d.seedBlock) : null, d.at ?? null); }
  }
  if (pending && pending.roundN !== round.n + 1) { // cannot happen through this code (a round and its log entry are written together); say so loudly if the database was changed by hand
    console.error(`[sim] the log holds a sealed commitment for round ${pending.roundN} but the next round is ${round.n + 1}. It is closed as voided.`);
    db.prepare("UPDATE commits SET status='voided', closedAt=?, note='found sealed at start for a round that was not the next one', state=NULL WHERE seq=?").run(now(), pending.seq); pending = null;
  }
  restoreState();
  // a round sealed by the previous version of this server (kept in kv, rules version 1) cannot be drawn by this one: it is voided in public
  const old = kv.get('round_pending', null);
  if (old && old.input && old.roundN === round.n + 1 && !pending) {
    try {
      old.seq = Number(db.prepare("INSERT INTO commits(n,hash,at,scheduledAt,status,state) VALUES(?,?,?,?,'sealed',?)").run(old.roundN, old.snapshotHash, old.committedAt, old.scheduledAt, JSON.stringify(old)).lastInsertRowid);
      voidRound(old, null, 'the server was upgraded to a new version of the rules while this round was sealed');
    } catch (e) { console.error('[sim] the round sealed before the upgrade could not be closed:', e.message); pending = wake(sealedRow()); }
  }
  if (old) kv.set('round_pending', null);
  if (pending) round.next = pending.scheduledAt + SEED_DELAY_MS; // committed before a restart: the same snapshot waits for the same block
  else if (!round.next || round.next < now()) { const h = new Date(); h.setUTCMinutes(0, 0, 0); round.next = h.getTime() + ROUND_MS; kv.set('round_next', round.next); }
  // a throw in one tick must not stop the meadow (or the process)
  setInterval(() => { try { tick(); } catch (e) { console.error('[sim] tick', e); } }, DT * 1000);
  setInterval(step, 1000);
  setInterval(saveSoon, SAVE_MS);
}

export function trialStats() {
  const out = Object.fromEntries(TRIALS.map((t) => [t.key, { ...t, rounds: 0, killed: 0, lastN: null, worst: {} }]));
  for (const g of db.prepare('SELECT n, data FROM gens ORDER BY n').all()) { const d = JSON.parse(g.data); const o = out[d.trial]; if (!o) continue; o.rounds++; o.killed += d.died; o.lastN = g.n; for (const m of d.models) o.worst[m.id] = (o.worst[m.id] || 0) + m.died; }
  return Object.values(out).map((o) => { const w = Object.entries(o.worst).sort((a, z) => z[1] - a[1])[0]; return { key: o.key, name: o.name, what: o.what, w: o.w, rounds: o.rounds, killed: o.killed, lastN: o.lastN, deadliestFor: w ? { id: w[0], name: byId[w[0]].name, died: w[1] } : null }; });
}

export const scene = () => ({ bushes: bushes.map((b) => [+b.p[0].toFixed(1), +b.p[1].toFixed(1)]) });

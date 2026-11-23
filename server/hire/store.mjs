// Hire tables, the operator's daily budget and the per-visitor limits. Everything that must be atomic is ONE sqlite statement,
// so two hires arriving together can never both take the last cent of the day.
import { createHash } from 'node:crypto';
import { db } from '../db.mjs';
import '../ots.mjs'; // creates the ots table this file reads

db.exec(`
CREATE TABLE IF NOT EXISTS hires (id TEXT PRIMARY KEY, creature_id INTEGER, pid_h TEXT, ip_h TEXT, task TEXT, model TEXT, status TEXT, started_at INTEGER, ended_at INTEGER,
  cost_micros INTEGER DEFAULT 0, receipt TEXT, receipt_hash TEXT, signature TEXT, outputs TEXT, error TEXT, paid_by TEXT, energy TEXT);
CREATE INDEX IF NOT EXISTS hires_creature ON hires(creature_id, started_at);
CREATE INDEX IF NOT EXISTS hires_started ON hires(started_at);
CREATE TABLE IF NOT EXISTS hire_budget (day TEXT PRIMARY KEY, spent INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS hire_limits (k TEXT, win INTEGER, n INTEGER, PRIMARY KEY (k, win));
CREATE TABLE IF NOT EXISTS hire_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, creature_id INTEGER, at INTEGER, note TEXT, hire_id TEXT);
CREATE INDEX IF NOT EXISTS hire_memory_c ON hire_memory(creature_id, id);
CREATE TABLE IF NOT EXISTS hire_payments (ref TEXT PRIMARY KEY, hire_id TEXT, at INTEGER, payer TEXT, value TEXT, kind TEXT);
CREATE INDEX IF NOT EXISTS hires_ip ON hires(ip_h, started_at);
`);
// hidden = 1: kept off the public floor by the operator (node server/hire/admin.mjs hide <id>); the receipt stays reachable by its id
try { db.exec('ALTER TABLE hires ADD COLUMN hidden INTEGER DEFAULT 0'); } catch {}

export const USD = 1e6; // the budget is kept in micro-dollars (integers), so no float ever drifts
export const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const nextMidnight = (t = Date.now()) => { const d = new Date(t); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
export const dailyCapMicros = () => Math.max(0, Math.round(Number(process.env.HIRE_DAILY_USD ?? 2) * USD));

const ensureDay = db.prepare('INSERT OR IGNORE INTO hire_budget(day, spent) VALUES(?, 0)');
const take = db.prepare('UPDATE hire_budget SET spent = spent + ?1 WHERE day = ?2 AND spent + ?1 <= ?3');
const fix = db.prepare('UPDATE hire_budget SET spent = MAX(0, spent + ?1) WHERE day = ?2');
const spentQ = db.prepare('SELECT spent FROM hire_budget WHERE day=?');

/** Book the worst case of one model call before it is made. Returns the booking (to correct later) or null when the day's cap would be passed.
 *  The worst case stays booked if the process dies mid-call, so a crash can only over-count, never under-count. */
export function book(micros, free = true) {
  const day = dayOf(); ensureDay.run(day);
  if (!free) { fix.run(micros, day); return { day, micros }; } // paid hires are bounded by their own price, they still show in the day's total
  return take.run(micros, day, dailyCapMicros()).changes === 1 ? { day, micros } : null;
}
/** Replace a booking's worst case by what the call really cost. */
export const settle = (b, actualMicros) => { if (b) fix.run(Math.round(actualMicros) - b.micros, b.day); };
const todayQ = db.prepare('SELECT COUNT(*) n FROM hires WHERE started_at >= ?');
export function budget() {
  const day = dayOf(), cap = dailyCapMicros(), spent = spentQ.get(day)?.spent || 0;
  return { day, capUsd: cap / USD, spentUsd: +(spent / USD).toFixed(6), leftUsd: +(Math.max(0, cap - spent) / USD).toFixed(6), resetsAt: nextMidnight(), hiresToday: todayQ.get(Date.parse(day + 'T00:00:00Z')).n };
}
export const overCap = () => (spentQ.get(dayOf())?.spent || 0) >= dailyCapMicros();
export const leftMicros = () => Math.max(0, dailyCapMicros() - (spentQ.get(dayOf())?.spent || 0));

// fixed windows, smoothed: the previous window still counts in proportion to how much of it overlaps the last full period,
// so a burst at the end of one hour and the start of the next cannot reach twice the cap. One statement checks and counts.
const bump = db.prepare('INSERT INTO hire_limits(k, win, n) VALUES(?1, ?2, 1) ON CONFLICT(k, win) DO UPDATE SET n = n + 1 WHERE n < ?3');
const unbump = db.prepare('UPDATE hire_limits SET n = MAX(0, n - 1) WHERE k=? AND win=?');
const prevN = db.prepare('SELECT n FROM hire_limits WHERE k=? AND win=?');
/** Take one slot in each window, all or nothing. Returns null on success or the key that is full. */
export function takeSlots(slots) {
  const taken = [];
  for (const s of slots) {
    const now = Date.now(), win = Math.floor(now / s.ms), frac = (now % s.ms) / s.ms;
    const max = s.max - Math.floor((prevN.get(s.k, win - 1)?.n || 0) * (1 - frac));
    if (max < 1 || bump.run(s.k, win, max).changes !== 1) { for (const t of taken) unbump.run(t.k, t.win); return s; }
    taken.push({ k: s.k, win });
  }
  return null;
}
export const giveBack = (slots) => { for (const s of slots) unbump.run(s.k, Math.floor(Date.now() / s.ms)); };
setInterval(() => { try { db.prepare('DELETE FROM hire_limits WHERE win < ?').run(Math.floor(Date.now() / 3600_000) - 48); } catch {} }, 3600_000).unref();

// visitors are kept as salted hashes: the table can show "same visitor" without holding an address or a session id
const SALT = createHash('sha256').update('weightlings-hire|' + (process.env.HIRE_SALT || process.env.ANTHROPIC_API_KEY || 'local')).digest('hex').slice(0, 32);
export const visitorHash = (s) => createHash('sha256').update(SALT + '|' + String(s)).digest('hex').slice(0, 24);

export const q = {
  insert: db.prepare("INSERT INTO hires(id, creature_id, pid_h, ip_h, task, model, status, started_at, paid_by) VALUES(?,?,?,?,?,?,'running',?,?)"),
  cost: db.prepare('UPDATE hires SET cost_micros = cost_micros + ? WHERE id=?'),
  finish: db.prepare('UPDATE hires SET status=?, ended_at=?, receipt=?, receipt_hash=?, signature=?, outputs=?, error=?, energy=? WHERE id=? AND receipt_hash IS NULL'),
  get: db.prepare('SELECT * FROM hires WHERE id=?'),
  // the public lists show delivered hires only: a refused or failed task never reaches the floor, and the operator can hide any hire
  byCreature: db.prepare("SELECT * FROM hires WHERE creature_id=? AND receipt_hash IS NOT NULL AND status='done' AND COALESCE(hidden,0)=0 ORDER BY started_at DESC LIMIT ?"),
  recent: db.prepare("SELECT * FROM hires WHERE receipt_hash IS NOT NULL AND status='done' AND COALESCE(hidden,0)=0 ORDER BY started_at DESC LIMIT ?"),
  visitorSpent: db.prepare('SELECT COALESCE(SUM(cost_micros),0) m FROM hires WHERE ip_h=? AND started_at >= ?'),
  runningBy: db.prepare("SELECT COUNT(*) n FROM hires WHERE ip_h=? AND status='running'"),
  memByVisitor: db.prepare('SELECT COUNT(*) n FROM hire_memory m JOIN hires h ON h.id = m.hire_id WHERE m.creature_id=? AND h.ip_h=? AND m.at >= ?'),
  running: db.prepare("SELECT COUNT(*) n FROM hires WHERE status='running'"),
  fedSince: db.prepare("SELECT COUNT(*) n FROM hires WHERE creature_id=? AND status='done' AND energy IS NOT NULL AND json_extract(energy,'$.granted') > 0 AND ended_at >= ?"),
  memList: db.prepare('SELECT id, at, note, hire_id FROM hire_memory WHERE creature_id=? ORDER BY id DESC LIMIT ?'),
  memAdd: db.prepare('INSERT INTO hire_memory(creature_id, at, note, hire_id) VALUES(?,?,?,?)'),
  memTrim: db.prepare('DELETE FROM hire_memory WHERE creature_id=? AND id NOT IN (SELECT id FROM hire_memory WHERE creature_id=? ORDER BY id DESC LIMIT ?)'),
  payUse: db.prepare('INSERT OR IGNORE INTO hire_payments(ref, hire_id, at, payer, value, kind) VALUES(?,?,?,?,?,?)'),
  unstamped: db.prepare("SELECT h.receipt_hash, h.id FROM hires h LEFT JOIN ots o ON o.hash = h.receipt_hash WHERE h.receipt_hash IS NOT NULL AND o.hash IS NULL AND h.ended_at > ? ORDER BY h.ended_at DESC LIMIT 10"),
  ots: db.prepare('SELECT at, calendar FROM ots WHERE hash=?'),
};

// a run that was in flight when the process stopped cannot finish: close it as failed (its booked worst case stays booked)
db.prepare("UPDATE hires SET status='failed', ended_at=?, error='interrupted: the server restarted during this hire' WHERE status='running'").run(Date.now());

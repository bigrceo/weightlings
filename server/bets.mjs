// Backing a creature for the next trial, with the paper credits of the model exchange (book.bal.CRED, see market.mjs). No real money.
// One position per visitor per creature per round, 1 to 200 credits, "survive" or "die". Each creature has its own pool for the round:
// the winning side splits the whole pool pro rata. A pool with nobody on one side is returned in full, and so is every stake of a
// voided round or on a creature that was not in the round's committed snapshot. Settled from the stored round record (sim.record(n)).
import { db } from './db.mjs';
import * as sim from './sim.mjs';
import { book } from './market.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS backs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, round INTEGER, pid TEXT, being INTEGER, nick TEXT, side TEXT, amt REAL,
  status TEXT DEFAULT 'open', outcome TEXT, payout REAL, settledAt INTEGER, UNIQUE (pid, round, being));
CREATE INDEX IF NOT EXISTS backs_round ON backs(round, status);
CREATE INDEX IF NOT EXISTS backs_pid ON backs(pid, id);`);

export const MIN = 1, MAX = 200;
const PID = /^[a-z0-9]{8,40}$/;
const r2 = (x) => Math.round(x * 100) / 100;
const nextRound = () => sim.round.n + 1;
const open = () => !sim.seedPending();

function credit(pid, d) {
  const bal = book(pid); bal.CRED = Math.max(0, (bal.CRED || 0) + d);
  db.prepare('UPDATE book SET bal=? WHERE pid=?').run(JSON.stringify(bal), pid);
  return bal.CRED;
}
function pools(round, being) {
  const p = { survive: 0, die: 0, backers: 0 };
  for (const r of db.prepare('SELECT side, SUM(amt) a, COUNT(*) c FROM backs WHERE round=? AND being=? GROUP BY side').all(round, being)) { p[r.side] = r.a; p.backers += r.c; }
  return p;
}
const shape = (r) => ({ id: r.id, at: r.at, round: r.round, being: r.being, nick: r.nick, side: r.side, amt: r.amt, status: r.status, outcome: r.outcome, payout: r.payout, profit: r.payout == null ? null : r2(r.payout - r.amt), settledAt: r.settledAt });

/** Place a position. Throws an Error with a plain message when it is not allowed. */
export function back(pid, id, amt, side) {
  if (!PID.test(pid || '')) throw new Error('bad session');
  id = Number(id); amt = Math.floor(Number(amt));
  if (side !== 'survive' && side !== 'die') throw new Error('Pick SURVIVES or DIES');
  if (!(amt >= MIN && amt <= MAX)) throw new Error(`Between ${MIN} and ${MAX} credits per creature per round`);
  if (!open()) throw new Error('Sealed. The block decides.');
  const b = sim.L.get(id); if (!b) throw new Error('That creature is not alive');
  const round = nextRound();
  if (db.prepare('SELECT 1 FROM backs WHERE pid=? AND round=? AND being=?').get(pid, round, id)) throw new Error('You already have a position on this creature for this round');
  const bal = book(pid);
  if ((bal.CRED || 0) < amt) throw new Error('Not enough credits');
  db.exec('BEGIN');
  try {
    credit(pid, -amt);
    db.prepare('INSERT INTO backs(at,round,pid,being,nick,side,amt) VALUES(?,?,?,?,?,?,?)').run(Date.now(), round, pid, id, b.nick, side, amt);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, round, being: id, side, amt, credits: book(pid).CRED || 0, pool: pools(round, id) };
}

/** Pay every open position of a round out of its record. One transaction; a round is settled once (status leaves 'open'). */
function settleRound(round) {
  const rows = db.prepare("SELECT * FROM backs WHERE round=? AND status='open'").all(round);
  if (!rows.length) return;
  const rec = sim.record(round);
  if (!rec && sim.round.n < round) return; // not held yet
  const usable = rec && !rec.voided && !rec.legacy && rec.result && Array.isArray(rec.result.dead) && Array.isArray(rec.snapshot);
  const dead = usable ? new Set(rec.result.dead.map(Number)) : null, entered = usable ? new Set(rec.snapshot.map((s) => Number(s.id))) : null;
  const by = new Map(); for (const r of rows) (by.get(r.being) || by.set(r.being, []).get(r.being)).push(r);
  const at = Date.now(), upd = db.prepare('UPDATE backs SET status=?, outcome=?, payout=?, settledAt=? WHERE id=?');
  db.exec('BEGIN');
  try {
    for (const [being, list] of by) {
      const refund = (why) => { for (const r of list) { upd.run('refunded', why, r.amt, at, r.id); credit(r.pid, r.amt); } };
      if (!usable) { refund('void'); continue; }
      if (!entered.has(being)) { refund('absent'); continue; }
      const outcome = dead.has(being) ? 'die' : 'survive';
      const pool = list.reduce((s, r) => s + r.amt, 0), win = list.filter((r) => r.side === outcome), winSum = win.reduce((s, r) => s + r.amt, 0);
      if (!winSum || winSum === pool) { refund(outcome === 'die' ? 'died-onesided' : 'survived-onesided'); continue; }
      for (const r of list) {
        const pay = r.side === outcome ? (pool * r.amt) / winSum : 0;
        upd.run(pay ? 'won' : 'lost', outcome, pay, at, r.id); if (pay) credit(r.pid, pay);
      }
    }
    db.exec('COMMIT');
    console.log(`[bets] round ${round}: ${rows.length} paper positions settled${usable ? '' : ' (refunded: no usable record)'}`);
  } catch (e) { db.exec('ROLLBACK'); console.warn('[bets] settle', round, e.message); }
}
export function settleDue() {
  for (const { round } of db.prepare("SELECT DISTINCT round FROM backs WHERE status='open' AND round<=?").all(sim.round.n)) settleRound(round);
}

export function mine(pid) {
  if (!PID.test(pid || '')) return { round: nextRound(), sealed: !open(), credits: null, open: [], settled: [] };
  const round = nextRound();
  return { round, sealed: !open(), min: MIN, max: MAX, credits: book(pid).CRED || 0,
    open: db.prepare("SELECT * FROM backs WHERE pid=? AND status='open' ORDER BY id DESC").all(pid).map((r) => ({ ...shape(r), pool: pools(r.round, r.being) })),
    settled: db.prepare("SELECT * FROM backs WHERE pid=? AND status!='open' ORDER BY settledAt DESC, id DESC LIMIT 20").all(pid).map(shape) };
}
export function backing(id) {
  id = Number(id); const round = nextRound(), b = sim.L.get(id);
  return { id, round, sealed: !open(), alive: !!b, nick: b ? b.nick : null, min: MIN, max: MAX, ...pools(round, id) };
}
export function board(pid) {
  const round = nextRound();
  const top = db.prepare("SELECT pid, SUM(payout-amt) profit, COUNT(*) n, SUM(status='won') won, SUM(amt) staked FROM backs WHERE status IN ('won','lost') GROUP BY pid ORDER BY profit DESC LIMIT 20").all()
    .map((r, i) => ({ rank: i + 1, who: r.pid.slice(0, 4) + '…', you: r.pid === pid, profit: r2(r.profit), positions: r.n, won: r.won, staked: r.staked }));
  const all = db.prepare("SELECT being, SUM(amt) pool, COUNT(*) backers, SUM(CASE WHEN side='survive' THEN amt ELSE 0 END) survive, SUM(CASE WHEN side='die' THEN amt ELSE 0 END) die FROM backs WHERE round=? AND status='open' GROUP BY being ORDER BY pool DESC, being LIMIT 400").all(round);
  const most = all.slice(0, 10).map((r) => { const b = sim.L.get(r.being); return { id: r.being, nick: b ? b.nick : null, model: b ? b.m.id : null, modelName: b ? b.m.name : null, tier: b ? b.m.tier : null, pool: r.pool, backers: r.backers, survive: r.survive, die: r.die }; });
  // every pool of the coming round, by creature id: [on survives, on dies]
  const pools = Object.fromEntries(all.map((r) => [r.being, [r.survive, r.die]]));
  return { round, sealed: !open(), top, most, pools };
}
export function start() { try { settleDue(); } catch (e) { console.warn('[bets]', e.message); } setInterval(() => { try { settleDue(); } catch (e) { console.warn('[bets]', e.message); } }, 2000).unref(); }

// The brain market. Every model trades as an index around a reference of 1.000. Survival moves the premium after each round;
// paper swaps move it a little too. The premium is capped at ±30% of reference. Host prices (USD per million tokens, 3 input : 1 output)
// come live from OpenRouter's public model list where the model is still hosted.
import { db, kv } from './db.mjs';
import { MODELS, byId } from './models.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS mkt (model TEXT PRIMARY KEY, premium REAL DEFAULT 0, hist TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS book (pid TEXT PRIMARY KEY, bal TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS fills (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, pid TEXT, gave TEXT, got TEXT, amt REAL, out REAL);`);
const OR_ID = { 'qwen2.5-72b': 'qwen/qwen-2.5-72b-instruct', 'llama-3.1-70b': 'meta-llama/llama-3.1-70b-instruct', 'llama-3.1-8b': 'meta-llama/llama-3.1-8b-instruct', 'llama-3.2-3b': 'meta-llama/llama-3.2-3b-instruct',
  'gemma-2-27b': 'google/gemma-2-27b-it', 'mixtral-8x22b': 'mistralai/mixtral-8x22b-instruct', 'deepseek-v3': 'deepseek/deepseek-chat', 'deepseek-r1': 'deepseek/deepseek-r1-0528', 'llama-3.1-405b': 'meta-llama/llama-3.1-405b-instruct',
  'mistral-7b': 'mistralai/mistral-7b-instruct', 'mixtral-8x7b': 'mistralai/mixtral-8x7b-instruct', 'gemma-2-9b': 'google/gemma-2-9b-it', 'qwen2.5-7b': 'qwen/qwen-2.5-7b-instruct' };
const host = {}; let hostAt = 0;
const FEE = 0.003, CAP = 0.3, START = 1000;

for (const m of MODELS) db.prepare('INSERT OR IGNORE INTO mkt(model, hist) VALUES(?, ?)').run(m.id, JSON.stringify([[Date.now(), 1]]));
const row = (id) => db.prepare('SELECT * FROM mkt WHERE model=?').get(id);
export const price = (id) => 1 + row(id).premium;
function setPremium(id, p, at = Date.now()) {
  p = Math.max(-CAP, Math.min(CAP, p));
  const h = JSON.parse(row(id).hist); h.push([at, +(1 + p).toFixed(5)]); while (h.length > 600) h.shift();
  db.prepare('UPDATE mkt SET premium=?, hist=? WHERE model=?').run(p, JSON.stringify(h), id);
}

async function refreshHosts() {
  try {
    const j = await (await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) })).json();
    const by = Object.fromEntries(j.data.map((m) => [m.id, m]));
    for (const [id, or] of Object.entries(OR_ID)) { const m = by[or]; host[id] = m ? +(((Number(m.pricing.prompt) * 3 + Number(m.pricing.completion)) / 4) * 1e6).toFixed(4) : null; }
    hostAt = Date.now();
  } catch (e) { console.warn('[mkt] hosts', e.message); }
}

/** After each round: models that survived better than the meadow average gain premium, the others lose it. */
export function onRound(data) {
  const ms = data.models.filter((m) => m.start > 0);
  const tot = ms.reduce((s, m) => s + m.start, 0), dead = ms.reduce((s, m) => s + m.died, 0);
  const avg = tot ? (tot - dead) / tot : 0;
  const moves = [];
  for (const m of ms) {
    const rate = (m.start - m.died) / m.start, weight = Math.min(1, m.start / 8); // small samples move less
    const before = price(m.id);
    setPremium(m.id, row(m.id).premium + 0.08 * (rate - avg) * weight + 0.002 * (m.born - m.died) / Math.max(1, m.start));
    moves.push({ id: m.id, before, after: price(m.id) });
  }
  return moves;
}

export function book(pid) {
  let b = db.prepare('SELECT * FROM book WHERE pid=?').get(pid);
  if (!b) { db.prepare('INSERT INTO book(pid,bal,created) VALUES(?,?,?)').run(pid, JSON.stringify({ CRED: START }), Date.now()); b = db.prepare('SELECT * FROM book WHERE pid=?').get(pid); }
  return JSON.parse(b.bal);
}
/** Paper swap. Credits (CRED) are worth 1.000 each; a model unit is worth its price. Moving in pushes a model up, out pushes it down. */
export function swap(pid, gave, got, amt) {
  const bal = book(pid);
  if (gave === got || !(amt > 0)) throw new Error('Pick two different assets and an amount');
  if ((bal[gave] || 0) < amt - 1e-9) throw new Error('Not enough balance');
  if (gave !== 'CRED' && !byId[gave]) throw new Error('Unknown model'); if (got !== 'CRED' && !byId[got]) throw new Error('Unknown model');
  const value = gave === 'CRED' ? amt : amt * price(gave);
  if (gave !== 'CRED') setPremium(gave, row(gave).premium - value / 200000);
  if (got !== 'CRED') setPremium(got, row(got).premium + value / 200000);
  const out = ((got === 'CRED' ? value : value / price(got))) * (1 - FEE);
  bal[gave] -= amt; if (bal[gave] < 1e-9) delete bal[gave]; bal[got] = (bal[got] || 0) + out;
  db.prepare('UPDATE book SET bal=? WHERE pid=?').run(JSON.stringify(bal), pid);
  db.prepare('INSERT INTO fills(at,pid,gave,got,amt,out) VALUES(?,?,?,?,?,?)').run(Date.now(), pid, gave, got, amt, out);
  return { bal, out };
}

export function markets() {
  const day = Date.now() - 86400000;
  // last settled round, per model: raw counts plus the smoothed rate (survived + 1) / (entered + 2); "enough" means 8 or more entered
  const sm = (s, n) => (s + 1) / (n + 2); let lr = null, lastBy = {};
  try { const g = db.prepare('SELECT n, data FROM gens ORDER BY n DESC LIMIT 1').get();
    if (g) { const ms = (JSON.parse(g.data).models || []).filter((m) => m.start > 0); const tot = ms.reduce((s, m) => s + m.start, 0), dead = ms.reduce((s, m) => s + m.died, 0);
      lr = { n: g.n, entered: tot, survived: tot - dead, survival: tot ? (tot - dead) / tot : null, survivalSmoothed: sm(tot - dead, tot), enough: tot >= 8 };
      for (const m of ms) lastBy[m.id] = { round: g.n, entered: m.start, survived: m.start - m.died, survival: (m.start - m.died) / m.start, survivalSmoothed: sm(m.start - m.died, m.start), enough: m.start >= 8, weight: Math.min(1, m.start / 8), meadow: lr }; } } catch {}
  return MODELS.map((m) => { const r = row(m.id), h = JSON.parse(r.hist); const p24 = (h.find((x) => x[0] >= day) || h[h.length - 1])[1];
    return { id: m.id, name: m.name, lab: m.lab, logo: m.logo, tier: m.tier, price: +(1 + r.premium).toFixed(5), premium: r.premium, change24: (1 + r.premium) / p24 - 1, host: host[m.id] ?? null, last: lastBy[m.id] || (lr ? { round: lr.n, entered: 0, survived: 0, survival: null, survivalSmoothed: null, enough: false, weight: 0, meadow: lr } : null), trades: db.prepare('SELECT COUNT(*) n FROM fills WHERE gave=? OR got=?').get(m.id, m.id).n }; })
    .sort((a, z) => z.price - a.price);
}
export const history = (id) => (row(id) ? JSON.parse(row(id).hist) : []);
export const hostInfo = () => ({ at: hostAt });
export function start() { refreshHosts(); setInterval(refreshHosts, 10 * 60000); }

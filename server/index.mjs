import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.mjs';
import * as idx from './indexer.mjs';
import * as sim from './sim.mjs';
import * as market from './market.mjs';
import * as ots from './ots.mjs';
import * as bets from './bets.mjs';
import { MODELS, TIERS, byId } from './models.mjs';
import * as hire from './hire/routes.mjs';
import * as build from './build.mjs';
import * as coin from './token.mjs';

const PORT = Number(process.env.PORT || 4091);
const PUB = path.resolve('public');
const POP = Number(process.env.POP_SEED || 140);
const CFG = () => ({ brand: process.env.BRAND || 'WEIGHTLINGS', ticker: coin.ticker(), token: coin.token(), ponsUrl: coin.token() ? `https://pons.fun/token/${coin.token()}` : '', xUrl: process.env.X_URL || '', site: process.env.SITE || '' });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.json': 'application/json', '.ico': 'image/x-icon' };
const rl = new Map();
function limited(ip, key, max, winMs) { const k = ip + key, t = Date.now(); const a = (rl.get(k) || []).filter((x) => t - x < winMs); if (a.length >= max) return true; a.push(t); rl.set(k, a); return false; }
// forget connections that have been quiet for an hour (the longest window in use)
setInterval(() => { const t = Date.now(); for (const [k, a] of rl) if (!a.length || t - a[a.length - 1] > 3600_000) rl.delete(k); }, 600_000).unref();
// Who is calling. X-Forwarded-For is written by whoever sends the request, except for the entries appended by proxies we trust:
// each trusted proxy appends the address it saw, so with N trusted proxies in front the caller is the N-th entry from the right.
// TRUST_PROXY_HOPS=0 (default off a platform) ignores the header and uses the socket; on Railway the default is 1 (its own proxy).
const HOPS = Math.max(0, Math.floor(Number(process.env.TRUST_PROXY_HOPS ?? (process.env.RAILWAY_ENVIRONMENT ? 1 : 0))) || 0);
// Behind weightlings.vercel.app -> Railway there may be two proxies (Vercel's, then Railway's): with HOPS=1 every visitor of the
// Vercel domain could share Vercel's egress address. The first proxied request logs the header SHAPE (counts only, never an
// address) so the right TRUST_PROXY_HOPS can be read from the production log: entries = 2 with a Vercel header => set 2.
let xffLogged = false;
function callerOf(req) {
  const sock = req.socket.remoteAddress || '';
  if (!xffLogged && req.headers['x-forwarded-for']) { xffLogged = true; console.log(`[proxy] x-forwarded-for has ${String(req.headers['x-forwarded-for']).split(',').length} entr(y/ies); TRUST_PROXY_HOPS=${HOPS}; x-vercel-forwarded-for ${req.headers['x-vercel-forwarded-for'] ? 'present' : 'absent'}; x-vercel-id ${req.headers['x-vercel-id'] ? 'present' : 'absent'}; x-real-ip ${req.headers['x-real-ip'] ? 'present' : 'absent'}`); }
  if (!HOPS) return sock;
  const xs = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xs.length >= HOPS ? xs[xs.length - HOPS] : sock;
}
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || '');

// population: holders of the token first; before launch, the most active real Pons traders of the last 24 h
function seed() {
  for (const [w] of idx.tokenInfo.holders) sim.found(w, 'holder');
  const have = db.prepare("SELECT COUNT(*) n FROM beings WHERE gen=0 AND source='seed'").get().n;
  if (have >= POP) return;
  const since = Math.floor(Date.now() / 1000) - 86400;
  const rows = db.prepare('SELECT wallet, COUNT(*) n FROM trades WHERE ts>=? GROUP BY wallet HAVING n BETWEEN 3 AND 400 ORDER BY n DESC LIMIT ?').all(since, POP * 2);
  let k = have; for (const r of rows) { if (k >= POP) break; if (!db.prepare('SELECT 1 FROM beings WHERE wallet=?').get(r.wallet)) { sim.found(r.wallet, 'seed'); k++; } }
}

// when the indexer head last moved, so /api/status can say whether the chain view is fresh
const headSeen = { n: 0, at: 0 };
const seeHead = () => { const h = idx.state.head || 0; if (h && h !== headSeen.n) { headSeen.n = h; headSeen.at = Date.now(); } };
setInterval(seeHead, 5000).unref();

const routes = {
  'GET /api/config': () => CFG(),
  'GET /api/proof': () => { try { const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CAST(value AS INTEGER) - CAST(COALESCE(cost,'0') AS INTEGER) - CAST(COALESCE(fee,'0') AS INTEGER)),0) kept FROM pay_runs WHERE status='charged'").get(); return { paidHires: r.n, usdgEarned: r.kept / 1e6 }; } catch { return { paidHires: 0, usdgEarned: 0 }; } },
  'GET /api/models': () => ({ models: MODELS, tiers: TIERS }),
  'GET /api/world': () => sim.snapshot(),
  'GET /api/scene': () => sim.scene(),
  'GET /api/events': () => sim.events.slice(0, 50),
  'GET /api/round': () => ({ n: sim.round.n, next: sim.round.next, now: Date.now(), last: sim.round.last, trials: sim.TRIALS, upcoming: sim.TRIALS[sim.round.n % sim.TRIALS.length], sealed: sim.seedPending() }),
  // the hash of the coming round's frozen input, published a minute before its seed block exists (?full=1 adds the input itself)
  'GET /api/commit': (q) => sim.commit(q.get('full') === '1'),
  // every commitment ever published, newest first, with how it ended; ?n=N gives round N and its two neighbours
  'GET /api/commits': (q) => { const n = q.get('n'); return sim.commits(q.get('limit') || 50, n != null && /^\d+$/.test(n) ? Number(n) : null); },
  'GET /api/standing': () => sim.standing(),
  // stale = no simulation tick for 10 s, or the indexer head has not moved for 2 minutes (staleWhy says which)
  'GET /api/status': () => { seeHead(); const t = Date.now(), last = sim.round.last;
    const staleWhy = [];
    if (!sim.clock.lastTick || t - sim.clock.lastTick > 10000) staleWhy.push('simulation');
    if (!headSeen.at || t - headSeen.at > 120000) staleWhy.push('chain');
    return { stats_at: t, chainBlock: idx.state.head || null, chainBlockAt: headSeen.at || null, round: sim.round.n, nextTrialAt: sim.round.next, lastSeedBlock: last?.block || null, alive: sim.L.size, lastTickAt: sim.clock.lastTick || null, sealed: sim.seedPending(),
      roundOverdue: t - sim.round.next > 180000, stale: staleWhy.length > 0, staleWhy }; },
  'GET /api/rounds': () => sim.gens(48),
  'GET /api/genes': () => sim.modelBoard(),
  'GET /api/markets': () => ({ markets: market.markets(), hosts: market.hostInfo() }),
  'GET /api/history': (q) => market.history(q.get('id')),
  'GET /api/book': (q) => (/^[a-z0-9]{8,40}$/.test(q.get('pid') || '') ? market.book(q.get('pid')) : {}),
  // paper positions on the next round (bets.mjs): credits only, settled from the round record
  'GET /api/backs': (q) => bets.mine(q.get('pid')),
  'GET /api/backing': (q) => bets.backing(q.get('id')),
  'GET /api/backboard': (q) => bets.board(q.get('pid')),
  'GET /api/trials': () => sim.trialStats(),
  'GET /api/dead': (q) => sim.deadList(q.get('limit') || 30),
  'GET /api/toll': () => sim.toll(),
  'GET /api/stats': () => ({ alive: sim.L.size, lineages: db.prepare('SELECT COUNT(*) n FROM beings WHERE gen=0').get().n, beings: db.prepare('SELECT COUNT(*) n FROM beings').get().n, dead: db.prepare('SELECT COUNT(*) n FROM beings WHERE died IS NOT NULL').get().n, maxGen: db.prepare('SELECT MAX(gen) g FROM beings').get().g || 0, holders: idx.state.holders }),
};

async function body(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 1e4) break; } try { return JSON.parse(b || '{}'); } catch { return {}; } }

http.createServer(async (req, res) => {
  const send = (code, obj) => { if (res.headersSent) return res.end(); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  let u;
  try { u = new URL(req.url, 'http://x'); decodeURIComponent(u.pathname); } catch { return send(400, { error: 'bad request' }); }
  const ip = callerOf(req);
  try {
    const k = `${req.method} ${u.pathname}`;
    if (routes[k]) return send(200, routes[k](u.searchParams));
    if (req.method === 'GET' && u.pathname.startsWith('/api/being/')) {
      const id = Number(u.pathname.split('/').pop()); const b = sim.L.get(id);
      const row = db.prepare('SELECT * FROM beings WHERE id=?').get(id); if (!row) return send(404, { error: 'not found' });
      const m = byId[row.model];
      return send(200, { ...(b ? sim.view(b) : { ...row, modelName: m.name, lab: m.lab, logo: m.logo, tier: m.tier }), alive: !!b, died: row.died, cause: row.cause, rdied: row.rdied, rborn: row.rborn, modelCard: m, events: sim.events.filter((e) => e.who.includes(id)).slice(0, 10) });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/lineage/')) return send(200, sim.lineage(u.pathname.split('/').pop().toLowerCase()));
    const otsList = req.method === 'GET' && /^\/api\/round\/(\d+)\/ots$/.exec(u.pathname);
    if (otsList) return send(200, ots.forRound(Number(otsList[1])));
    const otsFile = req.method === 'GET' && /^\/api\/ots\/(0x[0-9a-f]{64})\.ots$/.exec(u.pathname);
    if (otsFile) { const f = ots.file(otsFile[1]); if (!f) return send(404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="weightlings-${otsFile[1].slice(2, 14)}.ots"` }); return res.end(f); }
    const rec = req.method === 'GET' && /^\/api\/round\/(\d+)\/record$/.exec(u.pathname);
    if (rec) { const r = sim.record(Number(rec[1])); return r ? send(200, r) : send(404, { error: 'not found' }); }
    if (req.method === 'GET' && u.pathname.startsWith('/api/round/')) { const g = sim.gen(Number(u.pathname.split('/').pop())); return g ? send(200, g) : send(404, { error: 'not found' }); }
    if (k === 'POST /api/admin/token') { const r = coin.setFromAdmin(req, await body(req)); return send(r.status, r.body); }
    if (k === 'POST /api/swap') {
      const { pid, gave, got, amt } = await body(req);
      if (!/^[a-z0-9]{8,40}$/.test(pid || '')) return send(400, { error: 'bad session' });
      if (limited(ip, 'swap', 60, 3600_000)) return send(429, { error: 'Slow down' });
      try { return send(200, market.swap(pid, gave, got, Number(amt))); } catch (e) { return send(400, { error: e.message }); }
    }
    if (k === 'POST /api/back') {
      const { pid, id, amt, side } = await body(req);
      if (!/^[a-z0-9]{8,40}$/.test(pid || '')) return send(400, { error: 'bad session' });
      if (limited(ip, 'back', 120, 3600_000)) return send(429, { error: 'Slow down' });
      try { return send(200, bets.back(pid, id, amt, side)); } catch (e) { return send(400, { error: e.message }); }
    }
    if (k === 'POST /api/hatch') {
      const { address } = await body(req);
      if (!isAddr(address)) return send(400, { error: 'Enter a 0x… Robinhood Chain address' });
      if (limited(ip, 'hatch', 10, 3600_000)) return send(429, { error: 'Too many hatches from this connection, try later' });
      const r = sim.found(address, idx.tokenInfo.holders.has(address.toLowerCase()) ? 'holder' : 'visitor');
      return r.error ? send(429, { error: r.error }) : send(200, r);
    }
    if (await hire.handle(req, res, u, ip)) return;
    if (await build.handle(req, res, u, ip, { holder: (a) => idx.tokenInfo.holders.has(a) })) return;
    if (u.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
    const pages = { '/': '/index.html', '/app': '/app.html', '/genes': '/genes.html', '/market': '/market.html', '/record': '/record.html', '/verify': '/verify.html', '/back': '/back.html', '/hire': '/hire.html', '/build': '/build.html', '/agents': '/agents.html' };
    let p = pages[u.pathname] || (u.pathname.startsWith('/l/') ? '/lineage.html' : u.pathname.startsWith('/r/') ? '/round.html' : decodeURIComponent(u.pathname));
    let f = path.join(PUB, p);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    let html = null;
    if (p === '/round.html') { const g = sim.gen(Number(u.pathname.slice(3))); html = fs.readFileSync(f, 'utf8'); html = html.replaceAll('__DESC__', g ? `Round ${g.n} · ${g.trialName}: ${g.died} died, ${g.born} born. ${g.dominant.name} dominates.` : 'Hourly natural selection for creatures whose brains are simulated from open model cards.'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': /\.(png|jpg|mp4)$/.test(f) ? 'public, max-age=86400' : 'no-cache' });
    html ? res.end(html) : fs.createReadStream(f).pipe(res);
  } catch (e) { console.warn('[http]', e.message); try { send(500, { error: 'internal' }); } catch {} }
})
  // a server that cannot listen must stop: a second process on the same database would hold the same rounds twice
  .on('error', (e) => { console.error('[http] cannot listen:', e.message); process.exit(1); })
  .listen(PORT, () => console.log(`[weightlings] http://localhost:${PORT}`));

// one bad request or one failed timer must not take the meadow down: log it and keep running
process.on('uncaughtException', (e) => console.error('[fatal] uncaught exception, still running:', e));
process.on('unhandledRejection', (e) => console.error('[fatal] unhandled rejection, still running:', e));
// a deploy or a stop writes the hour first, so the next start reads it back
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { sim.saveState(); } catch (e) { console.warn('[sim] the hour could not be saved on', sig, e.message); } process.exit(0); });

market.start();
ots.start();
sim.start();
bets.start();
// the chain indexer needs the RPC; the meadow does not. If the RPC is unreachable at boot, keep serving and keep trying:
// creatures go on foraging and the hourly round waits for its seed block (sim.mjs never falls back to another source of dice).
(async () => {
  for (let wait = 5000; ; wait = Math.min(60000, wait * 2)) {
    try { await idx.start(() => {}); break; }
    catch (e) { idx.state.lastError = e.message; console.warn(`[boot] Robinhood Chain RPC unreachable (${e.cause?.message || e.message}); the indexer retries in ${wait / 1000} s`); await new Promise((r) => setTimeout(r, wait)); }
  }
  const seedSafe = () => { try { seed(); } catch (e) { console.warn('[seed]', e.message); } };
  seedSafe(); setInterval(seedSafe, 120000);
})();

// HTTP surface of the hire engine. index.mjs calls handle() once per request, before its /api 404:
//   POST /api/hire                { creatureId, task, pid }  -> 202 { id, stream, receipt } | 402 terms | 409 | 429 | 503
//   GET  /api/hire/:id/stream     Server-Sent Events: start, call, thinking, text, tool, usage, energy, error, done
//   GET  /api/hire/:id            receipt + hash + signature + timestamp proof + tool outputs (hash them to check the steps)
//   GET  /api/hires?creature=&limit=   recent receipts
//   GET  /api/hire/key            Ed25519 public key and how receipts are hashed and signed
//   GET  /api/hire/budget         today's operator budget and how many hires started today
//   GET  /api/hire/config         budget left today, limits, prices, payment mode
//   GET  /api/hire/creature/:id   what hiring this creature means: persona, model, allowance, price, recent hires
//   GET  /api/earnings            per creature wallet: earned, cost, profit, runs, owner (chain reads, cached 60 s); { live:false } while payments are off
//   GET  /api/earnings/total      the same, summed
//   POST /mcp                     MCP over streamable HTTP (list_creatures, hire_creature, get_receipt)
import net from 'node:net';
import * as sim from '../sim.mjs';
import { tierOf } from '../models.mjs';
import * as store from './store.mjs';
import { q, visitorHash } from './store.mjs';
import * as engine from './engine.mjs';
import * as x402 from './x402.mjs';
import * as wallets from './wallets.mjs';
import { keyDoc, keyFor, otsOf } from './receipts.mjs';
import { recall } from './tools.mjs';
import * as mcp from './mcp.mjs';
import { jobOf } from '../build.mjs';

const PER_PID = () => Math.max(1, Number(process.env.HIRE_PER_HOUR || 5));
const PER_IP = () => Math.max(1, Number(process.env.HIRE_PER_HOUR_IP || 8));
const GLOBAL_10MIN = () => Math.max(1, Number(process.env.HIRE_GLOBAL_PER_10MIN || 40)); // free hires started by everyone together
const VISITOR_SHARE = () => Math.min(1, Math.max(0.01, Number(process.env.HIRE_VISITOR_SHARE || 0.25))); // of the daily budget, per connection
const RUNNING_PER_IP = () => Math.max(1, Number(process.env.HIRE_RUNNING_PER_IP || 2));
/** One key per connection: IPv4 as is (IPv4-mapped IPv6 unwrapped), IPv6 by its /64, which one subscriber usually holds whole. */
export function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const z = s.indexOf('%'); if (z >= 0) s = s.slice(0, z);
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s); if (m) return m[1];
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s || 'unknown';
  let [head, tail = null] = s.split('::');
  const part = (x) => (x ? x.split(':') : []);
  let h = part(head), t = tail == null ? [] : part(tail);
  const v4 = (arr) => { const last = arr[arr.length - 1]; if (last && last.includes('.')) { const o = last.split('.').map(Number); arr.splice(-1, 1, ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)); } };
  if (tail == null) v4(h); else v4(t);
  const g = tail == null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return g.slice(0, 4).map((x) => x.padStart(4, '0')).join(':') + '::/64';
}
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const json = (res, code, obj, headers = {}) => { if (res.headersSent) return res.end(); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'payment-required, payment-response, x-payment-response, retry-after', ...headers }); res.end(JSON.stringify(obj)); };
export const siteOf = (req) => (process.env.SITE ? (process.env.SITE.includes('://') ? process.env.SITE : 'https://' + process.env.SITE) : `http://${req.headers.host || 'localhost'}`).replace(/\/$/, '');

export async function readBody(req, max = 60_000) {
  let b = ''; for await (const c of req) { b += c; if (b.length > max) throw Object.assign(new Error('The request is too large.'), { status: 413 }); }
  try { return JSON.parse(b || '{}'); } catch { throw Object.assign(new Error('Send JSON.'), { status: 400 }); }
}

/** Admission for one hire, shared by the page and MCP so both get the same limits and payment checks. Returns { status, body, headers }. */
export async function admit({ creatureId, task, pid, ip, req, resource }) {
  creatureId = Number(creatureId); task = clean(task);
  if (!/^[a-z0-9]{8,40}$/.test(String(pid || ''))) return { status: 400, body: { error: 'bad session' } };
  if (!Number.isInteger(creatureId) || creatureId <= 0) return { status: 400, body: { error: 'Which creature? Send creatureId.' } };
  if (task.length < 3) return { status: 400, body: { error: 'Write the task in a sentence or two.' } };
  if (task.length > engine.LIMITS.taskChars) return { status: 413, body: { error: `A task is at most ${engine.LIMITS.taskChars} characters.` } };
  const b = sim.L.get(creatureId);
  if (!b) return { status: 409, body: { error: 'That creature is not alive. Only living creatures can be hired.' } };
  if (!process.env.ANTHROPIC_API_KEY) return { status: 503, body: { error: 'Hiring is not switched on on this server yet.' } };
  if (engine.runningCount() >= engine.LIMITS.concurrency) return { status: 503, body: { error: 'Every worker is busy. Try again in a few seconds.', again: true }, headers: { 'retry-after': '10' } };
  const pidH = visitorHash('pid:' + pid), ipH = visitorHash('ip:' + ipKey(ip)), id = engine.newId();
  if (q.runningBy.get(ipH).n >= RUNNING_PER_IP()) return { status: 429, body: { error: 'Your earlier hire is still running. Wait for its receipt, then hire again.' }, headers: { 'retry-after': '15' } };
  let paidBy = 'operator (launch)', free = true, extraHeaders = {}, pay = null;
  if (wallets.enabled()) {
    // paid into the creature's own wallet contract (wallets.mjs): quote, then take the signed payment, then run
    if (!wallets.configured()) return { status: 503, body: { error: 'Payments are switched on but not configured (FACTORY / TREASURY / USDG / OPERATOR_KEY).' } };
    const runCapUsd = engine.LIMITS.runUsd[engine.modelFor(b.m.tier)];
    let paid;
    try {
      paid = await wallets.collect(req, b, { hireId: id, runCapUsd });
      if (!paid) {
        // a quote for a creature with no wallet yet makes one (operator gas): at most 3 such quotes per connection an hour, on top of WALLETS_PER_DAY
        if (!wallets.walletOf(b.id) && store.takeSlots([{ k: 'mkwallet:' + ipH, max: 3, ms: 3600_000 }])) return { status: 429, body: { error: 'You asked for terms on too many creatures without a wallet this hour. Hire one that already has a wallet, or try again later.' }, headers: { 'retry-after': '900' } };
        return await wallets.quote(b, { resource, runCapUsd });
      }
    } catch (e) { console.warn('[pay]', e.message); return { status: e.status || 503, body: { error: e.status ? e.message : 'Robinhood Chain could not be reached to set up the payment. Nothing was charged; try again.' } }; }
    if (!paid.ok) return { status: paid.status, body: { error: paid.error, ...(paid.extra || {}) } };
    paidBy = paid.paidBy; free = false; pay = { budgetUnits: paid.budgetUnits };
  } else if (x402.on()) {
    if (!x402.configured()) return { status: 503, body: { error: 'Payments are switched on but not configured (USDG / PAY_TO).' } };
    const paid = await x402.pay(req, { creatureId, task, tier: b.m.tier, resource, hireIdHint: id });
    if (!paid) { const t = x402.terms({ creatureId, task, tier: b.m.tier, resource }); return t; }
    if (!paid.ok) return { status: paid.status, body: { error: paid.error } };
    paidBy = paid.paidBy; free = false;
    if (paid.responseHeader) extraHeaders = { 'x-payment-response': paid.responseHeader, 'payment-response': paid.responseHeader };
  } else {
    const bud = store.budget();
    // the smallest first call this creature can make; below it, today's budget is spent for this creature
    const need = engine.PRICES.perMTok[engine.modelFor(b.m.tier)].output * 1500 / 1e6 * store.USD;
    if (store.leftMicros() < need) {
      const mins = Math.ceil((bud.resetsAt - Date.now()) / 60000);
      return { status: 503, body: { error: `Today's hiring budget ($${bud.capUsd.toFixed(2)}, paid by the operator) is spent. Hiring opens again at 00:00 UTC, in ${Math.floor(mins / 60)} h ${mins % 60} min.`, budget: bud }, headers: { 'retry-after': String(Math.ceil((bud.resetsAt - Date.now()) / 1000)) } };
    }
    // no single connection may spend more than its share of the day's free budget (booked worst cases count until settled)
    const mine = q.visitorSpent.get(ipH, Date.parse(bud.day + 'T00:00:00Z')).m, share = Math.round(store.dailyCapMicros() * VISITOR_SHARE());
    if (mine + need > share) {
      const mins = Math.ceil((bud.resetsAt - Date.now()) / 60000);
      return { status: 429, body: { error: `You have used your share of today's free hiring budget. It opens again at 00:00 UTC, in ${Math.floor(mins / 60)} h ${mins % 60} min.` }, headers: { 'retry-after': String(Math.ceil((bud.resetsAt - Date.now()) / 1000)) } };
    }
    const full = store.takeSlots([{ k: 'all', max: GLOBAL_10MIN(), ms: 600_000 }, { k: 'pid:' + pidH, max: PER_PID(), ms: 3600_000 }, { k: 'ip:' + ipH, max: PER_IP(), ms: 3600_000 }]);
    if (full && full.k === 'all') return { status: 503, body: { error: 'Many hires started in the last few minutes. Try again in a few minutes.', again: true }, headers: { 'retry-after': '120' } };
    if (full) { const wait = 3600 - Math.floor((Date.now() % 3600_000) / 1000); return { status: 429, body: { error: `You can hire ${full.max === 1 ? 'once' : full.max + ' times'} an hour while hiring is free. Try again in ${Math.ceil(wait / 60)} min.` }, headers: { 'retry-after': String(wait) } }; }
  }
  let r;
  try { r = engine.start({ id, creatureId, task, pidH, ipH, paidBy, free, pay }); }
  catch (e) {
    if (!pay) throw e;
    // paid but not started: give it all back now, and say where the refund is recorded
    const refund = await wallets.refundUnstarted(id, e.message).catch(() => null);
    return { status: e.status || 500, body: { error: (e.status ? e.message : 'The hire could not start.') + ' Your payment is refunded in full.', id, refund, receipt: `/api/hire/${id}` } };
  }
  return { status: 202, headers: extraHeaders, body: { id: r.id, status: 'running', model: r.model, creature: { id: b.id, nick: b.nick, brain: b.m.name, tier: b.m.tier }, paidBy, stream: `/api/hire/${r.id}/stream`, receipt: `/api/hire/${r.id}`, disclosure: engine.disclosure(b, r.model) } };
}

export function config() {
  return {
    payments: wallets.enabled() ? wallets.describe() : x402.on() ? { on: true, configured: x402.configured(), network: 'eip155:4663', asset: process.env.USDG || null, payTo: process.env.PAY_TO || null, prices: Object.fromEntries(['common', 'uncommon', 'rare', 'epic', 'legendary'].map((t) => [t, x402.priceOf(t)])) } : { on: false, paidBy: 'operator (launch)' },
    budget: store.budget(), running: engine.runningCount(),
    limits: { perVisitorPerHour: PER_PID(), perConnectionPerHour: PER_IP(), connectionShareOfDailyBudget: VISITOR_SHARE(), allVisitorsPer10Min: GLOBAL_10MIN(), runningPerConnection: RUNNING_PER_IP(), notesPerVisitorPerCreaturePerDay: Number(process.env.HIRE_NOTES_PER_VISITOR_DAY ?? 2), maxSteps: engine.LIMITS.maxSteps, maxRunTokens: engine.LIMITS.maxRunTokens, runUsd: engine.LIMITS.runUsd, taskChars: engine.LIMITS.taskChars, concurrency: engine.LIMITS.concurrency, feedsPerHour: engine.LIMITS.feedsPerHour },
    models: { fast: engine.MODEL.fast, smart: engine.MODEL.smart, rule: 'Legendary and Epic creatures work through the smart model, the others through the fast one' },
    prices: engine.PRICES,
    honesty: "Every hire is done by Claude (Anthropic) through the operator's API key, in the creature's voice. A creature's open model is its brain in the game only.",
  };
}

export function creatureCard(id) {
  const b = sim.L.get(id);
  const recent = q.byCreature.all(id, 5).map(listItem);
  if (!b) return { id, alive: false, recent };
  const p = engine.persona(b);
  const j = jobOf(b.w);
  return { id, alive: true, nick: b.nick, job: j ? { job: j.job, title: j.title || null } : null, brain: b.m.name, tier: b.m.tier, tierName: tierOf(b.m.tier).name, energy: Math.round(b.down > 0 ? 0 : b.e), model: p.model, allowance: p.allowance, persona: p.text,
    price: x402.on() ? { units: x402.priceOf(b.m.tier), usdg: (Number(x402.priceOf(b.m.tier)) / 1e6).toFixed(2), ...(wallets.enabled() ? { wallet: wallets.walletOf(id)?.wallet || null } : {}) } : { free: true, paidBy: 'operator (launch)' },
    fedThisHour: q.fedSince.get(id, sim.round.next - sim.ROUND_MS).n, disclosure: engine.disclosure(b, p.model), recent,
    // its shared memory, each note with the hire that wrote it, so a planted note can be traced (and removed: server/hire/admin.mjs)
    memory: recall(id, p.allowance.notes).map((n) => ({ id: n.id, at: n.at, note: n.note, hireId: n.hire_id })) };
}
const listItem = (row) => { const r = row.receipt ? JSON.parse(row.receipt) : {}; return { id: row.id, creatureId: row.creature_id, nick: r.creature?.nick, brain: r.creature?.brain?.name, status: row.status, task: (r.task || '').slice(0, 200), answer: r.answer ? r.answer.slice(0, 280) : null, tools: (r.steps || []).map((s) => s.tool), model: row.model, costUsd: r.costUsd, energy: r.energy, startedAt: row.started_at, endedAt: row.ended_at, receiptHash: row.receipt_hash }; };

export function hireView(id) {
  const row = q.get.get(id);
  // a payment taken for a hire that never started (not confirmed in time, or refused after payment): its on-chain record and refund
  if (!row) { const payment = wallets.publicRun(id); return payment ? { id, status: 'not-started', payment } : null; }
  const v = engine.publicHire(row);
  if (!row.receipt_hash) return { ...v, stream: `/api/hire/${id}/stream` };
  // the key that signed THIS receipt: named inside the signed receipt; for older receipts, the known key that verifies it
  const keyId = v.receipt?.keyId || keyFor(row.receipt_hash, row.signature) || null;
  return { ...v, keyId, key: '/api/hire/key', ots: otsOf(row.receipt_hash), payment: wallets.publicRun(id),
    verify: 'receiptHash = sha256(canonical(receipt)); Ed25519.verify(the key named by keyId in /api/hire/key keys[], bytes(receiptHash), signature). Each step outputHash = sha256(outputs[i]). costUsd = the formula in receipt.prices applied to receipt.usage. systemHash = sha256(system).' };
}

export async function handle(req, res, u, ip) {
  const p = u.pathname, m = req.method;
  if (p === '/mcp') { await mcp.handle(req, res, ip, { admit, hireView, siteOf, readBody }); return true; }
  if ((p === '/api/earnings' || p === '/api/earnings/total') && m === 'GET') {
    try { json(res, 200, p === '/api/earnings' ? await wallets.earnings() : await wallets.earningsTotal(), { 'cache-control': 'public, max-age=30' }); }
    catch (e) { console.warn('[earnings]', e.message); json(res, 503, { live: true, error: 'Robinhood Chain could not be read just now. Try again in a minute.' }); }
    return true;
  }
  if (!p.startsWith('/api/hire')) return false;
  try {
    if (m === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-payment, payment-signature, x-payment-tx', 'access-control-max-age': '86400' }); res.end(); return true; }
    if (p === '/api/hire' && m === 'POST') {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { json(res, 415, { error: 'Send application/json.' }); return true; }
      const body = await readBody(req);
      const r = await admit({ creatureId: body.creatureId, task: body.task, pid: body.pid, ip, req, resource: siteOf(req) + '/api/hire' });
      json(res, r.status, r.body, r.headers); return true;
    }
    if (m !== 'GET') return false;
    if (p === '/api/hire/key') { json(res, 200, keyDoc(), { 'cache-control': 'public, max-age=300' }); return true; }
    if (p === '/api/hire/config') { json(res, 200, config()); return true; }
    if (p === '/api/hire/budget') { json(res, 200, store.budget()); return true; }
    if (p === '/api/hires') {
      const c = u.searchParams.get('creature'), lim = Math.max(1, Math.min(100, Number(u.searchParams.get('limit')) || 20));
      json(res, 200, { hires: (c && /^\d+$/.test(c) ? q.byCreature.all(Number(c), lim) : q.recent.all(lim)).map(listItem), budget: store.budget() }); return true;
    }
    let g = /^\/api\/hire\/creature\/(\d+)$/.exec(p);
    if (g) { json(res, 200, creatureCard(Number(g[1]))); return true; }
    g = /^\/api\/hire\/(h[0-9a-f]{20})\/stream$/.exec(p);
    if (g) { engine.subscribe(g[1], res, Number(req.headers['last-event-id'] ?? -1)); return true; }
    g = /^\/api\/hire\/(h[0-9a-f]{20})$/.exec(p);
    if (g) { const v = hireView(g[1]); v ? json(res, 200, v) : json(res, 404, { error: 'no such hire' }); return true; }
    return false;
  } catch (e) { json(res, e.status || 500, { error: e.status ? e.message : 'internal' }); if (!e.status) console.warn('[hire]', e.message); return true; }
}

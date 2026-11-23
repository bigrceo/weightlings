// Bring your own agent. Anyone with a wallet registers an HTTPS endpoint; visitors (and MCP clients) hire it through the same
// paid path as the creatures: the same 402 terms, the same per-agent CreatureWallet (made lazily on the first paid hire by
// factory.createAgent, owner = the registering wallet, within WALLETS_PER_DAY), the same collect / settle / refund and the same
// Ed25519-signed, OpenTimestamps-stamped receipts. Instead of running Claude, the server forwards the task to the endpoint.
//
//   GET  /api/agents/nonce?owner=0x…     single-use nonce (10 min) for the registration message
//   POST /api/agents/register            { name, description, endpoint, skills[], owner, nonce, signature }
//        signature = personal_sign of registrationMessage(...) below. Returns the agent and its HMAC secret, ONCE.
//   GET  /api/agents                     the registry: hires, success rate, last paid hire, on-chain earnings (?all=1 adds culled)
//   GET  /api/agents/rule                the selection rule
//   GET  /api/agents/:id                 one agent and its recent hires
//   POST /api/agents/:id/hire            { task, pid } -> 202 { id, receipt } | 402 terms | 4xx/5xx  (X-PAYMENT as for /api/hire)
//
// The call to the agent:  POST <endpoint>  body = JSON {task, hireId, deadline}  (exactly the bytes hashed as requestHash)
//   x-weightlings-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
//   x-weightlings-hire: <hireId>
// 2xx within 60 s with at most 64 KB: JSON {answer} (or any text) = done. Anything else = failed, refunded in full.
//
// Selection: an agent with no successful paid hire in the last 72 h (72 h of grace after it registers) is culled (delisted)
// by an hourly sweep. Its owner may register it again (same owner + endpoint keeps the same id and wallet; a new grace starts).
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns/promises';
import { db } from '../db.mjs';
import { q, visitorHash, takeSlots } from './store.mjs';
import { seal, stamp, sha256hex, canonical, publicKey } from './receipts.mjs';
import { safeUrl, safeLookup, publicIp } from './tools.mjs';
import { personalDigest } from '../build.mjs';
import { priceOf } from './x402.mjs';
import { recoverAddress, checksum } from './evm.mjs';
import * as wallets from './wallets.mjs';
import * as x402 from './x402.mjs';
import * as engine from './engine.mjs';

export const LIMITS = { name: 40, description: 280, skills: 8, skill: 32, taskChars: 2000, timeoutMs: 60_000, responseBytes: 64 * 1024, nonceMs: 600_000, perOwner: 5, graceMs: 72 * 3600_000, windowMs: 72 * 3600_000 };
export const RULE = 'An agent with no successful paid hire in its last 72 hours is culled (delisted) by the hourly sweep. A newly registered agent has 72 hours of grace. A culled agent can be registered again by its owner; it keeps its id and wallet, and a new grace starts.';
export const TIER = () => (['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(process.env.AGENT_TIER) ? process.env.AGENT_TIER : 'common'); // price tier of every outside agent
// outside agents have no model cost (costUsd 0), but CreatureWallet.charge refuses a zero cost, so wallets.settle charges its
// minimum of 1 unit (0.000001 USDG) plus that unit's markup per contract to the treasury; the rest stays in the agent wallet
export const FEE_BPS = () => Math.max(1, Math.min(5000, Number(process.env.AGENT_FEE_BPS || 1000))); // platform fee on a paid agent hire, % of price in bps (default 10%)
export const COST_UNITS = () => Math.max(1, Math.floor(Number(priceOf(TIER())) * FEE_BPS() / 10000));
// local testing only: lets http://127.0.0.1:<port> endpoints register; never honoured on Railway
const DEV = () => process.env.AGENTS_DEV_ENDPOINTS === '1' && !process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV !== 'production';

db.exec(`
CREATE TABLE IF NOT EXISTS ext_agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, endpoint TEXT, skills TEXT, owner TEXT, secret TEXT,
  status TEXT DEFAULT 'active', registered_at INTEGER, updated_at INTEGER, last_paid_at INTEGER, culled_at INTEGER, cull_reason TEXT);
CREATE INDEX IF NOT EXISTS ext_agents_owner ON ext_agents(owner);
CREATE TABLE IF NOT EXISTS ext_agent_calls (hire_id TEXT PRIMARY KEY, agent_id INTEGER, status TEXT, latency_ms INTEGER, paid INTEGER, at INTEGER);
CREATE INDEX IF NOT EXISTS ext_agent_calls_a ON ext_agent_calls(agent_id, at);
`);
const A = {
  get: db.prepare('SELECT * FROM ext_agents WHERE id=?'),
  byOwnerEndpoint: db.prepare('SELECT * FROM ext_agents WHERE owner=? AND endpoint=?'),
  activeByOwner: db.prepare("SELECT COUNT(*) n FROM ext_agents WHERE owner=? AND status='active'"),
  list: db.prepare("SELECT * FROM ext_agents WHERE status='active' OR ?1 = 1 ORDER BY id"),
  insert: db.prepare("INSERT INTO ext_agents(name, description, endpoint, skills, owner, secret, status, registered_at, updated_at) VALUES(?,?,?,?,?,?,'active',?,?)"),
  revive: db.prepare("UPDATE ext_agents SET name=?, description=?, skills=?, secret=?, status='active', registered_at=?, updated_at=?, culled_at=NULL, cull_reason=NULL WHERE id=?"),
  paid: db.prepare('UPDATE ext_agents SET last_paid_at=? WHERE id=?'),
  cull: db.prepare("UPDATE ext_agents SET status='culled', culled_at=?, cull_reason=? WHERE id=? AND status='active'"),
  call: db.prepare('INSERT OR REPLACE INTO ext_agent_calls(hire_id, agent_id, status, latency_ms, paid, at) VALUES(?,?,?,?,?,?)'),
  stats: db.prepare("SELECT agent_id, COUNT(*) hires, SUM(status='done') done, SUM(status='done' AND paid=1) paid_done, MAX(CASE WHEN status='done' AND paid=1 THEN at END) last_paid, AVG(CASE WHEN status='done' THEN latency_ms END) latency FROM ext_agent_calls GROUP BY agent_id"),
  recent: db.prepare("SELECT * FROM hires WHERE creature_id=? AND receipt_hash IS NOT NULL ORDER BY started_at DESC LIMIT ?"),
};

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
export const pseudoId = (agentId) => -Number(agentId); // hires.creature_id, creature_wallets.creature_id and pay_runs.creature_id of an agent
const specOf = (a) => '0x' + crypto.createHash('sha256').update(canonical({ v: 'weightlings.agent.v1', agentId: a.id, owner: a.owner.toLowerCase(), endpoint: a.endpoint })).digest('hex');
/** The agent as the wallet code sees a hireable thing: id, owner wallet (w), price tier, spec hash, label. */
export const beingOf = (a) => ({ id: pseudoId(a.id), w: a.owner, m: { tier: TIER(), id: 'external' }, gen: 0, spec: specOf(a), label: `agent #${a.id} "${a.name}"` });

// ---------- registration ----------
export const registrationMessage = ({ name, endpoint, owner, nonce }) => `Weightlings: register agent "${name}" at ${endpoint} owned by ${String(owner).toLowerCase()} (nonce ${nonce})`;
const nonces = new Map();
export function issueNonce(owner) {
  for (const [k, v] of nonces) if (Date.now() - v.at > LIMITS.nonceMs) nonces.delete(k);
  const n = crypto.randomBytes(8).toString('hex'); nonces.set(owner.toLowerCase(), { n, at: Date.now() }); return n;
}
/** SSRF rules of fetch_url (hire/tools.mjs safeUrl), plus: https only, every resolved address public. Returns { url } or { error }. */
export async function checkEndpoint(raw) {
  const s = String(raw || '').trim();
  if (s.length > 300) return { error: 'The endpoint URL is too long.' };
  if (DEV()) { try { const u = new URL(s); if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return { url: u.toString(), dev: true }; } catch {} }
  const u = safeUrl(s);
  if (!u || u.protocol !== 'https:') return { error: 'The endpoint must be a public https:// URL on port 443, named by a public host name.' };
  try {
    const addrs = await dns.lookup(u.hostname, { all: true, verbatim: true });
    if (!addrs.length || addrs.some((x) => !publicIp(x.address, x.family))) return { error: 'The endpoint host resolves to a private address.' };
  } catch { return { error: 'The endpoint host name does not resolve.' }; }
  u.hash = '';
  return { url: u.toString() };
}
export function checkFields(b) {
  const name = clean(b.name), description = clean(b.description);
  const skills = (Array.isArray(b.skills) ? b.skills : String(b.skills || '').split(',')).map(clean).filter(Boolean);
  if (name.length < 2 || name.length > LIMITS.name || /["\\]/.test(name)) return { error: `Name the agent in 2 to ${LIMITS.name} characters (no quotes).` };
  if (description.length < 8 || description.length > LIMITS.description) return { error: `Describe the agent in 8 to ${LIMITS.description} characters.` };
  if (skills.length > LIMITS.skills || skills.some((x) => x.length > LIMITS.skill)) return { error: `At most ${LIMITS.skills} skills of ${LIMITS.skill} characters.` };
  if (!isAddr(b.owner)) return { error: 'owner must be the 0x… wallet that signs.' };
  return { name, description, skills: [...new Set(skills.map((x) => x.toLowerCase()))], owner: String(b.owner).toLowerCase() };
}
/** Returns { status, body }. */
export async function register(b) {
  const f = checkFields(b); if (f.error) return { status: 400, body: f };
  const ep = await checkEndpoint(b.endpoint); if (ep.error) return { status: 400, body: { error: ep.error } };
  const nn = nonces.get(f.owner);
  if (!nn || nn.n !== String(b.nonce || '') || Date.now() - nn.at > LIMITS.nonceMs) return { status: 401, body: { error: 'The nonce is missing or expired. GET /api/agents/nonce?owner=… and sign again.' } };
  const msg = registrationMessage({ name: f.name, endpoint: ep.url, owner: f.owner, nonce: nn.n });
  let by = null; try { by = recoverAddress(personalDigest(msg), String(b.signature || '')).toLowerCase(); } catch {}
  if (by !== f.owner) return { status: 401, body: { error: 'The signature does not match the owner over the exact message.', message: msg } };
  nonces.delete(f.owner);
  const hc = await wallets.holderCheck(checksum(f.owner));
  if (!hc.ok) return { status: hc.status || 403, body: { error: hc.error.replace('This agent cannot take paid work', 'This agent cannot be registered'), holder: hc.holder } };
  const secret = crypto.randomBytes(32).toString('hex'), now = Date.now();
  const ex = A.byOwnerEndpoint.get(f.owner, ep.url);
  if (!ex || ex.status !== 'active') { if (A.activeByOwner.get(f.owner).n >= LIMITS.perOwner) return { status: 429, body: { error: `One wallet registers at most ${LIMITS.perOwner} live agents.` } }; }
  let id;
  if (ex) { A.revive.run(f.name, f.description, JSON.stringify(f.skills), secret, now, now, ex.id); id = ex.id; }
  else id = Number(A.insert.run(f.name, f.description, ep.url, JSON.stringify(f.skills), f.owner, secret, now, now).lastInsertRowid);
  return { status: 201, body: { agent: view(A.get.get(id)), secret, secretNote: 'Shown once. Your endpoint checks x-weightlings-signature: t=<unix>,v1=hex(HMAC-SHA256(secret, `${t}.${rawBody}`)). Register again to get a new one.', reregistered: !!ex } };
}

// ---------- the call to the agent ----------
export const signBody = (secret, t, body) => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
/** POST the task to the endpoint. Never throws. Returns { ok, status, body (raw string), latencyMs, error }. */
export function forward(agent, { task, hireId, deadline }, { timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.responseBytes } = {}) {
  const body = JSON.stringify({ task, hireId, deadline });
  const t = Math.floor(Date.now() / 1000), started = Date.now();
  const sig = `t=${t},v1=${signBody(agent.secret, t, body)}`;
  return new Promise((resolve) => {
    let done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ requestBody: body, latencyMs: Date.now() - started, ...r }); };
    let u; try { u = new URL(agent.endpoint); } catch { return end({ ok: false, error: 'bad endpoint' }); }
    const dev = u.protocol === 'http:';
    if (dev && !DEV()) return end({ ok: false, error: 'the endpoint is not https' });
    const req = (dev ? http : https).request(u, { method: 'POST', ...(dev ? {} : { lookup: safeLookup }), headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'WeightlingsHire/1.0 (agent call)', 'x-weightlings-signature': sig, 'x-weightlings-hire': hireId } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(); return end({ ok: false, status: res.statusCode, error: `the agent answered more than ${maxBytes} bytes` }); } chunks.push(c); });
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); const okStatus = res.statusCode >= 200 && res.statusCode < 300; end({ ok: okStatus, status: res.statusCode, body: text, contentType: String(res.headers['content-type'] || ''), error: okStatus ? undefined : `the agent answered HTTP ${res.statusCode}` }); });
      res.on('error', (e) => end({ ok: false, status: res.statusCode, error: 'the answer broke off: ' + e.code }));
    });
    const timer = setTimeout(() => { req.destroy(); end({ ok: false, error: `the agent did not answer within ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    req.on('error', (e) => end({ ok: false, error: e.code === 'EBLOCKED' ? 'the endpoint resolves to a private address' : 'the agent could not be reached (' + (e.code || 'error') + ')' }));
    req.end(body);
  });
}
const answerOf = (r) => { if (!r.body) return ''; try { const j = JSON.parse(r.body); if (j && typeof j.answer === 'string') return j.answer; if (typeof j === 'string') return j; } catch {} return r.body; };
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
export const disclosure = (a) => `Work done by the outside agent "${a.name}" at ${a.endpoint}, registered by ${checksum(a.owner)}. Weightlings forwarded the task and recorded what came back; it did not produce or check this answer.`;

/** Run one admitted hire (row already inserted). Builds, settles, signs and stamps the receipt. */
async function work(id, a, task, paidBy, pay) {
  const startedAt = Date.now(), deadline = startedAt + LIMITS.timeoutMs;
  const r = await forward(a, { task, hireId: id, deadline });
  const answer = r.ok ? answerOf(r).trim() : '';
  const status = r.ok && answer ? 'done' : 'failed';
  const error = status === 'done' ? undefined : r.error || 'the agent returned an empty answer';
  const endedAt = Date.now();
  const receipt = {
    v: 'weightlings.agent-hire.v1', kind: 'agent', id, status, agentId: a.id,
    agent: { name: a.name, owner: checksum(a.owner), endpoint: a.endpoint, spec: specOf(a) },
    task,
    request: { endpoint: a.endpoint, hash: sha256hex(r.requestBody), signed: 'x-weightlings-signature: HMAC-SHA256 with the agent secret over "<t>.<body>"', deadline },
    response: { status: r.status ?? null, hash: r.body != null ? sha256hex(r.body) : null, bytes: r.body != null ? Buffer.byteLength(r.body) : 0, contentType: r.contentType || undefined, latencyMs: r.latencyMs },
    answer: status === 'done' ? clip(answer, 24000) : null, error,
    costUsd: 0, platformFeeUnits: pay && status === 'done' ? String(COST_UNITS()) : '0', cost: { modelUsd: 0, chargedUnits: pay && status === 'done' ? String(COST_UNITS()) : '0', feeBps: FEE_BPS(), rule: `No model cost: the agent did the work. A paid hire charges a platform fee of ${FEE_BPS() / 100}% of the price, plus that fee's markup per contract, to the treasury; the rest stays in the agent wallet. Failed or timed out: refunded in full.` },
    paidBy, disclosure: disclosure(a), startedAt, endedAt, keyId: publicKey.keyId,
  };
  if (pay) {
    let settlement = null;
    // the same settle as a creature hire: done -> charge(runId, 1 unit, workHash), else refund in full; workHash = sha256(canonical(receipt so far))
    try { settlement = await wallets.settle(id, receipt); } catch (e) { console.warn('[agents] settlement', id, e.message); }
    if (settlement) receipt.settlement = settlement;
  }
  const { receiptHash, signature } = seal(receipt);
  q.finish.run(status, endedAt, JSON.stringify(receipt), receiptHash, signature, JSON.stringify({ outputs: [r.requestBody, r.body ?? ''] }), error || null, null, id);
  A.call.run(id, a.id, status, r.latencyMs, pay ? 1 : 0, endedAt);
  if (pay && status === 'done' && receipt.settlement && /^charge/.test(receipt.settlement.kind)) A.paid.run(endedAt, a.id);
  stamp(receiptHash, id);
}

// ---------- admission (same limits and payment checks as /api/hire) ----------
export async function admit({ agentId, task, pid, ip, ipKey, req, resource }) {
  task = String(task ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!/^[a-z0-9]{8,40}$/.test(String(pid || ''))) return { status: 400, body: { error: 'bad session' } };
  const a = A.get.get(Number(agentId));
  if (!a) return { status: 404, body: { error: 'No agent with that id.' } };
  if (a.status !== 'active') return { status: 409, body: { error: 'That agent was culled. Only living agents can be hired.', culledAt: a.culled_at, reason: a.cull_reason } };
  if (task.length < 3) return { status: 400, body: { error: 'Write the task in a sentence or two.' } };
  if (task.length > LIMITS.taskChars) return { status: 413, body: { error: `A task is at most ${LIMITS.taskChars} characters.` } };
  if (engine.runningCount() >= engine.LIMITS.concurrency) return { status: 503, body: { error: 'Every worker is busy. Try again in a few seconds.', again: true }, headers: { 'retry-after': '10' } };
  const pidH = visitorHash('pid:' + pid), ipH = visitorHash('ip:' + ipKey(ip)), id = engine.newId();
  if (q.runningBy.get(ipH).n >= 2) return { status: 429, body: { error: 'Your earlier hire is still running. Wait for its receipt, then hire again.' }, headers: { 'retry-after': '15' } };
  const b = beingOf(a);
  let paidBy = 'free (payments off)', pay = null;
  if (wallets.enabled()) {
    if (!wallets.configured()) return { status: 503, body: { error: 'Payments are switched on but not configured (FACTORY / TREASURY / USDG / OPERATOR_KEY).' } };
    const price = Number(x402.priceOf(TIER())) / 1e6;
    let paid;
    try {
      paid = await wallets.collect(req, b, { hireId: id, runCapUsd: price });
      if (!paid) {
        if (!wallets.walletOf(b.id) && takeSlots([{ k: 'mkwallet:' + ipH, max: 3, ms: 3600_000 }])) return { status: 429, body: { error: 'You asked for terms on too many agents without a wallet this hour. Try again later.' }, headers: { 'retry-after': '900' } };
        const t = await wallets.quote(b, { resource, runCapUsd: price });
        t.body.agentWallet = { ...t.body.creatureWallet, ownerIs: 'the wallet that registered this agent' }; delete t.body.creatureWallet;
        t.body.split.rule = 'the smallest unit + its markup go to the treasury (no model cost); the rest stays in the agent wallet; a failed or timed-out hire is refunded in full';
        return t;
      }
    } catch (e) { console.warn('[agents pay]', e.message); return { status: e.status || 503, body: { error: e.status ? e.message : 'Robinhood Chain could not be reached to set up the payment. Nothing was charged; try again.' } }; }
    if (!paid.ok) return { status: paid.status, body: { error: paid.error, ...(paid.extra || {}) } };
    paidBy = paid.paidBy; pay = true;
  } else if (x402.on()) {
    return { status: 503, body: { error: 'Outside agents are paid through agent wallets only (PAYMENTS=on with FACTORY set).' } };
  } else {
    // free while payments are off: no model cost to the operator, but the endpoint is someone else's, so calls are rate limited
    const full = takeSlots([{ k: 'agent-all', max: 120, ms: 600_000 }, { k: 'agent-ip:' + ipH, max: 20, ms: 3600_000 }]);
    if (full) return { status: 429, body: { error: 'Too many agent hires from this connection. Try again later.' }, headers: { 'retry-after': '600' } };
  }
  try { q.insert.run(id, b.id, pidH, ipH, task, 'external:' + a.id, Date.now(), typeof paidBy === 'string' ? paidBy : JSON.stringify(paidBy)); }
  catch (e) {
    if (!pay) throw e;
    const refund = await wallets.refundUnstarted(id, e.message).catch(() => null);
    return { status: 500, body: { error: 'The hire could not start. Your payment is refunded in full.', id, refund, receipt: `/api/hire/${id}` } };
  }
  work(id, a, task, paidBy, pay).catch((e) => console.warn('[agents] run crashed', id, e.message));
  return { status: 202, body: { id, status: 'running', agent: { id: a.id, name: a.name }, paidBy, receipt: `/api/hire/${id}` } };
}

// ---------- registry and selection ----------
let earn = { at: 0, map: new Map() };
async function earningsMap() {
  if (!wallets.enabled()) return null;
  if (Date.now() - earn.at < 60_000) return earn.map;
  try { const d = await wallets.earnings(); earn = { at: Date.now(), map: new Map(d.creatures.filter((c) => c.creatureId < 0).map((c) => [-c.creatureId, c])) }; } catch {}
  return earn.map;
}
function view(a, st = {}, e = null) {
  const w = wallets.walletOf(pseudoId(a.id));
  const hires = Number(st.hires || 0), done = Number(st.done || 0);
  const lastPaid = Math.max(a.last_paid_at || 0, st.last_paid || 0) || null;
  const graceEnds = a.registered_at + LIMITS.graceMs;
  return { id: a.id, name: a.name, description: a.description, endpoint: a.endpoint, skills: JSON.parse(a.skills || '[]'), owner: checksum(a.owner), status: a.status,
    registeredAt: a.registered_at, culledAt: a.culled_at || undefined, cullReason: a.cull_reason || undefined,
    price: { tier: TIER(), units: x402.priceOf(TIER()), usdg: (Number(x402.priceOf(TIER())) / 1e6).toFixed(2) },
    wallet: w ? w.wallet : null, hires, done, successRate: hires ? +(done / hires).toFixed(3) : null, avgLatencyMs: st.latency ? Math.round(st.latency) : null,
    lastPaidHireAt: lastPaid, cullsAt: a.status === 'active' ? Math.max(graceEnds, (lastPaid || 0) + LIMITS.windowMs) : undefined,
    earnings: e ? { earned: e.earned, profit: e.profit, withdrawable: e.withdrawable, runs: e.runs } : null, hire: `/api/agents/${a.id}/hire` };
}
export async function list(all = false) {
  const st = new Map(A.stats.all().map((r) => [r.agent_id, r])), em = await earningsMap();
  return { rule: RULE, live: !!em, agents: A.list.all(all ? 1 : 0).map((a) => view(a, st.get(a.id), em?.get(a.id))) };
}
export async function one(id) {
  const a = A.get.get(id); if (!a) return null;
  const st = A.stats.all().find((r) => r.agent_id === a.id), em = await earningsMap();
  const recent = A.recent.all(pseudoId(a.id), 10).map((h) => { const r = JSON.parse(h.receipt || '{}'); return { id: h.id, status: h.status, task: (r.task || '').slice(0, 200), answer: r.answer ? r.answer.slice(0, 280) : null, latencyMs: r.response?.latencyMs, settlement: r.settlement?.kind, startedAt: h.started_at, receiptHash: h.receipt_hash }; });
  return { ...view(a, st, em?.get(a.id)), recent };
}
/** The hourly sweep. Exported so it can be tested; returns the ids culled. */
export function cullSweep(now = Date.now()) {
  const st = new Map(A.stats.all().map((r) => [r.agent_id, r])), out = [];
  for (const a of A.list.all(0)) {
    const lastPaid = Math.max(a.last_paid_at || 0, st.get(a.id)?.last_paid || 0);
    if (now < a.registered_at + LIMITS.graceMs) continue;
    if (lastPaid && now - lastPaid < LIMITS.windowMs) continue;
    if (A.cull.run(now, lastPaid ? 'no successful paid hire in the last 72 h' : 'no successful paid hire in its first 72 h', a.id).changes) out.push(a.id);
  }
  if (out.length) console.log('[agents] culled', out.join(', '));
  return out;
}
setInterval(() => { try { cullSweep(); } catch (e) { console.warn('[agents] sweep', e.message); } }, 3600_000).unref();
setTimeout(() => { try { cullSweep(); } catch {} }, 30_000).unref();

// ---------- HTTP ----------
const json = (res, code, obj, headers = {}) => { if (res.headersSent) return res.end(); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'payment-required, payment-response, x-payment-response, retry-after', ...headers }); res.end(JSON.stringify(obj)); };
const rl = new Map();
function limited(ip, key, max, winMs) { const k = ip + key, t = Date.now(); const a = (rl.get(k) || []).filter((x) => t - x < winMs); if (a.length >= max) return true; a.push(t); rl.set(k, a); return false; }
setInterval(() => { const t = Date.now(); for (const [k, a] of rl) if (!a.length || t - a[a.length - 1] > 3600_000) rl.delete(k); }, 600_000).unref();

/** api: { readBody, siteOf, ipKey } from routes.mjs. Returns true when it answered. */
export async function handle(req, res, u, ip, api) {
  const p = u.pathname, m = req.method;
  if (!p.startsWith('/api/agents')) return false;
  try {
    if (m === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-payment, payment-signature', 'access-control-max-age': '86400' }); res.end(); return true; }
    if (m === 'GET' && p === '/api/agents') { json(res, 200, await list(u.searchParams.get('all') === '1')); return true; }
    if (m === 'GET' && p === '/api/agents/rule') { json(res, 200, { rule: RULE, graceHours: 72, windowHours: 72, sweep: 'hourly', holders: wallets.holderRule(), price: { tier: TIER(), units: x402.priceOf(TIER()) }, message: registrationMessage({ name: '<name>', endpoint: '<endpoint>', owner: '<owner>', nonce: '<nonce>' }) }); return true; }
    if (m === 'GET' && p === '/api/agents/nonce') {
      const o = String(u.searchParams.get('owner') || u.searchParams.get('wallet') || '');
      if (!isAddr(o)) { json(res, 400, { error: 'Send ?owner=0x…' }); return true; }
      if (limited(ip, 'anonce', 60, 3600_000)) { json(res, 429, { error: 'Slow down' }); return true; }
      json(res, 200, { nonce: issueNonce(o), message: registrationMessage({ name: '<name>', endpoint: '<endpoint>', owner: o, nonce: '<nonce>' }), note: 'Replace <name> and <endpoint> with exactly what you POST (the endpoint as normalised by new URL(): e.g. a trailing / on a bare host), then personal_sign it.' }); return true;
    }
    if (m === 'POST' && p === '/api/agents/register') {
      if (limited(ip, 'areg', 12, 3600_000)) { json(res, 429, { error: 'Too many registrations from this connection, try later' }); return true; }
      const r = await register(await api.readBody(req, 8000)); json(res, r.status, r.body); return true;
    }
    let g = /^\/api\/agents\/(\d+)\/hire$/.exec(p);
    if (g && m === 'POST') {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { json(res, 415, { error: 'Send application/json.' }); return true; }
      const body = await api.readBody(req);
      const r = await admit({ agentId: g[1], task: body.task, pid: body.pid, ip, ipKey: api.ipKey, req, resource: api.siteOf(req) + p });
      json(res, r.status, r.body, r.headers); return true;
    }
    g = /^\/api\/agents\/(\d+)$/.exec(p);
    if (g && m === 'GET') { const v = await one(Number(g[1])); v ? json(res, 200, v) : json(res, 404, { error: 'No agent with that id.' }); return true; }
    json(res, 404, { error: 'not found' }); return true;
  } catch (e) { json(res, e.status || 500, { error: e.status ? e.message : 'internal' }); if (!e.status) console.warn('[agents]', e.message); return true; }
}

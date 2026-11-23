// Paid hires through creature wallets (PAYMENTS=on with FACTORY set). Off by default: with PAYMENTS off nothing here runs,
// no wallet is made and /api/earnings answers { live: false }.
//
// The flow of one paid hire, every step on Robinhood Chain (4663) and every transaction hash in the signed receipt:
//   1. quote   POST /api/hire without payment -> 402. The creature's wallet is made now if it has none yet (lazily, from the
//              server, at most WALLETS_PER_DAY a UTC day): factory.createAgent(owner = the wallet that founded the creature's
//              lineage). The terms carry the EIP-712 message to sign: USDG ReceiveWithAuthorization to that wallet.
//   2. pay     the visitor signs it (no gas, no transaction of theirs) and POSTs again with X-PAYMENT. The server checks the
//              signature, the amount, the window, the nonce and the funds, simulates, then the operator sends
//              wallet.pay(...): the wallet pulls the payment in and holds ALL of it for this run (tx 1, `paidBy.payTx`).
//   3. run     the hire runs, its model cost capped by the run's budget (price less markup, and the engine's own cap).
//   4. settle  done   -> wallet.charge(runId, model cost, workHash): model cost + markup go to the treasury, the rest of the
//                        payment stays in the creature's wallet: that is what the creature earned (tx 2).
//              failed -> wallet.refund(runId, 0, workHash): the whole payment goes back to the payer (tx 2).
//              workHash = sha256(canonical(receipt without `settlement`)), the receipt fingerprint published in the
//              contract's Charged event; then `settlement` (with tx 2) is added and the whole receipt is signed.
// Who owns a creature's earnings: the owner of its wallet contract, set at creation to its lineage wallet. It changes only by
// the contract's own two-step transferOwnership/acceptOwnership, signed by the current owner. The server cannot move it.
//
// Env: PAYMENTS=on, FACTORY, TREASURY, USDG, OPERATOR_KEY, optional FACTORY_BLOCK, PAY_RPC_URL, CHAIN_ID,
//      WALLETS_PER_DAY (20), WALLET_PER_RUN_CAP (250000 = 0.25 USDG), WALLET_PER_DAY_CAP (12500000 = 12.5 USDG),
//      PAY_MIN_GAS (1500000: the operator must hold this much gas at today's price, x2, to take a payment).
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db.mjs';
import { canonical, receiptHashOf, seal, publicKey } from './receipts.mjs';
import * as chain from './chain.mjs';
import { recoverAddress, keccak256, encodeArgs, isAddress, checksum } from './evm.mjs';
import { priceOf } from './x402.mjs';

const NETWORK = 'eip155:4663';
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
export const on = () => String(process.env.PAYMENTS || '').toLowerCase() === 'on';
/** wallet mode = payments go to per-creature wallet contracts (FACTORY set); otherwise the older PAY_TO path in x402.mjs */
export const enabled = () => on() && isAddress(process.env.FACTORY || '');
export const configured = () => enabled() && isAddress(process.env.TREASURY || '') && isAddress(process.env.USDG || '') && !!chain.operator();
const env = () => ({ factory: checksum(process.env.FACTORY), treasury: checksum(process.env.TREASURY), usdg: checksum(process.env.USDG) });
const usd = (units) => (Number(units) / 1e6).toFixed(6).replace(/0{1,4}$/, '');

db.exec(`
CREATE TABLE IF NOT EXISTS creature_wallets (creature_id INTEGER PRIMARY KEY, wallet TEXT UNIQUE, owner TEXT, agent_id INTEGER, tx TEXT, block INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS pay_runs (hire_id TEXT PRIMARY KEY, creature_id INTEGER, wallet TEXT, run_id TEXT, payer TEXT, value TEXT, budget TEXT, form TEXT,
  pay_tx TEXT, status TEXT, want TEXT, work_hash TEXT, settle_tx TEXT, cost TEXT, fee TEXT, back TEXT, error TEXT, at INTEGER, settled_at INTEGER, late TEXT);
CREATE INDEX IF NOT EXISTS pay_runs_status ON pay_runs(status);
CREATE INDEX IF NOT EXISTS pay_runs_creature ON pay_runs(creature_id);
CREATE TABLE IF NOT EXISTS hire_payments (ref TEXT PRIMARY KEY, hire_id TEXT, at INTEGER, payer TEXT, value TEXT, kind TEXT);
`);
const q = {
  wallet: db.prepare('SELECT * FROM creature_wallets WHERE creature_id=?'),
  wallets: db.prepare('SELECT * FROM creature_wallets ORDER BY creature_id'),
  madeSince: db.prepare('SELECT COUNT(*) n FROM creature_wallets WHERE at >= ?'),
  addWallet: db.prepare('INSERT INTO creature_wallets(creature_id, wallet, owner, agent_id, tx, block, at) VALUES(?,?,?,?,?,?,?)'),
  run: db.prepare('SELECT * FROM pay_runs WHERE hire_id=?'),
  addRun: db.prepare("INSERT INTO pay_runs(hire_id, creature_id, wallet, run_id, payer, value, budget, form, pay_tx, status, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"),
  setRun: db.prepare('UPDATE pay_runs SET status=?, want=?, work_hash=?, settle_tx=?, cost=?, fee=?, back=?, error=?, settled_at=? WHERE hire_id=?'),
  setLate: db.prepare('UPDATE pay_runs SET late=? WHERE hire_id=?'),
  setPayTx: db.prepare('UPDATE pay_runs SET status=?, pay_tx=?, error=? WHERE hire_id=?'),
  // one settler at a time: whoever moves the row from `from` to 'settling' sends the transaction (engine or sweep, never both)
  claim: db.prepare("UPDATE pay_runs SET status='settling', want=?, cost=?, work_hash=? WHERE hire_id=? AND status=?"),
  setClosed: db.prepare("UPDATE pay_runs SET status='closed', error=?, settled_at=? WHERE hire_id=?"),
  pending: db.prepare("SELECT p.*, h.status hire_status, h.receipt_hash FROM pay_runs p LEFT JOIN hires h ON h.id = p.hire_id WHERE p.status IN ('held','unsettled','unknown') AND p.at < ?"),
  runsBy: db.prepare("SELECT creature_id, SUM(status='charged') charged, SUM(status='refunded') refunded, SUM(status IN ('held','unsettled','settling','unknown')) open FROM pay_runs GROUP BY creature_id"),
  useRef: db.prepare('INSERT OR IGNORE INTO hire_payments(ref, hire_id, at, payer, value, kind) VALUES(?,?,?,?,?,?)'),
  freeRef: db.prepare('DELETE FROM hire_payments WHERE ref=?'),
};
// After a restart: a payment that was being sent ('paying') may have landed, and a settlement that was being sent ('settling')
// may or may not have. Neither is lost: the sweep reads the hold from the chain and finishes each one.
db.prepare("UPDATE pay_runs SET status='unknown', error='interrupted: the server restarted while taking this payment' WHERE status='paying'").run();
db.prepare("UPDATE pay_runs SET status='unsettled', error='interrupted: the server restarted while settling' WHERE status='settling'").run();

// ---------- what the chain says about the deployment (read once, re-read every 10 minutes) ----------
let facts = null, factsAt = 0;
async function deployment() {
  if (facts && Date.now() - factsAt < 600_000) return facts;
  const e = env(), op = chain.operator();
  const [usdgOf, operatorOf, treasuryOf, markup, paused, domain] = await Promise.all([
    chain.read(e.factory, 'function usdg() view returns (address)'),
    chain.read(e.factory, 'function operator() view returns (address)'),
    chain.read(e.factory, 'function treasury() view returns (address)'),
    chain.read(e.factory, 'function markupBps() view returns (uint16)'),
    chain.read(e.factory, 'function operatorPaused() view returns (bool)'),
    chain.read(e.usdg, 'function DOMAIN_SEPARATOR() view returns (bytes32)'),
  ]);
  const problems = [];
  if (usdgOf[0] !== e.usdg) problems.push('the factory uses another USDG');
  if (treasuryOf[0] !== e.treasury) problems.push('the factory pays another treasury');
  if (!op || operatorOf[0] !== op.address) problems.push("OPERATOR_KEY is not the factory's operator");
  facts = { ...e, markupBps: Number(markup[0]), operatorPaused: paused[0], domainSeparator: domain[0], problems };
  factsAt = Date.now();
  return facts;
}

// ---------- the operator must be able to pay gas for what it is about to promise ----------
let gasSeen = { at: 0, ok: false };
async function operatorCanPay() {
  if (Date.now() - gasSeen.at < 30_000) return gasSeen.ok;
  const op = chain.operator(); if (!op) return false;
  const [bal, price] = await Promise.all([chain.ethBalance(op.address), chain.gasPrice()]);
  gasSeen = { at: Date.now(), ok: bal >= BigInt(num(process.env.PAY_MIN_GAS, 1_500_000)) * price * 2n };
  return gasSeen.ok;
}

// ---------- the price split of one run ----------
// a wallet keeps the markup it was made with (only its owner can adopt a new one), so the split is read from the wallet itself
const markups = new Map();
async function markupOf(wallet) {
  const m = markups.get(wallet);
  if (m && Date.now() - m.at < 600_000) return m.bps;
  const [bps] = await chain.read(wallet, 'function markupBps() view returns (uint16)');
  markups.set(wallet, { bps: Number(bps), at: Date.now() });
  return Number(bps);
}
// budget: the most the run may cost before the markup, so that budget + markup fits in the price; never above the engine's cap
export function budgetOf(priceUnits, markupBps, runCapUsd) {
  const byPrice = Math.floor((Number(priceUnits) * 10_000) / (10_000 + markupBps));
  return Math.max(1, Math.min(byPrice, Math.floor(runCapUsd * 1e6)));
}
export const runIdOf = (hireId) => '0x' + createHash('sha256').update('weightlings.hire.run|' + hireId).digest('hex');
const specHashOf = (b) => '0x' + createHash('sha256').update(canonical({ v: 'weightlings.creature.v1', creatureId: b.id, lineage: b.w.toLowerCase(), brain: b.m.id, gen: b.gen })).digest('hex');

// ---------- 1. the creature's wallet, made on its first paid hire ----------
let making = Promise.resolve();
export function walletOf(creatureId) { return q.wallet.get(Number(creatureId)) || null; }
/** The creature's wallet row, making it now if needed. Throws { status, message } when it cannot. */
export function ensureWallet(b) {
  const have = walletOf(b.id); if (have) return Promise.resolve(have);
  const job = making.then(async () => {
    const again = walletOf(b.id); if (again) return again;
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const cap = num(process.env.WALLETS_PER_DAY, 20);
    if (q.madeSince.get(day.getTime()).n >= cap) throw Object.assign(new Error(`New creature wallets are made at most ${cap} a day, and today's are made. Hire a creature that already has a wallet (see /api/earnings), or come back after 00:00 UTC.`), { status: 503 });
    if (!(await operatorCanPay())) throw Object.assign(new Error('Paid hiring is paused: the operator is low on gas. Nothing was charged.'), { status: 503 });
    const f = await deployment();
    if (f.problems.length) throw Object.assign(new Error('Payments are misconfigured on this server: ' + f.problems.join('; ')), { status: 503 });
    const owner = checksum(b.w);
    // The earnings belong to the lineage wallet. Many lineages were founded from bonding-curve trades, and a trade's buyer can be
    // a router or a bot contract that will never call withdraw or acceptOwnership: its creature's earnings would be locked for
    // good. Only an account with no code (or an EIP-7702 delegated account, which is still a key holder) gets a wallet.
    const code = String(await chain.rpc('eth_getCode', [owner, 'latest']) || '0x').toLowerCase();
    if (code !== '0x' && !(code.startsWith('0xef0100') && code.length === 48)) throw Object.assign(new Error("This creature cannot take paid hires: the wallet that founded its lineage is a contract, which may not be able to collect what the creature earns. Nothing was charged. Hire another creature."), { status: 409 });
    const data = chain.calldata('function createAgent(address,uint128,uint128,bytes32,string,address,uint16)',
      [owner, num(process.env.WALLET_PER_RUN_CAP, 250_000), num(process.env.WALLET_PER_DAY_CAP, 12_500_000), specHashOf(b), '', f.treasury, f.markupBps]);
    const r = await chain.send({ to: f.factory, data, label: 'createAgent' });
    const topic = chain.topicOf('AgentCreated(uint256,address,address,bytes32)');
    const log = r.logs.find((l) => l.address.toLowerCase() === f.factory.toLowerCase() && l.topics[0] === topic);
    if (!log) throw Object.assign(new Error('The wallet was made but its event was not found.'), { status: 502 });
    const wallet = chain.addrTopic(log.topics[2]);
    q.addWallet.run(b.id, wallet, owner, Number(BigInt(log.topics[1])), r.hash, r.block, Date.now());
    console.log(`[pay] wallet ${wallet} made for creature #${b.id} (owner ${owner}) in ${r.hash}`);
    return walletOf(b.id);
  });
  making = job.catch(() => {});
  return job;
}

// ---------- the message the visitor signs ----------
const RECEIVE = 'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)';
const TRANSFER = 'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)';
const FIELDS = [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }];
function authDigest(domainSeparator, form, a) {
  const struct = keccak256(Buffer.from(keccak256(form === 'receive' ? RECEIVE : TRANSFER).toString('hex') + encodeArgs(['address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32'], [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce]), 'hex'));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), Buffer.from(domainSeparator.slice(2), 'hex'), struct]));
}

/** 402 terms for a paid hire of creature b. Makes its wallet first if it has none. */
export async function quote(b, { resource, runCapUsd }) {
  const f = await deployment();
  const w = await ensureWallet(b);
  const markupBps = await markupOf(w.wallet);
  const price = priceOf(b.m.tier), budget = budgetOf(price, markupBps, runCapUsd), now = Math.floor(Date.now() / 1000);
  const message = { from: '<your address>', to: w.wallet, value: price, validAfter: '0', validBefore: String(now + 600), nonce: '0x' + randomBytes(32).toString('hex') };
  const domain = { name: process.env.USDG_NAME || 'Global Dollar', version: process.env.USDG_VERSION || '1', chainId: chain.CHAIN_ID(), verifyingContract: f.usdg };
  const body = {
    x402Version: 1, error: 'Payment required',
    accepts: [{ scheme: 'exact', network: NETWORK, maxAmountRequired: price, resource, description: `Hire creature #${b.id} for one task`, mimeType: 'application/json', payTo: w.wallet, maxTimeoutSeconds: 600, asset: f.usdg, extra: { name: domain.name, version: domain.version, receiveWithAuthorization: true } }],
    price: { units: price, usdg: usd(price) },
    creatureWallet: { address: w.wallet, owner: w.owner, ownerIs: "the wallet that founded this creature's lineage", made: w.tx },
    split: { budgetUnits: String(budget), markupBps, rule: 'model cost + markup go to the treasury; the rest stays in the creature wallet; a failed hire is refunded in full' },
    sign: {
      how: 'Sign this EIP-712 message (eth_signTypedData_v4) with the paying address, put it in "from", then POST the same body again with header X-PAYMENT = base64(JSON {payload:{form:"receive", authorization: message, signature}}). No gas: the operator submits it. TransferWithAuthorization (standard x402 "exact") is accepted too, with form "transfer", but anyone who sees that form can submit it straight to USDG and skip the refund, so prefer "receive".',
      typedData: { domain, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ReceiveWithAuthorization: FIELDS }, primaryType: 'ReceiveWithAuthorization', message },
    },
  };
  const header = Buffer.from(JSON.stringify({ x402Version: 2, error: 'Payment required', resource: { url: resource, description: body.accepts[0].description, mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: NETWORK, amount: price, asset: f.usdg, payTo: w.wallet, maxTimeoutSeconds: 600, extra: body.accepts[0].extra }] })).toString('base64');
  return { status: 402, body, headers: { 'payment-required': header } };
}

// ---------- 2. take the payment ----------
const fail = (status, error, extra) => ({ ok: false, status, error, ...(extra ? { extra } : {}) });
const decodeHeader = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64').toString('utf8')); } catch { try { return JSON.parse(String(s)); } catch { return null; } } };
const WORDS = {
  OverDayCap: [429, "This creature's wallet has reached its spending limit for today (its owner sets it). Nothing was charged; your authorization was not used."],
  OverRunCap: [409, "This hire is above this creature's per-run limit (its owner sets it). Nothing was charged; your authorization was not used."],
  Paused: [409, "This creature's owner has paused its wallet. Nothing was charged."],
  OperatorPaused: [503, 'Paid hires are paused for every creature right now. Nothing was charged.'],
  Underpaid: [400, 'The payment is below the price. Nothing was charged.'],
  NotPaid: [400, 'USDG did not move: the authorization was refused (used, expired or not signed by the payer). Nothing was charged.'],
  RunAlreadyCharged: [409, 'This hire was already paid.'],
};

/** Verify and take a payment for one hire. Returns null (no payment sent), { ok:false, status, error } or { ok:true, paidBy }. */
export async function collect(req, b, { hireId, runCapUsd }) {
  const raw = req.headers['x-payment'] || req.headers['payment-signature'];
  if (!raw) return null;
  const f = await deployment();
  if (f.problems.length) return fail(503, 'Payments are misconfigured on this server: ' + f.problems.join('; '));
  const w = walletOf(b.id);
  if (!w) return fail(409, 'This creature has no wallet yet: POST without payment first to get the terms.');
  const p = decodeHeader(raw), pl = p?.payload || p, a = pl?.authorization, sig = pl?.signature;
  if (!a || !sig) return fail(400, 'The payment must carry payload.authorization and payload.signature.');
  for (const k of ['from', 'to']) if (!isAddress(a[k])) return fail(400, `authorization.${k} is not an address.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce || '')) return fail(400, 'authorization.nonce must be 32 bytes.');
  if (a.to.toLowerCase() !== w.wallet.toLowerCase()) return fail(400, "The payment is not addressed to this creature's wallet.");
  const price = priceOf(b.m.tier);
  if (String(a.value) !== price) return fail(400, `The price of this hire is exactly ${price} USDG units.`);
  const now = Math.floor(Date.now() / 1000), va = Number(a.validAfter), vb = Number(a.validBefore);
  if (!(va <= now) || !(vb >= now + 45) || vb > now + 3600) return fail(400, 'The authorization must be valid now, for at least 45 more seconds and at most an hour.');
  // which form was signed: the one named, else whichever recovers to `from`
  const forms = pl.form === 'transfer' ? ['transfer'] : pl.form === 'receive' ? ['receive'] : ['receive', 'transfer'];
  let form = null;
  for (const fm of forms) { try { if (recoverAddress(authDigest(f.domainSeparator, fm, a), sig).toLowerCase() === a.from.toLowerCase()) { form = fm; break; } } catch {} }
  if (!form) return fail(400, 'The signature was not made by authorization.from over this payment.');
  let used, funds;
  try {
    [[used], [funds]] = await Promise.all([chain.read(f.usdg, 'function authorizationState(address,bytes32) view returns (bool)', [a.from, a.nonce]), chain.read(f.usdg, 'function balanceOf(address) view returns (uint256)', [a.from])]);
  } catch { return fail(503, 'Robinhood Chain could not be read to check the payment. Nothing was charged; try again.'); }
  if (used) return fail(409, 'This authorization was already used. Sign a new one.');
  if (BigInt(funds) < BigInt(price)) return fail(402, 'The paying address does not hold enough USDG.');
  if (!(await operatorCanPay().catch(() => false))) return fail(503, 'Paid hiring is paused: the operator is low on gas. Nothing was charged.');

  let markupBps;
  try { markupBps = await markupOf(w.wallet); } catch { return fail(503, 'Robinhood Chain could not be read to check the payment. Nothing was charged; try again.'); }
  const budget = budgetOf(price, markupBps, runCapUsd), runId = runIdOf(hireId);
  const s65 = String(sig).replace(/^0x/, ''), v = parseInt(s65.slice(128), 16), vv = v < 27 ? v + 27 : v;
  const data = chain.calldata('function pay(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32,bytes32,uint256,bool)',
    [a.from, a.value, a.validAfter, a.validBefore, a.nonce, vv, '0x' + s65.slice(0, 64), '0x' + s65.slice(64, 128), runId, budget, form === 'receive']);
  // a refusal by the wallet (its limits, its pause) is found before anything is sent, so the authorization stays unused
  const sim = await chain.simulate(w.wallet, data);
  if (!sim.ok) { const [st, msg] = WORDS[sim.error] || [502, `The payment would not go through (${String(sim.error).slice(0, 80)}). Nothing was charged.`]; return fail(st, msg); }
  const ref = 'wallet:' + a.from.toLowerCase() + ':' + a.nonce.toLowerCase();
  if (q.useRef.run(ref, hireId, Date.now(), a.from.toLowerCase(), price, 'creature-wallet').changes !== 1) return fail(409, 'This payment was already used for a hire.');
  q.addRun.run(hireId, b.id, w.wallet, runId, checksum(a.from), price, String(budget), form, null, 'paying', Date.now());
  let r;
  try { r = await chain.send({ to: w.wallet, data, label: 'pay' }); }
  catch (e) {
    if (e.stage === 'wait') { q.setPayTx.run('unknown', e.hash, e.message, hireId); return fail(502, `The payment was sent (${e.hash}) but not confirmed in time. If it lands it is refunded in full automatically; nothing will run. Follow it at /api/hire/${hireId}.`, { id: hireId, payTx: e.hash, receipt: `/api/hire/${hireId}` }); }
    q.setPayTx.run('void', e.hash || null, e.message, hireId); q.freeRef.run(ref);
    const [st, msg] = WORDS[e.reason] || [502, 'The payment could not be taken. Nothing was charged.'];
    return fail(st, msg);
  }
  q.setPayTx.run('held', r.hash, null, hireId);
  return { ok: true, budgetUnits: budget, paidBy: { payer: checksum(a.from), amount: usd(price) + ' USDG', units: price, network: NETWORK, method: 'creature-wallet', form,
    wallet: w.wallet, walletOwner: w.owner, runId, budgetUnits: String(budget), markupBps, payTx: r.hash, payBlock: r.block, treasury: f.treasury } };
}

// ---------- 4. settle: charge what the run cost, or refund it all ----------
const CHARGED = chain.topicOf('Charged(bytes32,uint256,uint256,address,bytes32)');
const REFUNDED = chain.topicOf('Refunded(bytes32,address,uint256,bool)');
const ZERO32 = '0x' + '0'.repeat(64);
const STALE_MS = 30 * 60_000; // a hire still "running" this long after its payment is dead (its deadline is 150 s): refund it
const HOLD_TIMEOUT_S = 86_400; // CreatureWallet.HOLD_TIMEOUT: after it anyone may release a hold, and a payment goes back to its payer
/** What one mined transaction did to this run, read from the wallet's own events. */
function outcomeOf(row, r) {
  const mine = (r.logs || []).filter((l) => l.address.toLowerCase() === row.wallet.toLowerCase() && String(l.topics[1]).toLowerCase() === row.run_id.toLowerCase());
  const ch = mine.find((l) => l.topics[0] === CHARGED), rf = mine.find((l) => l.topics[0] === REFUNDED);
  const w = (l, i) => BigInt('0x' + l.data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  return { tx: r.hash, block: r.block, cost: ch ? w(ch, 0) : 0n, fee: ch ? w(ch, 1) : 0n, back: rf ? w(rf, 0) : 0n, parked: rf ? w(rf, 1) !== 0n : false, closed: !!(ch || rf) };
}
async function settleTx(row, kind, costUnits, workHash) {
  const sig = kind === 'charge' ? 'function charge(bytes32,uint256,bytes32)' : 'function refund(bytes32,uint256,bytes32)';
  return outcomeOf(row, await chain.send({ to: row.wallet, data: chain.calldata(sig, [row.run_id, kind === 'charge' ? costUnits : 0, workHash]), label: kind }));
}
/** The run's hold on chain: open or closed, and since when. */
async function holdOf(row) {
  const h = await chain.read(row.wallet, 'function holds(bytes32) view returns (address,uint32,uint64,uint96,uint80,uint80)', [row.run_id]);
  return { open: Number(h[2]) !== 0, openedAt: Number(h[2]) };
}
const view = (row, kind, s, workHash, how) => {
  const value = BigInt(row.value), kept = kind === 'charge' ? value - s.cost - s.fee : 0n;
  return { kind: kind === 'charge' ? 'charged' : 'refunded', tx: s.tx, block: s.block, runId: row.run_id, wallet: row.wallet, workHash,
    costUnits: String(s.cost), feeUnits: String(s.fee), toTreasuryUnits: String(s.cost + s.fee), keptByCreatureUnits: String(kept), refundedUnits: String(s.back),
    ...(s.parked ? { parked: true } : {}), ...(how ? { how } : {}),
    note: kind === 'charge' ? `model cost ${usd(s.cost)} + markup ${usd(s.fee)} USDG to the treasury; ${usd(kept)} USDG stays in the creature's wallet`
      : s.parked ? `${usd(s.back)} USDG set aside in the creature's wallet for the payer (USDG would not deliver it now); the payer claims it with claimParked`
      : `${usd(s.back)} USDG sent back to the payer` };
};

/** Called by the engine once a paid hire has ended, before its receipt is signed. receiptCore: the receipt so far.
 *  Returns the `settlement` object to add to the receipt (or null when the hire was not paid through a creature wallet). */
export async function settle(hireId, receiptCore) {
  const row = q.run.get(hireId); if (!row || row.status !== 'held') return null;
  const kind = receiptCore.status === 'done' ? 'charge' : 'refund';
  const costUnits = Math.min(Number(row.budget), Math.max(1, Math.ceil(Number(receiptCore.costUsd || 0) * 1e6)));
  const workHash = receiptHashOf(receiptCore), cost = kind === 'charge' ? String(costUnits) : '0';
  // take the run for this settlement; if the sweep already took it, it settles it and publishes the transaction late
  if (q.claim.run(kind, cost, workHash, hireId, 'held').changes !== 1) return null;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const s = await settleTx(row, kind, costUnits, workHash);
      q.setRun.run(kind === 'charge' ? 'charged' : 'refunded', kind, workHash, s.tx, String(s.cost), String(s.fee), String(s.back), null, Date.now(), hireId);
      return view(row, kind, s, workHash);
    } catch (e) { last = e; if (e.stage === 'reverted' || e.stage === 'wait') break; await new Promise((r) => setTimeout(r, 3000 * (i + 1))); }
  }
  q.setRun.run('unsettled', kind, workHash, last?.hash || null, cost, null, null, String(last?.message || last).slice(0, 300), null, hireId);
  return { kind: kind === 'charge' ? 'charge-pending' : 'refund-pending', runId: row.run_id, wallet: row.wallet, workHash, costUnits: cost, ...(last?.hash ? { sentTx: last.hash } : {}),
    error: String(last?.message || last).slice(0, 200), note: 'Not settled yet: no settlement transaction is confirmed. The server retries every two minutes and then publishes the transaction, signed, under settlementLate on this hire. If the operator cannot settle it, the hold is released to the payer once it is a day old.' };
}

/** Refund a payment whose hire never started (the creature died in between, the engine refused). */
export async function refundUnstarted(hireId, why) {
  const row = q.run.get(hireId); if (!row || row.status !== 'held') return null;
  return settle(hireId, { v: 'weightlings.hire.unstarted.v1', id: hireId, status: 'failed', error: why, costUsd: 0, paidBy: { runId: row.run_id, payTx: row.pay_tx } });
}

// ---------- the retrier: anything held, unsettled or unconfirmed is finished here, and the late transaction is signed ----------
function finishLate(row, kind, s, workHash, how) {
  q.setRun.run(kind === 'charge' ? 'charged' : 'refunded', kind, workHash, s.tx, String(s.cost), String(s.fee), String(s.back), null, Date.now(), row.hire_id);
  const late = { v: 'weightlings.hire.settlement.v1', hireId: row.hire_id, receiptHash: row.receipt_hash || null, settlement: view(row, kind, s, workHash, how), at: Date.now(), keyId: publicKey.keyId };
  q.setLate.run(JSON.stringify({ record: late, ...seal(late) }), row.hire_id);
  console.log(`[pay] late ${kind} for ${row.hire_id} in ${s.tx}`);
}
const closedElsewhere = (row, why) => { q.setClosed.run(why, Date.now(), row.hire_id); console.warn('[pay] sweep', row.hire_id, why); };
async function sweep() {
  if (!configured()) return;
  for (const row of q.pending.all(Date.now() - 120_000)) {
    try {
      if (row.status === 'unknown') {
        // Was the payment taken? The hold on chain says, whatever became of the transaction (or of the server that sent it).
        const rc = row.pay_tx ? await chain.rpc('eth_getTransactionReceipt', [row.pay_tx]).catch(() => null) : null;
        const h = await holdOf(row);
        if (!h.open) {
          if (rc && rc.status === '0x1') { closedElsewhere(row, 'the payment landed but its hold was already closed on chain (released after its day)'); continue; }
          // the authorization was valid an hour at most, so after that the payment can no longer land
          if ((rc && rc.status !== '0x1') || Date.now() - row.at > 3900_000) q.setPayTx.run('void', row.pay_tx, rc ? 'reverted' : 'never mined', row.hire_id);
          continue;
        }
        q.setPayTx.run('held', row.pay_tx || rc?.transactionHash || null, null, row.hire_id); row.status = 'held'; row.hire_status = null; // landed after we gave up: the hire never ran, so refund
      }
      if (row.status === 'held' && row.hire_status === 'running' && Date.now() - row.at < STALE_MS) continue;
      if (row.status === 'unsettled' && row.settle_tx) {
        // the last settlement may have been mined after we stopped waiting for it
        const rc = await chain.rpc('eth_getTransactionReceipt', [row.settle_tx]).catch(() => null);
        if (rc && rc.status === '0x1') { const s = outcomeOf(row, { hash: row.settle_tx, block: Number(rc.blockNumber), logs: rc.logs }); if (s.closed) { finishLate(row, row.want || 'refund', s, row.work_hash || ZERO32); continue; } }
      }
      let kind = row.status === 'unsettled' ? row.want || 'refund' : 'refund';
      const workHash = row.work_hash || row.receipt_hash || ZERO32, cost = kind === 'charge' ? String(row.cost || 0) : '0';
      if (q.claim.run(kind, cost, workHash, row.hire_id, row.status).changes !== 1) continue; // the engine is settling it
      let s = null, how;
      try { s = await settleTx(row, kind, Number(cost), workHash); }
      catch (e) {
        const h = e.stage === 'simulate' ? await holdOf(row).catch(() => null) : null;
        if (h && !h.open) { closedElsewhere(row, 'the hold was closed on chain outside this server (released after its day, or settled by an earlier transaction)'); continue; }
        // the operator cannot settle it (paused by the guardian, replaced): once the hold is a day old anyone may release it,
        // which sends the payment back to the payer, so the operator does exactly that
        if (h && h.open && Date.now() / 1000 >= h.openedAt + HOLD_TIMEOUT_S + 60) {
          try { s = outcomeOf(row, await chain.send({ to: row.wallet, data: chain.calldata('function release(bytes32)', [row.run_id]), label: 'release' })); kind = 'refund'; how = 'released to the payer after the one-day hold timeout'; }
          catch (e2) { e = e2; }
        }
        if (!s) { q.setRun.run('unsettled', kind, workHash, e.hash || row.settle_tx || null, cost, null, null, String(e.message).slice(0, 300), null, row.hire_id); throw e; }
      }
      finishLate(row, kind, s, workHash, how);
    } catch (e) { console.warn('[pay] sweep', row.hire_id, e.message); }
  }
}
let sweeping = false;
const runSweep = async () => { if (sweeping) return; sweeping = true; try { await sweep(); } catch (e) { console.warn('[pay] sweep', e.message); } finally { sweeping = false; } };
setInterval(runSweep, 120_000).unref();
setTimeout(runSweep, 15_000).unref();

/** What /api/hire/:id adds for a paid hire: the run's on-chain record and any late settlement, signed. */
export function publicRun(hireId) {
  const r = q.run.get(hireId); if (!r) return undefined;
  return { wallet: r.wallet, runId: r.run_id, payer: r.payer, valueUnits: r.value, budgetUnits: r.budget, form: r.form, payTx: r.pay_tx, status: r.status, settleTx: r.settle_tx,
    costUnits: r.cost, feeUnits: r.fee, refundedUnits: r.back, settlementLate: r.late ? JSON.parse(r.late) : undefined };
}

// ---------- earnings, read from the chain, cached a minute ----------
let cache = { at: 0, data: null, pending: null };
const W = (sig) => `function ${sig} view returns (uint256)`;
export async function earnings() {
  if (!enabled()) return { live: false };
  if (cache.data && Date.now() - cache.at < 60_000) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const e = env(), rows = q.wallets.all(), counts = new Map(q.runsBy.all().map((r) => [r.creature_id, r]));
    const reads = ['income()', 'totalCharged()', 'profit()', 'withdrawable()', 'totalRefunded()', 'heldTotal()'];
    const calls = [];
    for (const r of rows) { for (const s of reads) calls.push(chain.callReq(r.wallet, W(s))); calls.push(chain.callReq(r.wallet, 'function owner() view returns (address)')); }
    calls.push(chain.callReq(e.usdg, 'function balanceOf(address) view returns (uint256)', [e.treasury]));
    const res = await chain.batch(calls);
    const big = (x) => (x instanceof Error || x == null ? null : BigInt(x === '0x' ? 0 : x));
    const nick = db.prepare('SELECT nick, died, wallet FROM beings WHERE id=?');
    const creatures = rows.map((r, i) => {
      const o = res.slice(i * 7, i * 7 + 7), [income, charged, profit, withdrawable, refunded, held] = o.slice(0, 6).map(big);
      const owner = o[6] instanceof Error || !o[6] ? null : chain.addrTopic(o[6]);
      const being = nick.get(r.creature_id) || {}, c = counts.get(r.creature_id) || {};
      const u = (x) => (x == null ? null : { units: x.toString(), usdg: usd(x) });
      return { creatureId: r.creature_id, nick: being.nick || null, alive: being.died == null, wallet: r.wallet, owner, lineageWallet: being.wallet ? checksum(being.wallet) : null,
        ownerIsLineage: owner && being.wallet ? owner.toLowerCase() === being.wallet.toLowerCase() : null,
        earned: u(income), cost: u(charged), profit: u(profit), withdrawable: u(withdrawable), refunded: u(refunded), held: u(held),
        runs: { charged: Number(c.charged || 0), refunded: Number(c.refunded || 0), open: Number(c.open || 0) }, made: { tx: r.tx, block: r.block } };
    });
    const sum = (k) => creatures.reduce((a, c) => a + (c[k] ? BigInt(c[k].units) : 0n), 0n);
    const tre = big(res[res.length - 1]);
    const totals = { wallets: creatures.length, earned: sum('earned'), cost: sum('cost'), profit: sum('profit'), withdrawable: sum('withdrawable'),
      runs: creatures.reduce((a, c) => a + c.runs.charged, 0), refundedRuns: creatures.reduce((a, c) => a + c.runs.refunded, 0), treasuryBalance: tre };
    const fmt = (x) => (x == null ? null : { units: x.toString(), usdg: usd(x) });
    const data = { live: true, at: Date.now(), cachedForSeconds: 60, network: NETWORK, factory: e.factory, treasury: e.treasury, usdg: e.usdg,
      meaning: "earned = USDG paid to the creature's wallet, net of refunds (income()); cost = model cost + markup charged to the treasury (totalCharged()); profit = earned - cost, what the wallet's owner keeps (profit()). The owner is the wallet that founded the creature's lineage, set when the wallet was made; only the contract's own ownership transfer can change it.",
      creatures, totals: { ...totals, earned: fmt(totals.earned), cost: fmt(totals.cost), profit: fmt(totals.profit), withdrawable: fmt(totals.withdrawable), treasuryBalance: fmt(totals.treasuryBalance) } };
    cache = { at: Date.now(), data, pending: null };
    return data;
  })().catch((err) => { cache.pending = null; throw err; });
  return cache.pending;
}
export async function earningsTotal() {
  if (!enabled()) return { live: false };
  const d = await earnings();
  return { live: true, at: d.at, cachedForSeconds: 60, network: d.network, factory: d.factory, treasury: d.treasury, ...d.totals, meaning: d.meaning };
}

/** for /api/hire/config */
export function describe() {
  if (!enabled()) return null;
  return { on: true, mode: 'creature-wallets', configured: configured(), network: NETWORK, factory: process.env.FACTORY, treasury: process.env.TREASURY, asset: process.env.USDG, operator: chain.operator()?.address || null,
    walletsPerDay: num(process.env.WALLETS_PER_DAY, 20), prices: Object.fromEntries(['common', 'uncommon', 'rare', 'epic', 'legendary'].map((t) => [t, priceOf(t)])),
    rule: "A visitor signs a USDG authorization (no gas). The operator pulls it into the creature's own wallet contract and holds it for the run. Done: model cost + markup go to the treasury, the rest stays with the creature, owned by its lineage wallet. Failed: refunded in full." };
}

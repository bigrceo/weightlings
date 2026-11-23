#!/usr/bin/env node
// Rehearsal of the whole paid path on a local anvil fork of Robinhood Chain. Run by `node scripts/activate.mjs --dry-run`
// (which deploys on the fork first), or by hand:
//   FORK_OPERATOR_KEY=0x<throwaway funded on the fork> node contracts/scripts/fork-paid-hires.mjs --rpc http://127.0.0.1:8547 --deployment .secrets/deployed.dry-run.json
// It starts the real server (server/index.mjs) on a copy of the local database, with PAYMENTS=on and the fork as its chain,
// and the Anthropic API stubbed (mock-anthropic.mjs), then makes three paid hires as a visitor with real USDG on the fork
// (taken from a holder by impersonation):
//   A. success        -> pay (wallet pulls the signed payment), run, charge: model cost + markup to the treasury, rest kept
//   B. failure        -> pay, run fails, refund: the visitor gets everything back
//   C. budget refusal -> the creature's owner lowers its day limit; the server refuses before sending anything
// and prints balances before and after, checks every tx hash and the receipt fingerprints against the chain, reads
// /api/earnings, then restarts the server with PAYMENTS off and checks /api/earnings says { live: false }.
// Writes the measured gas of each operation to contracts/deployments/measured-gas.json (activate.mjs sizes its reserve with it).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2), opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const RPC = opt('--rpc', 'http://127.0.0.1:8547');
const dep = JSON.parse(readFileSync(opt('--deployment', join(ROOT, '.secrets', 'deployed.dry-run.json')), 'utf8'));
const OP_KEY = process.env.FORK_OPERATOR_KEY;
if (!OP_KEY) die('FORK_OPERATOR_KEY (a throwaway key funded on the fork) is required');
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC)) die('this rehearsal only runs against a local fork');

const VIEM = [process.env.VIEM, '/Users/rayane/optima-clone/node_modules/viem/_esm/index.js', '/Users/rayane/swarm/node_modules/viem/_esm/index.js'].filter(Boolean).find((p) => existsSync(p));
const viem = await import(pathToFileURL(VIEM).href);
const accounts = await import(pathToFileURL(join(dirname(VIEM), 'accounts', 'index.js')).href);
const { createPublicClient, http, defineChain, parseAbi, formatUnits, formatEther, getAddress, parseEventLogs } = viem;
const chain = defineChain({ id: 4663, name: 'Robinhood Chain fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const USDG = getAddress(dep.usdg);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function authorizationState(address,bytes32) view returns (bool)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const walletAbi = parseAbi(['function pay(address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32,bytes32,uint256,bool)', 'function setLimits(uint128,uint128)', 'function owner() view returns (address)', 'function income() view returns (uint256)', 'function profit() view returns (uint256)', 'function totalCharged() view returns (uint256)', 'function perRunCap() view returns (uint128)',
  'event Charged(bytes32 indexed runId, uint256 cost, uint256 fee, address indexed treasury, bytes32 receipt)', 'event Refunded(bytes32 indexed runId, address indexed payer, uint256 amount, bool parked)', 'event Paid(bytes32 indexed runId, address indexed payer, uint256 value, bool outside)']);
const operator = accounts.privateKeyToAccount(OP_KEY).address;
const visitor = accounts.privateKeyToAccount(accounts.generatePrivateKey());
const rpc = async (method, params = []) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const usdgOf = (a) => pub.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [a] });
const u = (x) => formatUnits(x, 6);
const checks = [];
const check = (name, pass, detail = '') => { checks.push(pass); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

// ---------- the visitor gets 2 USDG on the fork from a real holder (impersonated: possible on a fork only) ----------
console.log(`visitor ${visitor.address} (throwaway), operator ${operator} (throwaway)`);
const head = await pub.getBlockNumber();
let holder = null;
const seen = new Set();
for (let k = 0n; k < 20n && !holder; k++) { // windows of 4,000 blocks back from the fork head (the node refuses wider ranges)
  const logs = await pub.getLogs({ address: USDG, event: erc20[3], fromBlock: head - (k + 1n) * 4000n, toBlock: head - k * 4000n }).catch(() => []);
  for (const l of logs.reverse()) { const to = l.args.to; if (seen.has(to) || seen.size > 60) continue; seen.add(to); if ((await usdgOf(to)) >= 5_000_000n) { holder = to; break; } }
}
if (!holder) die('no USDG holder with 5 USDG found in recent transfers');
await rpc('anvil_impersonateAccount', [holder]);
await rpc('anvil_setBalance', [holder, '0xde0b6b3a7640000']);
await sendAs(holder, USDG, viem.encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [visitor.address, 2_000_000n] }));
await rpc('anvil_stopImpersonatingAccount', [holder]);
console.log(`visitor funded with 2 USDG from holder ${holder}`);

// ---------- the local server, on a copy of the database ----------
const dataDir = join(tmpdir(), 'weightlings-fork-' + Date.now());
mkdirSync(dataDir, { recursive: true });
new DatabaseSync(join(ROOT, 'data', 'murmur.db'), { readOnly: true }).exec(`VACUUM INTO '${join(dataDir, 'murmur.db')}'`);
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const serverEnv = (payments) => ({ ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'stub-not-a-key', HIRE_SALT: 'fork-rehearsal', HIRE_SIGNING_KEY: '',
  PAY_RPC_URL: RPC, HIRE_RPC_URL: RPC, CHAIN_ID: '4663', ...(payments ? { PAYMENTS: 'on', FACTORY: dep.factory, TREASURY: dep.treasury, USDG, OPERATOR_KEY: OP_KEY, WALLETS_PER_DAY: '5' } : { PAYMENTS: '', FACTORY: '', OPERATOR_KEY: '' }) });
let server = await startServer(true);

const api = async (path, init = {}) => { const r = await fetch(BASE + path, init); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body, headers: r.headers }; };
const world = (await api('/api/world')).body;
// a creature's wallet is made only when its lineage wallet is a key holder (no code): pick one such creature to hire, and one
// whose lineage wallet is a contract, to check that it is refused before anything is sent
const lineageCode = async (id) => { const w = (await api('/api/being/' + id)).body?.w; return w ? String(await rpc('eth_getCode', [w, 'latest'])).toLowerCase() : null; };
let creature = null, contractCreature = null;
for (const c of world.c.filter((c) => c[3] >= 0)) {
  if (creature && contractCreature) break;
  const code = await lineageCode(c[0]); if (code == null) continue;
  if (code !== '0x') { contractCreature ||= c[0]; continue; }
  const card = (await api('/api/hire/creature/' + c[0])).body;
  if (card.alive && (!creature || (card.tier === 'common' && creature.tier !== 'common'))) creature = card;
}
if (!creature) die('no living creature whose lineage wallet is a key holder');
console.log(`creature #${creature.id} ${creature.nick} (${creature.tier}, price ${creature.price.usdg} USDG)`);

const snapshot = async (w) => ({ visitor: await usdgOf(visitor.address), treasury: await usdgOf(dep.treasury), wallet: w ? await usdgOf(w) : 0n, opEth: await pub.getBalance({ address: operator }), opNonce: await pub.getTransactionCount({ address: operator }) });
const show = (label, s) => console.log(`  ${label.padEnd(8)} visitor ${u(s.visitor).padStart(9)} USDG | creature wallet ${u(s.wallet).padStart(9)} USDG | treasury ${u(s.treasury).padStart(9)} USDG | operator ${formatEther(s.opEth)} ETH, nonce ${s.opNonce}`);
const pid = 'forkrehearsal' + Date.now().toString(36);

async function quoteAndSign(task) {
  const q = await api('/api/hire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creatureId: creature.id, task, pid }) });
  if (q.status !== 402) die(`expected 402 terms, got ${q.status}: ${JSON.stringify(q.body).slice(0, 300)}`);
  const td = q.body.sign.typedData, message = { ...td.message, from: visitor.address, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) };
  const { EIP712Domain, ...types } = td.types;
  const signature = await visitor.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message });
  const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'eip155:4663', payload: { form: 'receive', signature, authorization: { ...td.message, from: visitor.address } } })).toString('base64');
  return { terms: q.body, header, nonce: td.message.nonce };
}
async function hire(task, header) {
  const r = await api('/api/hire', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': header }, body: JSON.stringify({ creatureId: creature.id, task, pid }) });
  if (r.status !== 202) return r;
  for (let i = 0; i < 240; i++) { const h = await api('/api/hire/' + r.body.id); if (h.body?.receiptHash) return { ...r, hire: h.body }; await new Promise((x) => setTimeout(x, 500)); }
  die('the hire did not finish');
}
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map((x) => canonical(x === undefined ? null : x)).join(',') + ']' : '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
const sha = (s) => '0x' + createHash('sha256').update(s).digest('hex');
const keyDoc = (await api('/api/hire/key')).body;
async function checkReceipt(h, kind) {
  const r = h.receipt, s = r.settlement;
  check('receipt hash = sha256(canonical(receipt))', sha(canonical(r)) === h.receiptHash);
  const k = keyDoc.keys.find((x) => x.keyId === r.keyId);
  check('Ed25519 signature', !!k && verify(null, Buffer.from(h.receiptHash.slice(2), 'hex'), createPublicKey(k.publicKeyPem), Buffer.from(h.signature.slice(2), 'hex')));
  check('pay tx in the signed receipt', /^0x[0-9a-f]{64}$/.test(r.paidBy?.payTx || ''), r.paidBy?.payTx);
  check(`${kind} tx in the signed receipt`, s?.kind === kind && /^0x[0-9a-f]{64}$/.test(s.tx || ''), s?.tx);
  const { settlement, ...core } = r;
  check('workHash = sha256(canonical(receipt without settlement))', sha(canonical(core)) === s.workHash, s.workHash);
  const payRc = await pub.getTransactionReceipt({ hash: r.paidBy.payTx });
  const paid = parseEventLogs({ abi: walletAbi, logs: payRc.logs, eventName: 'Paid' })[0];
  check('pay tx: Paid(runId, visitor, price) by the creature wallet', payRc.status === 'success' && paid?.args.runId === r.paidBy.runId && paid.args.payer === visitor.address && String(paid.args.value) === r.paidBy.units && getAddress(paid.address) === r.paidBy.wallet);
  const rc = await pub.getTransactionReceipt({ hash: s.tx });
  const ch = parseEventLogs({ abi: walletAbi, logs: rc.logs, eventName: 'Charged' })[0];
  check('settle tx: Charged event carries runId and workHash', rc.status === 'success' && ch?.args.runId === r.paidBy.runId && ch.args.receipt === s.workHash);
  const vr = spawnSync(process.execPath, [join(ROOT, 'server', 'hire', 'verify-receipt.mjs'), BASE, h.id, '--rpc', RPC], { encoding: 'utf8' });
  check('standalone verify-receipt.mjs --rpc passes', vr.status === 0, (vr.stdout.match(/^(PASS|FAIL)  (paid hire|on chain).*$/gm) || []).length + ' payment lines, ' + (vr.stdout.trim().split('\n').pop()));
  gas[r.paidBy.form === 'receive' ? 'pay' : 'payTransfer'] = Number(payRc.gasUsed); gas[kind === 'charged' ? 'charge' : 'refund'] = Number(rc.gasUsed);
  return { rc, ch };
}
const gas = {};

// ---------- 0. a creature whose lineage wallet is a contract: refused before any transaction ----------
if (contractCreature) {
  console.log(`\n0. creature #${contractCreature}: its lineage wallet is a contract`);
  const n0 = await pub.getTransactionCount({ address: operator });
  const r0 = await api('/api/hire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creatureId: contractCreature, task: 'This hire should be refused.', pid }) });
  check('refused (409) with a reason, no wallet made', r0.status === 409 && !r0.body?.creatureWallet, `${r0.status} ${r0.body?.error}`);
  check('no operator transaction was sent', (await pub.getTransactionCount({ address: operator })) === n0);
} else console.log('\n0. (no living creature with a contract lineage wallet on this fork: refusal check skipped)');

// ---------- A. success ----------
console.log('\nA. paid hire that succeeds');
const qa = await quoteAndSign('In two sentences, what is a creature wallet?');
const W = qa.terms.creatureWallet.address;
console.log(`  terms: price ${qa.terms.price.usdg} USDG to creature wallet ${W} (owner ${qa.terms.creatureWallet.owner}, made in ${qa.terms.creatureWallet.made}); budget ${qa.terms.split.budgetUnits} units, markup ${qa.terms.split.markupBps} bps`);
const made = await pub.getTransactionReceipt({ hash: qa.terms.creatureWallet.made }); gas.createAgent = Number(made.gasUsed);
check('wallet owner on chain = the lineage wallet of the creature', (await pub.readContract({ address: W, abi: walletAbi, functionName: 'owner' })).toLowerCase() === (await api('/api/being/' + creature.id)).body.w?.toLowerCase());
const a0 = await snapshot(W); show('before', a0);
const A = await hire('In two sentences, what is a creature wallet?', qa.header);
check('hire A accepted (202) and done', A.status === 202 && A.hire?.status === 'done', `${A.status} ${A.hire?.status || JSON.stringify(A.body)}`);
const a1 = await snapshot(W); show('after', a1);
const sA = A.hire.receipt.settlement;
await checkReceipt(A.hire, 'charged');
const price = BigInt(A.hire.receipt.paidBy.units), cost = BigInt(sA.costUnits), fee = BigInt(sA.feeUnits);
check('visitor paid exactly the price', a0.visitor - a1.visitor === price, `${u(price)} USDG`);
check('treasury got model cost + markup', a1.treasury - a0.treasury === cost + fee, `${u(cost)} + ${u(fee)} USDG`);
check('the rest stays in the creature wallet', a1.wallet - a0.wallet === price - cost - fee, `${u(price - cost - fee)} USDG`);
check('model cost in the receipt = charged cost', Math.ceil(A.hire.receipt.costUsd * 1e6) === Number(cost), `$${A.hire.receipt.costUsd}`);

// ---------- B. failure, refunded ----------
console.log('\nB. paid hire that fails: refunded');
const qb = await quoteAndSign('[[mock:fail]] this one fails on purpose');
const b0 = await snapshot(W); show('before', b0);
const B = await hire('[[mock:fail]] this one fails on purpose', qb.header);
check('hire B accepted (202) then failed', B.status === 202 && B.hire?.status === 'failed', `${B.status} ${B.hire?.status} ${B.hire?.error || ''}`);
const b1 = await snapshot(W); show('after', b1);
await checkReceipt(B.hire, 'refunded');
check('visitor got all of it back', b1.visitor === b0.visitor);
check('wallet and treasury unchanged', b1.wallet === b0.wallet && b1.treasury === b0.treasury);
check('refund amount in the receipt = price', B.hire.receipt.settlement.refundedUnits === B.hire.receipt.paidBy.units);

// ---------- D. the server dies right after sending a payment: the sweep finds the hold on chain after a restart and refunds it ----------
console.log('\nD. payment sent, then the server stops before recording it: refunded by the sweep after the restart');
const qd = await quoteAndSign('This hire is interrupted after its payment.');
const d0 = await snapshot(W); show('before', d0);
server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r));
const hireD = 'h' + randomBytes(10).toString('hex'), runD = '0x' + createHash('sha256').update('weightlings.hire.run|' + hireD).digest('hex');
{ // exactly what the server writes before it sends `pay`, with the time pushed back past the sweep's two-minute grace
  const ddb = new DatabaseSync(join(dataDir, 'murmur.db'));
  ddb.prepare("INSERT INTO pay_runs(hire_id, creature_id, wallet, run_id, payer, value, budget, form, pay_tx, status, at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(hireD, creature.id, W, runD, visitor.address, qd.terms.price.units, qd.terms.split.budgetUnits, 'receive', null, 'paying', Date.now() - 180_000);
  ddb.close();
}
const pd = JSON.parse(Buffer.from(qd.header, 'base64').toString()).payload, sd = pd.signature.slice(2), ad = pd.authorization;
const payD = await sendKey(OP_KEY, W, viem.encodeFunctionData({ abi: walletAbi, functionName: 'pay', args: [ad.from, BigInt(ad.value), BigInt(ad.validAfter), BigInt(ad.validBefore), ad.nonce, parseInt(sd.slice(128), 16), '0x' + sd.slice(0, 64), '0x' + sd.slice(64, 128), runD, BigInt(qd.terms.split.budgetUnits), true] }));
const d1 = await snapshot(W); show('paid', d1);
check('the payment is held in the creature wallet', d0.visitor - d1.visitor === BigInt(qd.terms.price.units) && d1.wallet - d0.wallet === BigInt(qd.terms.price.units), payD);
server = await startServer(true);
let D = null;
for (let i = 0; i < 90; i++) { D = (await api('/api/hire/' + hireD)).body; if (D?.payment?.status === 'refunded') break; await new Promise((x) => setTimeout(x, 1000)); }
const d2 = await snapshot(W); show('after', d2);
const late = D?.payment?.settlementLate;
check('the sweep refunded it after the restart', D?.status === 'not-started' && D.payment.status === 'refunded', `${D?.status} ${D?.payment?.status} ${D?.payment?.settleTx || ''}`);
check('visitor got all of it back, wallet unchanged', d2.visitor === d0.visitor && d2.wallet === d0.wallet);
const lateKey = late && (await api('/api/hire/key')).body.keys.find((k) => k.keyId === late.record.keyId);
check('the late refund is signed: hash = sha256(canonical(record)), Ed25519 by the key it names', !!lateKey && sha(canonical(late.record)) === late.receiptHash && verify(null, Buffer.from(late.receiptHash.slice(2), 'hex'), createPublicKey(lateKey.publicKeyPem), Buffer.from(late.signature.slice(2), 'hex')));
if (late) {
  const rc = await pub.getTransactionReceipt({ hash: late.record.settlement.tx });
  const rf = parseEventLogs({ abi: walletAbi, logs: rc.logs, eventName: 'Refunded' })[0];
  check('the refund tx in the record: Refunded(runId, visitor, price) on chain', rc.status === 'success' && rf?.args.runId === runD && rf.args.payer === visitor.address && String(rf.args.amount) === qd.terms.price.units, late.record.settlement.tx);
}

// ---------- C. budget refusal ----------
console.log("\nC. budget refusal: the creature's owner lowers its day limit");
const owner = await pub.readContract({ address: W, abi: walletAbi, functionName: 'owner' });
await rpc('anvil_impersonateAccount', [owner]);
await rpc('anvil_setBalance', [owner, '0x2386f26fc10000']);
const perRun = await pub.readContract({ address: W, abi: walletAbi, functionName: 'perRunCap' });
await sendAs(owner, W, viem.encodeFunctionData({ abi: walletAbi, functionName: 'setLimits', args: [perRun, 10_000n] }));
await rpc('anvil_stopImpersonatingAccount', [owner]);
console.log(`  owner ${owner} set the day limit to 0.01 USDG (on the fork, by impersonation)`);
const qc = await quoteAndSign('This hire should be refused before anything moves.');
const c0 = await snapshot(W); show('before', c0);
const C = await hire('This hire should be refused before anything moves.', qc.header);
const c1 = await snapshot(W); show('after', c1);
check('refused with a reason, no hire started', C.status === 429 && !C.body?.id, `${C.status} ${C.body?.error}`);
check('no operator transaction was sent', c1.opNonce === c0.opNonce);
check('no USDG moved', c1.visitor === c0.visitor && c1.wallet === c0.wallet && c1.treasury === c0.treasury);
check("the visitor's authorization is still unused on chain", !(await pub.readContract({ address: USDG, abi: erc20, functionName: 'authorizationState', args: [visitor.address, qc.nonce] })));

// ---------- earnings ----------
console.log('\nearnings');
const E = (await api('/api/earnings')).body, T = (await api('/api/earnings/total')).body;
const mine = E.creatures?.find((c) => c.wallet === W);
console.log('  /api/earnings (this creature):', JSON.stringify({ wallet: mine?.wallet, owner: mine?.owner, ownerIsLineage: mine?.ownerIsLineage, earned: mine?.earned?.usdg, cost: mine?.cost?.usdg, profit: mine?.profit?.usdg, withdrawable: mine?.withdrawable?.usdg, runs: mine?.runs }));
console.log('  /api/earnings/total:', JSON.stringify({ live: T.live, wallets: T.wallets, earned: T.earned?.usdg, cost: T.cost?.usdg, profit: T.profit?.usdg, runs: T.runs, refundedRuns: T.refundedRuns, treasuryBalance: T.treasuryBalance?.usdg }));
check('earnings live, read from chain', E.live === true && T.live === true);
check('earned = price, cost = cost + markup, profit = the rest', mine?.earned.units === String(price) && mine?.cost.units === String(cost + fee) && mine?.profit.units === String(price - cost - fee));
check('runs: 1 charged, 2 refunded (B and D), none open', mine?.runs.charged === 1 && mine?.runs.refunded === 2 && mine?.runs.open === 0);
check('owner of the earnings is the lineage wallet', mine?.ownerIsLineage === true, mine?.owner);

// ---------- PAYMENTS off ----------
console.log('\nPAYMENTS off');
server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r));
server = await startServer(false);
const off = (await api('/api/earnings')).body, offT = (await api('/api/earnings/total')).body, cfg = (await api('/api/hire/config')).body;
check('/api/earnings and /total answer { live: false }', JSON.stringify(off) === '{"live":false}' && JSON.stringify(offT) === '{"live":false}', JSON.stringify(off));
check('/api/hire/config says payments off', cfg.payments?.on === false);
server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r));
rmSync(dataDir, { recursive: true, force: true });

const out = join(ROOT, 'contracts', 'deployments');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'measured-gas.json'), JSON.stringify({ at: new Date().toISOString(), on: 'anvil fork of Robinhood Chain (4663)', note: 'gasUsed of one call each; activate.mjs sizes its reserve from these', gas }, null, 2) + '\n');
console.log(`\nmeasured gas: ${JSON.stringify(gas)}  -> contracts/deployments/measured-gas.json`);
const all = checks.every(Boolean);
console.log(all ? `ALL ${checks.length} CHECKS PASS` : `${checks.filter((x) => !x).length} CHECK(S) FAILED`);
process.exit(all ? 0 : 1);

// ---------- helpers ----------
async function sendKey(key, to, data) {
  const wc = viem.createWalletClient({ account: accounts.privateKeyToAccount(key), chain, transport: http(RPC) });
  const hash = await wc.sendTransaction({ to, data });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') die(`call to ${to} reverted`);
  return hash;
}
async function sendAs(from, to, data) {
  const hash = await rpc('eth_sendTransaction', [{ from, to, data }]);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') die(`impersonated call from ${from} reverted`);
}
async function startServer(payments) {
  const p = spawn(process.execPath, ['--import', join(ROOT, 'contracts', 'scripts', 'mock-anthropic.mjs'), 'server/index.mjs'], { cwd: ROOT, env: serverEnv(payments), stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  const keep = (d) => { for (const l of String(d).split('\n')) if (l.trim()) { log.push(l); if (/\[pay\]|\[hire\]|\[fatal\]|Error/.test(l)) console.log('  server| ' + l.slice(0, 220)); } };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  process.on('exit', () => { try { p.kill(); } catch {} });
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/hire/config`); if (r.ok) return p; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  console.log(log.slice(-20).join('\n')); die('the local server did not start');
}
function die(msg) { console.error('fork-paid-hires: ' + msg); process.exit(1); }

#!/usr/bin/env node
// One command to switch paid hires on, once the operator wallet holds ETH on Robinhood Chain (4663).
//
//   node scripts/activate.mjs --dry-run     everything against a local anvil fork: nothing reaches Robinhood Chain
//   node scripts/activate.mjs               the real thing: deploys (or resumes), verifies, prints the Railway variables
//   node scripts/activate.mjs --apply       same, then sets those variables with the Railway CLI (never OPERATOR_KEY)
//
// What it does, in order:
//   1. reads the operator key from .secrets/operator.env (OPERATOR_KEY=0x...). The key is never printed or logged.
//   2. measures what the activation needs in ETH (deploy gas estimated live + a reserve of first wallets and hires, measured
//      on a fork, at today's gas price, +30%) and refuses below it, saying exactly how much is missing.
//   3. deploys WeightlingsTreasury and WeightlingsFactory, or resumes: each step's tx and address are written to
//      .secrets/deployed.json as soon as they exist, so a second run picks up where the first stopped and never deploys twice.
//   4. reads every setting back from the chain (owner, operator, guardian, treasury, USDG, ERC-8004 registry, markup,
//      pause, deployed code against the build) and stops on any difference.
//   5. creates NO creature wallet: the server makes each one on that creature's first paid hire, at most WALLETS_PER_DAY a day.
//   6. prints the Railway variable lines. With --apply it sets them (addresses first, PAYMENTS=on last, and only once
//      OPERATOR_KEY is already on Railway and belongs to the operator). OPERATOR_KEY itself is typed by the owner (piped from
//      the file, never shown): the exact command is printed.
//   7. --dry-run: starts anvil on a fork of Robinhood Chain, rehearses 1-6 there with a throwaway key (so no transaction
//      signed by the real key exists anywhere), then runs three paid hires against a local server (contracts/scripts/fork-paid-hires.mjs).
//
// Options: --yes (no typed confirmation), --port 8547 (anvil), --skip-hires, --reserve-wallets 20, --reserve-hires 50,
//          OWNER / GUARDIAN / MARKUP_BPS env (default: owner = guardian = operator address, markup 2000 = 20%), RPC_URL.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = join(ROOT, '.secrets');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('--dry-run'), APPLY = flag('--apply'), YES = flag('--yes');
if (DRY && APPLY) die('--dry-run and --apply do not go together');
const MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MARGIN = 1.3;
const RESERVE_WALLETS = Number(opt('--reserve-wallets', 20));
const RESERVE_HIRES = Number(opt('--reserve-hires', 50));
const MARKUP_BPS = Number(process.env.MARKUP_BPS ?? 2000);
if (!Number.isInteger(MARKUP_BPS) || MARKUP_BPS < 0 || MARKUP_BPS > 5000) die('MARKUP_BPS must be 0..5000');

// ---------- viem (local tooling only; the server itself has no dependencies) ----------
const VIEM = [process.env.VIEM, '/Users/rayane/optima-clone/node_modules/viem/_esm/index.js', '/Users/rayane/swarm/node_modules/viem/_esm/index.js'].filter(Boolean).find((p) => existsSync(p));
if (!VIEM) die('viem not found. Set VIEM=/path/to/node_modules/viem/_esm/index.js');
const viem = await import(pathToFileURL(VIEM).href);
const accounts = await import(pathToFileURL(join(dirname(VIEM), 'accounts', 'index.js')).href);
const { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress, formatEther, formatGwei, encodeDeployData, getContractAddress, keccak256, zeroAddress } = viem;

const art = (name) => {
  const p = join(ROOT, 'contracts', 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) die(`missing ${p}. Run \`forge build\` in contracts/ first.`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object, immutables: j.deployedBytecode.immutableReferences || {} };
};
const Treasury = art('WeightlingsTreasury'), Factory = art('WeightlingsFactory'), Wallet = art('CreatureWallet');

// ---------- 1. the operator key, from the file only ----------
const envFile = process.env.OPERATOR_ENV_FILE || join(SECRETS, 'operator.env'); // the override is for rehearsals with a throwaway key
if (!existsSync(envFile)) die(`${envFile} not found`);
const fileVars = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const rawKey = fileVars.OPERATOR_KEY || '';
const realKey = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey;
if (!/^0x[0-9a-fA-F]{64}$/.test(realKey)) die('OPERATOR_KEY in .secrets/operator.env is not 32 bytes of hex');
const realOperator = accounts.privateKeyToAccount(realKey);
if (fileVars.OPERATOR_ADDRESS && getAddress(fileVars.OPERATOR_ADDRESS) !== realOperator.address) die('OPERATOR_ADDRESS in operator.env does not match OPERATOR_KEY');
step(`operator ${realOperator.address} (key read from ${envFile.replace(ROOT + '/', '')}, not shown)`);

// ---------- the chain: mainnet, or a fork in --dry-run ----------
let anvil = null, rpcUrl = process.env.RPC_URL || MAINNET_RPC;
if (DRY) {
  const port = Number(opt('--port', 8547));
  const bin = [join(process.env.HOME || '', '.foundry', 'bin', 'anvil'), 'anvil'].find((b) => b === 'anvil' || existsSync(b));
  rpcUrl = `http://127.0.0.1:${port}`;
  // the fork charges the real chain's gas price, so what it measures in ETH is what mainnet would charge
  const realPrice = BigInt(await rawRpc(MAINNET_RPC, 'eth_gasPrice'));
  anvil = spawn(bin, ['--fork-url', process.env.FORK_URL || MAINNET_RPC, '--port', String(port), '--silent', '--no-rate-limit', '--block-base-fee-per-gas', String(realPrice)], { stdio: 'ignore' });
  process.on('exit', () => { try { anvil.kill(); } catch {} });
  let exited = false; anvil.on('exit', () => { exited = true; });
  for (let i = 0; ; i++) { try { await rawRpc(rpcUrl, 'eth_chainId'); break; } catch { if (exited || i > 120) die('anvil did not start'); await sleep(250); } }
  // something else answering on that port (another node, an old fork) is not this rehearsal's fresh fork: stop
  await sleep(300);
  if (exited || anvil.exitCode != null) die(`anvil exited: port ${port} is probably taken by another node. Pass --port with a free port.`);
  step(`dry run: anvil fork of Robinhood Chain at ${rpcUrl} (pid ${anvil.pid}); nothing is sent to Robinhood Chain`);
}
const chain = defineChain({ id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000 }) });
const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) die(`RPC ${rpcUrl} is chain ${chainId}, expected ${CHAIN_ID}`);
for (const [n, a] of [['USDG', USDG], ['ERC-8004 registry', IDENTITY_REGISTRY]]) if (((await pub.getCode({ address: a })) || '0x') === '0x') die(`${n} ${a} has no code on this chain`);

// In a dry run every transaction is signed by a throwaway key, so no transaction signed by the real key exists anywhere.
const throwawayKey = DRY ? accounts.generatePrivateKey() : null;
const account = DRY ? accounts.privateKeyToAccount(throwawayKey) : realOperator;
const OPERATOR = account.address;
const OWNER = process.env.OWNER ? addr(process.env.OWNER, 'OWNER') : OPERATOR;
const GUARDIAN = process.env.GUARDIAN ? addr(process.env.GUARDIAN, 'GUARDIAN') : OWNER;
if (DRY) step(`dry run: transactions are signed by throwaway ${OPERATOR}; the real operator is only read`);
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 60_000 }) });
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(rpcUrl);
const stateFile = join(SECRETS, DRY ? 'deployed.dry-run.json' : LOCAL ? 'deployed.local.json' : 'deployed.json');
if (APPLY && LOCAL && process.env.ACTIVATE_ALLOW_LOCAL_APPLY !== '1') die('--apply with a local RPC would put fork addresses on Railway: refused');
// a dry run starts on a fresh fork, where the last rehearsal's addresses mean nothing: it starts from an empty state
let state = !DRY && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
if (state.chainId && state.chainId !== CHAIN_ID) die(`${stateFile} is for chain ${state.chainId}`);
if (state.operator && state.operator !== OPERATOR) die(`${stateFile} was made by operator ${state.operator}, not ${OPERATOR}. Move it away to start over.`);

// ---------- 2. what it needs, and what it has ----------
const measuredFile = join(ROOT, 'contracts', 'deployments', 'measured-gas.json');
const measured = existsSync(measuredFile) ? JSON.parse(readFileSync(measuredFile, 'utf8')) : null;
// gas of one operation, measured on a fork by contracts/scripts/fork-paid-hires.mjs; the fallbacks are on the high side
const OPS = { createAgent: 300_000, pay: 220_000, charge: 160_000, refund: 160_000, ...(measured?.gas || {}) };
// the real chain, read only (a dry run prints what the real operator needs at the real price; anvil's own eth_gasPrice adds a 1 gwei tip)
const mainPub = createPublicClient({ chain: { ...chain, rpcUrls: { default: { http: [MAINNET_RPC] } } }, transport: http(MAINNET_RPC, { timeout: 30_000 }) });
async function need(skipDone = true, priceFrom = pub) {
  const price = await priceFrom.getGasPrice();
  const tData = encodeDeployData({ abi: Treasury.abi, bytecode: Treasury.bytecode, args: [OWNER] });
  const fData = encodeDeployData({ abi: Factory.abi, bytecode: Factory.bytecode, args: [USDG, OWNER, OPERATOR, OWNER /* stand-in treasury */, MARKUP_BPS, IDENTITY_REGISTRY, GUARDIAN] });
  const gT = skipDone && state.treasury ? 0n : await pub.estimateGas({ account: OPERATOR, data: tData });
  const gF = skipDone && state.factory ? 0n : await pub.estimateGas({ account: OPERATOR, data: fData });
  const reserve = BigInt(RESERVE_WALLETS * OPS.createAgent + RESERVE_HIRES * (OPS.pay + Math.max(OPS.charge, OPS.refund)));
  const spend = (gT + gF + reserve) * price;
  const want = (spend * BigInt(Math.round(MARGIN * 100))) / 100n;
  // a node also wants gasLimit x maxFeePerGas up front for the largest single transaction
  const peak = ((gF > gT ? gF : gT) * 13n / 10n + 10_000n) * (price * 2n + 1n);
  return { price, gT, gF, reserve, want: want > peak ? want : peak };
}
async function checkFunds(who, label) {
  const n = await need(), bal = await pub.getBalance({ address: who });
  console.log(`  gas price            ${formatGwei(n.price)} gwei`);
  console.log(`  deploy               ${n.gT + n.gF} gas  (treasury ${n.gT}, factory ${n.gF}${state.factory ? ', already deployed' : ''})`);
  console.log(`  reserve              ${n.reserve} gas  (${RESERVE_WALLETS} creature wallets + ${RESERVE_HIRES} paid hires, gas per op ${measured ? 'measured on a fork ' + measured.at.slice(0, 10) : 'not measured yet (high defaults)'})`);
  console.log(`  needed (+${Math.round((MARGIN - 1) * 100)}%)        ${formatEther(n.want)} ETH`);
  console.log(`  ${label.padEnd(20)} ${formatEther(bal)} ETH`);
  if (bal < n.want) return { ok: false, missing: n.want - bal, n, bal };
  return { ok: true, n, bal };
}

if (DRY) {
  // what the owner must actually send: the real operator's balance on Robinhood Chain, read from the real chain
  const realBal = await mainPub.getBalance({ address: realOperator.address });
  step('2. funds (real operator on Robinhood Chain, read only)');
  const n = await need(false, mainPub);
  console.log(`  needed (+30%)        ${formatEther(n.want)} ETH at ${formatGwei(n.price)} gwei`);
  console.log(`  real operator has    ${formatEther(realBal)} ETH  -> ${realBal >= n.want ? 'enough' : 'missing ' + formatEther(n.want - realBal) + ' ETH'}`);
  step('2. funds on the fork (at the fork\'s own gas price), before funding the throwaway: the refusal a real run gives');
  const c0 = await checkFunds(OPERATOR, 'throwaway has');
  if (!c0.ok) console.log(`  REFUSED: missing ${formatEther(c0.missing)} ETH. Send at least that to ${OPERATOR}.`);
  await rawRpc(rpcUrl, 'anvil_setBalance', [OPERATOR, '0x' + c0.n.want.toString(16)]);
  step('2. funds on the fork, after anvil_setBalance to exactly the need:');
  const c1 = await checkFunds(OPERATOR, 'throwaway has');
  if (!c1.ok) die('the funded throwaway is still short');
} else {
  step('2. funds');
  const c = await checkFunds(OPERATOR, 'operator has');
  if (!c.ok) die(`REFUSED: the operator holds ${formatEther(c.bal)} ETH and needs ${formatEther(c.n.want)}. Missing ${formatEther(c.missing)} ETH: send at least that to ${OPERATOR} on Robinhood Chain (4663), then run this again.`);
}

// ---------- 3. deploy, or resume ----------
async function deploy() {
  if (state.factory && state.treasury) { console.log('  treasury and factory are already deployed: nothing to send'); return; }
  if (!DRY && !YES) {
    if (!process.stdin.isTTY) die('not a terminal: pass --yes to confirm');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`Type "deploy" to deploy on Robinhood Chain from ${OPERATOR}: `)).trim(); rl.close();
    if (a !== 'deploy') die('cancelled, nothing sent');
  }
  Object.assign(state, { chainId: CHAIN_ID, rpc: rpcUrl, operator: OPERATOR, owner: OWNER, guardian: GUARDIAN, markupBps: MARKUP_BPS, usdg: USDG, identityRegistry: IDENTITY_REGISTRY, txs: state.txs || {}, gasUsed: state.gasUsed || {}, dryRun: DRY });
  save();
  state.treasury ||= await step1('treasury', Treasury, [OWNER]);
  state.factory ||= await step1('factory', Factory, [USDG, OWNER, OPERATOR, state.treasury, MARKUP_BPS, IDENTITY_REGISTRY, GUARDIAN]);
  save();
}
// One contract creation that can be resumed: the nonce is written before sending and the tx hash right after, so a run that
// stopped anywhere finds the contract at getContractAddress(operator, nonce) instead of creating a second one.
async function step1(name, a, args) {
  const pending = state.pending?.[name];
  if (pending) {
    const at = getContractAddress({ from: OPERATOR, nonce: BigInt(pending.nonce) });
    if (((await pub.getCode({ address: at })) || '0x') !== '0x') { console.log(`  ${name}: found at ${at} from an earlier run`); return done(name, at, pending.tx, null); }
    if (pending.tx) {
      const rc = await pub.waitForTransactionReceipt({ hash: pending.tx, timeout: 120_000 }).catch(() => null);
      if (rc?.status === 'success') return done(name, getAddress(rc.contractAddress), pending.tx, rc);
    }
    const nonceNow = await pub.getTransactionCount({ address: OPERATOR, blockTag: 'pending' });
    if (nonceNow > pending.nonce) die(`${name}: nonce ${pending.nonce} was used but no contract is at ${at}. Look at ${OPERATOR} on the explorer before running again.`);
  }
  const nonce = await pub.getTransactionCount({ address: OPERATOR, blockTag: 'pending' });
  const price = await pub.getGasPrice();
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
  const gas = (await pub.estimateGas({ account: OPERATOR, data })) * 13n / 10n + 10_000n;
  state.pending = { ...(state.pending || {}), [name]: { nonce } }; save();
  const tx = await wallet.sendTransaction({ data, gas, nonce, maxFeePerGas: price * 2n + 1n, maxPriorityFeePerGas: 0n });
  state.pending[name].tx = tx; save();
  console.log(`  ${name}: sent ${tx}`);
  const rc = await pub.waitForTransactionReceipt({ hash: tx, timeout: 180_000 });
  if (rc.status !== 'success') die(`${name} reverted: ${tx}`);
  return done(name, getAddress(rc.contractAddress), tx, rc);
}
function done(name, address, tx, rc) {
  state.txs[name] = tx; if (rc) { state.gasUsed[name] = rc.gasUsed.toString(); if (name === 'factory') state.factoryBlock = rc.blockNumber.toString(); }
  delete state.pending[name]; state[name] = address; save();
  console.log(`  ${name}: ${address}${rc ? `  gas ${rc.gasUsed}  ${formatEther(rc.gasUsed * rc.effectiveGasPrice)} ETH` : ''}`);
  return address;
}
function save() { mkdirSync(SECRETS, { recursive: true, mode: 0o700 }); writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }

step(`3. deploy (state in ${stateFile.replace(ROOT + '/', '')})`);
await deploy();
if (!state.factoryBlock && state.txs?.factory) { const rc = await pub.getTransactionReceipt({ hash: state.txs.factory }); state.factoryBlock = rc.blockNumber.toString(); save(); }
if (DRY) { step('3. deploy again, to show the resume: '); await deploy(); }

// ---------- 4. read everything back ----------
step('4. verify from the chain');
const F = (fn, args = []) => pub.readContract({ address: state.factory, abi: Factory.abi, functionName: fn, args });
const T = (fn) => pub.readContract({ address: state.treasury, abi: Treasury.abi, functionName: fn });
const checks = [
  ['factory.owner', getAddress(await F('owner')), OWNER], ['factory.pendingOwner', getAddress(await F('pendingOwner')), zeroAddress],
  ['factory.operator', getAddress(await F('operator')), OPERATOR], ['factory.guardian', getAddress(await F('guardian')), GUARDIAN],
  ['factory.treasury', getAddress(await F('treasury')), state.treasury], ['factory.usdg', getAddress(await F('usdg')), getAddress(USDG)],
  ['factory.identityRegistry', getAddress(await F('identityRegistry')), getAddress(IDENTITY_REGISTRY)], ['factory.markupBps', Number(await F('markupBps')), MARKUP_BPS],
  ['factory.operatorPaused', await F('operatorPaused'), false], ['factory.agentCount', Number(await F('agentCount')), Number(await F('agentCount'))],
  ['treasury.owner', getAddress(await T('owner')), OWNER], ['treasury.pendingOwner', getAddress(await T('pendingOwner')), zeroAddress],
];
const impl = getAddress(await F('walletImplementation'));
checks.push(['treasury code = build', await sameCode(state.treasury, Treasury), true], ['factory code = build', await sameCode(state.factory, Factory), true], ['wallet implementation code = build', await sameCode(impl, Wallet), true]);
let bad = 0;
for (const [n, got, want] of checks) { const ok = String(got) === String(want); if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n.padEnd(34)} ${got}${ok ? '' : `  (expected ${want})`}`); }
if (bad) die(`${bad} setting(s) differ from what was intended. Do not switch payments on.`);
console.log(`  creature wallets: ${Number(await F('agentCount'))} made. None are made here: the server makes each on that creature's first paid hire (WALLETS_PER_DAY a day).`);

// ---------- 6. Railway ----------
const vars = { CHAIN_ID: String(CHAIN_ID), USDG: getAddress(USDG), FACTORY: state.factory, FACTORY_BLOCK: String(state.factoryBlock), TREASURY: state.treasury, MARKUP_BPS: String(MARKUP_BPS), WALLETS_PER_DAY: process.env.WALLETS_PER_DAY || '20' };
step('6. Railway variables');
for (const [k, v] of Object.entries(vars)) console.log(`  ${k}=${v}`);
console.log('  PAYMENTS=on            (last, once OPERATOR_KEY is set)');
console.log(`  OPERATOR_KEY           the secret of ${DRY ? realOperator.address : OPERATOR}: the owner sets it himself, from the file, without showing it:`);
console.log("      sed -n 's/^OPERATOR_KEY=//p' .secrets/operator.env | npx -y @railway/cli variable set OPERATOR_KEY --stdin --skip-deploys");
if (DRY) console.log('  (dry run: nothing is set on Railway; these addresses are on the fork only)');
if (APPLY) await applyRailway();
else if (!DRY) console.log('  To set them: node scripts/activate.mjs --apply   (it deploys nothing more; it sets the lines above, PAYMENTS=on last)');

// ---------- 7. dry run: three paid hires against a local server ----------
if (DRY && !flag('--skip-hires')) {
  step('7. three paid hires on the fork (contracts/scripts/fork-paid-hires.mjs)');
  const r = spawnSync(process.execPath, [join(ROOT, 'contracts', 'scripts', 'fork-paid-hires.mjs'), '--rpc', rpcUrl, '--deployment', stateFile], {
    stdio: 'inherit', cwd: ROOT, env: { ...process.env, FORK_OPERATOR_KEY: throwawayKey } });
  if (r.status !== 0) die('the paid-hire rehearsal failed');
}
step(DRY ? 'dry run complete. Nothing was sent to Robinhood Chain and nothing was set on Railway.' : 'activation complete.');
process.exit(0);

// ---------- helpers ----------
async function applyRailway() {
  const rw = (args, input) => spawnSync('npx', ['-y', '@railway/cli', ...args], { cwd: ROOT, input, encoding: 'utf8', stdio: [input == null ? 'inherit' : 'pipe', 'pipe', 'pipe'] });
  for (const [k, v] of Object.entries(vars)) {
    const r = rw(['variable', 'set', `${k}=${v}`, '--skip-deploys']);
    if (r.status !== 0) die(`railway refused ${k}: ${(r.stderr || '').trim().slice(0, 200)}`);
    console.log(`  set ${k}`);
  }
  // OPERATOR_KEY must already be there, and be the operator's: checked in this process, never printed
  const l = rw(['variable', 'list', '--json']);
  let have = null; try { have = JSON.parse(l.stdout || '{}').OPERATOR_KEY || null; } catch {}
  // a value piped in with --stdin may keep the file's line break; the server trims it, so this check does too
  let ok = false; try { have = have == null ? null : String(have).trim(); ok = !!have && accounts.privateKeyToAccount(have.startsWith('0x') ? have : '0x' + have).address === OPERATOR; } catch {}
  have = null;
  if (!ok) { console.log('  OPERATOR_KEY is not on Railway yet (or is not the operator\'s). Set it with the command above, then run --apply again. PAYMENTS stays off.'); return; }
  const r = rw(['variable', 'set', 'PAYMENTS=on']);
  if (r.status !== 0) die(`railway refused PAYMENTS: ${(r.stderr || '').trim().slice(0, 200)}`);
  console.log('  set PAYMENTS=on (Railway redeploys the service now)');
}
async function sameCode(address, a) {
  const code = ((await pub.getCode({ address })) || '0x').slice(2).toLowerCase();
  let want = a.deployed.replace(/^0x/, '').toLowerCase();
  if (code.length !== want.length) return false;
  let got = code;
  for (const refs of Object.values(a.immutables)) for (const { start, length } of refs) { // immutables are written at deploy: mask them on both sides
    got = got.slice(0, start * 2) + '0'.repeat(length * 2) + got.slice((start + length) * 2);
    want = want.slice(0, start * 2) + '0'.repeat(length * 2) + want.slice((start + length) * 2);
  }
  return keccak256('0x' + got) === keccak256('0x' + want);
}
async function rawRpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
function step(s) { console.log(`\n== ${s}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function addr(v, name) { if (!isAddress(String(v).trim(), { strict: false })) die(`${name} is not an address`); return getAddress(String(v).trim()); }
function die(msg) { console.error(`\nactivate: ${msg}`); try { anvil?.kill(); } catch {} process.exit(1); }

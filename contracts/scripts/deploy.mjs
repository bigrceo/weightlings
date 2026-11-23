#!/usr/bin/env node
// Deploys the Weightlings payment contracts on Robinhood Chain (4663):
//   1. WeightlingsTreasury(owner)            (skipped when TREASURY is given)
//   2. WeightlingsFactory(USDG, owner, operator, treasury, markupBps, ERC-8004 registry, guardian)
//   3. optionally one CreatureWallet through factory.createAgent (FIRST_WALLET_OWNER)
//   4. optionally the first network cost (PUBLISH_NETWORK_COST), which needs no wait
//
// Run by a human, from ~/weightlings/contracts, after `forge build`:
//   DEPLOYER_KEY=0x... OPERATOR=0x<address of the server's OPERATOR_KEY> node scripts/deploy.mjs
//   node scripts/deploy.mjs --dry-run        (no key needed: gas and ETH estimate only, sends nothing)
//
// Env (all optional except DEPLOYER_KEY and OPERATOR for a real run):
//   RPC_URL               default https://rpc.mainnet.chain.robinhood.com
//   OWNER                 owner of treasury + factory; default = deployer address
//   OPERATOR              the address the server meters runs with (its OPERATOR_KEY); required
//   GUARDIAN              may pause every meter at once; default = OWNER
//   MARKUP_BPS            fee on a run's cost, kept for life by each wallet; default 2000 (20%), max 5000
//   TREASURY              reuse an existing treasury contract instead of deploying one
//   USDG, IDENTITY_REGISTRY  override the Robinhood Chain addresses (do not, on mainnet)
//   FIRST_WALLET_OWNER    also create one wallet owned by this address
//   PER_RUN_CAP, PER_DAY_CAP  its caps in USDG units (6 decimals); default 250000 / 12500000
//   SPEC_HASH, AGENT_URI  its spec hash and ERC-8004 card URI; empty URI = no identity
//   PUBLISH_NETWORK_COST  e.g. 25000: publish the flat per-run network cost (first publication is immediate)
//   VIEM                  path to viem's ESM entry if the defaults below do not exist
//
// The key is never printed. Nothing is sent until you confirm (or pass --yes).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const YES = args.has('--yes');

const VIEM_CANDIDATES = [
  process.env.VIEM,
  '/Users/rayane/optima-clone/node_modules/viem/_esm/index.js',
  '/Users/rayane/swarm/node_modules/viem/_esm/index.js',
].filter(Boolean);
const viemPath = VIEM_CANDIDATES.find((p) => existsSync(p));
if (!viemPath) die('viem not found. Set VIEM=/path/to/node_modules/viem/_esm/index.js');
const viem = await import(pathToFileURL(viemPath).href);
const accounts = await import(pathToFileURL(join(dirname(viemPath), 'accounts', 'index.js')).href);
const { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress, formatEther, formatGwei,
  parseEventLogs, encodeDeployData, encodeFunctionData, zeroAddress, zeroHash, keccak256, toHex } = viem;

const CHAIN_ID = 4663;
const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const USDG = addr(process.env.USDG || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'USDG');
const IDENTITY_REGISTRY = addr(process.env.IDENTITY_REGISTRY || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', 'IDENTITY_REGISTRY');
const MARKUP_BPS = num(process.env.MARKUP_BPS ?? '2000', 'MARKUP_BPS');
if (MARKUP_BPS > 5000) die('MARKUP_BPS is above the contract maximum of 5000');

const chain = defineChain({
  id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 60_000 }) });

const art = (name) => {
  const p = join(ROOT, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) die(`missing ${p}. Run \`forge build\` in ${ROOT} first.`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
};
const Treasury = art('WeightlingsTreasury');
const Factory = art('WeightlingsFactory');

const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) die(`RPC ${RPC_URL} is chain ${chainId}, expected ${CHAIN_ID}`);
for (const [n, a] of [['USDG', USDG], ['IDENTITY_REGISTRY', IDENTITY_REGISTRY]]) {
  if (((await pub.getCode({ address: a })) || '0x') === '0x') die(`${n} ${a} has no code on this chain`);
}
const gasPrice = await pub.getGasPrice();

// ---------- dry run: estimate only ----------
if (DRY) {
  const from = process.env.OWNER ? addr(process.env.OWNER, 'OWNER') : '0x000000000000000000000000000000000000dEaD';
  const operator = process.env.OPERATOR ? addr(process.env.OPERATOR, 'OPERATOR') : from;
  const tData = encodeDeployData({ abi: Treasury.abi, bytecode: Treasury.bytecode, args: [from] });
  const fData = encodeDeployData({ abi: Factory.abi, bytecode: Factory.bytecode,
    args: [USDG, from, operator, from /* any non-zero treasury */, MARKUP_BPS, IDENTITY_REGISTRY, from] });
  const gT = await pub.estimateGas({ account: from, data: tData });
  const gF = await pub.estimateGas({ account: from, data: fData });
  // createAgent cannot be estimated before the factory exists. Its L2 execution gas was measured on a
  // local fork of Robinhood Chain (see README); its L1 data share comes from Arbitrum's NodeInterface.
  const CREATE_AGENT_EXEC = BigInt(process.env.CREATE_AGENT_GAS || 560_000);
  const cData = encodeFunctionData({ abi: Factory.abi, functionName: 'createAgent',
    args: [from, 250_000n, 12_500_000n, keccak256(toHex('spec')), 'https://weightlings.vercel.app/card/0x' + '0'.repeat(64) + '.json', from, MARKUP_BPS] });
  const l1 = await l1Gas(from, cData);
  const gC = CREATE_AGENT_EXEC + l1;
  const line = (n, g) => console.log(`${n.padEnd(34)} ${String(g).padStart(9)} gas  ${formatEther(g * gasPrice)} ETH`);
  console.log(`gas price ${formatGwei(gasPrice)} gwei (eth_gasPrice on ${RPC_URL})`);
  line('WeightlingsTreasury deploy', gT);
  line('WeightlingsFactory deploy (+impl)', gF);
  line('createAgent with identity (est.)', gC);
  line('total', gT + gF + gC);
  console.log('Nothing was sent.');
  process.exit(0);
}

// ---------- real run ----------
const rawKey = (process.env.DEPLOYER_KEY || '').trim();
if (!rawKey) die('DEPLOYER_KEY is not set (or use --dry-run)');
const hexKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(hexKey)) die('DEPLOYER_KEY must be 32 bytes of hex');
let account;
try { account = accounts.privateKeyToAccount(hexKey); } catch { die('DEPLOYER_KEY is not a valid private key'); }
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL, { timeout: 60_000 }) });

const OWNER = process.env.OWNER ? addr(process.env.OWNER, 'OWNER') : account.address;
if (!process.env.OPERATOR) die('OPERATOR is not set: give the address of the key the server meters runs with');
const OPERATOR = addr(process.env.OPERATOR, 'OPERATOR');
const GUARDIAN = process.env.GUARDIAN ? addr(process.env.GUARDIAN, 'GUARDIAN') : OWNER;
let TREASURY = process.env.TREASURY ? addr(process.env.TREASURY, 'TREASURY') : null;
const FIRST = process.env.FIRST_WALLET_OWNER ? addr(process.env.FIRST_WALLET_OWNER, 'FIRST_WALLET_OWNER') : null;
const NET_COST = process.env.PUBLISH_NETWORK_COST ? BigInt(num(process.env.PUBLISH_NETWORK_COST, 'PUBLISH_NETWORK_COST')) : null;
if (TREASURY && ((await pub.getCode({ address: TREASURY })) || '0x') === '0x') die('TREASURY has no code: it must be a contract');
if (OWNER !== account.address && NET_COST != null) die('PUBLISH_NETWORK_COST needs OWNER = deployer (only the owner may publish)');

const balance = await pub.getBalance({ address: account.address });
console.log(`chain       ${chainId} via ${RPC_URL}`);
console.log(`deployer    ${account.address}  balance ${formatEther(balance)} ETH`);
console.log(`owner       ${OWNER}`);
console.log(`operator    ${OPERATOR}`);
console.log(`guardian    ${GUARDIAN}`);
console.log(`treasury    ${TREASURY || '(new WeightlingsTreasury owned by owner)'}`);
console.log(`markup      ${MARKUP_BPS} bps (each wallet keeps it for life)`);
console.log(`usdg        ${USDG}`);
console.log(`identity    ${IDENTITY_REGISTRY} (ERC-8004)`);
console.log(`first wallet ${FIRST || '(none)'}`);
console.log(`gas price   ${formatGwei(gasPrice)} gwei`);
if (balance === 0n) die('the deployer has no ETH for gas');
if (!YES) {
  if (!process.stdin.isTTY) die('not a terminal: pass --yes to confirm');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Type "deploy" to send these transactions on mainnet: ')).trim();
  rl.close();
  if (a !== 'deploy') die('cancelled, nothing sent');
}

const record = { chainId, rpc: RPC_URL, at: new Date().toISOString(), deployer: account.address, owner: OWNER,
  operator: OPERATOR, guardian: GUARDIAN, markupBps: MARKUP_BPS, usdg: USDG, identityRegistry: IDENTITY_REGISTRY, txs: {}, gasUsed: {} };
let totalWei = 0n;
const note = (name, r) => {
  const wei = r.gasUsed * r.effectiveGasPrice;
  totalWei += wei;
  record.txs[name] = r.transactionHash;
  record.gasUsed[name] = r.gasUsed.toString();
  console.log(`  ${name}: ${r.transactionHash}  gas ${r.gasUsed}  ${formatEther(wei)} ETH`);
};
const mine = async (name, hash) => {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== 'success') die(`${name} reverted: ${hash}`);
  note(name, r);
  return r;
};

if (!TREASURY) {
  const hash = await wallet.deployContract({ abi: Treasury.abi, bytecode: Treasury.bytecode, args: [OWNER] });
  const r = await mine('treasury', hash);
  TREASURY = getAddress(r.contractAddress);
}
const fHash = await wallet.deployContract({ abi: Factory.abi, bytecode: Factory.bytecode,
  args: [USDG, OWNER, OPERATOR, TREASURY, MARKUP_BPS, IDENTITY_REGISTRY, GUARDIAN] });
const fr = await mine('factory', fHash);
const FACTORY = getAddress(fr.contractAddress);
const read = (fn, a = []) => pub.readContract({ address: FACTORY, abi: Factory.abi, functionName: fn, args: a });
const IMPL = await read('walletImplementation');

// Read back what the chain now says, so a typo cannot pass unnoticed.
const check = { owner: OWNER, operator: OPERATOR, treasury: TREASURY, guardian: GUARDIAN, usdg: USDG, identityRegistry: IDENTITY_REGISTRY };
for (const [fn, want] of Object.entries(check)) {
  const got = getAddress(await read(fn));
  if (got !== want) die(`factory.${fn}() is ${got}, expected ${want}`);
}
if (Number(await read('markupBps')) !== MARKUP_BPS) die('factory.markupBps() mismatch');

if (NET_COST != null) {
  await mine('proposeNetworkCost', await wallet.writeContract({ address: FACTORY, abi: Factory.abi, functionName: 'proposeNetworkCost', args: [NET_COST] }));
  await mine('acceptNetworkCost', await wallet.writeContract({ address: FACTORY, abi: Factory.abi, functionName: 'acceptNetworkCost' }));
}

let first = null;
if (FIRST) {
  const perRun = BigInt(process.env.PER_RUN_CAP || 250_000);
  const perDay = BigInt(process.env.PER_DAY_CAP || 12_500_000);
  const spec = process.env.SPEC_HASH || zeroHash;
  const uri = process.env.AGENT_URI || '';
  const h = await wallet.writeContract({ address: FACTORY, abi: Factory.abi, functionName: 'createAgent',
    args: [FIRST, perRun, perDay, spec, uri, TREASURY, MARKUP_BPS] });
  const r = await mine('createAgent', h);
  const logs = parseEventLogs({ abi: Factory.abi, logs: r.logs });
  const created = logs.find((l) => l.eventName === 'AgentCreated');
  const ident = logs.find((l) => l.eventName === 'IdentityRegistered');
  first = { id: created.args.id.toString(), wallet: getAddress(created.args.wallet), owner: FIRST,
    identityId: ident ? ident.args.identityId.toString() : null };
}

Object.assign(record, { treasury: TREASURY, factory: FACTORY, walletImplementation: IMPL, factoryBlock: fr.blockNumber.toString(),
  firstWallet: first, totalEth: formatEther(totalWei) });
mkdirSync(join(ROOT, 'deployments'), { recursive: true });
const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(RPC_URL);
record.localFork = local;
const out = join(ROOT, 'deployments', `${local ? 'local-fork-' : ''}${chainId}-${record.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(record, null, 2) + '\n');

console.log(`\nDeployed. Total ${formatEther(totalWei)} ETH. Record: ${out}`);
console.log(`treasury               ${TREASURY}`);
console.log(`factory                ${FACTORY}`);
console.log(`wallet implementation  ${IMPL}`);
if (first) console.log(`first wallet           #${first.id} ${first.wallet}${first.identityId ? `  ERC-8004 id ${first.identityId}` : ''}`);
console.log('\n# paste into the server env (OPERATOR_KEY is the secret for ' + OPERATOR + '; set it separately)');
console.log(`CHAIN_ID=${chainId}`);
console.log(`USDG=${USDG}`);
console.log(`IDENTITY_REGISTRY=${IDENTITY_REGISTRY}`);
console.log(`FACTORY=${FACTORY}`);
console.log(`FACTORY_BLOCK=${fr.blockNumber}`);
console.log(`TREASURY=${TREASURY}`);
console.log(`MARKUP_BPS=${MARKUP_BPS}`);
if (first) console.log(`FIRST_WALLET=${first.wallet}`);
console.log('# PAYMENTS=on   <- only once the server side has been tested against these addresses');

// ---------- helpers ----------
function die(msg) { console.error(`deploy: ${msg}`); process.exit(1); }
function addr(v, name) { if (!isAddress(String(v).trim(), { strict: false })) die(`${name} is not an address`); const a = getAddress(String(v).trim()); if (a === zeroAddress) die(`${name} is the zero address`); return a; }
function num(v, name) { const n = Number(v); if (!Number.isInteger(n) || n < 0) die(`${name} must be a whole number`); return n; }

// Arbitrum NodeInterface (0xc8): the L1 data share of a transaction's gas, which local forks do not charge.
async function l1Gas(from, data) {
  const NI = '0x00000000000000000000000000000000000000C8';
  const abi = [{ type: 'function', name: 'gasEstimateL1Component', stateMutability: 'payable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'contractCreation', type: 'bool' }, { name: 'data', type: 'bytes' }],
    outputs: [{ name: 'gasEstimateForL1', type: 'uint64' }, { name: 'baseFee', type: 'uint256' }, { name: 'l1BaseFeeEstimate', type: 'uint256' }] }];
  try {
    const { result } = await pub.simulateContract({ address: NI, abi, functionName: 'gasEstimateL1Component', args: [from, false, data], account: from });
    return BigInt(result[0]);
  } catch { return 0n; }
}

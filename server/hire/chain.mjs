// The operator's line to Robinhood Chain for paid hires: reads (single and batched), and transactions signed in this process
// with OPERATOR_KEY (EIP-1559, RFC 6979 signatures from evm.mjs, no dependencies). Every transaction goes through one queue,
// so nonces never collide. The key is read from the environment only, and is never logged, returned or written anywhere.
//
// Env: OPERATOR_KEY (0x + 64 hex), PAY_RPC_URL (default: HIRE_RPC_URL, else the first of RPC_URLS, else the public RPC),
//      CHAIN_ID (default 4663).
import { addressOfKey, signTx1559, parseSignature, encodeArgs, decodeArgs, keccakHex, isAddress, checksum } from './evm.mjs';

export const CHAIN_ID = () => Number(process.env.CHAIN_ID || 4663);
export const rpcUrl = () => (process.env.PAY_RPC_URL || process.env.HIRE_RPC_URL || (process.env.RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com').split(',')[0]).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ChainError extends Error { constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); } }

export async function rpc(method, params = [], tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) throw new Error('the node answered ' + r.status);
      const j = await r.json();
      if (j.error) throw new ChainError(j.error.message || 'rpc error', { rpc: true, data: revertData(j.error) });
      return j.result;
    } catch (e) { err = e; if (e.rpc) throw e; await sleep(300 * 2 ** i); }
  }
  throw err;
}
const revertData = (e) => { const d = e?.data?.data ?? e?.data; return typeof d === 'string' && d.startsWith('0x') ? d : null; };

/** Several calls in one JSON-RPC batch (chunks of 40). Each result is the value or an Error. Falls back to one by one. */
export async function batch(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 40) {
    const part = calls.slice(i, i + 40);
    try {
      const r = await fetch(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part.map((c, k) => ({ jsonrpc: '2.0', id: k, method: c.method, params: c.params }))), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error('no batch');
      const byId = new Map(j.map((x) => [x.id, x]));
      part.forEach((_, k) => { const x = byId.get(k); out.push(!x ? new Error('missing') : x.error ? new ChainError(x.error.message, { data: revertData(x.error) }) : x.result); });
    } catch {
      for (const c of part) out.push(await rpc(c.method, c.params).catch((e) => e));
    }
  }
  return out;
}

const sigs = new Map();
const S = (sig) => { let s = sigs.get(sig); if (!s) { s = parseSignature(sig); sigs.set(sig, s); } return s; };
export const calldata = (sig, args = []) => { const s = S(sig); return s.selector + encodeArgs(s.inputs, args); };
export const decode = (sig, hex) => decodeArgs(S(sig).outputs, hex);
export const callReq = (to, sig, args = [], from) => ({ method: 'eth_call', params: [{ to, data: calldata(sig, args), ...(from ? { from } : {}) }, 'latest'] });
export async function read(to, sig, args = []) { return decode(sig, await rpc('eth_call', callReq(to, sig, args).params)); }

// ---------- custom errors of the payment contracts, so a refusal can be said in words ----------
const ERRORS = ['NotOwner', 'NotOperator', 'OperatorPaused', 'Paused', 'RunAlreadyCharged', 'OverRunCap', 'OverDayCap', 'ZeroAddress', 'ZeroCost', 'TransferFailed',
  'TermsChanged', 'NotPaid', 'NotOpen', 'HoldStands', 'Underpaid', 'NotAgent', 'NotPayable', 'NotAccepted', 'HoldsOpen', 'LienOwed', 'MarkupTooHigh'];
const BY_SELECTOR = new Map(ERRORS.map((n) => [keccakHex(n + '()').slice(0, 10), n]));
export const errorName = (data) => (data && BY_SELECTOR.get(String(data).slice(0, 10).toLowerCase())) || null;

// ---------- the operator ----------
let OP = null;
/** { address } of OPERATOR_KEY, or null when it is missing or malformed. */
export function operator() {
  const k = String(process.env.OPERATOR_KEY || '').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) return null;
  if (!OP || OP.k !== k) { try { OP = { k, address: addressOfKey(k) }; } catch { return null; } }
  return { address: OP.address };
}
const keyOf = () => { operator(); if (!OP) throw new ChainError('OPERATOR_KEY is not set'); return OP.k.startsWith('0x') ? OP.k : '0x' + OP.k; };

/** Simulate a call from the operator. Returns { ok: true } or { ok: false, error: name | message, data }. */
export async function simulate(to, data) {
  const op = operator(); if (!op) return { ok: false, error: 'no operator key' };
  try { await rpc('eth_call', [{ from: op.address, to, data }, 'latest']); return { ok: true }; }
  catch (e) { return { ok: false, error: errorName(e.data) || e.message, data: e.data || null }; }
}

let queue = Promise.resolve();
let chainChecked = false;
/** Send one transaction from the operator and wait for it to be mined. Resolves { hash, receipt, gasUsed, block, logs }.
 *  Rejects with { stage: 'simulate' | 'send' | 'wait' | 'reverted', hash? }: 'simulate' and 'send' mean nothing reached the chain. */
export function send({ to, data, label = 'tx', waitMs = 90_000 }) {
  const job = queue.then(() => sendNow({ to, data, label, waitMs }));
  queue = job.catch(() => {});
  return job;
}
async function sendNow({ to, data, label, waitMs }) {
  const op = operator(); if (!op) throw new ChainError('OPERATOR_KEY is not set', { stage: 'simulate' });
  if (!chainChecked) { const id = Number(await rpc('eth_chainId')); if (id !== CHAIN_ID()) throw new ChainError(`the payment RPC is chain ${id}, expected ${CHAIN_ID()}`, { stage: 'simulate' }); chainChecked = true; }
  let gas;
  try { gas = BigInt(await rpc('eth_estimateGas', [{ from: op.address, to, data }])); }
  catch (e) { throw new ChainError(`${label} would revert: ${errorName(e.data) || e.message}`, { stage: 'simulate', reason: errorName(e.data) || e.message }); }
  const [nonceHex, priceHex] = await Promise.all([rpc('eth_getTransactionCount', [op.address, 'pending']), rpc('eth_gasPrice')]);
  const price = BigInt(priceHex);
  const tx = { chainId: CHAIN_ID(), nonce: BigInt(nonceHex), maxPriorityFeePerGas: 0n, maxFeePerGas: price * 2n + 1n, gas: (gas * 13n) / 10n + 10_000n, to, value: 0n, data };
  const { raw, hash } = signTx1559(tx, keyOf());
  try { await rpc('eth_sendRawTransaction', [raw], 1); }
  catch (e) {
    // Only a JSON-RPC answer refusing it means it was not taken. The node may already know it (a retry after a lost answer),
    // and a timeout or a dropped connection says nothing: the node may have it. Both are in flight: wait for it below, and if
    // it is not mined in time this rejects with stage 'wait' and its hash, so the caller never says "nothing was charged".
    if (e.rpc && !/already known|known transaction/i.test(e.message)) throw new ChainError(`${label} was not accepted by the node: ${e.message}`, { stage: 'send' });
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const rc = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) {
      const out = { hash, receipt: rc, gasUsed: BigInt(rc.gasUsed), block: Number(rc.blockNumber), logs: rc.logs || [], feeWei: BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || price) };
      if (rc.status !== '0x1') throw new ChainError(`${label} reverted on chain`, { stage: 'reverted', hash });
      return out;
    }
    await sleep(400);
  }
  throw new ChainError(`${label} was sent but not mined within ${Math.round(waitMs / 1000)} s`, { stage: 'wait', hash });
}

export async function ethBalance(addr) { return BigInt(await rpc('eth_getBalance', [addr, 'latest'])); }
export async function gasPrice() { return BigInt(await rpc('eth_gasPrice')); }
export const topicOf = (eventSig) => keccakHex(eventSig);
export const addrTopic = (t) => checksum('0x' + String(t).slice(26));
export { isAddress, checksum };

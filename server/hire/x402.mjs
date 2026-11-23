// Paid hires in USDG on Robinhood Chain, behind PAYMENTS=on (off at launch: hires are free and the operator pays the model,
// bounded by HIRE_DAILY_USD). Two ways to pay, both verified on chain before any work starts:
//
//  1. x402 "exact" (EIP-3009 TransferWithAuthorization). Without a payment, POST /api/hire answers 402 with the terms
//     (x402 v1 body, v2 in the `payment-required` header). The client signs the typed data and sends it back in X-PAYMENT
//     (or PAYMENT-SIGNATURE). We check the signature (EIP-712 recovery), the amount, the recipient, the time window, that the
//     nonce is unused on the USDG contract and that the payer holds the funds; then a facilitator (FACILITATOR_URL) settles it.
//  2. Direct transfer (no facilitator, no operator gas): the client sends USDG.transfer(PAY_TO, price) itself with 32 extra
//     bytes of calldata binding the transfer to this exact hire (sha256 of {creatureId, task}), then sends the tx hash in
//     X-PAYMENT-TX. We read the transaction and its receipt from the chain; each transaction pays for one hire only.
//
// Env: PAYMENTS=on, USDG (token address), PAY_TO (receiving address), optional FACILITATOR_URL, USDG_NAME / USDG_VERSION
// (EIP-712 domain, default "Global Dollar" / "1"), HIRE_PRICE_<TIER> in USDG base units (6 decimals).
import { createHash } from 'node:crypto';
import { canonical } from '../../public/cull.v2.js';
import { isAddress, checksum, transferAuthDigest, recoverAddress, parseSignature, encodeArgs, decodeArgs, TRANSFER_TOPIC } from './evm.mjs';
import { chainRpc } from './tools.mjs';
import { q } from './store.mjs';

const CHAIN_ID = 4663, NETWORK = 'eip155:4663';
export const on = () => String(process.env.PAYMENTS || '').toLowerCase() === 'on';
const env = () => ({ usdg: process.env.USDG || '', payTo: process.env.PAY_TO || '', facilitator: (process.env.FACILITATOR_URL || '').replace(/\/$/, ''), name: process.env.USDG_NAME || 'Global Dollar', version: process.env.USDG_VERSION || '1' });
export const configured = () => { const e = env(); return isAddress(e.usdg) && isAddress(e.payTo); };
// USDG base units (6 decimals); every price is at least the hire's own cost cap, so a paid hire never runs at a loss
const DEFAULT_PRICE = { common: 50000, uncommon: 60000, rare: 80000, epic: 250000, legendary: 300000 };
export const priceOf = (tier) => String(Math.max(1, Math.floor(Number(process.env['HIRE_PRICE_' + tier.toUpperCase()] || DEFAULT_PRICE[tier] || 50000))));
const usd = (units) => (Number(units) / 1e6).toFixed(2);
/** 32 bytes that tie a direct transfer to one hire: sha256(canonical({creatureId, task})) */
export const bindingOf = (creatureId, task) => '0x' + createHash('sha256').update(canonical({ creatureId, task })).digest('hex');

export function terms({ creatureId, task, tier, resource }) {
  const e = env(), price = priceOf(tier), binding = bindingOf(creatureId, task);
  const accepts = [{ scheme: 'exact', network: NETWORK, maxAmountRequired: price, resource, description: `Hire creature #${creatureId} for one task`, mimeType: 'application/json', payTo: checksum(e.payTo), maxTimeoutSeconds: 600, asset: checksum(e.usdg), extra: { name: e.name, version: e.version } }];
  const transfer = parseSignature('function transfer(address,uint256) returns (bool)');
  const body = {
    x402Version: 1, error: 'Payment required', accepts,
    price: { units: price, usdg: usd(price) },
    direct: { note: 'Or send this transaction yourself and pass its hash in the X-PAYMENT-TX header with the same body.', to: checksum(e.usdg), data: transfer.selector + encodeArgs(transfer.inputs, [e.payTo, price]) + binding.slice(2), binding },
    settlement: e.facilitator ? 'x402 payments are settled by the facilitator; direct transfers are read from the chain' : 'x402 settlement is not configured on this server yet; use the direct transfer',
  };
  const header = Buffer.from(JSON.stringify({ x402Version: 2, error: 'Payment required', resource: { url: resource, description: accepts[0].description, mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: NETWORK, amount: price, asset: accepts[0].asset, payTo: accepts[0].payTo, maxTimeoutSeconds: 600, extra: accepts[0].extra }] })).toString('base64');
  return { status: 402, body, headers: { 'payment-required': header } };
}

const fail = (status, error) => ({ ok: false, status, error });
const decode = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64').toString('utf8')); } catch { try { return JSON.parse(String(s)); } catch { return null; } } };

/** Verify (and settle) a payment for one hire. Returns { ok, paidBy, ref } or { ok:false, status, error }. */
export async function pay(req, { creatureId, task, tier, resource, hireIdHint }) {
  const e = env(), price = priceOf(tier);
  const txh = req.headers['x-payment-tx'];
  if (txh) return direct(String(txh).trim(), e, price, bindingOf(creatureId, task), hireIdHint);
  const raw = req.headers['x-payment'] || req.headers['payment-signature'];
  if (!raw) return null; // no payment: caller answers 402
  const p = decode(raw);
  const pl = p?.payload || p, auth = pl?.authorization, sig = pl?.signature;
  if (!auth || !sig) return fail(400, 'The payment must carry payload.authorization and payload.signature.');
  for (const k of ['from', 'to']) if (!isAddress(auth[k])) return fail(400, `authorization.${k} is not an address.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce || '')) return fail(400, 'authorization.nonce must be 32 bytes.');
  if (auth.to.toLowerCase() !== e.payTo.toLowerCase()) return fail(400, 'The payment is not addressed to this site.');
  if (String(auth.value) !== price) return fail(400, `The price of this hire is exactly ${price} USDG units.`);
  const now = Math.floor(Date.now() / 1000), va = Number(auth.validAfter), vb = Number(auth.validBefore);
  if (!(va <= now) || !(vb >= now + 45) || vb > now + 900) return fail(400, 'The authorization must be valid now, for at least 45 more seconds and at most 15 minutes.');
  let signer;
  try { signer = recoverAddress(transferAuthDigest({ name: e.name, version: e.version, chainId: CHAIN_ID, verifyingContract: e.usdg }, auth), sig); } catch (x) { return fail(400, 'The signature is not valid: ' + x.message); }
  if (signer.toLowerCase() !== auth.from.toLowerCase()) return fail(400, 'The signature was not made by authorization.from.');
  try {
    const st = parseSignature('function authorizationState(address,bytes32) view returns (bool)'), bal = parseSignature('function balanceOf(address) view returns (uint256)');
    const [used, funds] = await Promise.all([
      chainRpc('eth_call', [{ to: e.usdg, data: st.selector + encodeArgs(st.inputs, [auth.from, auth.nonce]) }, 'latest']).then((h) => decodeArgs(st.outputs, h)[0]),
      chainRpc('eth_call', [{ to: e.usdg, data: bal.selector + encodeArgs(bal.inputs, [auth.from]) }, 'latest']).then((h) => BigInt(decodeArgs(bal.outputs, h)[0])),
    ]);
    if (used) return fail(409, 'This authorization was already used. Sign a new one.');
    if (funds < BigInt(price)) return fail(402, 'The paying address does not hold enough USDG.');
  } catch { return fail(503, 'Robinhood Chain could not be read to check the payment. Nothing was charged; try again.'); }
  const ref = 'x402:' + auth.from.toLowerCase() + ':' + auth.nonce.toLowerCase();
  if (!e.facilitator) return fail(503, 'This server cannot settle x402 payments yet (no facilitator). Nothing was charged. Use the direct transfer in the 402 terms.');
  if (q.payUse.run(ref, hireIdHint, Date.now(), auth.from.toLowerCase(), price, 'x402').changes !== 1) return fail(409, 'This payment was already used for a hire.');
  const requirements = { scheme: 'exact', network: NETWORK, maxAmountRequired: price, resource, payTo: e.payTo, asset: e.usdg, maxTimeoutSeconds: 600, extra: { name: e.name, version: e.version } };
  try {
    const r = await fetch(e.facilitator + '/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x402Version: 1, paymentPayload: p, paymentRequirements: requirements }), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return fail(402, 'The payment could not be settled: ' + String(j.errorReason || j.error || r.status).slice(0, 120));
    return { ok: true, ref, paidBy: { payer: checksum(auth.from), amount: usd(price) + ' USDG', units: price, network: NETWORK, method: 'x402-exact', tx: j.transaction || null }, responseHeader: Buffer.from(JSON.stringify({ success: true, transaction: j.transaction || null, network: NETWORK, payer: auth.from })).toString('base64') };
  } catch { return fail(502, 'The facilitator did not answer. If the payment settles anyway, contact the site with the nonce.'); }
}

async function direct(hash, e, price, binding, hireIdHint) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return fail(400, 'X-PAYMENT-TX must be a transaction hash.');
  let tx, rc, head;
  try { [tx, rc, head] = await Promise.all([chainRpc('eth_getTransactionByHash', [hash]), chainRpc('eth_getTransactionReceipt', [hash]), chainRpc('eth_blockNumber', [])]); }
  catch { return fail(503, 'Robinhood Chain could not be read to check the payment. Try again.'); }
  if (!tx || !rc) return fail(409, 'That transaction is not on chain yet. Wait for it to be included, then send the hash again.');
  if (rc.status !== '0x1') return fail(400, 'That transaction reverted.');
  if (String(tx.to || '').toLowerCase() !== e.usdg.toLowerCase()) return fail(400, 'That transaction is not a USDG transfer.');
  const transfer = parseSignature('function transfer(address,uint256) returns (bool)');
  const want = (transfer.selector + encodeArgs(transfer.inputs, [e.payTo, price]) + binding.slice(2)).toLowerCase();
  if (String(tx.input || tx.data || '').toLowerCase() !== want) return fail(400, 'That transfer is not bound to this hire: send exactly the `direct.data` of the 402 terms for this creature and task.');
  if (Number(head) - Number(rc.blockNumber) > 864000) return fail(400, 'That transfer is more than a day old.');
  const log = rc.logs.find((l) => l.address.toLowerCase() === e.usdg.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3 && ('0x' + l.topics[1].slice(26)) === tx.from.toLowerCase() && ('0x' + l.topics[2].slice(26)) === e.payTo.toLowerCase() && BigInt(l.data) === BigInt(price));
  if (!log) return fail(400, 'That transaction did not move the price to this site.');
  if (q.payUse.run('tx:' + hash.toLowerCase(), hireIdHint, Date.now(), tx.from.toLowerCase(), price, 'transfer').changes !== 1) return fail(409, 'That transaction already paid for a hire.');
  return { ok: true, ref: 'tx:' + hash.toLowerCase(), paidBy: { payer: checksum(tx.from), amount: usd(price) + ' USDG', units: price, network: NETWORK, method: 'usdg-transfer', tx: hash.toLowerCase(), binding } };
}

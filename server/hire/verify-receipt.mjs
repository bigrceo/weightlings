#!/usr/bin/env node
// Check a Weightlings hire receipt on your own machine. Standalone: Node 20+ only, no project code, no dependencies.
//   node verify-receipt.mjs https://<site>/api/hire/<id>
//   node verify-receipt.mjs <base-url> <id>
//   add --key 0x<64 hex> to require a public key you got somewhere other than this site (the strongest check: then
//   nothing the server serves can make a forged receipt pass)
// It refetches the receipt and the public key, then checks, independently of the server:
//   1. receiptHash == sha256(canonical(receipt))          (canonical = keys sorted, no whitespace, undefined dropped)
//   2. the Ed25519 signature over the 32 bytes of receiptHash, with the key the receipt names (receipt.keyId, signed),
//      taken from the published key list, or with --key
//   3. each step: sha256(outputs[i]) == steps[i].outputHash  (the exact text each tool gave the model)
//   4. systemHash == sha256(system prompt)
//   5. costUsd == the price formula applied to the token usage, with the prices written in the receipt
//   6. whether an OpenTimestamps proof exists (download it at /api/ots/<receiptHash>.ots and check it with the `ots` tool)
//   (an outside agent's hire, kind "agent": 3-5 are replaced by: sha256(request body) == request.hash, the request carries
//    this task and hire id, sha256(response body) == response.hash, costUsd == 0)
//   7. a paid hire: workHash == sha256(canonical(receipt without `settlement`)); with --rpc <Robinhood Chain RPC URL>, also that
//      the pay transaction holds Paid(runId, payer, price) from the creature wallet and the settlement transaction holds
//      Charged(runId, cost, fee, treasury, workHash), both mined and successful
import { createHash, createPublicKey, verify } from 'node:crypto';

function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x === undefined ? null : x)).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  throw new Error('unsupported value');
}
const sha = (s) => '0x' + createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

const argv = process.argv.slice(2), ki = argv.indexOf('--key');
const pinned = ki >= 0 ? String(argv.splice(ki, 2)[1] || '').toLowerCase() : null;
const ri = argv.indexOf('--rpc');
const rpcUrl = ri >= 0 ? String(argv.splice(ri, 2)[1] || '') : null;
if (pinned != null && !/^0x[0-9a-f]{64}$/.test(pinned)) { console.error('--key takes the raw Ed25519 public key as 0x + 64 hex characters'); process.exit(2); }
let [a, b] = argv;
if (!a) { console.error('usage: node verify-receipt.mjs <receipt url> | <base url> <hire id>  [--key 0x<public key hex>] [--rpc <Robinhood Chain RPC URL>]'); process.exit(2); }
const url = b ? `${a.replace(/\/$/, '')}/api/hire/${b}` : a;
const base = new URL(url).origin;
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} answered ${r.status}`); return r.json(); };
const [h, key] = await Promise.all([get(url), get(base + '/api/hire/key')]);
if (!h.receipt) { console.log('This hire has no receipt yet (status: ' + h.status + ').'); process.exit(1); }

const results = [];
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const r = h.receipt;
const hash = sha(canonical(r));
ok('receipt hash', hash === h.receiptHash, hash);
// the key: the one the signed receipt names; older receipts (no receipt.keyId) use the key id the server reports for them
const wantId = r.keyId || h.keyId || null;
const list = Array.isArray(key.keys) && key.keys.length ? key.keys : [key];
const k = list.find((x) => wantId && x.keyId === wantId) || (wantId ? null : list[0]);
ok('signing key is published', !!k, wantId ? `receipt names ${wantId}${r.keyId ? ' (signed)' : ' (server says, receipt predates keyId)'}` : 'receipt names no key');
let sigOk = false;
if (k) {
  const pub = createPublicKey(k.publicKeyPem);
  const rawPub = '0x' + pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  ok('public key matches its hex form and id', rawPub === k.publicKeyHex && sha(Buffer.from(rawPub.slice(2), 'hex')).slice(0, 18) === k.keyId, `${k.keyId}  raw ${rawPub}`);
  if (pinned) ok('public key equals the one you pinned with --key', rawPub === pinned);
  else console.log(`INFO  key fingerprint sha256(raw key) = ${sha(Buffer.from(rawPub.slice(2), 'hex'))}. This key was served by the same site; for a check that trusts nothing it serves, rerun with --key and a public key you got elsewhere.`);
  sigOk = verify(null, Buffer.from(h.receiptHash.slice(2), 'hex'), pub, Buffer.from(h.signature.replace(/^0x/, ''), 'hex'));
}
ok('Ed25519 signature', sigOk);
const outs = h.outputs || [];
const isAgent = r.kind === 'agent' || r.v === 'weightlings.agent-hire.v1';
if (isAgent) {
  // an outside agent's hire: outputs = [the exact request body sent to the agent, the exact response body it gave]
  ok('request body present and hashed', outs[0] !== undefined && sha(outs[0]) === r.request.hash, r.request.hash);
  let sent = null; try { sent = JSON.parse(outs[0]); } catch {}
  ok('request body carries this task and hire id', !!sent && sent.task === r.task && sent.hireId === r.id);
  if (r.response.hash) ok('response body hashed', outs[1] !== undefined && sha(outs[1]) === r.response.hash, `${r.response.bytes} bytes, HTTP ${r.response.status}, ${r.response.latencyMs} ms`);
  else console.log('INFO  no response body (the agent could not be reached or timed out)');
  ok('no model cost', r.costUsd === 0);
} else {
  ok('tool outputs present', outs.length === r.steps.length, `${r.steps.length} step(s)`);
  r.steps.forEach((s, i) => ok(`step ${i + 1} ${s.tool} output hash`, outs[i] !== undefined && sha(outs[i]) === s.outputHash));
  if (h.system !== undefined) ok('system prompt hash', sha(h.system) === r.systemHash);
  const p = r.prices.perMTok, u = r.usage;
  const cost = +(((u.input_tokens * p.input + u.cache_creation_input_tokens * p.cacheWrite + u.cache_read_input_tokens * p.cacheRead + u.output_tokens * p.output) / 1e6)).toFixed(6);
  ok('cost from usage and prices', Math.abs(cost - r.costUsd) <= 0.000002 * Math.max(1, u.calls), `$${r.costUsd} (recomputed $${cost}; per-call rounding allowed)`);
}
if (r.settlement) {
  const { settlement: st, ...core } = r;
  ok('paid hire: workHash = sha256(canonical(receipt without settlement))', sha(canonical(core)) === st.workHash, st.workHash);
  console.log(`INFO  paid ${r.paidBy?.amount} into ${isAgent ? 'agent' : 'creature'} wallet ${r.paidBy?.wallet} in ${r.paidBy?.payTx}; ${st.kind} in ${st.tx || '(pending: see settlementLate)'}: ${st.note || st.error || ''}`);
  if (rpcUrl && st.tx) {
    const call = async (method, params) => { const x = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((y) => y.json()); if (x.error) throw new Error(x.error.message); return x.result; };
    const PAID = '0x408247e89d39871c0cb4768c90199873315688a638cb09e6f8eeb7a32a5cf1eb', CHARGED = '0xfadbc2931392d9d570a587fe9e4709595e8d26fb463f098bc02b0197fdfa2cbf';
    const [pr, sr] = await Promise.all([call('eth_getTransactionReceipt', [r.paidBy.payTx]), call('eth_getTransactionReceipt', [st.tx])]);
    const from = (l) => l.address.toLowerCase() === String(r.paidBy.wallet).toLowerCase() && l.topics[1] === r.paidBy.runId;
    const paid = pr?.status === '0x1' && pr.logs.find((l) => from(l) && l.topics[0] === PAID && ('0x' + l.topics[2].slice(26)).toLowerCase() === String(r.paidBy.payer).toLowerCase() && BigInt('0x' + l.data.slice(2, 66)) === BigInt(r.paidBy.units));
    ok('on chain: pay tx moved the price from the payer into the creature wallet, for this run', !!paid);
    const ch = sr?.status === '0x1' && sr.logs.find((l) => from(l) && l.topics[0] === CHARGED);
    ok('on chain: settlement tx charged this run with this receipt\'s workHash', !!ch && '0x' + ch.data.slice(2 + 128, 2 + 192) === st.workHash && BigInt('0x' + ch.data.slice(2, 66)) === BigInt(st.costUnits));
  }
}
console.log(`INFO  OpenTimestamps: ${h.ots?.stamped ? `stamped via ${h.ots.calendar}, proof at ${base}${h.ots.proof}` : 'not stamped yet'}`);
if (isAgent) console.log(`INFO  agent "${r.agent.name}" at ${r.agent.endpoint} (owner ${r.agent.owner}); status ${r.status}; paid by ${typeof r.paidBy === 'string' ? r.paidBy : `${r.paidBy?.amount || ''} from ${r.paidBy?.payer || 'unknown'}`}`);
else console.log(`INFO  ${r.creature.nick} (brain in game: ${r.creature.brain.name}) worked through ${r.model}; status ${r.status}; paid by ${typeof r.paidBy === 'string' ? r.paidBy : `${r.paidBy?.amount || ''} from ${r.paidBy?.payer || 'unknown'}`}; Anthropic message ids ${r.messageIds.join(', ')}`);
console.log(`INFO  ${r.disclosure}`);
const all = results.every(Boolean);
console.log(all ? 'RECEIPT VERIFIED' : 'RECEIPT DOES NOT VERIFY');
process.exit(all ? 0 : 1);

// Robinhood Chain (4663) raw JSON-RPC: retry, chunked getLogs, tiny ABI helpers. No dependencies.
const URLS = (process.env.RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com').split(',');
let rr = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rpc(method, params = [], tries = 5) {
  let err;
  for (let i = 0; i < tries; i++) {
    const url = URLS[rr++ % URLS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) throw new Error('http ' + r.status);
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message); e.rpc = true; throw e; }
      return j.result;
    } catch (e) {
      err = e;
      if (e.rpc && /spans|too many|limit|exceed/i.test(e.message)) throw e;
      if (e.rpc && i >= 1) throw e;
      await sleep(400 * 2 ** i);
    }
  }
  throw err;
}

export const hex = (n) => '0x' + BigInt(n).toString(16);
export const pad32 = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const topicAddr = (t) => '0x' + t.slice(26).toLowerCase();
export const words = (data) => { const d = data.replace(/^0x/, ''); const o = []; for (let i = 0; i < d.length; i += 64) o.push(BigInt('0x' + d.slice(i, i + 64))); return o; };

/** eth_getLogs over [from,to] in windows of maxRange, halving when the node refuses. */
export async function getLogs(filter, from, to, maxRange = 30000) {
  const out = [];
  for (let a = from; a <= to; a += maxRange) {
    const b = Math.min(to, a + maxRange - 1);
    for (const x of await logsRange(filter, a, b)) out.push(x);
  }
  return out;
}
async function logsRange(filter, a, b) {
  try { return await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }]); }
  catch (e) {
    if (b - a < 10) throw e;
    const m = Math.floor((a + b) / 2);
    const L = await logsRange(filter, a, m); for (const x of await logsRange(filter, m + 1, b)) L.push(x); return L;
  }
}

export const blockNumber = async () => Number(await rpc('eth_blockNumber'));

// Block timestamps: RH makes ~10 blocks/s. We anchor on two real blocks and interpolate.
let anchor = null;
export async function calibrate() {
  const n = await blockNumber();
  const [a, b] = await Promise.all([rpc('eth_getBlockByNumber', [hex(n), false]), rpc('eth_getBlockByNumber', [hex(n - 2_000_000), false])]);
  anchor = { n, t: Number(a.timestamp), rate: (Number(a.timestamp) - Number(b.timestamp)) / 2_000_000 };
  return anchor;
}
export const blockTime = (bn) => (anchor ? Math.round(anchor.t - (anchor.n - bn) * anchor.rate) : 0);
export const blocksPerSec = () => (anchor ? 1 / anchor.rate : 10);

// selectors
export const SEL = { symbol: '0x95d89b41', name: '0x06fdde03', balanceOf: '0x70a08231' };
export function decodeString(h) {
  if (!h || h === '0x') return '';
  const d = h.slice(2);
  try {
    if (d.length >= 128) { const len = parseInt(d.slice(64, 128), 16); return Buffer.from(d.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, ''); }
    return Buffer.from(d, 'hex').toString('utf8').replace(/\0/g, '').trim();
  } catch { return ''; }
}
const CALL_URL = process.env.CALL_URL || 'https://robinhood-rpc.publicnode.com';
export async function batchCall(calls) {
  // calls: [{to, data}] → results (null on failure). Uses JSON-RPC batching on a second provider.
  const url = CALL_URL;
  const out = [];
  for (let i = 0; i < calls.length; i += 10) {
    if (i) await sleep(250);
    const chunk = calls.slice(i, i + 10);
    for (let tr = 0; tr < 3; tr++) try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }))), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      const byId = new Map((Array.isArray(j) ? j : []).map((x) => [x.id, x.result ?? null]));
      if (!byId.size) throw new Error('empty batch answer ' + r.status);
      chunk.forEach((_, k) => out.push(byId.get(k) ?? null));
      break;
    } catch (e) { if (tr === 2) { console.warn('[rpc] batch', e.message); chunk.forEach(() => out.push(null)); } else await sleep(800 * (tr + 1)); }
  }
  return out;
}

let eth = { usd: 0, at: 0 };
export async function ethUsd() {
  if (Date.now() - eth.at < 120000 && eth.usd) return eth.usd;
  try { const j = await (await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(8000) })).json(); eth = { usd: Number(j.data.amount), at: Date.now() }; } catch {}
  return eth.usd || 3000;
}

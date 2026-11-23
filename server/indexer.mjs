// Pons V2 indexer: every launch (factory logs) and every bonding-curve buy/sell on Robinhood Chain, stored per wallet.
// Live tail every few seconds + backfill of BACKFILL_DAYS going backwards. Also tracks holders of our own token (TOKEN env).
import { db, kv } from './db.mjs';
import { rpc, getLogs, blockNumber, calibrate, blockTime, blocksPerSec, topicAddr, words, batchCall, SEL, decodeString, ethUsd, pad32 } from './rpc.mjs';

export const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const T = {
  launched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  buy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  sell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
};
export const TOPIC = T;
const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const DAYS = Number(process.env.BACKFILL_DAYS || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const state = { head: 0, live: 0, bfLo: 0, bfTarget: 0, coins: 0, trades: 0, lastError: null, phase: 'boot', holders: 0, holderScan: 0 };
const curveMap = new Map(); // curve -> {token, pair}

const insCoin = db.prepare('INSERT OR IGNORE INTO coins(token,curve,pair,deployer,block) VALUES(?,?,?,?,?)');
const insTrade = db.prepare('INSERT OR IGNORE INTO trades(tx,li,wallet,token,side,quote,tokens,eth,block,ts) VALUES(?,?,?,?,?,?,?,?,?,?)');

function loadCurves() { for (const r of db.prepare('SELECT token,curve,pair FROM coins').all()) curveMap.set(r.curve, { token: r.token, pair: r.pair }); state.coins = curveMap.size; }

async function scanLaunches(from, to) {
  const logs = await getLogs({ address: FACTORY, topics: [T.launched] }, from, to, 5_000_000);
  // the connection is shared with the meadow: a transaction left open here would make every later one fail, the hourly round included
  db.exec('BEGIN');
  try {
    for (const l of logs) {
      const token = topicAddr(l.topics[1]), curve = topicAddr(l.topics[2]), deployer = topicAddr(l.topics[3]);
      const pair = '0x' + l.data.slice(26, 66).toLowerCase();
      insCoin.run(token, curve, pair, deployer, Number(l.blockNumber));
      curveMap.set(curve, { token, pair });
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  state.coins = curveMap.size;
  return logs.length;
}

async function scanTrades(from, to) {
  const logs = await getLogs({ topics: [[T.buy, T.sell]] }, from, to, 30000);
  const usd = await ethUsd();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const l of logs) {
      const c = curveMap.get(l.address.toLowerCase());
      if (!c) continue;
      const w = words(l.data); // buy: quoteIn, tokensOut, fee, tax | sell: tokensIn, quoteOut, fee, tax
      const isBuy = l.topics[0] === T.buy;
      const quoteRaw = isBuy ? w[0] : w[1], tokRaw = isBuy ? w[1] : w[0];
      let eth = null;
      if (c.pair === ZERO || c.pair === WETH) eth = Number(quoteRaw) / 1e18;
      else if (c.pair === USDG) eth = Number(quoteRaw) / 1e6 / usd;
      const bn = Number(l.blockNumber);
      insTrade.run(l.transactionHash, Number(l.logIndex), topicAddr(l.topics[2]), c.token, isBuy ? 0 : 1, Number(quoteRaw) / 1e18, Number(tokRaw) / 1e18, eth, bn, blockTime(bn));
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  state.trades += n;
  return n;
}

import stocks from './stocks.json' with { type: 'json' };
export const STOCKS = stocks;
const SKIP_SYM = new Set(['WETH', 'USDG', 'USDC', 'USDT', 'cbBTC']);
const STOCK_ADDRS = Object.keys(stocks).filter((a) => !SKIP_SYM.has(stocks[a]));
const STOCK_DAYS = Number(process.env.STOCK_DAYS || 0);
const upAgg = db.prepare(`INSERT INTO stagg(wallet,sym,ain,aout,n,f,l) VALUES(?,?,?,?,1,?,?) ON CONFLICT(wallet,sym) DO UPDATE SET ain=ain+excluded.ain, aout=aout+excluded.aout, n=n+1, f=MIN(f,excluded.f), l=MAX(l,excluded.l)`);
async function scanStocks(from, to) {
  const logs = await getLogs({ address: STOCK_ADDRS, topics: [T.transfer] }, from, to, 100000);
  db.exec('BEGIN');
  try {
    for (const l of logs) {
      const sym = stocks[l.address.toLowerCase()]; if (!sym) continue;
      const amt = Number(BigInt(l.data.slice(0, 66))) / 1e18, ts = blockTime(Number(l.blockNumber));
      upAgg.run(topicAddr(l.topics[2]), sym, amt, 0, ts, ts);
      upAgg.run(topicAddr(l.topics[1]), sym, 0, amt, ts, ts);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

async function fillSymbols() {
  const rows = db.prepare('SELECT c.token FROM coins c WHERE c.sym IS NULL AND EXISTS (SELECT 1 FROM trades t WHERE t.token=c.token) ORDER BY c.block DESC LIMIT 60').all();
  if (!rows.length) return;
  const res = await batchCall(rows.flatMap((r) => [{ to: r.token, data: SEL.symbol }, { to: r.token, data: SEL.name }]));
  const up = db.prepare('UPDATE coins SET sym=?, name=? WHERE token=?');
  rows.forEach((r, i) => res[2 * i] && up.run(decodeString(res[2 * i]).slice(0, 24) || '?', decodeString(res[2 * i + 1]).slice(0, 48) || '', r.token));
}

// ---- holders of our own token (set TOKEN once the coin is live) ----
const TOKEN = (process.env.TOKEN || '').toLowerCase();
export const tokenInfo = { address: TOKEN, curve: null, holders: new Map() };
async function scanHolders() {
  if (!TOKEN) return;
  const coin = db.prepare('SELECT * FROM coins WHERE token=?').get(TOKEN);
  if (!coin) return;
  tokenInfo.curve = coin.curve;
  let from = kv.get('h_from', coin.block);
  const bal = new Map(Object.entries(kv.get('h_bal', {})).map(([k, v]) => [k, BigInt(v)]));
  const to = state.head;
  if (to <= from) return;
  const logs = await getLogs({ address: TOKEN, topics: [T.transfer] }, from, to, 5_000_000);
  for (const l of logs) {
    const f = topicAddr(l.topics[1]), t = topicAddr(l.topics[2]), v = BigInt(l.data.slice(0, 66));
    if (f !== ZERO) bal.set(f, (bal.get(f) || 0n) - v);
    bal.set(t, (bal.get(t) || 0n) + v);
  }
  kv.set('h_from', to + 1);
  kv.set('h_bal', Object.fromEntries([...bal].filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()])));
  const skip = new Set([ZERO, coin.curve, '0x000000000000000000000000000000000000dead', '0x8366a39cc670b4001a1121b8f6a443a643e40951', TOKEN]);
  tokenInfo.holders = new Map([...bal].filter(([k, v]) => v > 0n && !skip.has(k)).map(([k, v]) => [k, Number(v) / 1e18]));
  state.holders = tokenInfo.holders.size;
  state.holderScan = Date.now();
}

export async function start(onTick) {
  await calibrate();
  loadCurves();
  state.head = await blockNumber();
  // launches: whole history once, then incremental
  state.bfTarget = state.head - Math.round(DAYS * 86400 * blocksPerSec());
  const lfrom = kv.get('launch_hi', state.bfTarget - Math.round(30 * 86400 * blocksPerSec()));
  await scanLaunches(lfrom, state.head);
  kv.set('launch_hi', state.head + 1);
  fillSymbols().catch(() => {});
  state.live = kv.get('live_hi', state.head - 3000);
  state.bfLo = kv.get('bf_lo', state.live);
  state.phase = 'live';
  console.log(`[idx] head ${state.head}, ${state.coins} Pons coins, backfill ${DAYS}d → ${state.bfTarget}, ${(1 / blocksPerSec()).toFixed(3)} s/block`);

  // live tail
  (async () => {
    for (;;) {
      try {
        state.head = await blockNumber();
        if (state.head > state.live) {
          const to = Math.min(state.head, state.live + 30000);
          await scanLaunches(state.live, to);
          await scanTrades(state.live, to);
          state.live = to + 1;
          kv.set('live_hi', state.live);
          kv.set('launch_hi', state.live);
        }
        await scanHolders();
        onTick?.();
      } catch (e) { state.lastError = e.message; console.warn('[idx] live', e.message); }
      await sleep(4000);
    }
  })();
  // backfill (newest first)
  (async () => {
    while (state.bfLo > state.bfTarget) {
      const hi = state.bfLo - 1, lo = Math.max(state.bfTarget, hi - 30000 * 4 + 1);
      try {
        await Promise.all([scanTrades(lo, hi), lo > state.head - STOCK_DAYS * 86400 * blocksPerSec() ? scanStocks(lo, hi) : null]);
        state.bfLo = lo; state.bfLoTs = blockTime(lo);
        kv.set('bf_lo', lo);
      } catch (e) { state.lastError = e.message; console.warn('[idx] backfill', e.message); await sleep(3000); }
      await sleep(150);
    }
    console.log('[idx] backfill done');
  })();
  setInterval(() => fillSymbols().catch(() => {}), 8000);
  setInterval(() => calibrate().catch(() => {}), 3600_000);
}

// ---- market reads used by agents ----
export function coinInfo(token) { return db.prepare('SELECT * FROM coins WHERE token=?').get(token); }
export function lastPrice(token, beforeTs = 1e12) {
  const r = db.prepare('SELECT eth, tokens FROM trades WHERE token=? AND eth IS NOT NULL AND tokens>0 AND ts<=? ORDER BY block DESC, li DESC LIMIT 1').get(token, beforeTs);
  return r ? r.eth / r.tokens : null;
}
export function hotCoins(hours = 1, limit = 8) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return db.prepare(`SELECT t.token, c.sym, c.name, c.block, COUNT(*) n, SUM(CASE WHEN side=0 THEN eth ELSE 0 END) buyEth, SUM(CASE WHEN side=1 THEN eth ELSE 0 END) sellEth,
    COUNT(DISTINCT wallet) wallets FROM trades t JOIN coins c ON c.token=t.token WHERE t.ts>=? AND t.eth IS NOT NULL GROUP BY t.token ORDER BY (buyEth+sellEth) DESC LIMIT ?`).all(since, limit);
}

// Stock-token flows for one wallet, aggregated over the indexed stock window.
export async function stockFlows(wallet) {
  const per = {};
  for (const r of db.prepare('SELECT * FROM stagg WHERE wallet=?').all(wallet)) per[r.sym] = { in: r.ain, out: r.aout, n: r.n, first: r.f, last: r.l };
  return per;
}
export async function walletBasics(wallet) {
  const [bal, nonce] = await Promise.all([rpc('eth_getBalance', [wallet, 'latest']), rpc('eth_getTransactionCount', [wallet, 'latest'])]);
  return { ethBalance: Number(BigInt(bal)) / 1e18, txCount: Number(nonce) };
}

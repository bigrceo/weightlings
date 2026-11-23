// The hourly cull, as one pure function. The server (server/sim.mjs) and the public checker (/verify) both import THIS file,
// so the round anyone recomputes is the round that was run. ES module: works in Node and in the browser. No dependencies.
//
//   cull({ roundN, trialKey, seedHash, snapshot, extinct, cap, models, nextId }) -> { ranked, dead, survivors, births, reborn, scores }
//
// Inputs
//   roundN    round number (integer)
//   trialKey  'famine' | 'storm' | 'plague' | 'maze'   (rotation: trialFor(roundN))
//   seedHash  the full 0x… 256-bit hash of the seed block (first Robinhood Chain block with timestamp >= scheduledAt + 60 s)
//   snapshot  every living creature, frozen at scheduledAt: { id, wallet, model, gen, source, eaten, wins, shares, faints }
//             (eaten / wins / shares / faints are that hour's foraging counts)
//   extinct   lineages with no living creature at scheduledAt: { wallet, holder, gen (next generation), last (last creature id), model (founding brain), source }
//   cap       population cap
//   models    the brain table: { id, power, tier, stats: { perception, judgement, memory, strength, metabolism, cooperation } }
//   nextId    id given to the first newborn; newborns are numbered nextId, nextId + 1, … in the order of `births`
//
// Determinism
//   No Math.random, no Date, no random sort comparator. Arithmetic uses only + - * /, Math.max, Math.min, Math.floor and BigInt
//   (no pow / exp / log, whose last bit may differ between engines), so every JavaScript engine produces the same result bit for bit.
//   All randomness comes from one stream:
//     key      = SHA-256( utf8( "weightlings/cull/v1|" + lowercase(seedHash) + "|" + roundN ) )         (32 bytes)
//     block k  = SHA-256( key ‖ uint32_be(k) ),  k = 0, 1, 2, …   each block gives 8 draws, read as big-endian uint32
//     u        = draw / 2^32   in [0, 1)
//   Draws are consumed in this fixed order:
//     1. Noise. For each creature in ascending id: three draws a, b, c -> noise = (a + b + c - 1.5) / 1.5.
//     2. Second chances. The extinct list sorted by wallet (ascending) is shuffled with Fisher–Yates
//        (for i = length-1 down to 1: one draw u, j = floor(u * (i + 1)), swap i and j), then holders are moved first, order otherwise kept.
//     3. Breeding. For each bred child in order: one draw for the parent; one draw u for mutation; and only if u < 0.12,
//        one draw for the direction (u < 0.5 -> weaker, else stronger) and one for the distance (u < 0.8 -> 1 step, else 2).

// ---------- rules ----------
export const VERSION = 1;
export const KILL_PCT = 35; // the weakest 35% are removed: floor(N * 35 / 100)
export const MUT = 0.12; // chance a child mutates to a neighbouring model
export const REBORN_SHARE = 4; // at most a quarter of the free places go to extinct lineages
export const SEED_DELAY_MS = 60000; // the seed block is the first block at or after scheduledAt + 60 s
export const TRIAL_ORDER = ['famine', 'storm', 'plague', 'maze'];
// trait weights per trial, summed in this order. "thrift" is 1.6 - metabolism.
export const TRIAL_WEIGHTS = {
  famine: [['perception', 0.25], ['judgement', 0.25], ['thrift', 0.5]],
  storm: [['strength', 0.5], ['memory', 0.3], ['judgement', 0.2]],
  plague: [['cooperation', 0.5], ['judgement', 0.3], ['perception', 0.2]],
  maze: [['judgement', 0.5], ['memory', 0.35], ['perception', 0.15]],
};
export const trialFor = (roundN) => TRIAL_ORDER[(roundN - 1) % TRIAL_ORDER.length];

// ---------- names (a creature's name is a pure function of its wallet and generation) ----------
const NA = ['Ash', 'Bix', 'Cog', 'Dot', 'Elo', 'Fen', 'Gus', 'Hux', 'Ivo', 'Jin', 'Kip', 'Lux', 'Moe', 'Nib', 'Ozz', 'Pip', 'Quill', 'Rho', 'Sly', 'Tock', 'Umi', 'Vex', 'Wren', 'Yui', 'Zed'];
const NB = ['bit', 'byte', 'loop', 'node', 'vec', 'mesh', 'gate', 'sum', 'max', 'norm', 'grad', 'tok', 'lex', 'ply', 'dex'];
const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];
export const familyName = (w) => { let h = 0; for (const c of w) h = (h * 33 + c.charCodeAt(0)) >>> 0; return NA[h % NA.length] + NB[(h >>> 8) % NB.length]; };
export const nickOf = (w, gen) => familyName(w) + (gen < ROMAN.length ? ROMAN[gen] : ' ' + (gen + 1));

// ---------- canonical JSON: keys sorted, no whitespace ----------
export function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('canonical: non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x === undefined ? null : x)).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  throw new Error('canonical: unsupported value');
}

// ---------- SHA-256 (plain JavaScript, synchronous; used for the random stream) ----------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function utf8(s) {
  const o = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
    if (c < 0x80) o.push(c); else if (c < 0x800) o.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) o.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else o.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(o);
}
/** SHA-256 of a byte array -> 32 bytes. */
export function sha256(bytes) {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length, total = (((len + 8) >> 6) + 1) << 6, m = new Uint8Array(total), w = new Uint32Array(64);
  m.set(bytes); m[len] = 0x80;
  const bits = len * 8; m[total - 4] = bits >>> 24; m[total - 3] = (bits >>> 16) & 255; m[total - 2] = (bits >>> 8) & 255; m[total - 1] = bits & 255; m[total - 5] = Math.floor(len / 0x20000000) & 255;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3]) >>> 0;
    for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = (H[i] >>> 16) & 255; out[4 * i + 2] = (H[i] >>> 8) & 255; out[4 * i + 3] = H[i] & 255; }
  return out;
}
export const toHex = (bytes) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
/** '0x…' SHA-256 of the canonical JSON of a value (same output as WebCrypto / node:crypto over the same text). */
export const hashOf = (v) => toHex(sha256(utf8(canonical(v))));

// ---------- the random stream ----------
export function makeRng(seedHash, roundN) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(seedHash || '')) throw new Error('cull: seedHash must be a full 0x… 256-bit block hash');
  if (!Number.isInteger(roundN) || roundN < 1) throw new Error('cull: bad round number');
  const key = sha256(utf8('weightlings/cull/v' + VERSION + '|' + seedHash.toLowerCase() + '|' + roundN));
  const buf = new Uint8Array(36); buf.set(key);
  let k = 0, blk = null, pos = 8, n = 0;
  const u32 = () => {
    if (pos === 8) { buf[32] = k >>> 24; buf[33] = (k >>> 16) & 255; buf[34] = (k >>> 8) & 255; buf[35] = k & 255; blk = sha256(buf); k++; pos = 0; }
    const i = 4 * pos++; n++;
    return ((blk[i] << 24) | (blk[i + 1] << 16) | (blk[i + 2] << 8) | blk[i + 3]) >>> 0;
  };
  return { u32, rnd: () => u32() / 4294967296, get draws() { return n; } };
}

/** floor(n * u^1.8) for u = r / 2^32, computed exactly with integers: the largest k with k^5 * 2^288 <= n^5 * r^9. */
export function skewIndex(r, n) {
  const R = BigInt(r) ** 9n * BigInt(n) ** 5n;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((BigInt(mid) ** 5n) << 288n <= R) lo = mid; else hi = mid - 1; }
  return lo;
}

/** The brain table reduced to what the cull reads, in a fixed shape (this is what gets committed). */
export const cullModels = (models) => models.map((m) => ({ id: m.id, power: m.power, tier: m.tier,
  stats: { perception: m.stats.perception, judgement: m.stats.judgement, memory: m.stats.memory, strength: m.stats.strength, metabolism: m.stats.metabolism, cooperation: m.stats.cooperation } }));

/** Everything the round depends on except the seed. Its hash is published (GET /api/commit) before the seed block exists. */
export const commitment = ({ roundN, trialKey, cap, snapshot, extinct, models }) => ({ v: VERSION, roundN, trial: trialKey, cap, snapshot, extinct, models });

/** The part of the outcome that is stored and hashed (recordHash). */
export const resultOf = (out) => ({ ranked: out.ranked, dead: out.dead, births: out.births });

// ---------- the round ----------
export function cull({ roundN, trialKey, seedHash, snapshot, extinct = [], cap, models, nextId = null }) {
  const weights = TRIAL_WEIGHTS[trialKey];
  if (!weights) throw new Error('cull: unknown trial ' + trialKey);
  const M = {}; for (const m of models) M[m.id] = m;
  const rng = makeRng(seedHash, roundN);
  const pop = [...snapshot].sort((a, b) => a.id - b.id);
  const N = pop.length;
  for (const b of pop) if (!M[b.model]) throw new Error('cull: unknown model ' + b.model);

  // crowding: the share of the meadow that carries the same model, the same tier, the same lineage
  const cnt = { m: {}, t: {}, w: {} };
  for (const b of pop) { const m = M[b.model]; cnt.m[m.id] = (cnt.m[m.id] || 0) + 1; cnt.t[m.tier] = (cnt.t[m.tier] || 0) + 1; cnt.w[b.wallet] = (cnt.w[b.wallet] || 0) + 1; }
  let maxPerf = 1; for (const b of pop) maxPerf = Math.max(maxPerf, b.eaten + 2 * b.wins + 2 * b.shares);
  const plague = trialKey === 'plague' ? 1.6 : 1;

  // 1. score every creature (ascending id; three draws each)
  const scored = pop.map((b) => {
    const m = M[b.model], s = m.stats, v = { ...s, thrift: 1.6 - s.metabolism };
    let f = 0; for (const [k, w] of weights) f += w * v[k];
    const perf = (b.eaten + 2 * b.wins + 2 * b.shares - 4 * b.faints) / maxPerf;
    const crowd = plague * (0.9 * (cnt.m[m.id] / N) + 0.5 * (cnt.t[m.tier] / N)) + 0.8 * (cnt.w[b.wallet] / N);
    const a = rng.rnd(), c = rng.rnd(), d = rng.rnd(), noise = (a + c + d - 1.5) / 1.5;
    return { b, f: f + 0.25 * Math.max(-0.5, perf) - crowd + 0.1 * noise };
  });
  // best first; equal scores are broken by the lower id
  const ranked = scored.slice().sort((x, y) => y.f - x.f || x.b.id - y.b.id);
  const nKill = Math.floor((N * KILL_PCT) / 100);
  const alive = ranked.slice(0, N - nKill), dead = ranked.slice(N - nKill);

  // 2. second chances: extinct lineages hatch a new founder with the wallet's founding brain
  const room = Math.max(0, cap - alive.length);
  const gone = [...extinct].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  for (let i = gone.length - 1; i > 0; i--) { const j = Math.floor(rng.rnd() * (i + 1)); const t = gone[i]; gone[i] = gone[j]; gone[j] = t; }
  const order = [...gone.filter((e) => e.holder), ...gone.filter((e) => !e.holder)];
  const births = [];
  const id = () => (nextId == null ? null : nextId + births.length);
  for (const e of order.slice(0, Math.floor(room / REBORN_SHARE))) {
    if (!M[e.model]) throw new Error('cull: unknown model ' + e.model);
    births.push({ id: id(), parent: e.last, wallet: e.wallet, model: e.model, mutated: false, reborn: true, gen: e.gen, source: e.holder ? 'holder' : e.source });
  }

  // 3. breeding back to the cap: parents drawn by rank (index floor(n * u^1.8), so the best breed most), 12% mutate to a neighbouring model
  const sorted = [...models].sort((a, b) => a.power - b.power || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let k = births.length; k < room && alive.length; k++) {
    const pa = alive[skewIndex(rng.u32(), alive.length)].b;
    let model = pa.model, mutated = false;
    if (rng.rnd() < MUT) {
      const i = sorted.findIndex((m) => m.id === model);
      const dir = rng.rnd() < 0.5 ? -1 : 1, step = rng.rnd() < 0.8 ? 1 : 2;
      const j = Math.max(0, Math.min(sorted.length - 1, i + dir * step));
      if (j !== i) { model = sorted[j].id; mutated = true; }
    }
    births.push({ id: id(), parent: pa.id, wallet: pa.wallet, model, mutated, reborn: false, gen: pa.gen + 1, source: pa.source });
  }

  return {
    ranked: ranked.map((x) => x.b.id), dead: dead.map((x) => x.b.id), survivors: alive.map((x) => x.b.id), births,
    reborn: births.filter((x) => x.reborn).map((x) => x.id),
    scores: ranked.map((x) => x.f), // same order as `ranked`; shown by the checker, not part of the stored result
    draws: rng.draws,
  };
}

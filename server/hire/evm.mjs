import { createHmac } from 'node:crypto';
// Just enough Ethereum for the hire engine, with no dependencies: keccak-256, a small ABI encoder/decoder for
// human-readable signatures, EIP-55 addresses, and secp256k1 public-key recovery (for EIP-712 / EIP-3009 payment checks).
// Everything is BigInt arithmetic; it is slow next to native code but a hire needs a handful of hashes at most.

// ---------- keccak-256 (the pre-NIST padding Ethereum uses: 0x01 … 0x80) ----------
const M64 = (1n << 64n) - 1n;
const RC = ['0x1', '0x8082', '0x800000000000808a', '0x8000000080008000', '0x808b', '0x80000001', '0x8000000080008081', '0x8000000000008009', '0x8a', '0x88', '0x80008009', '0x8000000a',
  '0x8000808b', '0x800000000000008b', '0x8000000000008089', '0x8000000000008003', '0x8000000000008002', '0x8000000000000080', '0x800a', '0x800000008000000a', '0x8000000080008081', '0x8000000000008080', '0x80000001', '0x8000000080008008'].map(BigInt);
// rotation offsets r[x][y]
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]].map((r) => r.map(BigInt));
const rotl = (v, n) => (n ? ((v << n) | (v >> (64n - n))) & M64 : v);
function keccakF(A) {
  const C = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n); for (let y = 0; y < 25; y += 5) A[x + y] ^= D; }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x][y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & M64 & B[((x + 2) % 5) + y]);
    A[0] ^= RC[round];
  }
}
/** keccak-256 of bytes (Uint8Array | Buffer | utf8 string) -> Buffer(32) */
export function keccak256(input) {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const rate = 136, padded = Buffer.alloc(Math.floor(data.length / rate) * rate + rate);
  data.copy(padded); padded[data.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(A);
  }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return out;
}
export const keccakHex = (input) => '0x' + keccak256(input).toString('hex');

// ---------- addresses ----------
export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
export function checksum(addr) {
  const a = String(addr).toLowerCase().replace(/^0x/, ''), h = keccak256(a).toString('hex');
  let out = '0x'; for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

// ---------- ABI (static types, string and bytes; no tuples or arrays) ----------
const word = (n) => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0');
const TYPE = /^(address|bool|string|bytes|bytes([1-9]|[12][0-9]|3[0-2])|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$/;
const norm = (t) => (t === 'uint' ? 'uint256' : t === 'int' ? 'int256' : t);
function typeList(s) {
  const parts = s.trim() ? s.split(',').map((p) => p.trim().split(/\s+/)[0]) : [];
  return parts.map((t) => { t = norm(t); if (!TYPE.test(t)) throw new Error(`type "${t}" is not supported here (no tuples or arrays)`); return t; });
}
/** "function balanceOf(address owner) view returns (uint256)" -> { name, inputs, outputs, selector } */
export function parseSignature(sig) {
  const m = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*((?:\s*(?:external|public|view|pure|payable|nonpayable))*)\s*(?:returns\s*\(([^()]*)\))?\s*;?\s*$/.exec(String(sig));
  if (!m) throw new Error('signature must look like "function name(types) view returns (types)"');
  const inputs = typeList(m[2]), outputs = typeList(m[4] || '');
  const selector = '0x' + keccak256(`${m[1]}(${inputs.join(',')})`).subarray(0, 4).toString('hex');
  return { name: m[1], inputs, outputs, selector };
}
const isDyn = (t) => t === 'string' || t === 'bytes';
function encodeOne(t, v) {
  if (t === 'address') { if (!isAddress(v)) throw new Error(`"${v}" is not an address`); return String(v).toLowerCase().slice(2).padStart(64, '0'); }
  if (t === 'bool') return word(v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0);
  if (/^bytes\d+$/.test(t)) { const n = Number(t.slice(5)), h = String(v).replace(/^0x/, ''); if (!/^[0-9a-fA-F]*$/.test(h) || h.length !== n * 2) throw new Error(`"${v}" is not ${t}`); return h.toLowerCase().padEnd(64, '0'); }
  if (/^u?int/.test(t)) {
    let b; try { b = BigInt(typeof v === 'number' ? Math.trunc(v) : String(v)); } catch { throw new Error(`"${v}" is not a ${t}`); }
    const bits = Number(t.replace(/^u?int/, '') || 256);
    if (t[0] === 'u' ? b < 0n || b >= 1n << BigInt(bits) : b < -(1n << BigInt(bits - 1)) || b >= 1n << BigInt(bits - 1)) throw new Error(`${v} does not fit ${t}`);
    return word(b);
  }
  throw new Error('unsupported ' + t);
}
function encodeDyn(t, v) {
  const buf = t === 'string' ? Buffer.from(String(v), 'utf8') : Buffer.from(String(v).replace(/^0x/, ''), 'hex');
  return word(buf.length) + buf.toString('hex').padEnd(Math.ceil(buf.length / 32) * 64, '0');
}
export function encodeArgs(types, values) {
  if (values.length !== types.length) throw new Error(`expected ${types.length} argument(s), got ${values.length}`);
  let head = '', tail = ''; const headLen = 32 * types.length;
  types.forEach((t, i) => { if (isDyn(t)) { head += word(headLen + tail.length / 2); tail += encodeDyn(t, values[i]); } else head += encodeOne(t, values[i]); });
  return head + tail;
}
export function decodeArgs(types, hexData) {
  const d = String(hexData || '0x').replace(/^0x/, '');
  const at = (i) => { const s = d.slice(i * 2, i * 2 + 64); if (s.length < 64) throw new Error('the answer is shorter than its types'); return s; };
  return types.map((t, k) => {
    const w = at(32 * k);
    if (isDyn(t)) { const off = Number(BigInt('0x' + w)), len = Number(BigInt('0x' + at(off))); const raw = d.slice((off + 32) * 2, (off + 32 + len) * 2); return t === 'string' ? Buffer.from(raw, 'hex').toString('utf8') : '0x' + raw; }
    if (t === 'address') return checksum('0x' + w.slice(24));
    if (t === 'bool') return BigInt('0x' + w) !== 0n;
    if (/^bytes\d+$/.test(t)) return '0x' + w.slice(0, Number(t.slice(5)) * 2);
    if (t.startsWith('uint')) return BigInt('0x' + w).toString();
    return BigInt.asIntN(Number(t.slice(3) || 256), BigInt('0x' + w)).toString();
  });
}

// ---------- secp256k1 ----------
const P = 2n ** 256n - 2n ** 32n - 977n;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) { let [x, y, u, v] = [mod(a, m), m, 1n, 0n]; while (x) { const q = y / x; [x, y] = [y - q * x, x]; [u, v] = [v - q * u, u]; } if (y !== 1n) throw new Error('no inverse'); return mod(v, m); }
function powmod(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
// Jacobian coordinates [X, Y, Z]; null is the point at infinity
function jDouble(p) {
  if (!p || p[1] === 0n) return null;
  const [X, Y, Z] = p, Y2 = mod(Y * Y), S = mod(4n * X * Y2), M = mod(3n * X * X), X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * Y2 * Y2), mod(2n * Y * Z)];
}
function jAdd(p, q) {
  if (!p) return q; if (!q) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q, Z1s = mod(Z1 * Z1), Z2s = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2s), U2 = mod(X2 * Z1s), S1 = mod(Y1 * Z2s * Z2), S2 = mod(Y2 * Z1s * Z1);
  if (U1 === U2) return S1 === S2 ? jDouble(p) : null;
  const H = mod(U2 - U1), R = mod(S2 - S1), H2 = mod(H * H), H3 = mod(H * H2), X3 = mod(R * R - H3 - 2n * U1 * H2);
  return [X3, mod(R * (U1 * H2 - X3) - S1 * H3), mod(H * Z1 * Z2)];
}
function mul(pt, k) { let r = null, a = [pt[0], pt[1], 1n]; k = mod(k, N); while (k > 0n) { if (k & 1n) r = jAdd(r, a); a = jDouble(a); k >>= 1n; } return r; }
function affine(p) { if (!p) return null; const zi = inv(p[2]), zi2 = mod(zi * zi); return [mod(p[0] * zi2), mod(p[1] * zi2 * zi)]; }
const addrOf = (pt) => checksum('0x' + keccak256(Buffer.from(pt[0].toString(16).padStart(64, '0') + pt[1].toString(16).padStart(64, '0'), 'hex')).subarray(12).toString('hex'));
/** Address of a private key (hex) */
export const addressOfKey = (priv) => addrOf(affine(mul(G, BigInt('0x' + String(priv).replace(/^0x/, '')))));

/** Recover the signer address from a 32-byte digest and a 65-byte r‖s‖v signature. Rejects high-s (EIP-2). */
export function recoverAddress(digest, sigHex) {
  const s65 = String(sigHex).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(s65)) throw new Error('signature must be 65 bytes');
  const r = BigInt('0x' + s65.slice(0, 64)), s = BigInt('0x' + s65.slice(64, 128)); let v = parseInt(s65.slice(128), 16);
  if (v >= 27) v -= 27; if (v !== 0 && v !== 1) throw new Error('bad recovery id');
  if (r <= 0n || r >= N || s <= 0n || s > N / 2n) throw new Error('signature out of range');
  const x = r, ySq = mod(x * x * x + 7n), y0 = powmod(ySq, (P + 1n) / 4n, P);
  if (mod(y0 * y0) !== ySq) throw new Error('signature does not lie on the curve');
  const y = (y0 & 1n) === BigInt(v) ? y0 : P - y0;
  const z = BigInt('0x' + Buffer.from(digest).toString('hex')), ri = inv(r, N);
  const Q = affine(jAdd(mul([x, y], mod(s * ri, N)), mul(G, mod(-z * ri, N))));
  if (!Q) throw new Error('signature does not recover');
  return addrOf(Q);
}
/** Sign a digest (test helper only; random k from node:crypto). Returns 0x r‖s‖v with v in {27, 28}. */
export async function signDigest(digest, priv) {
  const { randomBytes } = await import('node:crypto');
  const d = BigInt('0x' + String(priv).replace(/^0x/, '')), z = BigInt('0x' + Buffer.from(digest).toString('hex'));
  for (;;) {
    const k = mod(BigInt('0x' + randomBytes(32).toString('hex')), N); if (!k) continue;
    const R = affine(mul(G, k)), r = mod(R[0], N); if (!r) continue;
    let s = mod(inv(k, N) * (z + r * d), N), v = Number(R[1] & 1n); if (!s) continue;
    if (s > N / 2n) { s = N - s; v ^= 1; }
    return '0x' + r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0') + (27 + v).toString(16);
  }
}

/** Deterministic ECDSA (RFC 6979, HMAC-SHA256) over a 32-byte digest. Low-s (EIP-2). Returns { r, s, yParity } as BigInt/number.
 *  This is what the operator signs its own transactions with; the key never leaves the process. */
export function signHash(digest, priv) {
  const d = BigInt('0x' + String(priv).replace(/^0x/, ''));
  if (d <= 0n || d >= N) throw new Error('private key out of range');
  const h = Buffer.from(digest); if (h.length !== 32) throw new Error('digest must be 32 bytes');
  const z = BigInt('0x' + h.toString('hex'));
  const x = Buffer.from(d.toString(16).padStart(64, '0'), 'hex'), h1 = Buffer.from(mod(z, N).toString(16).padStart(64, '0'), 'hex');
  const hmac = (k, ...parts) => { const m = createHmac('sha256', k); for (const p of parts) m.update(p); return m.digest(); };
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  K = hmac(K, V, Buffer.from([0]), x, h1); V = hmac(K, V);
  K = hmac(K, V, Buffer.from([1]), x, h1); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = BigInt('0x' + V.toString('hex'));
    if (k > 0n && k < N) {
      const R = affine(mul(G, k)), r = mod(R[0], N);
      if (r) {
        let s = mod(inv(k, N) * (z + r * d), N), y = Number(R[1] & 1n);
        if (s) { if (s > N / 2n) { s = N - s; y ^= 1; } return { r, s, yParity: y }; }
      }
    }
    K = hmac(K, V, Buffer.from([0])); V = hmac(K, V);
  }
}

// ---------- RLP and EIP-1559 (type 2) transactions ----------
const bytesOfInt = (n) => { n = BigInt(n); if (n < 0n) throw new Error('negative'); if (n === 0n) return Buffer.alloc(0); let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
const rlpLen = (len, short, long) => { if (len <= 55) return Buffer.from([short + len]); const l = bytesOfInt(len); return Buffer.concat([Buffer.from([long + l.length]), l]); };
export function rlp(v) {
  if (Array.isArray(v)) { const body = Buffer.concat(v.map(rlp)); return Buffer.concat([rlpLen(body.length, 0xc0, 0xf7), body]); }
  const b = Buffer.isBuffer(v) ? v : typeof v === 'string' && v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex') : bytesOfInt(v);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([rlpLen(b.length, 0x80, 0xb7), b]);
}
/** Sign an EIP-1559 transaction. tx: { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data }. Returns { raw, hash }. */
export function signTx1559(tx, priv) {
  const fields = [BigInt(tx.chainId), BigInt(tx.nonce), BigInt(tx.maxPriorityFeePerGas), BigInt(tx.maxFeePerGas), BigInt(tx.gas),
    tx.to ? Buffer.from(String(tx.to).slice(2), 'hex') : Buffer.alloc(0), BigInt(tx.value || 0), Buffer.from(String(tx.data || '0x').replace(/^0x/, ''), 'hex'), []];
  const unsigned = Buffer.concat([Buffer.from([2]), rlp(fields)]);
  const { r, s, yParity } = signHash(keccak256(unsigned), priv);
  const raw = Buffer.concat([Buffer.from([2]), rlp([...fields, BigInt(yParity), r, s])]);
  return { raw: '0x' + raw.toString('hex'), hash: '0x' + keccak256(raw).toString('hex') };
}

// ---------- EIP-712 for EIP-3009 TransferWithAuthorization ----------
const DOMAIN_TYPE = keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const TWA_TYPE = keccak256('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');
export function transferAuthDigest({ name, version, chainId, verifyingContract }, a) {
  const domain = keccak256(Buffer.from(DOMAIN_TYPE.toString('hex') + keccak256(name).toString('hex') + keccak256(version).toString('hex') + word(chainId) + encodeOne('address', verifyingContract), 'hex'));
  const struct = keccak256(Buffer.from(TWA_TYPE.toString('hex') + encodeOne('address', a.from) + encodeOne('address', a.to) + word(a.value) + word(a.validAfter) + word(a.validBefore) + encodeOne('bytes32', a.nonce), 'hex'));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domain, struct]));
}
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

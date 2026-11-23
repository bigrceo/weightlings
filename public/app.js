// The meadow: an isometric pixel world at night, one creature per living being. The server is authoritative; this file only observes.
// Speed: ONE requestAnimationFrame loop draws the world, the sky signal, the minimap and the 3D brain preview in the card.
// Sprites, light pools, glyphs and the sky are cached canvases; draw lists are reused arrays sorted in place; no gradient or
// array is created per creature per frame; off-screen things are skipped; the render scale starts at devicePixelRatio (max 2)
// and steps down on a slow machine; HUD text is written only when it changes.
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const safe = (p) => api(p).catch(() => null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
const setHTML = (el, h) => { if (el && el.__h !== h) { el.__h = h; el.innerHTML = h; } };
let brainOn = false; // the full-screen brain view (see the end of the drawer section) is open: the meadow underneath stops drawing
$('#connect').onclick = openSummon; $('#connect2').onclick = openSummon;

const cv = $('#world'), ctx = cv.getContext('2d', { alpha: false });
const TW = 32, TH = 16, W = 56, H = 56;
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = (x, y) => Math.sin(x * 0.21 + Math.sin(y * 0.13) * 2) + Math.cos(y * 0.19 + Math.sin(x * 0.11) * 2);
const iso = (i, j) => [(i - j) * TW / 2, (i + j) * TH / 2];
const riverJ = (i) => 9 + 4 * Math.sin(i / 6.5) + i * 0.08;
const isWater = (i, j) => Math.abs(j - riverJ(i)) < 1.4;
const nearWater = (i, j) => Math.abs(j - riverJ(i)) < 2.6;
const TIERC = {}; for (const k in TIER) TIERC[k] = TIER[k][0]; // cards.js: the same colours as server/models.mjs
const TIER_KEYS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const SIG = '#5cf2a8', DIE = '#ff3f8e', CLOCK = '#ffb81f';
const FD = "'Chakra Petch', Inter, sans-serif"; // the display face (ds.css), for figures and names painted in the world

// ---------- terrain prerender: night, lit by signal ----------
const OX = H * TW / 2 + 40, OY = 120;
const ground = document.createElement('canvas'); ground.width = (W + H) * TW / 2 + 80; ground.height = (W + H) * TH / 2 + 240;
const bankDist = (i, j) => Math.abs(j - riverJ(i));
const pathV = (i, j) => Math.abs(Math.sin(i * 0.11 + 1.3) * 9 + 30 - j + Math.sin(i * 0.37) * 1.5);
{
  const g = ground.getContext('2d');
  const GR = [['#0d231a', '#10291f', '#0b1e16'], ['#112b1f', '#143224', '#0e261b'], ['#163425', '#1a3d2b', '#133022'], ['#1b3f2c', '#204833', '#183a29']];
  const WA = [['#040c1f', '#061026', '#030a1a'], ['#071533', '#091a3c', '#06122d'], ['#0b1f47', '#0e2552', '#091a3e']];
  const SAND = ['#232319', '#2a291f', '#1e1e16'], DIRT = ['#17140f', '#1c1913', '#13110c'];
  const diamond = (X, Y, pal, i, j) => { for (let r = 0; r < TH; r++) { const half = r < TH / 2 ? (r + 1) * 2 : (TH - r) * 2; g.fillStyle = pal[(r * 7 + i * 3 + j * 5) % 5 === 0 ? 1 : (r + i) % 7 === 0 ? 2 : 0]; g.fillRect(X - half, Y + r, half * 2, 1); } };
  for (let s = 0; s < W + H; s++) for (let i = 0; i <= s; i++) {
    const j = s - i; if (i >= W || j >= H) continue;
    const [x, y] = iso(i, j); const X = x + OX, Y = y + OY;
    const bd = bankDist(i, j), water = bd < 1.4;
    if (water) { diamond(X, Y, WA[bd < 0.5 ? 0 : bd < 1 ? 1 : 2], i, j); if (rnd() < 0.3) { g.fillStyle = '#1d3f8a'; g.fillRect(X - 5 + ((rnd() * 8) | 0), Y + 4 + ((rnd() * 6) | 0), 4, 1); } if (bd < 1 && rnd() < 0.05) { g.fillStyle = '#0f3324'; g.fillRect(X - 3, Y + 5, 6, 3); g.fillRect(X - 2, Y + 4, 4, 5); g.fillStyle = '#d2ffe8'; g.fillRect(X, Y + 5, 1, 1); } continue; }
    if (bd < 2.1) { diamond(X, Y, SAND, i, j); if (rnd() < 0.2) { g.fillStyle = '#35332a'; g.fillRect(X + ((rnd() - 0.5) * 14) | 0, Y + 6, 2, 1); } continue; }
    const pv = pathV(i, j);
    if (pv < 0.75 && i > 5 && i < W - 5) { diamond(X, Y, DIRT, i, j); if (rnd() < 0.25) { g.fillStyle = '#2a251b'; g.fillRect(X + ((rnd() - 0.5) * 14) | 0, Y + 5 + ((rnd() * 5) | 0), 2, 1); } if (i % 3 === 0) { g.fillStyle = 'rgba(92,242,168,.32)'; g.fillRect(X, Y + 7, 1, 1); } continue; }
    const n = noise(i, j) + 0.5 * Math.sin(i * 0.9) * Math.cos(j * 0.8);
    const pal = GR[n > 0.9 ? 3 : n > 0.1 ? 2 : n > -0.8 ? 1 : 0];
    diamond(X, Y, pal, i, j);
    for (let k = 0; k < 6; k++) { const px = X + ((rnd() - 0.5) * TW * 0.7) | 0, py = Y + 3 + ((rnd() * (TH - 6)) | 0); g.fillStyle = rnd() < 0.6 ? pal[1] : '#1f4733'; g.fillRect(px, py, 1, 2); }
    // night flowers: a single lit pixel, mostly signal-white
    if (rnd() < 0.07) { const c = ['#d2ffe8', '#5cf2a8', '#9fd8ff', '#b98cff'][(rnd() * 4.2) | 0] || '#d2ffe8', px = X + ((rnd() - 0.5) * 16) | 0; g.fillStyle = '#123a28'; g.fillRect(px, Y + 7, 1, 2); g.globalAlpha = 0.75; g.fillStyle = c; g.fillRect(px, Y + 6, 1, 1); g.globalAlpha = 0.25; g.fillRect(px - 1, Y + 5, 3, 3); g.globalAlpha = 1; }
    if (rnd() < 0.06) { const px = X + ((rnd() - 0.5) * 14) | 0; g.fillStyle = '#163a2a'; g.fillRect(px, Y + 3, 1, 5); g.fillRect(px + 2, Y + 4, 1, 4); g.fillRect(px - 2, Y + 5, 1, 3); }
  }
  // the survey grid: a dotted trace every four tiles, like an instrument laid over the field
  g.fillStyle = 'rgba(140,255,200,.085)';
  for (let k = 4; k < W; k += 4) for (let t = 0; t < H * 8; t += 2) {
    const f = t / 8; let a = iso(k, f); if (!isWater(k, f) && bankDist(k, f) > 2.1) g.fillRect((a[0] + OX) | 0, (a[1] + OY) | 0, 1, 1);
    a = iso(f, k); if (!isWater(f, k) && bankDist(f, k) > 2.1) g.fillRect((a[0] + OX) | 0, (a[1] + OY) | 0, 1, 1);
  }
  // cliff: a lit lip, then strata fading into the dark
  const side = (X, Y, w, cols) => { cols.forEach(([c, h0, h1]) => { g.fillStyle = c; g.fillRect(X, Y + h0, w, h1 - h0); }); };
  for (let i = 0; i < W; i++) {
    const [x, y] = iso(i, H - 1); side(x + OX - TW / 2, y + OY + TH / 2, TW / 2, [['#123224', 0, 3], ['#0c1712', 3, 14], ['#0a120e', 14, 26], ['#080d0b', 26, 40], ['#050807', 40, 54]]);
    const [x2, y2] = iso(W - 1, i); side(x2 + OX, y2 + OY + TH / 2, TW / 2, [['#163a2a', 0, 3], ['#0f1c16', 3, 14], ['#0c1511', 14, 26], ['#090f0c', 26, 40], ['#060a08', 40, 54]]);
    g.fillStyle = 'rgba(92,242,168,.4)'; g.fillRect(x + OX - TW / 2, y + OY + TH / 2, TW / 2, 1); g.fillRect(x2 + OX, y2 + OY + TH / 2, TW / 2, 1);
    if (i % 2 === 0) { g.fillStyle = 'rgba(140,255,200,.12)'; g.fillRect(x + OX - TW / 2 + 4, y + OY + TH / 2 + 20, 1, 1); g.fillRect(x2 + OX + 8, y2 + OY + TH / 2 + 30, 1, 1); }
    if (i % 5 === 2) { g.fillStyle = '#050807'; g.fillRect(x + OX - TW / 2 + 3, y + OY + TH / 2 + 54, 6, 8 + (i % 3) * 5); g.fillRect(x2 + OX + 4, y2 + OY + TH / 2 + 54, 6, 6 + (i % 4) * 5); }
  }
}
// visible window of a world-space canvas (ground, trails, maze), drawn in one call
let hw = 0, hh = 0;
function blitWorld(img) {
  const sx0 = Math.max(0, Math.floor(camX + OX - hw / zoom)), sy0 = Math.max(0, Math.floor(camY + OY - hh / zoom));
  const sx1 = Math.min(img.width, Math.ceil(camX + OX + hw / zoom) + 1), sy1 = Math.min(img.height, Math.ceil(camY + OY + hh / zoom) + 1);
  if (sx1 <= sx0 || sy1 <= sy0) return;
  ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, Math.round((sx0 - OX - camX) * zoom + hw), Math.round((sy0 - OY - camY) * zoom + hh), (sx1 - sx0) * zoom, (sy1 - sy0) * zoom);
}

// ---------- sprites (all built once) ----------
function spriteFrom(rows, colors) { const c = document.createElement('canvas'); c.width = rows[0].length; c.height = rows.length; const g = c.getContext('2d'); rows.forEach((r, y) => [...r].forEach((ch, x) => { if (colors[ch]) { g.fillStyle = colors[ch]; g.fillRect(x, y, 1, 1); } })); return c; }
const mirror = (rows) => rows.map((r) => [...r].reverse().join(''));
function treeSprite(v) {
  const c = document.createElement('canvas'); c.width = 34; c.height = 46; const g = c.getContext('2d');
  g.fillStyle = '#120c08'; g.fillRect(15, 28, 5, 16); g.fillStyle = '#1e150d'; g.fillRect(15, 28, 2, 16);
  const blobs = [[17, 20, 13], [10, 24, 8], [24, 24, 8], [17, 12, 9]];
  const pal = [['#04110b', '#0a1d14', '#10291d', '#1b4232'], ['#051209', '#0b2016', '#123020', '#1f4a38'], ['#06120a', '#0e2214', '#16331d', '#24502e']][v];
  for (const [x, y, r] of blobs) for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) { const d = Math.hypot(xx, yy * 1.1); if (d > r) continue; const lit = (-xx - yy) / r; g.fillStyle = pal[lit > 0.7 ? 3 : lit > 0.1 ? 2 : lit > -0.5 ? 1 : 0]; if ((xx + yy) % 5 === 0 && d > r - 2) continue; g.fillRect(x + xx, y + yy, 1, 1); }
  // a signal rim on the lit edge
  g.fillStyle = 'rgba(92,242,168,.5)';
  for (const [x, y, r] of blobs) for (let a = 3.6; a < 5.6; a += 0.22) { const xx = Math.round(Math.cos(a) * (r - 0.5)), yy = Math.round(Math.sin(a) * (r - 0.5) / 1.1); if ((xx + yy) % 3) g.fillRect(x + xx, y + yy, 1, 1); }
  return c;
}
const TREES = [0, 1, 2].map(treeSprite);
const ROCK = spriteFrom(['..KKKK..', '.KLLLLK.', 'KLLMLLLK', 'KMLLLMLK', '.KMMMMK.'], { K: '#0d141b', L: '#2b3a4d', M: '#1a2633' });
const BUSH = spriteFrom(['...GGGG....', '.GGHGGGGG..', 'GGGGGRGGHG.', 'GHGRGGGGGGG', 'GGGGGGHGRGG', '.GGRGGGGGG.', '..GGGGGGG..'], { G: '#0b2519', H: '#17402d', R: '#9dffd0' });
// graves: a small stone carrying a cut glyph in the dead creature's tier colour
const GRAVE_ROWS = ['..SSS..', '.SLLLS.', '.SGLGS.', '.SLGLS.', '.SGLGS.', '.SLLLS.', 'SSSSSSS', '.DDDDD.'];
const GRAVES = {}; for (const k of TIER_KEYS) GRAVES[k] = spriteFrom(GRAVE_ROWS, { S: '#1c2622', L: '#2a3832', G: TIERC[k], D: '#050806' });
const BERRY = spriteFrom(['.cc.', 'cbbc', 'bbbd', '.dd.'], { c: '#eafff4', b: SIG, d: '#1f8a5e' });
let bushes = []; safe('/api/scene').then((r) => { if (r && Array.isArray(r.bushes)) { bushes = r.bushes; scenDirty = true; } });
const ROWS = [
  '.A.......A.',
  '..A.....A..',
  '...KKKKK...',
  '..KKSKSKK..',
  '.KKWPKWPKK.',
  '.KKKKKKKKK.',
  '.KKKKMKKKK.',
  '..KKKKKKK..',
  '...L...L...'];
const TSCALE = { legendary: 1.55, epic: 1.35, rare: 1.18, uncommon: 1.05, common: 0.95 };
const sprCache = new Map();
// [facing right, facing left]: flipped once here, never with save/scale/restore per frame
function critter(tier) {
  let s = sprCache.get(tier);
  if (!s) { const c = TIERC[tier] || TIERC.common, pal = { A: '#ffffff', K: c, S: '#ffffffaa', W: '#ffffff', P: '#06090a', M: '#06090a', L: '#6b7770' }; s = [spriteFrom(ROWS, pal), spriteFrom(mirror(ROWS), pal)]; sprCache.set(tier, s); }
  return s;
}
const logos = {}; function logoImg(src) { if (!logos[src]) { const i = new Image(); i.src = src; logos[src] = i; } return logos[src].complete && logos[src].naturalWidth ? logos[src] : null; }
const MODELS = {}; safe('/api/genes').then((L) => { if (Array.isArray(L)) { L.forEach((m) => (MODELS[m.id] = m)); for (const b of agents.values()) b.tier = MODELS[b.model]?.tier || 'common'; scenDirty = true; skyData(); } });

// ---------- scenery ----------
const props = [];
seed = 99;
for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
  if (isWater(i, j)) continue;
  const edge = Math.min(i, j, W - 1 - i, H - 1 - j), d = Math.hypot(i - 30, j - 30);
  const p = edge < 4 ? 0.45 : d > 20 ? 0.12 : d > 14 ? 0.03 : 0;
  if (rnd() < p && !nearWater(i, j)) props.push({ i: i + 0.5, j: j + 0.5, d: i + j + 1, img: TREES[(rnd() * 3) | 0], ox: 17, oy: 42, s: 1.1 });
  else if (nearWater(i, j) && rnd() < 0.06) props.push({ i: i + 0.5, j: j + 0.5, d: i + j + 1, img: ROCK, ox: 4, oy: 4, s: 1 });
}
// static draw list (scenery + bushes + graves), sorted by depth once; rebuilt only when bushes or graves change
let scen = [], scenDirty = true, graves = [];
function buildScen() {
  scenDirty = false; scen = props.slice();
  for (const [i, j] of bushes) scen.push({ i, j, d: i + j - 0.01, img: BUSH, ox: 5.5, oy: 6, s: 1 });
  for (const g of graves) { const t = MODELS[g[2]]?.tier || 'common'; scen.push({ i: g[0], j: g[1], d: g[0] + g[1], img: GRAVES[t] || GRAVES.common, ox: 3.5, oy: 7, s: 1, grave: 1 }); }
  scen.sort((a, b) => a.d - b.d);
}

// ---------- cached light sprites (never build gradients per creature per frame) ----------
const glowCache = new Map();
function glow(col) {
  let c = glowCache.get(col);
  if (!c) { c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, col + 'aa'); r.addColorStop(0.45, col + '33'); r.addColorStop(1, col + '00'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); glowCache.set(col, c); }
  return c;
}
// the beam that takes a creature in the cull: pink, white at its core
const BEAM = (() => { const c = document.createElement('canvas'); c.width = 32; c.height = 256; const g = c.getContext('2d'); const v = g.createLinearGradient(0, 0, 0, 256); v.addColorStop(0, 'rgba(255,63,142,0)'); v.addColorStop(0.55, 'rgba(255,63,142,.4)'); v.addColorStop(1, 'rgba(255,208,226,.95)'); g.fillStyle = v; g.fillRect(0, 0, 32, 256); g.globalCompositeOperation = 'destination-in'; const h = g.createLinearGradient(0, 0, 32, 0); h.addColorStop(0, 'rgba(0,0,0,0)'); h.addColorStop(0.5, 'rgba(0,0,0,1)'); h.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = h; g.fillRect(0, 0, 32, 256); return c; })();

// ---------- the sky: a slow rain of real model-card numbers (same glyphs as the site's signal field), its own small canvas ----------
const SKY = { cv: document.createElement('canvas'), g: null, w: 0, h: 0, px: 2, cols: 0, strs: ['70.6B 86 128K'], acc: 0, drawn: false };
SKY.g = SKY.cv.getContext('2d');
const RF = { '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001010010', '8': '111101111101111', '9': '111101111001111', '.': '000000000000010', 'B': '110101110101110', 'K': '101101110101101', ' ': '000000000000000' };
const RG = Object.keys(RF), RGI = {}; RG.forEach((k, i) => (RGI[k] = i));
const RPAL = [SIG, '#d2ffe8', ...TIER_KEYS.map((k) => TIERC[k])]; // trail, head, tiers
const RAT = (() => { const a = document.createElement('canvas'); a.width = (RG.length + 1) * 4; a.height = RPAL.length * 9; const g = a.getContext('2d'); const BR = ['.X.......X.', '..X.....X..', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.XXXXXXXXX.', '.XXXX.XXXX.', '..XXXXXXX..', '...X...X...'];
  RPAL.forEach((col, r) => { g.fillStyle = col; RG.forEach((k, i) => { for (let p = 0; p < 15; p++) if (RF[k][p] === '1') g.fillRect(i * 4 + (p % 3), r * 9 + ((p / 3) | 0), 1, 1); }); }); return { a, BR }; })();
const CR = (() => { const out = {}; RPAL.forEach((col, r) => { if (r < 2) return; out[r] = spriteFrom(RAT.BR, { X: col }); }); return out; })();
let colHead, colSpeed, colLen, colStr, colOn, colTier;
function skyData() { const L = Object.values(MODELS); if (L.length) SKY.strs = L.map((m) => `${m.params}B ${m.mmlu} ${m.ctx}K`); }
function skySize(cw, ch) {
  SKY.px = Math.max(2, Math.round(2 * rs)); const w = Math.ceil(cw / SKY.px), h = Math.ceil(ch / SKY.px);
  if (w === SKY.w && h === SKY.h) return; SKY.w = SKY.cv.width = w; SKY.h = SKY.cv.height = h; SKY.cols = Math.ceil(w / 4);
  colHead = new Float32Array(SKY.cols); colSpeed = new Float32Array(SKY.cols); colLen = new Uint8Array(SKY.cols); colStr = new Uint16Array(SKY.cols); colOn = new Uint8Array(SKY.cols); colTier = new Int8Array(SKY.cols);
  for (let c = 0; c < SKY.cols; c++) { if (Math.random() < 0.3) skySpawn(c, Math.random() * h); }
  SKY.drawn = false;
}
function skySpawn(c, y) { colOn[c] = 1; colHead[c] = y == null ? -Math.random() * 30 : y; colSpeed[c] = 10 + Math.random() * 12; colLen[c] = 4 + ((Math.random() * 10) | 0); colStr[c] = (Math.random() * 65535) | 0; colTier[c] = Math.random() < 0.18 ? 2 + ((Math.random() * 5) | 0) : -1; }
function skyStep(dt) {
  const g = SKY.g, h = SKY.h;
  for (let c = 0; c < SKY.cols; c++) { if (colOn[c]) { colHead[c] += colSpeed[c] * dt; if (colHead[c] - colLen[c] * 6 > h) colOn[c] = 0; } else if (Math.random() < dt * 0.011) skySpawn(c); }
  g.fillStyle = '#020403'; g.fillRect(0, 0, SKY.w, h);
  const S = SKY.strs;
  for (let c = 0; c < SKY.cols; c++) {
    if (!colOn[c]) continue;
    const s = S[colStr[c] % S.length], x = c * 4, hy = Math.floor(colHead[c] / 6) * 6, n = colLen[c];
    for (let k = 0; k < n; k++) {
      const y = hy - k * 6; if (y < -6 || y > h) continue;
      const ch = s[(colStr[c] + ((hy / 6) | 0) - k) % s.length] || ' ', gi = RGI[ch] ?? 13;
      g.globalAlpha = k === 0 ? 0.9 : 0.55 * (1 - k / n);
      if (k === 0 && colTier[c] > 0) { const sp = CR[colTier[c]]; g.drawImage(sp, x - 4, y - 1, 11, 9); continue; }
      g.drawImage(RAT.a, gi * 4, (k === 0 ? 1 : 0) * 9, 3, 5, x, y, 3, 5);
    }
  }
  g.globalAlpha = 1; SKY.drawn = true;
}

// ---------- camera ----------
const DPR_MAX = Math.min(2, devicePixelRatio || 1);
let rs = DPR_MAX; // render scale (device pixels per CSS pixel); steps down if frames run long
const DPR = () => rs;
let zoom = (innerWidth < 700 ? 2.4 : 3.6) * rs, zoomT = zoom, camX = 0, camY = 0, paused = false, showNames = true, showBubbles = true;
let follow = null, goal = null, ts = 1, cine = null;
const HOME = iso(30, 30);
function center() { follow = null; goal = { x: HOME[0], y: HOME[1] }; updWatch(); }
[camX, camY] = HOME;
const toScreen = (i, j) => { const [x, y] = iso(i, j); return [(x - camX) * zoom + cv.width / 2, (y - camY) * zoom + cv.height / 2]; };
function userCam() { follow = null; goal = null; if (cine) cine.user = true; if (!drawerOn()) focus = null; updWatch(); }
let drag = null; const ptrs = new Map(); let pinch = null;
cv.addEventListener('pointerdown', (e) => {
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z: zoomT }; drag = null; return; }
  drag = { x: e.clientX, y: e.clientY, cx: camX, cy: camY, moved: 0 }; cv.classList.add('drag');
  prefetchBrain();
});
addEventListener('pointermove', (e) => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; zoomT = zoom = Math.max(rs * 0.5, Math.min(6 * rs, pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d)); if (cine) cine.user = true; return; }
  if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; const was = drag.moved; drag.moved = Math.max(drag.moved, Math.hypot(dx, dy)); if (drag.moved >= 5) { if (was < 5) userCam(); camX = drag.cx - (dx * rs) / zoom; camY = drag.cy - (dy * rs) / zoom; } }
  hover(e);
});
const ptrEnd = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; };
addEventListener('pointerup', (e) => { const wasPinch = !!pinch; ptrEnd(e); if (drag && !wasPinch && drag.moved < 5 && e.target === cv) click(e); drag = null; cv.classList.remove('drag'); });
addEventListener('pointercancel', (e) => { ptrEnd(e); drag = null; cv.classList.remove('drag'); });
const setZoom = (z) => { zoomT = Math.max(rs * 0.5, Math.min(6 * rs, z)); if (cine) cine.user = true; };
cv.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoomT * (e.deltaY < 0 ? 1.12 : 0.89)); }, { passive: false });
$('#tIn').onclick = () => setZoom(zoomT * 1.25); $('#tOut').onclick = () => setZoom(zoomT / 1.25); $('#tCenter').onclick = center;
$('#tPause').onclick = (e) => { paused = !paused; e.currentTarget.classList.toggle('on', paused); e.currentTarget.setAttribute('aria-pressed', paused); };
$('#tNames').onclick = (e) => { showNames = !showNames; e.currentTarget.classList.toggle('on', showNames); e.currentTarget.setAttribute('aria-pressed', showNames); };
$('#tBubbles').onclick = (e) => { showBubbles = !showBubbles; e.currentTarget.classList.toggle('on', showBubbles); e.currentTarget.setAttribute('aria-pressed', showBubbles); };
// the render scale changed (slow machine): keep the same view
function setScale(n) { if (n === rs) return; const k = n / rs; rs = n; zoom *= k; zoomT *= k; if (cine && cine.save) cine.save.zoomT *= k; miniBg = null; }

// ---------- creatures (server is authoritative; we glide toward its positions) ----------
const agents = new Map();
let focus = null, food = [], bubbles = [], trialKey = 'famine', roundNext = 0, parts = [], lastRoundN = null;
const order = []; // living creatures, kept sorted by depth (insertion sort on nearly sorted data each frame)
// what a creature is "thinking" is read straight from its real state: the act code and energy sent by /api/world
const ACTS = { f: 'berry spotted', r: 'it remembers a bush', w: 'wandering', e: 'eating', s: 'sharing a berry' };
function thought(b) { if (b.e < 0) return 'fainted'; const a = ACTS[b.act] || ''; return b.e < 25 ? (a ? 'starving · ' + a : 'starving') : a; }
let lastCount = -1;
function syncWorld(snap) {
  if (!snap || !Array.isArray(snap.c) || !snap.round) return;
  const changed = lastRoundN !== null && snap.round.n !== lastRoundN, show = changed && !document.hidden && !brainOn;
  const seen = new Set(), born = [];
  let added = false;
  for (const [id, x, y, e, act, model, nick, holder, gen] of snap.c) {
    seen.add(id); let b = agents.get(id);
    if (!b) { b = { id, i: x, j: y, phase: Math.random() * 6, drop: 0, face: 1, hold: 0, sx: 0, sy: 0, r: 0, gx: 0, gy: 0, on: false, d: x + y }; agents.set(id, b); added = true; if (show) born.push(b); else if (lastRoundN !== null) { b.drop = 60; burst(id, '#d2ffe8', 10); } }
    b.ti = x; b.tj = y; b.e = e; b.act = act; b.model = model; b.name = nick; b.holder = holder; b.gen = gen; b.tier = MODELS[model]?.tier || 'common';
  }
  const dead = [];
  for (const [k, b] of agents) if (!seen.has(k) && !b.dying) { b.dying = 0.001; if (show) dead.push(b); else if (changed) agents.delete(k); }
  if (added || changed) { order.length = 0; for (const b of agents.values()) order.push(b); }
  food = snap.food || [];
  const g = snap.graves || []; if (g.length !== graves.length || (g[0] && graves[0] && g[0][0] !== graves[0][0])) { graves = g; scenDirty = true; }
  trialKey = snap.round.trial; roundNext = snap.round.next;
  lastRoundN = snap.round.n;
  if (show) startCull(snap.round.n, dead, born);
  const n = snap.c.length;
  if (n !== lastCount) { lastCount = n; const c = $('#cnt'); setText(c, String(n)); if (c) c.style.setProperty('--v', Math.min(1, n / 160).toFixed(3)); $$('[data-art-alive]').forEach((el) => setText(el, n.toLocaleString('en-US'))); }
  updWatch();
  const st = $('#dState'); if (st && openId != null) { const b = agents.get(openId); if (b && !b.dying) setText(st, thought(b) || '—'); }
}
function burst(id, col, n, glyph) { for (let k = 0; k < n; k++) parts.push({ id, col, glyph, a: Math.random() * 6.28, v: 6 + Math.random() * 14, t: 0, life: 0.8 + Math.random() * 0.6 }); }
function step(dt) {
  for (const b of agents.values()) {
    if (b.dying || b.hold) continue;
    if (b.drop > 0) b.drop = Math.max(0, b.drop - dt * 90);
    const di = b.ti - b.i, dj = b.tj - b.j, d = Math.hypot(di, dj);
    if (d > 6) { b.i = b.ti; b.j = b.tj; continue; }
    b.moving = d > 0.05;
    if (b.moving) { const sp = Math.max(1.2, d * 2) * dt; b.i += (di / d) * Math.min(d, sp); b.j += (dj / d) * Math.min(d, sp); b.phase += dt * 12; const sx = di - dj; if (Math.abs(sx) > 0.01) b.face = sx > 0 ? 1 : -1; }
  }
}

// ---------- neural trails: moving creatures leave a fading dotted trace in world space (one canvas, one draw per frame) ----------
const trail = document.createElement('canvas'); trail.width = ground.width; trail.height = ground.height;
const tg = trail.getContext('2d'); let trailAcc = 0, fadeAcc = 0;
function trails(dt) {
  fadeAcc += dt; trailAcc += dt;
  if (fadeAcc > 0.16) { fadeAcc = 0; tg.globalCompositeOperation = 'destination-out'; tg.fillStyle = 'rgba(0,0,0,.1)'; tg.fillRect(0, 0, trail.width, trail.height); tg.globalCompositeOperation = 'source-over'; }
  if (trailAcc < 0.14) return; trailAcc = 0;
  for (const k of TIER_KEYS) { tg.fillStyle = TIERC[k]; for (let n = 0; n < order.length; n++) { const b = order[n]; if (b.tier !== k || !b.moving || b.dying || b.hold || b.e < 0) continue; tg.fillRect(((b.i - b.j) * 16 + OX) | 0, ((b.i + b.j) * 8 + OY) | 0, 1, 1); } }
}
// ---------- same-brain links: nearby creatures that carry the same model are joined (the plague spreads along them) ----------
const links = []; let linkAcc = 1;
function updateLinks() {
  links.length = 0; const R2 = 4.5 * 4.5;
  for (let a = 0; a < order.length; a++) {
    const A = order[a]; if (!A.on || A.dying || A.hold) continue; let best = null, bd = R2;
    for (let c = a + 1; c < order.length; c++) { const B = order[c]; if (B.model !== A.model || !B.on || B.dying || B.hold) continue; const di = B.i - A.i, dj = B.j - A.j, d = di * di + dj * dj; if (d < bd) { bd = d; best = B; } }
    if (best) links.push(A, best);
  }
}

// ---------- the cull, as a sequence ----------
// 0.0 time slows, colour drains, camera pulls back · 0.8 a scan crosses the meadow, each creature that is gone gets a beam
// 2.9 the title, with the numbers /api/round reports · 5.5 colour returns, the newborns drop in · 7.4 over
const WX = H * TW / 2, WSPAN = (W + H) * TW / 2, WYS = (W + H) * TH / 2;
function startCull(n, dead, born) {
  cine = { t: 0, n, cam: !RM, user: false, save: { zoomT, x: camX, y: camY }, titled: false, untitled: false, coloured: false };
  for (const b of dead) { const [x] = iso(b.i, b.j); b.cull = true; b.beamAt = RM ? 0.4 : 0.8 + 2.0 * Math.max(0, Math.min(1, (x + WX) / WSPAN)); }
  born.forEach((b, k) => { b.hold = 5.5 + (born.length > 1 ? k / (born.length - 1) : 0) * 1.1; });
  document.body.classList.add('culling'); cv.classList.add('cull');
  $('#cullK').textContent = `Round ${n}`; $('#cullT').textContent = ''; $('#cullD').textContent = '';
  $('#tip').style.display = 'none';
  if (cine.cam) { const fit = Math.min(cv.width / (WSPAN + 120), cv.height / (WYS + 160)); zoomT = Math.min(zoomT, Math.max(fit, 0.4)); goal = { x: 0, y: WYS / 2 }; }
  if (window.blip) blip(98);
  (async () => {
    for (let k = 0; k < 5 && cine && cine.n === n; k++) {
      const r = await safe('/api/round');
      if (r && r.n === n && r.last) { const L = r.last; $('#cullK').textContent = `Round ${n}${L.trialName ? ' · ' + L.trialName : ''}`; $('#cullT').innerHTML = `<b class="die">${Number(L.died) || 0}</b> died <i>·</i> <b class="sig">${Number(L.born) || 0}</b> born`; $('#cullD').textContent = L.dominant?.name ? `Dominant model · ${L.dominant.name}` : ''; return; }
      await sleep(600);
    }
  })();
}
function cineTick(rdt) {
  if (!cine) { ts += (1 - ts) * Math.min(1, rdt * 3); return; }
  cine.t += rdt;
  ts += ((RM || cine.t > 5.4 ? 1 : 0.16) - ts) * Math.min(1, rdt * 2.5);
  if (!cine.titled && cine.t > 2.9) { cine.titled = true; $('#cull').classList.add('on'); if (window.blip) blip(196); }
  if (!cine.coloured && cine.t > 5.5) { cine.coloured = true; cv.classList.remove('cull'); if (cine.cam && !cine.user) { zoomT = cine.save.zoomT; goal = follow == null ? { x: cine.save.x, y: cine.save.y } : null; } else if (!cine.user) goal = null; cine.cam = false; }
  if (!cine.untitled && cine.t > 6.0) { cine.untitled = true; $('#cull').classList.remove('on'); }
  if (cine.t > 7.4) { cine = null; document.body.classList.remove('culling'); renderRound(); loadToll(); }
}

// ---------- maze weather: dotted walls laid over the meadow, drawn once when first needed ----------
let MAZE = null;
function mazeLayer() {
  if (MAZE) return MAZE;
  MAZE = document.createElement('canvas'); MAZE.width = ground.width; MAZE.height = ground.height; const g = MAZE.getContext('2d'); let s = 31; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#c8aaff';
  for (let i = 2; i < W - 2; i += 3) for (let j = 2; j < H - 2; j += 3) { const along = r() < 0.5; for (let t = 0; t < 3; t += 0.125) { const p = along ? iso(i + t, j) : iso(i, j + t); if ((t * 8) % 2 === 0) g.fillRect((p[0] + OX) | 0, (p[1] + OY) | 0, 1, 1); } }
  return MAZE;
}

// ---------- draw ----------
let last = performance.now(), T = 0, miniAcc = 0, skyAcc = 1, slowF = 0, okF = 0;
const drivers = new Set(); // per-frame callbacks (the card's 3D brain preview runs on this loop)
const addDriver = (f) => { drivers.add(f); return () => drivers.delete(f); };
const labels = [], beams = [];
function draw(now) {
  requestAnimationFrame(draw);
  if (brainOn) { last = now; return; }
  const raw = now - last, rdt = Math.min(0.05, Math.max(0, raw / 1000)); last = now;
  // a slow machine: if frames keep running long, draw fewer device pixels (2 -> 1.5 -> 1), never below 1
  if (!document.hidden && raw < 1000) { if (raw > 24) { slowF++; okF = 0; } else if (++okF > 30) slowF = Math.max(0, slowF - 2); if (slowF > 90 && rs > 1) { slowF = 0; setScale(rs > 1.5 ? 1.5 : 1); } }
  const dpr = rs, cw = Math.round(innerWidth * dpr), ch = Math.round(innerHeight * dpr);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  hw = cw / 2; hh = ch / 2;
  cineTick(rdt);
  const dt = paused ? 0 : rdt * ts;
  if (!paused) { T += dt; step(dt); if (!RM) trails(dt); }
  if (scenDirty) buildScen();
  // camera: smooth zoom, then follow / glide
  zoom += (zoomT - zoom) * Math.min(1, rdt * (RM ? 30 : 8));
  let g = goal;
  if (!(cine && cine.cam) && follow != null) { const b = agents.get(follow); if (b && !b.dying) { const [x, y] = iso(b.i, b.j); g = { x: x + (drawerOn() && innerWidth > 900 ? 220 * dpr / zoom : 0), y: y - 6 }; } else { follow = null; if (!drawerOn()) focus = null; updWatch(); } }
  if (g && !drag) { const k = Math.min(1, rdt * (RM ? 30 : 4.5)); camX += (g.x - camX) * k; camY += (g.y - camY) * k; if (g === goal && Math.hypot(g.x - camX, g.y - camY) < 0.4) goal = null; }
  const mx = 60 * zoom, my = 60 * zoom, vx0 = -mx, vx1 = cw + mx, vy0 = -my, vy1 = ch + my;
  // the near trial: dusk falls over the last ten minutes, its weather over the last two
  const left = roundNext ? (roundNext - (Date.now() + skew)) / 1000 : 9999, dusk = cine ? 0 : Math.max(0, Math.min(1, 1 - left / 600)), near = cine ? 0 : Math.max(0, Math.min(1, 1 - left / 120));

  // sky: redrawn on its own small canvas 15 times a second, blitted here
  skySize(cw, ch); skyAcc += rdt;
  if (!SKY.drawn || (!RM && skyAcc > 0.066)) { skyStep(RM ? 0 : Math.min(0.2, skyAcc)); skyAcc = 0; }
  ctx.imageSmoothingEnabled = false; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(SKY.cv, 0, 0, SKY.w * SKY.px, SKY.h * SKY.px);
  blitWorld(ground);
  // water: drifting ripples and the occasional glint
  ctx.fillStyle = '#5b86e6';
  for (let k = 0; k < 46; k++) { const i = (k * 1.37 + T * 0.6) % W, j = riverJ(i) + Math.sin(k * 3.1 + T) * 0.8; const x = ((i - j) * 16 - camX) * zoom + hw, y = ((i + j) * 8 - camY) * zoom + hh; if (x < -20 || x > cw + 20 || y < -20 || y > ch + 20) continue; const tw = Math.sin(T * 2.2 + k * 1.9); ctx.globalAlpha = 0.18 + 0.25 * Math.abs(tw); ctx.fillRect(x, y, 3 * zoom, zoom); if (k % 6 === 0 && tw > 0.82) { ctx.globalAlpha = (tw - 0.82) * 5; ctx.fillStyle = '#d2ffe8'; ctx.fillRect(x - zoom, y, 3 * zoom, zoom); ctx.fillRect(x, y - zoom, zoom, 3 * zoom); ctx.fillStyle = '#5b86e6'; } }
  ctx.globalAlpha = 0.5; blitWorld(trail); ctx.globalAlpha = 1;

  // creatures: screen positions, visibility, depth order (no allocation)
  let goneN = 0;
  for (let n = 0; n < order.length; n++) {
    const b = order[n];
    b.d = b.i + b.j;
    if (b.hold) { if (cine && cine.t < b.hold) { b.on = false; continue; } b.hold = 0; b.drop = 60; burst(b.id, '#d2ffe8', 12); }
    if (b.dying) { if (b.cull && cine) { b.tau = cine.t - b.beamAt; if (b.tau > 2.4) b.gone = true; } else { b.cull = false; b.dying += rdt; if (b.dying > 0.7) b.gone = true; } }
    if (b.gone) { b.on = false; goneN++; continue; }
    const x = ((b.i - b.j) * 16 - camX) * zoom + hw, y = ((b.i + b.j) * 8 - camY) * zoom + hh;
    const sc = TSCALE[b.tier] || 1, h = 9 * zoom * sc, w = 11 * zoom * sc;
    b.sx = x; b.sy = y - h / 2; b.r = Math.max(w, h) / 2; b.gx = x; b.gy = y; b.w = w; b.h = h; b.sc = sc;
    b.on = !(x < vx0 || x > vx1 || y < vy0 || y > vy1);
  }
  for (let a = 1; a < order.length; a++) { const v = order[a]; let c = a - 1; while (c >= 0 && order[c].d > v.d) { order[c + 1] = order[c]; c--; } order[c + 1] = v; }
  linkAcc += rdt; if (linkAcc > 0.25) { linkAcc = 0; updateLinks(); }

  // same-brain links, under everything that stands
  if (links.length && !cine) {
    const plague = trialKey === 'plague' ? near : 0, lw = Math.max(1, zoom * 0.22);
    ctx.lineWidth = lw;
    for (const k of TIER_KEYS) {
      let any = false; ctx.beginPath();
      for (let n = 0; n < links.length; n += 2) { const A = links[n], B = links[n + 1]; if (A.tier !== k || !A.on || !B.on || A.dying || B.dying) continue; ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); any = true; }
      if (!any) continue;
      ctx.strokeStyle = plague > 0 ? DIE : TIERC[k]; ctx.globalAlpha = 0.16 + 0.4 * plague * (0.6 + 0.4 * Math.sin(T * 4)); ctx.stroke();
    }
    // a signal runs along each link
    ctx.globalAlpha = 0.85; const ps = Math.max(1, zoom * 0.7);
    for (let n = 0; n < links.length; n += 2) { const A = links[n], B = links[n + 1]; if (!A.on || !B.on || A.dying || B.dying) continue; const f = (T * 0.45 + A.id * 0.137) % 1; ctx.fillStyle = plague > 0 ? DIE : '#d2ffe8'; ctx.fillRect(A.sx + (B.sx - A.sx) * f - ps / 2, A.sy + (B.sy - A.sy) * f - ps / 2, ps, ps); }
    ctx.globalAlpha = 1;
  }

  // light: a pool of signal under each creature, and the berries glow (additive, cached sprites)
  ctx.globalCompositeOperation = 'lighter'; ctx.imageSmoothingEnabled = true;
  const famine = trialKey === 'famine' ? near : 0;
  const bg = glow(SIG);
  for (let n = 0; n < food.length; n++) { const f = food[n], x = ((f[0] - f[1]) * 16 - camX) * zoom + hw, y = ((f[0] + f[1]) * 8 - camY) * zoom + hh; if (x < -40 || x > cw + 40 || y < -40 || y > ch + 40) continue; const R = 7 * zoom; ctx.globalAlpha = (0.32 + 0.14 * Math.sin(T * 2.4 + n)) * (1 - 0.6 * famine); ctx.drawImage(bg, x - R, y - R * 0.8, R * 2, R * 1.6); }
  for (let n = 0; n < order.length; n++) {
    const b = order[n]; if (!b.on || b.dying || b.e < 0) continue;
    const R = (b.tier === 'legendary' ? 16 : b.tier === 'epic' ? 13 : 10) * zoom; ctx.globalAlpha = (b.tier === 'legendary' ? 0.55 : 0.32) + 0.35 * dusk;
    ctx.drawImage(glow(TIERC[b.tier]), b.gx - R, b.gy - R * 0.5, R * 2, R);
    if (b.tier === 'legendary' || b.tier === 'epic') { const R2 = b.w * 1.2; ctx.globalAlpha = (b.tier === 'legendary' ? 0.45 : 0.3) * (1 + dusk); ctx.drawImage(glow(TIERC[b.tier]), b.sx - R2, b.sy - R2, R2 * 2, R2 * 2); }
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = false; ctx.globalAlpha = 1;
  // berries
  const bz = zoom * 0.8;
  for (let n = 0; n < food.length; n++) { const f = food[n], x = ((f[0] - f[1]) * 16 - camX) * zoom + hw, y = ((f[0] + f[1]) * 8 - camY) * zoom + hh; if (x < -20 || x > cw + 20 || y < -20 || y > ch + 20) continue; ctx.globalAlpha = 1 - 0.5 * famine; ctx.drawImage(BERRY, x - 2 * bz, y - 3 * bz, 4 * bz, 4 * bz); }
  ctx.globalAlpha = 1;

  // everything that stands, back to front: merge the static list with the sorted creatures
  labels.length = 0; beams.length = 0; let fl = null;
  const showLgZ = zoom > 3 * dpr, sel = focus;
  let si = 0, ci = 0; const SN = scen.length, CN = order.length;
  while (si < SN || ci < CN) {
    const takeS = ci >= CN || (si < SN && scen[si].d <= order[ci].d);
    if (takeS) {
      const p = scen[si++]; const x = ((p.i - p.j) * 16 - camX) * zoom + hw, y = ((p.i + p.j) * 8 - camY) * zoom + hh;
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      ctx.drawImage(p.img, x - p.ox * zoom * p.s, y - p.oy * zoom * p.s, p.img.width * zoom * p.s, p.img.height * zoom * p.s);
      continue;
    }
    const b = order[ci++]; if (!b.on) continue;
    const x = b.gx, y0 = b.gy, w = b.w, h = b.h, sc = b.sc, isF = sel === b.id;
    const faint = b.e < 0, hop = b.dying ? 0 : b.moving ? Math.abs(Math.sin(b.phase)) * 3 : faint ? 0 : Math.abs(Math.sin(T * 2 + b.phase)) * 0.6;
    const y = y0 - (hop + b.drop) * zoom;
    let alpha = faint ? 0.6 : 1;
    if (b.dying) { if (b.cull) { if (b.tau > 0) { alpha *= Math.max(0, 1 - b.tau / 0.9); beams.push(b); } } else alpha *= Math.max(0, 1 - b.dying / 0.7); }
    if (!b.dying && b.tier === 'legendary') { ctx.fillStyle = '#fff3c4'; for (let k = 0; k < 4; k++) { const a = T * 1.5 + k * 1.57; ctx.fillRect(x + Math.cos(a) * w * 0.7, y - h / 2 + Math.sin(a) * h * 0.5, zoom, zoom); } }
    // a hatched lineage (holder) stands between two signal ticks; the focused one inside drawn brackets
    if (!b.dying && b.holder && !isF) { ctx.fillStyle = 'rgba(92,242,168,.85)'; const ex = 8 * zoom * sc; ctx.fillRect(x - ex, y0 - zoom * 0.5, zoom * 0.8, zoom); ctx.fillRect(x + ex - zoom * 0.8, y0 - zoom * 0.5, zoom * 0.8, zoom); }
    if (alpha > 0.01) {
      const spr = critter(b.tier)[b.face < 0 ? 1 : 0];
      ctx.globalAlpha = alpha;
      if (faint) { ctx.save(); ctx.translate(x, y - h + zoom); ctx.rotate(Math.PI / 2); ctx.drawImage(spr, -w / 2, 0, w, h); ctx.restore(); }
      else ctx.drawImage(spr, x - w / 2, y - h + zoom, w, h);
      ctx.globalAlpha = 1;
    }
    if (b.dying) continue;
    if (isF) { const pad = zoom * (2 + Math.sin(T * 4) * 0.6), L = 3 * zoom, bx0 = x - w / 2 - pad, bx1 = x + w / 2 + pad, by0 = y - h - pad, by1 = y0 + pad * 0.6, t = Math.max(1, zoom * 0.4); ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx0, by0, L, t); ctx.fillRect(bx0, by0, t, L); ctx.fillRect(bx1 - L, by0, L, t); ctx.fillRect(bx1 - t, by0, t, L); ctx.fillRect(bx0, by1 - t, L, t); ctx.fillRect(bx0, by1 - L, t, L); ctx.fillRect(bx1 - L, by1 - t, L, t); ctx.fillRect(bx1 - t, by1 - L, t, L); }
    const lg = (isF || showLgZ) && MODELS[b.model] && logoImg(MODELS[b.model].logo);
    if (lg) { const ls = 6 * zoom, lx = x - ls * 0.75, ly0 = y - h - ls * 1.55; ctx.fillStyle = 'rgba(2,4,3,.86)'; ctx.fillRect(lx, ly0, ls * 1.5, ls * 1.5); ctx.fillStyle = TIERC[b.tier]; ctx.fillRect(lx, ly0, ls * 0.5, Math.max(1, zoom * 0.25)); ctx.fillRect(lx, ly0, Math.max(1, zoom * 0.25), ls * 0.5); ctx.imageSmoothingEnabled = true; ctx.drawImage(lg, x - ls / 2, ly0 + ls * 0.25, ls, ls); ctx.imageSmoothingEnabled = false; }
    if (isF && b.e >= 0) { const segs = 10, sw = 16 * zoom / segs, on = Math.round(segs * b.e / 100); ctx.fillStyle = b.e > 40 ? SIG : b.e >= 25 ? CLOCK : DIE; for (let k = 0; k < segs; k++) { ctx.globalAlpha = k < on ? 1 : 0.18; ctx.fillRect(x - 8 * zoom + k * sw, y0 + 4 * zoom, sw * 0.66, 1.5 * zoom); } ctx.globalAlpha = 1; }
    const ly = y - h - (lg ? 14 : 3) * zoom;
    if (showNames && !cine && (b.tier === 'legendary' || b.holder || isF || zoom > 4.2 * dpr)) labels.push(b, x, ly);
    if (follow === b.id || (isF && drawerOn())) fl = [b, x, showNames ? ly : ly + 8 * zoom];
  }
  // creatures whose exit has finished leave the lists
  if (goneN) { for (let n = order.length - 1; n >= 0; n--) if (order[n].gone) { agents.delete(order[n].id); order.splice(n, 1); } }
  // names: display face on a dark plate with a tick in the tier colour
  const fs = Math.max(10 * dpr, 4.4 * zoom); ctx.font = `600 ${fs}px ${FD}`; ctx.textAlign = 'center';
  for (let k = 0; k < labels.length; k += 3) { const b = labels[k], x = labels[k + 1], y = labels[k + 2]; if (b.lf !== fs || b.ln !== b.name) { b.lw = ctx.measureText(b.name).width + fs * 0.9; b.lf = fs; b.ln = b.name; } ctx.fillStyle = 'rgba(2,4,3,.78)'; ctx.fillRect(x - b.lw / 2, y - fs - 3 * dpr, b.lw, fs + 7 * dpr); ctx.fillStyle = TIERC[b.tier]; ctx.fillRect(x - b.lw / 2, y - fs - 3 * dpr, Math.max(1.5, 1.5 * dpr), fs + 7 * dpr); ctx.fillStyle = b.tier === 'legendary' ? CLOCK : focus === b.id ? '#fff' : '#e6eee8'; ctx.fillText(b.name, x, y); }
  // the followed creature's thought line, read from its live state
  if (fl && !cine) { const [b, x, ly] = fl, t = thought(b); if (t) { const f2 = Math.max(11 * dpr, 3.6 * zoom); ctx.font = `italic 500 ${f2}px Inter`; const tw = ctx.measureText(t).width + f2 * 1.6, by = ly - fs - 6 * dpr - f2 * 1.9; ctx.fillStyle = 'rgba(2,4,3,.86)'; ctx.fillRect(x - tw / 2, by, tw, f2 * 1.8); ctx.fillStyle = b.e >= 0 && b.e < 25 ? DIE : SIG; ctx.fillRect(x - tw / 2, by, 1.5 * dpr, f2 * 1.8); ctx.fillRect(x - tw / 2, by + f2 * 1.8, tw * 0.3, Math.max(1, dpr)); ctx.fillStyle = '#e6eee8'; ctx.fillText(t, x, by + f2 * 1.25); } }
  // event bubbles over the creatures involved
  if (showBubbles && !cine) for (const bb of bubbles) {
    const b = agents.get(bb.id); if (!b || !b.on || b.dying || Date.now() - bb.at > 4500) continue;
    const f3 = Math.max(11 * dpr, 4.2 * zoom); ctx.font = `500 ${f3}px Inter`; ctx.textAlign = 'left';
    if (bb.f !== f3) { bb.w = Math.min(ctx.measureText(bb.text).width, 340 * dpr) + 18 * dpr; bb.f = f3; }
    const tw = bb.w, bx = b.sx - tw / 2, by = b.sy - b.r - f3 - 34 * dpr;
    ctx.fillStyle = 'rgba(2,4,3,.88)'; ctx.fillRect(bx, by, tw, f3 + 14 * dpr); ctx.fillStyle = bb.kind === 'duel' ? DIE : SIG; ctx.fillRect(bx, by, 2 * dpr, f3 + 14 * dpr); ctx.fillRect(bx, by + f3 + 14 * dpr - Math.max(1, dpr), tw * 0.25, Math.max(1, dpr));
    ctx.fillStyle = '#e6eee8'; ctx.fillText(bb.text, bx + 10 * dpr, by + f3 + 4 * dpr, tw - 18 * dpr);
  }
  ctx.textAlign = 'center';
  // particles (hearts on a share, sparks on a duel, sparkles on a birth)
  if (parts.length) { let w = 0; for (let k = 0; k < parts.length; k++) { const p = parts[k]; if ((p.t += rdt) < p.life) parts[w++] = p; } parts.length = w;
    for (const p of parts) { const b = agents.get(p.id); if (!b || !b.on) continue; const x = b.sx + Math.cos(p.a) * p.v * p.t * zoom, y = b.sy - b.r - p.t * 16 * zoom + Math.sin(p.a) * p.v * p.t * zoom * 0.4; ctx.globalAlpha = 1 - p.t / p.life; ctx.fillStyle = p.col; if (p.glyph) { ctx.font = `${5 * zoom}px Inter`; ctx.fillText(p.glyph, x, y); } else ctx.fillRect(x, y, zoom, zoom); }
    ctx.globalAlpha = 1; }
  // dusk: the field darkens and the signal pools carry the light (drawn above); motes of signal rise
  if (dusk > 0) { ctx.fillStyle = `rgba(1,3,8,${0.42 * dusk})`; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#d2ffe8';
    for (let k = 0; k < 36; k++) { const fx = ((k * 211 % 997) / 997 + Math.sin(T * 0.2 + k) * 0.02) * cw, fy = (((k * 613 % 991) / 991 - T * 0.006 * (1 + k % 3)) % 1 + 1) % 1 * ch; ctx.globalAlpha = dusk * (0.25 + 0.6 * Math.abs(Math.sin(T * 1.5 + k))); ctx.fillRect(fx, fy, 1.5 * dpr, 1.5 * dpr); }
    ctx.globalAlpha = 1; }
  if (near > 0) {
    if (trialKey === 'storm') { ctx.strokeStyle = `rgba(160,200,255,${0.45 * near})`; ctx.lineWidth = dpr; ctx.beginPath(); for (let k = 0; k < 140; k++) { const x = (k * 97 % 1000) / 1000 * cw, y = ((k * 331 % 1000) / 1000 * ch + T * 900 * dpr) % ch; ctx.moveTo(x, y); ctx.lineTo(x - 5 * dpr, y + 16 * dpr); } ctx.stroke(); if (!RM && Math.sin(T * 1.7) > 0.992) { ctx.fillStyle = 'rgba(210,255,232,.22)'; ctx.fillRect(0, 0, cw, ch); } }
    if (trialKey === 'famine') { ctx.fillStyle = `rgba(120,70,10,${0.2 * near})`; ctx.fillRect(0, 0, cw, ch); ctx.fillStyle = CLOCK; for (let k = 0; k < 50; k++) { const x = (((k * 389 % 1000) / 1000 + T * 0.01 * (1 + k % 4)) % 1) * cw, y = (((k * 157 % 1000) / 1000 + T * 0.02) % 1) * ch; ctx.globalAlpha = 0.35 * near; ctx.fillRect(x, y, 2 * dpr, dpr); } ctx.globalAlpha = 1; }
    if (trialKey === 'plague') { ctx.globalCompositeOperation = 'lighter'; ctx.imageSmoothingEnabled = true; const gs = glow('#78dc5a'); ctx.globalAlpha = 0.22 * near; for (let k = 0; k < 26; k++) { const x = ((k * 173 % 1000) / 1000 + T * 0.01) % 1 * cw, y = (k * 577 % 1000) / 1000 * ch, R = (60 + k % 5 * 20) * dpr; ctx.drawImage(gs, x - R, y - R, R * 2, R * 2); } ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false; ctx.globalCompositeOperation = 'source-over'; }
    if (trialKey === 'maze') { ctx.globalAlpha = 0.55 * near; blitWorld(mazeLayer()); ctx.globalAlpha = 1; ctx.font = `600 ${14 * dpr}px ${FD}`; ctx.fillStyle = '#c8aaff'; for (let k = 0; k < 30; k++) { ctx.globalAlpha = 0.45 * near * Math.abs(Math.sin(T + k)); ctx.fillText('+=#%@'[k % 5], (k * 311 % 1000) / 1000 * cw, ((k * 127 % 1000) / 1000 * ch - T * 20 * dpr + ch * 4) % ch); } ctx.globalAlpha = 1; }
  }
  // the cull: a scan line, then one beam and one name for each creature that is gone
  if (cine) {
    // colour drains inside the canvas (a CSS filter on a full-screen canvas can composite to black on some GPUs)
    { const gk = Math.min(1, cine.t / 1.1, Math.max(0, (6.6 - cine.t) / 1.1)); if (gk > 0) { ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = `rgba(128,128,128,${gk})`; ctx.fillRect(0, 0, cw, ch); ctx.globalCompositeOperation = 'source-over'; } }
    ctx.fillStyle = `rgba(0,0,0,${0.28 * Math.min(1, cine.t / 0.8, Math.max(0, (6.4 - cine.t) / 0.9))})`; ctx.fillRect(0, 0, cw, ch);
    if (!RM && cine.t > 0.8 && cine.t < 2.8) { const sx = ((cine.t - 0.8) / 2 * WSPAN - WX - camX) * zoom + hw; ctx.fillStyle = 'rgba(92,242,168,.07)'; ctx.fillRect(sx - 60 * dpr, 0, 60 * dpr, ch); ctx.fillStyle = 'rgba(210,255,232,.7)'; ctx.fillRect(sx, 0, Math.max(1, dpr), ch); }
    if (beams.length) { const f4 = Math.max(10 * dpr, 4 * zoom); ctx.font = `600 ${f4}px ${FD}`;
      ctx.imageSmoothingEnabled = true; ctx.globalCompositeOperation = 'lighter';
      if (!RM) for (const b of beams) { const env = Math.sin(Math.PI * Math.min(1, b.tau / 1.5)); if (env <= 0) continue; const bw = Math.max(6 * dpr, (4 + 10 * env) * zoom); ctx.globalAlpha = env * 0.9; ctx.drawImage(BEAM, b.gx - bw / 2, -10, bw, b.gy + 10); }
      ctx.globalCompositeOperation = 'source-over'; ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#ffd0e2';
      for (const b of beams) { const a = Math.min(1, b.tau / 0.3) * Math.max(0, 1 - b.tau / 2.2); if (a <= 0) continue; ctx.globalAlpha = a; ctx.fillText(b.name.toUpperCase(), b.gx, b.gy - b.r * 2 - (6 + b.tau * 14) * zoom); }
      ctx.globalAlpha = 1; }
  }
  miniAcc += rdt; if (miniAcc > 0.12) { miniAcc = 0; drawMini(dpr); }
  for (const f of drivers) { try { if (f(now) === false) drivers.delete(f); } catch { drivers.delete(f); } }
}
requestAnimationFrame(draw);

// ---------- minimap ----------
const mini = $('#mini'), mctx = mini.getContext('2d'); let miniBg = null;
function drawMini(dpr) {
  if (document.body.classList.contains('map-off') && innerWidth <= 860) return;
  const w = Math.round(mini.clientWidth * dpr), h = Math.round(mini.clientHeight * dpr); if (!w || !h) return;
  if (mini.width !== w || mini.height !== h || !miniBg) { mini.width = w; mini.height = h; miniBg = null; }
  const X = (x) => (x + WX) / WSPAN * w, Y = (y) => y / WYS * h;
  if (!miniBg) { miniBg = document.createElement('canvas'); miniBg.width = w; miniBg.height = h; const g = miniBg.getContext('2d'); const tw = Math.ceil(w / W) + 1, th = Math.ceil(h / H / 1); for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) { const [x, y] = iso(i, j); g.fillStyle = isWater(i, j) ? '#0b1f47' : (i % 4 === 0 || j % 4 === 0) ? '#103024' : '#0c2219'; g.fillRect(X(x) - tw / 2, Y(y), tw, Math.max(1, th / 2 + 1)); } }
  mctx.clearRect(0, 0, w, h); mctx.drawImage(miniBg, 0, 0);
  const d = Math.max(2, Math.round(1.6 * dpr));
  for (let n = 0; n < order.length; n++) { const b = order[n]; if (b.dying || b.hold) continue; const x = X((b.i - b.j) * 16), y = Y((b.i + b.j) * 8), s = b.tier === 'legendary' ? d + dpr : d; mctx.globalAlpha = b.e < 0 ? 0.45 : 1; mctx.fillStyle = TIERC[b.tier]; mctx.fillRect(x - s / 2, y - s / 2, s, s); if (b.id === focus) { mctx.strokeStyle = '#fff'; mctx.lineWidth = dpr; mctx.strokeRect(x - s / 2 - 2 * dpr, y - s / 2 - 2 * dpr, s + 4 * dpr, s + 4 * dpr); } }
  mctx.globalAlpha = 1;
  // the view, drawn as four corner brackets
  const vw = cv.width / zoom, vh = cv.height / zoom, rx = Math.max(1, X(camX - vw / 2)), ry = Math.max(1, Y(camY - vh / 2)), rw = Math.min(w - 2, vw / WSPAN * w), rh = Math.min(h - 2, vh / WYS * h), L = Math.max(4, Math.min(rw, rh) * 0.28), t = Math.max(1, dpr);
  mctx.fillStyle = SIG;
  mctx.fillRect(rx, ry, L, t); mctx.fillRect(rx, ry, t, L); mctx.fillRect(rx + rw - L, ry, L, t); mctx.fillRect(rx + rw - t, ry, t, L);
  mctx.fillRect(rx, ry + rh - t, L, t); mctx.fillRect(rx, ry + rh - L, t, L); mctx.fillRect(rx + rw - L, ry + rh - t, L, t); mctx.fillRect(rx + rw - t, ry + rh - L, t, L);
}
{ let down = false; const jump = (e) => { const r = mini.getBoundingClientRect(); if (!r.width) return; userCam(); camX = (e.clientX - r.left) / r.width * WSPAN - WX; camY = (e.clientY - r.top) / r.height * WYS; };
  mini.addEventListener('pointerdown', (e) => { down = true; try { mini.setPointerCapture(e.pointerId); } catch {} jump(e); });
  mini.addEventListener('pointermove', (e) => down && jump(e)); mini.addEventListener('pointerup', () => (down = false)); mini.addEventListener('pointercancel', () => (down = false)); }

function pick(e) { const x = e.clientX * rs, y = e.clientY * rs; let best = null, bd = 1e9; for (const b of agents.values()) { if (!b.on || b.dying || b.hold) continue; const d = Math.hypot(b.sx - x, b.sy - y); if (d < Math.max(14 * rs, b.r * 1.2) && d < bd) { bd = d; best = b; } } return best; }
let tipOn = false, tipFor = null;
function hover(e) {
  const b = e.target === cv && !cine && !drag ? pick(e) : null; const tip = $('#tip');
  if (!b) { if (tipOn) { tip.style.display = 'none'; tipOn = false; } cv.classList.remove('pt'); return; }
  if (!tipOn) { tip.style.display = 'block'; tipOn = true; }
  cv.classList.add('pt'); prefetchBrain();
  tip.style.transform = `translate(${e.clientX}px,${e.clientY}px) translate(-50%,-150%)`;
  const key = b.id + b.name; if (tipFor !== key) { tipFor = key; tip.innerHTML = `<b style="color:${TIERC[b.tier]}">${esc(b.name)}</b><span>${esc(MODELS[b.model]?.name || b.model)}</span><span>${b.tier.toUpperCase()}</span>`; }
}
function click(e) { if (cine) return; const b = pick(e); if (b) openAgent(b.id); }

// ---------- follow / watch ----------
const drawerOn = () => $('#drawer').classList.contains('on');
let weakK = 0, legK = 0, note = null;
function watch(id) {
  const b = agents.get(id); if (!b) return;
  follow = id; focus = id; goal = null; zoomT = Math.max(zoomT, (innerWidth < 700 ? 3.2 : 4.4) * rs);
  if (drawerOn()) openAgent(id); updWatch();
}
function living() { return [...agents.values()].filter((b) => !b.dying && !b.hold); }
$('#tWeak').onclick = () => { if (cine) return; const L = living().sort((a, b) => a.e - b.e).slice(0, 8); if (L.length) watch(L[weakK++ % L.length].id); };
$('#tLegend').onclick = () => { if (cine) return; const L = living().filter((b) => b.tier === 'legendary').sort((a, b) => a.id - b.id); if (L.length) watch(L[legK++ % L.length].id); else { note = { text: 'No legendary creature is alive right now.', until: Date.now() + 3500 }; updWatch(); setTimeout(updWatch, 3600); } };
function updWatch() {
  const el = $('#watch'); if (!el) return;
  const b = follow != null ? agents.get(follow) : null;
  if (b && !b.dying && !drawerOn()) {
    setHTML(el, `<span class="ds-label ds-label--cr ds-label--sig">Watching</span><b style="--c:${TIERC[b.tier]}">${esc(b.name)}</b><span class="m">${esc(MODELS[b.model]?.name || b.model)} · ${b.e < 0 ? 'fainted' : 'energy <em>' + b.e + '</em>'}${thought(b) && b.e >= 0 ? ' · ' + esc(thought(b)) : ''}</span><span class="acts"><a data-a="open" role="button" tabindex="0">Open file</a><a data-a="stop" role="button" tabindex="0">Release</a></span>`);
    el.classList.add('on'); return;
  }
  if (note && Date.now() < note.until) { setHTML(el, `<span class="m">${esc(note.text)}</span>`); el.classList.add('on'); return; }
  el.classList.remove('on');
}
$('#watch').onclick = (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'open' && follow != null) openAgent(follow); if (a === 'stop') { follow = null; focus = null; updWatch(); } };

// ---------- drawer: the creature's file, with its brain already drawn at the top ----------
let openId = null, pollT = null, cur = null, slipOn = null;
function closeDrawer() { $('#drawer').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); openId = null; clearTimeout(pollT); unmountCardBrain(); if (follow == null) focus = null; updWatch(); }
$('#dClose').onclick = closeDrawer;
const DLOAD = '<div class="loading" role="status"><i></i>Reading the file</div>';
async function openAgent(id, repoll) {
  openId = id; focus = id; if (!repoll) { follow = id; goal = null; } $('#drawer').classList.add('on'); $('#drawer').removeAttribute('aria-hidden'); clearTimeout(pollT); updWatch();
  const live0 = agents.get(id);
  if (!repoll) {
    $('#dBody').innerHTML = DLOAD; $('#dIn').scrollTop = 0;
    // the brain first: drawn from what the meadow already knows, before the file arrives
    const m0 = live0 && MODELS[live0.model];
    if (m0 && dbId !== id) mountCardBrain(id, m0, live0.tier, { id, alive: true, energy: live0.e < 0 ? null : live0.e, act: live0.act, down: live0.e < 0 });
    else if (dbId !== id) clearCardBrain();
  }
  const a = await safe('/api/being/' + id); if (openId !== id) return;
  if (!a || a.error || !a.modelCard) { if (!repoll) $('#dBody').innerHTML = '<div class="loading">Not found</div>'; return; }
  cur = a; const m = a.modelCard, t = TIER[m.tier] || TIER.common, b = agents.get(id);
  if (dbId !== id || $('#dPlate').classList.contains('fail')) mountCardBrain(id, m, m.tier, a);
  $('#dTitle').textContent = a.alive ? 'Subject · alive' : 'Subject · dead';
  $('#drawer').classList.toggle('dead', !a.alive);
  const S = m.stats || {}, sc = $('#dIn').scrollTop, done = repoll ? ' is-drawn' : '';
  $('#dBody').innerHTML = `<h3 class="dname"><canvas id="dBird" width="11" height="9"></canvas><span>${esc(a.nick)}</span></h3>
  <div class="ar"><span class="ds-tag" style="--c:${t[0]}">${t[1]} ${stars(t[2])}</span><span class="ds-tag ds-tag--dim">Generation ${a.gen + 1}</span>${a.mutated ? '<span class="ds-tag ds-tag--mut">Mutant</span>' : ''}</div>
  <div class="brain"><span class="lgo"><img src="${esc(m.logo)}" width="32" height="32" alt=""></span><div><div class="bn">${esc(m.name)}</div><div class="lab">${esc(m.lab)} · <b>${m.params}B</b>${m.active ? ' (' + m.active + 'B active)' : ''} · MMLU <b>${m.mmlu}</b> · <b>${m.ctx}K</b> context</div></div></div>
  ${a.alive ? `<div class="ds-label ds-label--sig lbl">Current state</div><div class="state" id="dState">${esc((b && thought(b)) || '—')}</div>` : `<div class="ds-label ds-label--die lbl">Outcome</div><div class="state end">Died in round ${a.rdied}, ${esc(a.cause)}.</div>`}
  <div class="ds-label ds-label--rule lbl">Traits from the model card</div>
  ${['perception', 'judgement', 'memory', 'strength', 'metabolism', 'cooperation'].map((k, i) => `<div class="trait"><span>${k}</span><div class="ds-meter ds-meter--thin${done}" style="--c:${t[0]};--i:${i}"><i style="--v:${(S[k] || 0).toFixed(3)}"></i></div><b>${Math.round((S[k] || 0) * 100)}</b></div>`).join('')}
  <div class="note">Simulated from model-card data. No model is called.</div>
  <div class="ds-label ds-label--rule lbl">Record</div>
  <div class="rows"><div><small>Rounds survived</small><b>${a.survived}</b></div><div><small>Energy</small><b>${a.alive ? a.energy ?? '—' : '—'}</b></div><div><small>Berries</small><b>${a.eaten}</b></div><div><small>Duels won / lost</small><b>${a.wins} / ${a.losses}</b></div><div><small>Shared</small><b>${a.shares}</b></div><div><small>Born after round</small><b>${a.rborn}</b></div></div>
  <div id="backSlot"></div>
  <div id="hireSlot"></div>
  <div class="dact"><button class="ds-btn ds-btn--sm" id="shareB">Share card</button><button class="ds-btn ds-btn--sm" id="slipB">Print slip</button><a class="ds-btn ds-btn--sm" href="/l/${esc(a.w || a.wallet || '')}">Family tree</a></div>
  <div class="dslip" id="dSlip"></div><div class="dslipact" id="dSlipAct" hidden><button class="ds-btn ds-btn--sm" id="slipSaveB">Save slip image</button></div>
  ${a.events?.length ? `<div class="ds-label ds-label--rule lbl">Recent</div>${a.events.map((e) => `<div class="mem ${e.kind === 'duel' ? 'w' : 'r'}">${esc(e.text)}</div>`).join('')}` : ''}`;
  $('#dIn').scrollTop = repoll ? sc : 0;
  const bc = $('#dBird'); bc.getContext('2d').drawImage(critter(m.tier)[0], 0, 0);
  $('#brainB').onclick = openBrain;
  setText($('#brainBS'), archLine(m.id));
  if (!ARCH) loadArch().then(() => { const e = $('#brainBS'); if (e && openId === id) e.textContent = archLine(m.id); });
  // hook for back.js: a fresh empty #backSlot on every render of the drawer (the third argument says whether this is the 15 s re-poll)
  try { window.mountBack && window.mountBack($('#backSlot'), a, { repoll: !!repoll }); } catch (e) { console.warn('[back]', e); }
  try { window.mountHire && window.mountHire($('#hireSlot'), a); } catch (e) { console.warn('[hire]', e); }
  $('#shareB').onclick = async () => { const c = document.createElement('canvas'); c.width = 1200; c.height = 675; await drawBeingCard(c, { ...a, tier: m.tier, logo: m.logo, modelName: m.name }); downloadCanvas(c, `${a.nick}.png`); shareX(`${a.nick} carries the ${m.name} model card (${t[1]}). Survived ${a.survived} rounds of natural selection.`, `${location.origin}/l/${a.w || a.wallet || ''}`); };
  // printed slip (slip.js): stays printed across the 15 s re-polls of the same creature
  const showSlip = async (instant) => {
    if (!window.printSlip) return; let ep = null, cn = null;
    if (!a.alive) { const d = await safe('/api/dead?limit=100'); const e = Array.isArray(d) && d.find((v) => v.id === id); if (e) { ep = e.epitaph; cn = e.causeName; } if (openId !== id || cur !== a) return; }
    const s = beingSlip({ ...a, modelName: m.name }, { rarity: t[1], epitaph: ep, causeName: cn });
    slipOn = id; printSlip($('#dSlip'), s.lines, { ...s, instant, follow: !instant }); $('#dSlipAct').hidden = false; if (instant) $('#dIn').scrollTop = sc;
    $('#slipSaveB').onclick = async () => { try { await document.fonts.ready; } catch {} slipSave(s.lines, s, `${a.nick}-slip.png`); };
  };
  if (!window.printSlip) $('#slipB').style.display = 'none';
  $('#slipB').onclick = () => showSlip(false);
  if (repoll && slipOn === id) showSlip(true); else if (!repoll) slipOn = null;
  pollT = setTimeout(() => openId === id && openAgent(id, true), 15000);
}

// ---------- the brain in the card: a 2D plate drawn at once, then the live 3D preview (three.js fetched once, cached) ----------
let ARCH = null, archP = null, brainMod = null, brainH = null, brainTok = 0, brainBack = null;
const loadArch = () => archP || (archP = fetch('/arch.json').then((r) => r.json()).then((j) => (ARCH = (j && j.models) || {})).catch(() => { archP = null; return null; }));
const loadBrain = () => Promise.all([brainMod || (brainMod = import('/brain3d.js').catch((e) => { brainMod = null; throw e; })), loadArch()]);
let prefetched = false;
function prefetchBrain() { if (prefetched) return; prefetched = true; loadBrain().catch(() => { prefetched = false; }); }
const archLine = (mid) => { const x = ARCH && ARCH[mid]; return x && x.layers && x.attentionHeads ? `3D · ${x.layers} layers · ${x.attentionHeads} heads` : '3D'; };
let dbH = null, dbId = null, dbTok = 0, dbCard = null, dbCap = '';
function clearCardBrain() { unmountCardBrain(); const p = $('#dPlate'); if (p) { p.classList.add('is-loading'); p.classList.remove('ready'); } const c = $('#dPh'); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); setText($('#dCapL'), ''); setText($('#dCapR'), ''); }
function unmountCardBrain() { dbTok++; if (dbH) { try { dbH.dispose(); } catch {} } dbH = null; dbId = null; }
// what the meadow knows of a creature right now (energy and act from /api/world): null once it is gone, undefined before the first poll
const liveOf = (id) => { const b = agents.get(id); return b ? (b.dying ? null : { e: b.e, act: b.act }) : lastRoundN === null ? undefined : null; };
function mountCardBrain(id, model, tier, being) {
  unmountCardBrain();
  const tok = dbTok, plate = $('#dPlate'), arch = () => (ARCH && ARCH[model.id]) || null;
  dbId = id; dbCard = { model, tier, being };
  plate.classList.add('is-loading'); plate.classList.remove('ready', 'fail');
  plate.style.setProperty('--t', TIERC[tier] || SIG);
  setText($('#dCapL'), model.name || ''); setText($('#dCapR'), being.alive === false ? 'dead' : 'signal');
  setText($('#brainBS'), archLine(model.id));
  drawPlate($('#dPh'), arch(), tier, being.alive === false);
  if (!ARCH) loadArch().then(() => { if (tok === dbTok && !plate.classList.contains('ready')) { drawPlate($('#dPh'), arch(), tier, being.alive === false); setText($('#brainBS'), archLine(model.id)); } });
  const t0 = performance.now();
  loadBrain().then(([mod]) => {
    if (tok !== dbTok || !drawerOn() || brainOn) return;
    dbH = mod.mountBrain3D($('#d3'), { compact: true, fps: 30, model, arch: arch(), tier, traits: model.stats || {}, being, driver: addDriver,
      live: () => liveOf(id), onTap: openBrain, onState: cardState,
      onReady: () => { if (tok !== dbTok) return; plate.classList.remove('is-loading'); plate.classList.add('ready'); window.__brainReadyMs = performance.now() - t0; } });
  }).catch((e) => { console.warn('[brain]', e); if (tok === dbTok) { plate.classList.remove('is-loading'); plate.classList.add('fail'); setText($('#dCapR'), '3D unavailable'); } });
}
function cardState(s) {
  const txt = !s.alive ? 'dead' : s.fainted ? 'fainted' : `${s.thought}${s.energy != null ? ' · ' + Math.round(s.energy) : ''}`;
  if (txt !== dbCap) { dbCap = txt; setText($('#dCapR'), txt); }
}
// the instant plate: the layer stack seen from the side, one ring per layer, one dot per head (capped), in the tier colour
function drawPlate(c, arch, tier, dead) {
  if (!c) return; const r = c.getBoundingClientRect(), pr = Math.min(2, devicePixelRatio || 1), w = Math.max(1, Math.round((r.width || 360) * pr)), h = Math.max(1, Math.round((r.height || 225) * pr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d'), col = TIERC[tier] || SIG; g.clearRect(0, 0, w, h);
  const L = Math.min(96, (arch && arch.layers) || 24), Hd = Math.min(24, (arch && arch.attentionHeads) || 16), hid = (arch && arch.hiddenSize) || 4096;
  const cx = w / 2, cy = h * 0.47, AX = w * 0.36, R = h * (0.2 + 0.12 * Math.min(1, Math.max(0, Math.log2(hid / 896) / 4.2)));
  g.globalAlpha = dead ? 0.35 : 1;
  // the volume, dotted
  g.fillStyle = 'rgba(140,255,200,.22)'; for (let a = 0; a < 6.283; a += 0.035) g.fillRect(cx + Math.cos(a) * AX * 1.12, cy + Math.sin(a) * R * 1.35, pr, pr);
  // the spine
  g.fillStyle = col; g.globalAlpha = (dead ? 0.2 : 0.5); g.fillRect(cx - AX * 1.05, cy, AX * 2.1, Math.max(1, pr * 0.8));
  for (let l = 0; l < L; l++) {
    const f = (l + 0.5) / L, x = cx - AX + f * AX * 2, rr = R * Math.sqrt(Math.max(0.06, 1 - ((f * 2 - 1) * 0.92) ** 2));
    for (let k = 0; k < Hd; k++) { const a = (k / Hd) * 6.283 + l * 0.045, y = cy + Math.cos(a) * rr, z = Math.sin(a); g.globalAlpha = (dead ? 0.25 : 1) * (0.25 + 0.55 * (z * 0.5 + 0.5)); g.fillRect(x + z * rr * 0.16 - pr * 0.6, y - pr * 0.6, pr * 1.3, pr * 1.3); }
  }
  // the two end nodes
  g.globalAlpha = dead ? 0.3 : 0.9; g.fillStyle = '#d2ffe8'; g.fillRect(cx - AX * 1.08 - 2 * pr, cy - 2 * pr, 4 * pr, 4 * pr); g.fillRect(cx + AX * 1.08 - 2 * pr, cy - 2 * pr, 4 * pr, 4 * pr);
  g.globalAlpha = 1;
}

// ---------- inside the brain: full-screen 3D view (three.js and brain3d.js are fetched only when it opens) ----------
const TRAIT_KEYS = ['perception', 'judgement', 'memory', 'strength', 'metabolism', 'cooperation'];
const energyCol = (e) => (e > 40 ? SIG : e >= 25 ? CLOCK : DIE);
function renderBrainSide(a) {
  const m = a.modelCard, t = TIER[m.tier] || TIER.common, S = m.stats || {}, b = agents.get(a.id), side = $('#bxSide');
  const e = a.alive ? (b && !b.dying ? b.e : a.down ? -1 : a.energy) : null;
  side.className = 'bx-side' + (a.alive ? '' : ' dead');
  side.innerHTML = `<button class="bx-grip" id="bxGrip" aria-label="Show or hide the file"><i></i></button>
  <div class="bx-in">
    <div class="bx-k ds-label ${a.alive ? 'ds-label--cr ds-label--sig' : 'ds-label--die'}" id="bxK">${a.alive ? 'Subject · alive' : 'Subject · dead'}</div>
    <h3 class="bx-name">${esc(a.nick)}</h3>
    <div class="bx-tier"><span class="ds-tag" style="--c:${t[0]}">${t[1]} ${stars(t[2])}</span><span class="ds-tag ds-tag--dim">Generation ${a.gen + 1}</span>${a.mutated ? '<span class="ds-tag ds-tag--mut">Mutant</span>' : ''}</div>
    <div class="bx-live">
      <div class="bx-ew"><div class="ds-label lbl">Energy</div><div class="bx-energy"><b id="bxE">${e == null ? '—' : e < 0 ? 'fainted' : Math.round(e)}</b><i><u id="bxEB" style="width:${e == null ? 0 : Math.max(0, Math.min(100, e))}%;--c:${energyCol(e || 0)}"></u></i></div></div>
      <div><div class="ds-label lbl" id="bxSL">${a.alive ? 'Current state' : 'Outcome'}</div><div class="state${a.alive ? '' : ' end'}" id="bxState">${a.alive ? esc((b && thought(b)) || '—') : `Died in round ${esc(a.rdied)}, ${esc(a.cause)}.`}</div></div>
    </div>
    <div class="bx-next" id="bxNext"></div>
    <div class="bx-model"><span class="lgo"><img src="${esc(m.logo)}" width="30" height="30" alt=""></span><div><b>${esc(m.name)}</b><span>${esc(m.lab)} · ${m.params}B${m.active ? ' (' + m.active + 'B active)' : ''} · MMLU ${m.mmlu} · ${m.ctx}K context</span></div></div>
    <div class="ds-label ds-label--rule lbl">Traits from the model card</div>
    ${TRAIT_KEYS.map((k) => `<div class="trait bxt" data-k="${k}"><span>${k}</span><i><b style="width:${(S[k] || 0) * 100}%"></b></i><span>${Math.round((S[k] || 0) * 100)}</span></div>`).join('')}
    <div class="note">Simulated from model-card data. No model is called. A trait lights when the creature does the matching thing.</div>
    <div class="dact"><button class="ds-btn ds-btn--sm" id="bxSlip">Print slip</button><a class="ds-btn ds-btn--sm" href="/l/${esc(a.w || a.wallet || '')}">Family tree</a></div>
    <div class="bx-slip" id="bxSlipOut"></div>
  </div>`;
  $('#bxGrip').onclick = () => side.classList.toggle('open');
  brainClock();
  if (!window.printSlip) $('#bxSlip').style.display = 'none';
  $('#bxSlip').onclick = async () => {
    let ep = null, cn = null;
    if (!a.alive) { const d = await safe('/api/dead?limit=100'); const x = Array.isArray(d) && d.find((v) => v.id === a.id); if (x) { ep = x.epitaph; cn = x.causeName; } }
    const out = $('#bxSlipOut'); if (!out || !brainOn) return;
    const s = beingSlip({ ...a, modelName: m.name }, { rarity: t[1], epitaph: ep, causeName: cn });
    side.classList.add('open'); printSlip(out, s.lines, { ...s, follow: true });
  };
}
// the next trial, kept in view while inside the brain (the full-screen final-minute count is hidden there; see app-x.css)
function brainClock() {
  const n = $('#bxNext'); if (!n || !ROUND || !ROUND.upcoming) return;
  const ms = ROUND.next - (Date.now() + skew);
  n.classList.toggle('soon', ms <= 60000);
  setHTML(n, `Next trial · <b>${esc(ROUND.upcoming.name)}</b> <span>${ms > 0 ? 'in ' + fmtLeft(ms) : 'now'}</span>`);
}
// brain3d.js reports the creature's live state a few times a second (energy and act come from /api/world)
function brainState(s) {
  const eEl = $('#bxE'), bar = $('#bxEB'), st = $('#bxState'); if (!eEl || !bar || !st) return;
  if (!s.alive) { setText($('#bxK'), 'Subject · dead'); setText($('#bxSL'), 'Outcome'); $('#bxSide').classList.add('dead'); setText(eEl, '—'); bar.style.width = '0%'; st.classList.add('end'); setText(st, s.thought); }
  else { const e = s.energy == null ? null : Math.round(s.energy); setText(eEl, s.fainted ? 'fainted' : e == null ? '—' : String(e)); bar.style.width = (s.fainted || e == null ? 0 : Math.max(0, Math.min(100, e))) + '%'; bar.style.setProperty('--c', energyCol(s.fainted ? 0 : e || 0)); setText(st, s.thought || '—'); }
  for (const r of $$('.bxt', $('#bxSide'))) r.classList.toggle('on', s.alive && (s.lit[r.dataset.k] || 0) > 0.35);
}
async function openBrain() {
  const a = cur; if (!a || !a.modelCard || brainOn || a.id !== openId) return;
  const m = a.modelCard, id = a.id, tok = ++brainTok, ov = $('#brainx'), stage = $('#bxStage');
  unmountCardBrain(); // one live view at a time: the card preview hands the shared WebGL canvas to the full view
  brainOn = true; ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false'); document.body.classList.add('brain-open'); $('#tip').style.display = 'none'; tipOn = false;
  try { brainBack = location.pathname + location.search; history.replaceState(null, '', `/app?b=${id}&brain=1`); } catch {}
  renderBrainSide(a);
  stage.innerHTML = '<div class="loading" role="status"><i></i>Drawing its brain</div>';
  try { $('#bxClose').focus({ preventScroll: true }); } catch {}
  try {
    const [mod] = await loadBrain();
    if (tok !== brainTok || !brainOn) return;
    stage.innerHTML = '';
    for (const tr of mod.TRAITS || []) { const r = $(`.bxt[data-k="${tr.key}"]`, $('#bxSide')); if (r) r.style.setProperty('--c', tr.color); }
    brainH = mod.mountBrain3D(stage, { model: m, arch: (ARCH && ARCH[m.id]) || null, tier: m.tier, traits: m.stats || {}, being: a, onState: brainState,
      // the meadow's own copy of /api/world (refreshed every second): null once the creature is gone from it
      live: () => liveOf(id) });
  } catch (e) {
    console.warn('[brain]', e);
    if (tok === brainTok && brainOn) stage.innerHTML = '<div class="loading">The 3D view could not be loaded. Check the connection and try again.</div>';
  }
}
function closeBrain() {
  if (!brainOn) return; brainOn = false; brainTok++;
  try { brainH && brainH.dispose(); } catch {} brainH = null;
  const ov = $('#brainx'); ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true'); document.body.classList.remove('brain-open');
  $('#bxStage').innerHTML = ''; $('#bxSide').innerHTML = '';
  try { const u = new URL(brainBack || '/app', location.origin); u.searchParams.delete('brain'); history.replaceState(null, '', u.pathname + u.search); } catch {}
  last = performance.now(); const bb = $('#brainB'); if (bb) try { bb.focus({ preventScroll: true }); } catch {}
  // back to the card: its preview resumes on the warm renderer
  if (drawerOn() && openId != null && cur && cur.id === openId && cur.modelCard) mountCardBrain(openId, cur.modelCard, cur.modelCard.tier, cur);
}
$('#bxClose').onclick = closeBrain;
addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (brainOn) { e.preventDefault(); closeBrain(); } else if (drawerOn() && !(e.target && e.target.closest && e.target.closest('input,textarea,select'))) closeDrawer(); } });
addEventListener('resize', () => { if (dbCard && !$('#dPlate').classList.contains('ready')) drawPlate($('#dPh'), ARCH && ARCH[dbCard.model.id], dbCard.tier, dbCard.being.alive === false); }, { passive: true });

// ---------- round panel + feed ----------
let roundDrawn = false;
async function renderRound() {
  const [r, ev] = await Promise.all([safe('/api/round'), safe('/api/events')]);
  if (!r || !r.upcoming) return;
  const L = r.last, E = Array.isArray(ev) ? ev : [], done = roundDrawn ? ' is-drawn' : '';
  setHTML($('#round'), `<div class="ds-label ds-label--clock">Next trial · Round ${r.n + 1}</div><div class="q"><span class="tn">${esc(r.upcoming.name)}</span><span class="in">in</span><b id="rClock">${fmtLeft(r.next - (Date.now() + skew))}</b></div><div class="w">${esc(r.upcoming.what)}</div>
  ${L ? `<div class="c"><div class="ds-label ds-label--die">Last trial · Round ${r.n} · ${esc(L.trialName)}</div><div class="n"><span><b class="ds-num ds-num--sm ds-num--die${done}" style="--v:${L.population ? Math.min(1, L.died / L.population).toFixed(3) : 1}">${L.died}</b>died</span><span><b class="ds-num ds-num--sm ds-num--sig ds-num--plain">${L.born}</b>born</span><span><b class="ds-num ds-num--sm ds-num--mut ds-num--plain">${L.mutations}</b>mutations</span></div><div class="w">${L.dominant?.name ? esc(L.dominant.name) + ' dominates. ' : ''}<a href="/r/${r.n}">Open the record</a></div></div>` : ''}
  ${E.length ? `<div class="ds-label lv"><i class="ds-mark ds-mark--live"></i>Live</div>${E.slice(0, 8).map((e) => `<div class="p ${e.kind === 'duel' ? 'down' : 'up'}">${esc(e.text)}</div>`).join('')}` : ''}`);
  roundDrawn = true;
  const seen = new Set(bubbles.map((b) => b.at0 + b.text0));
  for (const e of E.slice(0, 6)) if (!seen.has(e.at + e.text) && Date.now() + skew - e.at < 6000 && e.who?.length) { e.who.forEach((id) => e.kind === 'share' ? burst(id, '#ff6b9a', 4, '♥') : e.kind === 'duel' ? burst(id, CLOCK, 8) : 0); bubbles.push({ id: e.who[0], at: Date.now(), at0: e.at, text0: e.text, text: e.text.replace(/ \([^)]*\)/g, ''), kind: e.kind }); }
  bubbles = bubbles.filter((b) => Date.now() - b.at < 5000);
}
$('#round').onclick = (e) => { if (!e.target.closest('a')) $('#round').classList.toggle('open'); };
async function loadToll() {
  let d = null; const t = await safe('/api/toll');
  if (t && Number.isFinite(t.dead)) d = t.dead; else { const s = await safe('/api/stats'); if (s && Number.isFinite(s.dead)) d = s.dead; }
  const el = $('#deadRow'); if (!el) return; if (d == null) { el.style.display = 'none'; return; } el.style.display = ''; setText($('#dead'), d.toLocaleString('en-US'));
}
async function refresh() { if (document.hidden) return; syncWorld(await safe('/api/world')); }
refresh(); setInterval(refresh, 1000); renderRound(); setInterval(() => !cine && !document.hidden && renderRound(), 4000); loadToll(); setInterval(loadToll, 30000);
setInterval(() => { const c = $('#rClock'); if (c && ROUND) setText(c, fmtLeft(ROUND.next - (Date.now() + skew))); if (brainOn) brainClock(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = performance.now(); refresh(); } });

// ---------- hatch panel ----------
$('#askForm').onsubmit = (e) => { e.preventDefault(); const v = $('#q').value.trim(); if (v) { $('#addr').value = v; openSummon(); summon(v); } };
$('#tHatch').onclick = (e) => { const on = document.body.classList.toggle('hatch-open'); e.currentTarget.classList.toggle('on', on); };
$('#tMap').onclick = (e) => { const off = document.body.classList.toggle('map-off'); e.currentTarget.classList.toggle('on', !off); };
const qs = new URLSearchParams(location.search), qa = qs.get('b');
// /app?b=ID opens the creature's file; /app?b=ID&brain=1 goes straight into its brain
if (qa) setTimeout(() => openAgent(Number(qa)).then(() => { if (qs.get('brain') === '1' && cur && cur.id === Number(qa)) openBrain(); }), 1200);

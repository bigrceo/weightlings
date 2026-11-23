// Inside a creature's brain. The model is drawn as its published stack: one ring per layer, one dot per attention head,
// ring radius from the hidden size, length from the layer count; mixtures of experts carry their expert cluster in every
// routed layer with only the active experts lit. All of it sits in a glass brain volume tinted by rarity.
// What moves is NOT the model: signals follow the creature's simulated state (energy and current act from the API).
// No weights are loaded and no model is run. Every number written on screen comes from arch.json or from the API.
//
//   mountBrain3D(container, { model, arch, tier, traits, being, live?, onState? }) -> { dispose, reset, selectLayer }
//     model   the model card from /api/being/:id (name, lab, ...)            arch    its entry in /arch.json, or null
//     tier    legendary | epic | rare | uncommon | common                    traits  the six stats, 0..1
//     being   /api/being/:id (id, alive, energy, act, wins, losses, shares, eaten)
//     live    optional () => { e, act } | null (gone) | undefined (unknown), fed by the caller's own /api/world polling;
//             without it this module polls /api/world itself
//     onState optional ({ alive, fainted, energy, act, thought, lit }) => void, a few times a second
//     compact optional: the small live preview in the creature card (no labels, no wheel zoom, tap -> onTap, slow turn)
//     onTap   optional () => void, compact only          onReady  optional () => void, after the first frame is drawn
//     driver  optional (fn) => unregister: the caller's animation loop calls fn(now) every frame instead of our own rAF
//     fps     optional frame cap (the compact preview uses 30)
// Every mount draws on ONE shared WebGL canvas (a new mount takes it over), so shader programs compile once per page.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';

const TIERC = { legendary: '#ffb81f', epic: '#b056ff', rare: '#2a7bff', uncommon: '#2fc46b', common: '#b9bcc4' };
// the six traits as regions of the glass volume (x runs from the input end to the output end, y is up)
export const TRAITS = [
  { key: 'perception', color: '#5cf2a8', dir: [-0.86, 0.28, 0.42] },
  { key: 'judgement', color: '#b98cff', dir: [0.84, 0.42, -0.34] },
  { key: 'memory', color: '#ffb81f', dir: [0.05, -0.2, 0.98] },
  { key: 'strength', color: '#ff3f8e', dir: [-0.12, 0.93, -0.34] },
  { key: 'metabolism', color: '#ffffff', dir: [-0.25, -0.95, 0.12] },
  { key: 'cooperation', color: '#2a7bff', dir: [0.22, 0.12, -0.97] },
];
// what each act (the code sent by /api/world) lights, and how much faster signals run while it lasts
const ACT = {
  w: { text: 'wandering', mul: 1, lit: {} },
  f: { text: 'berry spotted', mul: 1.7, lit: { perception: 1, judgement: 0.55 } },
  r: { text: 'it remembers a bush', mul: 1.45, lit: { memory: 1, judgement: 0.55 } },
  e: { text: 'eating', mul: 1.25, lit: { metabolism: 1 } },
  s: { text: 'sharing a berry', mul: 1.5, lit: { cooperation: 1, metabolism: 0.5 } },
};
const CAPTION = 'Architecture from the published model card · The weights are not loaded · Activity follows the creature’s simulated state';

const CSS = `
.b3{--fd:'Chakra Petch',Inter,system-ui,sans-serif;--ft:Inter,system-ui,sans-serif;position:relative;width:100%;height:100%;overflow:hidden;background:#020403;font-family:var(--ft);-webkit-user-select:none;user-select:none;color:#a6b2ab}
.b3 canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;outline:none}
.b3.drag canvas{cursor:grabbing}
.b3-lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.b3-lines line{stroke:rgba(140,255,200,.26);stroke-width:1;stroke-dasharray:2 3}
.b3-lab{position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap;font:600 10px/1 var(--ft);letter-spacing:.2em;text-transform:uppercase;color:#6b7770;text-shadow:0 0 8px #000,0 0 2px #000;transition:color .3s,opacity .3s;will-change:transform}
.b3-lab i{font:500 12px/1 var(--fd);font-style:normal;margin-left:8px;color:#e6eee8;letter-spacing:.02em;font-variant-numeric:tabular-nums}
.b3-lab::before{content:'';display:inline-block;width:4px;height:4px;background:var(--c,#fff);margin-right:8px;vertical-align:1px;opacity:.45;outline:1px solid transparent;outline-offset:2px;transition:opacity .3s,outline-color .3s}
.b3-lab.on{color:var(--c,#fff)}.b3-lab.on i{color:#fff}.b3-lab.on::before{opacity:1;outline-color:var(--c,#fff)}
.b3-lab.back{opacity:.34}.b3-lab.off{opacity:0}
.b3-lab.end{font-size:9px;letter-spacing:.18em;color:#6b7770}.b3-lab.end::before{display:none}
.b3.sel .b3-lab{opacity:.22}.b3.sel .b3-lab.off{opacity:0}.b3.sel .b3-lines .t{opacity:.25}
.b3-top{position:absolute;left:22px;top:20px;right:22px;max-width:660px;pointer-events:none;text-shadow:0 0 10px #000}
.b3-top .k{display:flex;align-items:center;gap:9px;font:600 10px/1 var(--ft);letter-spacing:.2em;text-transform:uppercase;color:#6b7770}
.b3-top .k::before{content:'';width:13px;height:5px;background:linear-gradient(currentColor 0 0) 0 50%/8px 1px no-repeat,linear-gradient(#5cf2a8 0 0) 100% 50%/3px 3px no-repeat}
.b3-top .m{font:600 clamp(20px,2.4vw,32px)/1.1 var(--fd);letter-spacing:.01em;color:#e6eee8;margin-top:10px}
.b3-top .f{font:600 10px/1.8 var(--ft);letter-spacing:.16em;text-transform:uppercase;color:#6b7770;margin-top:8px}
.b3-top .f b{font:500 13px/1 var(--fd);letter-spacing:.02em;color:#e6eee8;font-variant-numeric:tabular-nums}
.b3-top .src{font:400 11px/1.5 var(--ft);color:#3e4842;margin-top:4px}
.b3-top .st{margin-top:14px;font:600 10px/1.7 var(--ft);letter-spacing:.18em;text-transform:uppercase;color:#e6eee8}
.b3-top .st::before{content:'';display:inline-block;width:4px;height:4px;background:var(--s,#5cf2a8);outline:1px solid var(--s,#5cf2a8);outline-offset:2px;margin-right:11px;vertical-align:1px}
.b3-top .st span{color:#6b7770}
.b3-foot{position:absolute;left:22px;right:22px;bottom:16px;pointer-events:none;text-shadow:0 0 8px #000,0 0 2px #000}
.b3-hint{font:600 9.5px/1.7 var(--ft);letter-spacing:.18em;text-transform:uppercase;color:#a6b2ab;margin-bottom:6px;transition:opacity 1.2s}
.b3-hint.gone{opacity:0}
.b3-cap{font:600 9.5px/1.7 var(--ft);letter-spacing:.18em;text-transform:uppercase;color:#6b7770}
.b3-layer{--bc:rgba(140,255,200,.26);position:absolute;left:22px;top:50%;transform:translateY(-50%);width:270px;padding:16px 20px 14px;display:none;text-shadow:0 0 10px #000;background:repeating-linear-gradient(to bottom,rgba(140,255,200,.035) 0 1px,transparent 1px 3px),rgba(2,4,3,.86)}
.b3-layer::before{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(var(--tint,#fff) 0 0) 0 0/12px 1px,linear-gradient(var(--tint,#fff) 0 0) 0 0/1px 12px,linear-gradient(var(--bc) 0 0) 100% 0/12px 1px,linear-gradient(var(--bc) 0 0) 100% 0/1px 12px,linear-gradient(var(--bc) 0 0) 0 100%/12px 1px,linear-gradient(var(--bc) 0 0) 0 100%/1px 12px,linear-gradient(var(--bc) 0 0) 100% 100%/12px 1px,linear-gradient(var(--bc) 0 0) 100% 100%/1px 12px;background-repeat:no-repeat}
.b3-layer.on{display:block}
.b3-layer .k{font:600 10px/1 var(--ft);letter-spacing:.2em;text-transform:uppercase;color:#6b7770}
.b3-layer .n{font:500 56px/1 var(--fd);letter-spacing:-.01em;color:#e6eee8;margin:10px 0 12px;font-variant-numeric:tabular-nums}
.b3-layer .n small{font:600 10px/1 var(--ft);letter-spacing:.2em;text-transform:uppercase;color:#6b7770;margin-left:10px}
.b3-layer .r{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 0;font:600 9.5px/1.4 var(--ft);letter-spacing:.16em;text-transform:uppercase;color:#6b7770;background:linear-gradient(90deg,rgba(140,255,200,.12) 0 1px,transparent 1px) 0 100%/3px 1px repeat-x}
.b3-layer .r b{color:#e6eee8;font:500 14px/1.2 var(--fd);letter-spacing:.02em;font-variant-numeric:tabular-nums;text-align:right;text-transform:none}
.b3-layer .r b.na{font:600 9.5px/1.2 var(--ft);color:#6b7770;letter-spacing:.14em;text-transform:uppercase}
.b3-layer .x{margin-top:10px;font:400 11.5px/1.5 var(--ft);color:#a6b2ab}
.b3-layer .a{display:flex;gap:18px;margin-top:12px}
.b3-layer button{background:none;border:0;padding:6px 0;font:600 10px/1 var(--ft);letter-spacing:.18em;text-transform:uppercase;color:#a6b2ab;cursor:pointer;transition:color .14s}
.b3-layer button:hover{color:#5cf2a8}.b3-layer button:disabled{color:#3e4842;cursor:default}
.b3-msg{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px;font:600 10px/1.8 var(--ft);letter-spacing:.18em;text-transform:uppercase;color:#6b7770}
.b3.narrow .b3-top{left:16px;right:56px;top:14px}.b3.narrow .b3-top .src{display:none}.b3.narrow .b3-top .f{font-size:9px;letter-spacing:.13em;margin-top:6px}.b3.narrow .b3-top .st{margin-top:8px;font-size:9px}
.b3.narrow .b3-foot{left:16px;right:16px;bottom:10px}.b3.narrow .b3-cap,.b3.narrow .b3-hint{font-size:8px;letter-spacing:.13em;line-height:1.6}
.b3.narrow .b3-lab{font-size:8.5px;letter-spacing:.14em}.b3.narrow .b3-lab i{margin-left:5px}
.b3.narrow .b3-layer{left:16px;top:auto;bottom:84px;transform:none;width:236px;padding:12px 16px 10px}.b3.narrow .b3-layer .n{font-size:38px;margin:6px 0 6px}.b3.narrow .b3-layer .r{padding:3px 0}
.b3.narrow.sel .b3-hint{display:none}
.b3.compact{background:#050907}
.b3.compact canvas{touch-action:pan-y;cursor:pointer}
.b3.compact .b3-lines,.b3.compact .b3-top,.b3.compact .b3-foot,.b3.compact .b3-layer,.b3.compact .b3-lab{display:none}
@media (prefers-reduced-motion: reduce){.b3-lab,.b3-hint{transition:none}}
`;

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const posInt = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const fmt = (n) => n.toLocaleString('en-US');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const POINT_VS = `
attribute float aLayer; attribute float aSize; attribute vec3 aColor; attribute float aI; attribute float aB;
uniform float uPx; uniform float uSel; uniform float uBase; uniform float uMax;
varying vec3 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float on = abs(aLayer - uSel) < 0.5 ? 1.0 : 0.0;
  float sel = uSel < 0.0 ? 1.0 : mix(0.06, 1.7, on);
  gl_PointSize = clamp(uPx * aSize * (0.6 + 0.9 * aI) * (1.0 + 0.5 * on * step(0.0, uSel)) / max(0.05, -mv.z), 1.5, uMax);
  vC = aColor * (uBase * aB + 1.7 * aI) * sel;
}`;
const POINT_FS = `
varying vec3 vC;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.5, 0.0, d), halo = pow(1.0 - d, 2.4);
  gl_FragColor = vec4(vC * (core * 0.95 + halo * 0.55), 1.0);
}`;
const LINE_VS = `
attribute float aLayer; attribute float aA;
uniform float uSel; uniform float uN; uniform sampler2D uAct; uniform float uBase;
varying float vA;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  float act = texture2D(uAct, vec2((aLayer + 0.5) / uN, 0.5)).r;
  float sel = uSel < 0.0 ? 1.0 : (abs(aLayer - uSel) < 0.5 ? 2.6 : 0.05);
  vA = aA * (uBase + 1.5 * act) * sel;
}`;
const LINE_FS = `
uniform vec3 uColor; varying float vA;
void main() { gl_FragColor = vec4(uColor * vA, 1.0); }`;
const SHELL_VS = `
uniform float uT; uniform vec3 uAx;
varying vec3 vN; varying vec3 vV; varying vec3 vDir; varying float vFold;
float fold(vec3 n) {
  float f = sin(n.x * 7.0 + sin(n.y * 5.0 + uT * 0.31) * 1.6 + uT * 0.17) * sin(n.z * 8.0 + sin(n.x * 4.0 - uT * 0.13) * 1.8);
  return f + 0.5 * sin(n.y * 13.0 + n.x * 9.0 + sin(n.z * 7.0) * 2.0 - uT * 0.21);
}
vec3 surf(vec3 n) {
  float fiss = exp(-pow(n.z / 0.11, 2.0)) * smoothstep(-0.1, 0.5, n.y);
  float under = smoothstep(-0.5, -1.0, n.y) * 0.16;
  return n * uAx * (1.0 + 0.042 * fold(n) - 0.15 * fiss - under);
}
void main() {
  vec3 n = normalize(position);
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  vec3 p0 = surf(n), p1 = surf(normalize(n + t1 * 0.012)), p2 = surf(normalize(n + t2 * 0.012));
  vec3 nn = normalize(cross(p1 - p0, p2 - p0));
  if (dot(nn, p0) < 0.0) nn = -nn;
  vec4 mv = modelViewMatrix * vec4(p0, 1.0);
  vN = normalize(normalMatrix * nn); vV = -mv.xyz; vDir = n; vFold = fold(n);
  gl_Position = projectionMatrix * mv;
}`;
const SHELL_FS = `
uniform vec3 uTint; uniform float uGain; uniform vec3 uReg[6]; uniform vec3 uRegC[6]; uniform float uRegI[6];
varying vec3 vN; varying vec3 vV; varying vec3 vDir; varying float vFold;
void main() {
  vec3 V = normalize(vV), N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  float fr = pow(1.0 - abs(dot(N, V)), 2.4);
  vec3 R = reflect(-V, N);
  float band = smoothstep(0.5, 0.95, R.y) * 0.3 + smoothstep(0.22, 0.0, abs(R.y + 0.2)) * 0.06;
  float spec = pow(max(dot(R, normalize(vec3(0.35, 0.8, 0.5))), 0.0), 80.0) + 0.35 * pow(max(dot(R, normalize(vec3(-0.6, 0.3, 0.7))), 0.0), 40.0);
  float crease = smoothstep(-0.15, -1.1, vFold);
  vec3 col = uTint * (0.03 + 0.8 * fr + 0.07 * crease) + vec3(1.0) * (band * (0.25 + fr) * 0.3 + spec * (gl_FrontFacing ? 0.8 : 0.16));
  vec3 d = normalize(vDir);
  for (int i = 0; i < 6; i++) {
    float g = smoothstep(0.70, 1.0, max(dot(d, uReg[i]), 0.0));
    col += uRegC[i] * uRegI[i] * g * g * (0.16 + 0.95 * fr + 0.35 * crease);
  }
  gl_FragColor = vec4(col * uGain * (gl_FrontFacing ? 1.0 : 0.5), 1.0);
}`;

let cssDone = false;
function injectCss() { if (cssDone || document.getElementById('b3-style')) { cssDone = true; return; } const s = el('style'); s.id = 'b3-style'; s.textContent = CSS; document.head.appendChild(s); cssDone = true; }

// ---------- one WebGL renderer for the page, reused by every mount (compact card view and full-screen view) ----------
// Reusing it keeps the compiled shader programs warm: a finished mount's materials are only released after the NEXT mount has
// drawn its first frame (three.js keeps a program while one material still uses it), so the second brain opens without compiling.
let SHARED = null;
const LATER = [];
function sharedRenderer() {
  if (SHARED && !SHARED.lost) return SHARED;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  const s = { renderer, canvas, owner: null, lost: false };
  canvas.addEventListener('webglcontextlost', () => { s.lost = true; });
  return (SHARED = s);
}
// geometry and texture that never change between creatures: built once
const ICO = {};
const icoGeom = (d) => ICO[d] || (ICO[d] = new THREE.IcosahedronGeometry(1, d));
let GLOW = null;
const glowTexture = () => GLOW || (GLOW = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.42)'); gr.addColorStop(0.6, 'rgba(255,255,255,.1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })());

export function mountBrain3D(container, opts = {}) {
  injectCss();
  const model = opts.model || {}, arch = opts.arch || {}, traits = opts.traits || {}, being = opts.being || {};
  const tierKey = TIERC[opts.tier] ? opts.tier : 'common';
  // compact: the live preview at the top of the creature card. No labels or layer card, no wheel zoom (the card scrolls),
  // a tap calls opts.onTap (the caller opens the full view), a gentle turn when idle, lower pixel ratio, optional fps cap.
  const compact = !!opts.compact, fpsMs = opts.fps ? 1000 / opts.fps : 0;
  let RM = false; try { RM = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch {}
  let coarse = false; try { coarse = matchMedia('(pointer: coarse)').matches; } catch {}

  // ---------- the published facts (null = not published here) ----------
  const kL = posInt(arch.layers), kH = posInt(arch.attentionHeads), kD = posInt(arch.hiddenSize), kV = posInt(arch.vocab), kF = posInt(arch.ffSize);
  const moe = arch.moe && posInt(arch.moe.experts) ? arch.moe : null;
  const N = Math.min(kL || 24, 256), H = Math.min(kH || 16, 256);
  const E = moe ? Math.min(posInt(moe.experts), 512) : 0, EA = moe ? Math.min(E, posInt(moe.active) || 0) : 0, DENSE = moe ? Math.min(N, posInt(moe.denseLayers) || 0) : 0;
  const generic = !kL || !kH || !kD;

  // ---------- layout: x = depth through the stack ----------
  const R = kD ? 1.3 + 1.9 * clamp(Math.log2(kD / 896) / Math.log2(16384 / 896), 0, 1) : 2.0;
  const Lh = 1.6 + N * 0.034, AX = Lh * 1.1 + 0.35, AZ = R + 0.42, AY = AZ * 0.84, YS = 0.8, TW = 0.045;
  const dx = (2 * Lh) / N;
  const xOf = (l) => -Lh + (l + 0.5) * dx;
  const rOf = (l) => R * 0.96 * Math.sqrt(Math.max(0.05, 1 - (xOf(l) / AX) ** 2));
  const IN = [-AX * 0.93, 0, 0], OUT = [AX * 0.93, 0, 0];

  // ---------- DOM ----------
  const root = el('div', 'b3' + (compact ? ' compact' : '')); root.style.setProperty('--tint', TIERC[tierKey]); container.appendChild(root);
  let SR;
  try { SR = sharedRenderer(); }
  catch { root.appendChild(el('div', 'b3-msg', 'The 3D view needs WebGL, which this browser did not provide.')); return { dispose() { root.remove(); }, reset() {}, selectLayer() {} }; }
  if (SR.owner) { try { SR.owner.dispose(); } catch {} } // one live view at a time on the shared canvas
  const laterN = LATER.length; // resources of earlier views, released once this one has drawn
  const renderer = SR.renderer, canvas = SR.canvas;
  canvas.tabIndex = compact ? -1 : 0; canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', compact ? `Live 3D preview of the layer stack of ${model.name || 'this model'}. Tap to enter the brain.` : `3D view of the layer stack of ${model.name || 'this model'}. Drag to rotate, scroll to zoom, click a layer.`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'b3-lines'); svg.setAttribute('aria-hidden', 'true');
  const labels = el('div'); labels.setAttribute('aria-hidden', 'true');
  const facts = [
    kL ? `<b>${fmt(kL)}</b> layers` : 'layer count not published here',
    kH ? `<b>${fmt(kH)}</b> attention heads per layer` : 'head count not published here',
    kD ? `hidden size <b>${fmt(kD)}</b>` : 'hidden size not published here',
    kV ? `vocabulary <b>${fmt(kV)}</b>` : null,
    moe ? `<b>${fmt(E)}</b> experts per routed layer${EA ? `, <b>${fmt(EA)}</b> active per token` : ''}` : null,
  ].filter(Boolean).join(' · ');
  const top = el('div', 'b3-top', `<div class="k">${generic ? 'Generic stack' : 'Published architecture'}</div><div class="m">${esc(model.name || 'Unknown model')}</div><div class="f">${facts}</div>${arch.source ? `<div class="src">Source: ${esc(arch.source)}</div>` : ''}<div class="st"></div>`);
  const stEl = top.querySelector('.st');
  const foot = el('div', 'b3-foot', `<div class="b3-hint">${coarse ? 'Drag to rotate · Pinch to zoom · Tap a layer · Double-tap to reset' : 'Drag to rotate · Scroll to zoom · Click a layer · Double-click to reset'}</div><div class="b3-cap">${esc(CAPTION)}</div>`);
  const hintEl = foot.querySelector('.b3-hint');
  const card = el('div', 'b3-layer');
  root.append(canvas, svg, labels, top, card, foot);

  renderer.setClearColor(compact ? 0x050907 : 0x020403, 1);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(34, 1, 0.03, 400);
  const tint = new THREE.Color(TIERC[tierKey]), white = new THREE.Color('#ffffff');
  const uSel = { value: -1 }, uPx = { value: 600 }, uMax = { value: 96 };
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };
  const addMat = (o) => keep(new THREE.ShaderMaterial({ blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, ...o }));

  // ---------- heads (one dot per attention head) and experts ----------
  const NH = N * H, NE = (N - DENSE) * E, NP = NH + NE;
  const pos = new Float32Array(NP * 3), lay = new Float32Array(NP), siz = new Float32Array(NP), col = new Float32Array(NP * 3), I = new Float32Array(NP), FL = new Float32Array(NP);
  const headC = tint.clone().lerp(white, 0.3), expC = new THREE.Color('#fff1c9');
  for (let l = 0; l < N; l++) {
    const x = xOf(l), r = rOf(l), hs = Math.min((2 * Math.PI * r / H) * 1.15, dx * 1.6, 0.26);
    for (let k = 0; k < H; k++) {
      const a = (k / H) * Math.PI * 2 + l * TW, i = l * H + k;
      pos[i * 3] = x; pos[i * 3 + 1] = Math.cos(a) * r * YS; pos[i * 3 + 2] = Math.sin(a) * r;
      lay[i] = l; siz[i] = hs; col[i * 3] = headC.r; col[i * 3 + 1] = headC.g; col[i * 3 + 2] = headC.b;
    }
  }
  const expBase = (l) => NH + (l - DENSE) * E;
  const bas = new Float32Array(NP).fill(1, 0, NH).fill(0.1, NH); // idle experts stay nearly dark, so only the active ones read as lit
  const active = EA ? new Int32Array((N - DENSE) * EA).fill(-1) : null;
  for (let l = DENSE; l < N && E; l++) {
    const x = xOf(l), r = rOf(l), b = expBase(l), es = E <= 12 ? Math.min(0.3, dx * 2.2) : Math.min(0.15, dx * 1.5);
    for (let e = 0; e < E; e++) {
      const i = b + e; let rr, a;
      if (E <= 12) { rr = r * 0.4; a = (e / E) * Math.PI * 2 - l * TW; } else { rr = r * 0.56 * Math.sqrt((e + 0.5) / E); a = e * 2.399963 + l * 0.2; }
      pos[i * 3] = x; pos[i * 3 + 1] = Math.cos(a) * rr * YS; pos[i * 3 + 2] = Math.sin(a) * rr;
      lay[i] = l; siz[i] = es; col[i * 3] = expC.r; col[i * 3 + 1] = expC.g; col[i * 3 + 2] = expC.b;
    }
  }
  // which experts are active in a layer: re-drawn each time a signal crosses it (the routing itself is not computed, only its published size)
  function route(l, flash) {
    if (!EA || l < DENSE) return;
    const b = expBase(l), o = (l - DENSE) * EA;
    for (let j = 0; j < EA; j++) { const p = active[o + j]; if (p >= 0) FL[b + p] = 0; }
    for (let j = 0; j < EA; j++) {
      let e; do { e = (Math.random() * E) | 0; } while (FL[b + e] > 0);
      active[o + j] = e; FL[b + e] = 0.42; I[b + e] = flash ? 1 : 0.42;
    }
  }
  const pg = keep(new THREE.BufferGeometry());
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.setAttribute('aLayer', new THREE.BufferAttribute(lay, 1)); pg.setAttribute('aSize', new THREE.BufferAttribute(siz, 1)); pg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  pg.setAttribute('aB', new THREE.BufferAttribute(bas, 1));
  const aI = new THREE.BufferAttribute(I, 1); aI.setUsage(THREE.DynamicDrawUsage); pg.setAttribute('aI', aI);
  const uBase = { value: 0.2 };
  const points = new THREE.Points(pg, addMat({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { uPx, uSel, uBase, uMax } })); points.frustumCulled = false; scene.add(points);

  // ---------- rings, strands, spine ----------
  const SEG = 72, K = Math.min(H, 32), kStep = H / K, ribs = Math.min(K, 16);
  const nLine = N * SEG * 2 + (N - 1) * K * 2 + (N + 1) * 2 + ribs * 4;
  const lp = new Float32Array(nLine * 3), ll = new Float32Array(nLine), la = new Float32Array(nLine); let q = 0;
  const lv = (x, y, z, l, a) => { lp[q * 3] = x; lp[q * 3 + 1] = y; lp[q * 3 + 2] = z; ll[q] = l; la[q] = a; q++; };
  const head = (l, k) => { const i = (l * H + Math.round(k) % H) * 3; return [pos[i], pos[i + 1], pos[i + 2]]; };
  for (let l = 0; l < N; l++) { const x = xOf(l), r = rOf(l); for (let s = 0; s < SEG; s++) { const a = (s / SEG) * Math.PI * 2, b = ((s + 1) / SEG) * Math.PI * 2; lv(x, Math.cos(a) * r * YS, Math.sin(a) * r, l, 0.5); lv(x, Math.cos(b) * r * YS, Math.sin(b) * r, l, 0.5); } }
  for (let l = 0; l < N - 1; l++) for (let k = 0; k < K; k++) { const A = head(l, k * kStep), B = head(l + 1, k * kStep); lv(A[0], A[1], A[2], l, 0.16); lv(B[0], B[1], B[2], l + 1, 0.16); }
  for (let l = 0; l <= N; l++) { const a = l === 0 ? IN[0] : xOf(l - 1), b = l === N ? OUT[0] : xOf(l); lv(a, 0, 0, Math.max(0, l - 1), 0.55); lv(b, 0, 0, Math.min(N - 1, l), 0.55); }
  for (let k = 0; k < ribs; k++) { const A = head(0, (k / ribs) * H), B = head(N - 1, (k / ribs) * H); lv(IN[0], 0, 0, 0, 0.1); lv(A[0], A[1], A[2], 0, 0.1); lv(OUT[0], 0, 0, N - 1, 0.1); lv(B[0], B[1], B[2], N - 1, 0.1); }
  const lg = keep(new THREE.BufferGeometry());
  lg.setAttribute('position', new THREE.BufferAttribute(lp, 3)); lg.setAttribute('aLayer', new THREE.BufferAttribute(ll, 1)); lg.setAttribute('aA', new THREE.BufferAttribute(la, 1));
  const layAct = new Float32Array(N), actData = new Uint8Array(N * 4);
  const actTex = keep(new THREE.DataTexture(actData, N, 1, THREE.RGBAFormat)); actTex.magFilter = actTex.minFilter = THREE.NearestFilter; actTex.needsUpdate = true;
  const uLineBase = { value: 0.5 };
  const lines = new THREE.LineSegments(lg, addMat({ vertexShader: LINE_VS, fragmentShader: LINE_FS, uniforms: { uSel, uN: { value: N }, uAct: { value: actTex }, uColor: { value: tint.clone().lerp(white, 0.15) }, uBase: uLineBase } })); lines.frustumCulled = false; scene.add(lines);

  // ---------- the glass volume ----------
  const regDir = TRAITS.map((t) => new THREE.Vector3(...t.dir).normalize()), regI = new Float32Array(6);
  const shellU = { uT: { value: 0 }, uAx: { value: new THREE.Vector3(AX, AY, AZ) }, uTint: { value: tint.clone() }, uGain: { value: 0 }, uReg: { value: regDir }, uRegC: { value: TRAITS.map((t) => new THREE.Color(t.color)) }, uRegI: { value: regI } };
  const shell = new THREE.Mesh(icoGeom(compact ? 20 : 32), addMat({ vertexShader: SHELL_VS, fragmentShader: SHELL_FS, uniforms: shellU, side: THREE.DoubleSide })); shell.frustumCulled = false; scene.add(shell);

  // ---------- glow sprites: a halo behind the brain and one soft light per trait region ----------
  const glowTex = glowTexture();
  const sprite = (color, scale, p) => { const m = keep(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, opacity: 0 })); const s = new THREE.Sprite(m); s.scale.setScalar(scale); s.position.set(p[0], p[1], p[2]); scene.add(s); return s; };
  const halo = sprite(tint, Math.max(AX, AZ) * 5.2, [0, 0, 0]);
  const blobs = TRAITS.map((t, i) => sprite(new THREE.Color(t.color), R * 1.7, [regDir[i].x * AX * 0.74, regDir[i].y * AY * 0.74, regDir[i].z * AZ * 0.74]));

  // ---------- signals: travelling points, plus the two end nodes ----------
  const NS = 48, NF = NS + 2;
  const fp = new Float32Array(NF * 3), fl = new Float32Array(NF).fill(-10), fs = new Float32Array(NF), fc = new Float32Array(NF * 3), fi = new Float32Array(NF);
  const sigC = tint.clone().lerp(white, 0.6);
  for (let i = 0; i < NF; i++) { fc[i * 3] = sigC.r; fc[i * 3 + 1] = sigC.g; fc[i * 3 + 2] = sigC.b; fs[i] = Math.min(0.34, R * 0.13); }
  fp.set(IN, NS * 3); fp.set(OUT, (NS + 1) * 3); fs[NS] = fs[NS + 1] = R * 0.3; fi[NS] = fi[NS + 1] = 0.2;
  const fg = keep(new THREE.BufferGeometry());
  const aFP = new THREE.BufferAttribute(fp, 3), aFI = new THREE.BufferAttribute(fi, 1); aFP.setUsage(THREE.DynamicDrawUsage); aFI.setUsage(THREE.DynamicDrawUsage);
  fg.setAttribute('position', aFP); fg.setAttribute('aLayer', new THREE.BufferAttribute(fl, 1)); fg.setAttribute('aSize', new THREE.BufferAttribute(fs, 1)); fg.setAttribute('aColor', new THREE.BufferAttribute(fc, 3)); fg.setAttribute('aI', aFI); fg.setAttribute('aB', new THREE.BufferAttribute(new Float32Array(NF).fill(1), 1));
  const fx = new THREE.Points(fg, addMat({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { uPx, uSel: { value: -1 }, uBase: { value: 0 }, uMax: { value: 220 } } })); fx.frustumCulled = false; scene.add(fx);
  const sigs = Array.from({ length: NS }, () => ({ on: false, p: 0, ang: 0, v: 0, w: 0, last: -1 }));
  const TRAVEL = 1.7 + N * 0.012; // seconds for one signal to cross the stack
  const ringPos = (lf, ang, out) => { const l0 = Math.floor(lf), l1 = Math.min(N - 1, l0 + 1), f = lf - l0, x = xOf(l0) + (xOf(l1) - xOf(l0)) * f, r = rOf(l0) + (rOf(l1) - rOf(l0)) * f, a = ang + TW * lf; out[0] = x; out[1] = Math.cos(a) * r * YS; out[2] = Math.sin(a) * r; };
  const sigma = Math.max(1.1, H * 0.06), reach = Math.ceil(sigma * 2.4);
  function hit(l, ang) {
    layAct[l] = 1;
    const kc = Math.round((ang / (Math.PI * 2)) * H);
    for (let d = -reach; d <= reach; d++) { const k = (((kc + d) % H) + H) % H, i = l * H + k, v = Math.exp(-((d / sigma) ** 2)); if (v > I[i]) I[i] = v; }
    route(l, true);
  }
  function spawn(mul) {
    const s = sigs.find((x) => !x.on); if (!s) return;
    s.on = true; s.p = -1.5; s.ang = Math.random() * Math.PI * 2; s.v = (N / TRAVEL) * (0.85 + Math.random() * 0.3) * (0.8 + 0.2 * mul); s.w = (Math.random() - 0.5) * 0.9; s.last = -1;
    fi[NS] = 0.8;
  }

  // ---------- the creature's state ----------
  const S = { alive: being.alive !== false, e: Number.isFinite(being.energy) ? being.energy : null, act: typeof being.act === 'string' ? being.act[0] : 'w', fainted: !!being.down, end: null };
  if (S.act === 'f' && S.fainted) S.act = 'w';
  if (!S.alive) S.end = being.rdied != null ? `Died in round ${being.rdied}${being.cause ? ', ' + being.cause : ''}` : 'Dead';
  const lit = {}, pulse = {}; TRAITS.forEach((t) => { lit[t.key] = 0; pulse[t.key] = 0; });
  let counts = { wins: being.wins, losses: being.losses, shares: being.shares, eaten: being.eaten };
  const thought = () => { if (!S.alive) return S.end || 'Dead'; if (S.fainted) return 'fainted'; const a = (ACT[S.act] || ACT.w).text; return S.e != null && S.e < 25 ? 'starving · ' + a : a; };
  function setLive(v) {
    if (v === undefined || !S.alive) return;
    if (v === null) { S.alive = false; S.end = S.end || 'Signal lost'; return; }
    const fainted = v.e < 0, act = fainted ? S.act : (ACT[v.act] ? v.act : 'w');
    if (act !== S.act && !fainted && !RM) for (let k = 0; k < 3; k++) spawn((ACT[act] || ACT.w).mul);
    if (RM && (fainted !== S.fainted || act !== S.act || (!fainted && v.e !== S.e))) dirty = true;
    S.fainted = fainted; S.act = act; if (!fainted) S.e = v.e;
  }
  let stText = null, stateAt = 0;
  function publish(now) {
    const litNames = TRAITS.filter((t) => lit[t.key] > 0.35).map((t) => t.key);
    const txt = S.alive ? `${esc(thought())}${S.e != null && !S.fainted ? ` <span>·</span> energy ${Math.round(S.e)}` : ''}${litNames.length ? ` <span>→ ${litNames.join(' · ')}</span>` : ''}` : esc(S.end || 'Dead');
    if (txt !== stText) { stText = txt; stEl.innerHTML = txt; stEl.style.setProperty('--s', !S.alive ? '#ff3f8e' : S.fainted ? '#ffb81f' : '#5cf2a8'); }
    if (opts.onState && now - stateAt > 180) { stateAt = now; try { opts.onState({ alive: S.alive, fainted: S.fainted, energy: S.e, act: S.act, thought: thought(), lit: { ...lit } }); } catch {} }
  }
  const timers = [];
  const visible = () => !document.hidden && onScreen;
  if (typeof opts.live !== 'function' && being.id != null) timers.push(setInterval(async () => {
    if (!visible() || !S.alive) return;
    try { const w = await fetch('/api/world').then((r) => r.json()); if (!w || !Array.isArray(w.c)) return; const c = w.c.find((x) => x[0] === being.id); setLive(c ? { e: c[3], act: c[4] } : null); } catch {}
  }, 1000));
  // duels, shares and berries are read from the creature's own counters; a change lights the matching region
  if (being.id != null) timers.push(setInterval(async () => {
    if (!visible()) return;
    try {
      const b = await fetch('/api/being/' + being.id).then((r) => r.json()); if (!b || b.error || disposed) return;
      if (b.alive === false) { if (S.alive || S.end === 'Signal lost') { S.alive = false; S.end = b.rdied != null ? `Died in round ${b.rdied}${b.cause ? ', ' + b.cause : ''}` : 'Dead'; } return; }
      if (b.wins > counts.wins) { pulse.strength = 1; pulse.judgement = Math.max(pulse.judgement, 0.6); }
      if (b.losses > counts.losses) pulse.strength = 1;
      if (b.shares > counts.shares) pulse.cooperation = 1;
      if (b.eaten > counts.eaten) pulse.metabolism = 1;
      counts = { wins: b.wins, losses: b.losses, shares: b.shares, eaten: b.eaten };
      if (typeof opts.live !== 'function' && Number.isFinite(b.energy)) setLive({ e: b.down ? -1 : b.energy, act: typeof b.act === 'string' ? b.act[0] : 'w' });
    } catch {}
  }, compact ? 5000 : 2500));

  // ---------- labels ----------
  const svgLine = (cls) => { const l = document.createElementNS('http://www.w3.org/2000/svg', 'line'); if (cls) l.setAttribute('class', cls); svg.appendChild(l); return l; };
  const tl = TRAITS.map((t, i) => {
    const v = traits[t.key], e = el('div', 'b3-lab', `${t.key}${Number.isFinite(v) ? `<i>${Math.round(v * 100)}</i>` : ''}`); e.style.setProperty('--c', t.color); labels.appendChild(e);
    return { t, e, line: svgLine('t'), w: 0, a: [regDir[i].x * AX, regDir[i].y * AY, regDir[i].z * AZ], on: false, cls: '' };
  });
  const endIn = el('div', 'b3-lab end', kV ? `Tokens in · vocabulary ${fmt(kV)}` : 'Tokens in'), endOut = el('div', 'b3-lab end', 'Next token out'); labels.append(endIn, endOut);
  const ends = [{ e: endIn, p: IN, w: 0 }, { e: endOut, p: OUT, w: 0 }];
  const selLine = svgLine('s'); selLine.style.stroke = TIERC[tierKey]; selLine.style.opacity = '.6';
  const measure = () => { for (const x of tl) x.w = x.e.offsetWidth; for (const x of ends) x.w = x.e.offsetWidth; };

  // ---------- layer card ----------
  let sel = -1;
  function renderCard() {
    root.classList.toggle('sel', sel >= 0); card.classList.toggle('on', sel >= 0); uSel.value = sel;
    if (sel < 0) { selLine.style.display = 'none'; return; }
    selLine.style.display = '';
    const na = '<b class="na">Not published here</b>';
    const routed = moe && sel >= DENSE;
    card.innerHTML = `<div class="k">Layer</div>${kL ? `<div class="n">${sel + 1}<small>of ${fmt(kL)}</small></div>` : '<div class="x" style="margin:8px 0 10px">Layer count not published here.</div>'}
      <div class="r"><span>Attention heads</span>${kH ? `<b>${fmt(kH)}</b>` : na}</div>
      <div class="r"><span>Hidden size</span>${kD ? `<b>${fmt(kD)}</b>` : na}</div>
      ${kF ? `<div class="r"><span>Feed-forward size</span><b>${fmt(kF)}</b></div>` : ''}
      ${moe ? `<div class="r"><span>Experts</span><b>${routed ? fmt(E) + (EA ? ` · ${fmt(EA)} active per token` : '') : 'none, dense layer'}</b></div>` : ''}
      <div class="x">${kL && kH ? `Each dot on this ring is one of its ${fmt(kH)} attention heads.` : 'This ring is a placeholder: the real numbers are not published here.'}${routed && EA ? ' Which experts light up is not computed, only how many.' : ''}</div>
      <div class="a"><button data-a="prev"${sel <= 0 ? ' disabled' : ''}>‹ Prev</button><button data-a="next"${sel >= N - 1 ? ' disabled' : ''}>Next ›</button><button data-a="all">All layers</button></div>`;
  }
  function selectLayer(l) {
    sel = l == null || l < 0 ? -1 : clamp(Math.round(l), 0, N - 1);
    if (sel >= 0) { C.tgtT.set(xOf(sel), 0, 0); C.dT = Math.min(C.dT, Math.max(rOf(sel) * 4.6 + 2, 4)); } else C.tgtT.set(0, 0, 0);
    idleAt = performance.now(); dirty = true; renderCard();
  }
  card.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'prev') selectLayer(Math.max(0, sel - 1)); if (a === 'next') selectLayer(Math.min(N - 1, sel + 1)); if (a === 'all') selectLayer(-1); });

  // ---------- camera controls: drag to rotate, wheel / pinch to zoom, double-click to reset, inertia ----------
  let W = 1, Hh = 1, homeD = 20, homeTh = -0.5, onScreen = true, dirty = true, idleAt = 0, disposed = false;
  const HOME_PH = 1.22;
  const C = { th: -0.5, ph: HOME_PH, d: 20, thT: -0.5, phT: HOME_PH, dT: 20, vTh: 0, vPh: 0, tgt: new THREE.Vector3(), tgtT: new THREE.Vector3() };
  function fit(first) {
    const vf = (cam.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
    homeTh = cam.aspect < 0.85 ? -1.02 : -0.5;
    const lat = Math.hypot(AX * Math.cos(homeTh), AZ * Math.sin(homeTh)), depth = Math.hypot(AX * Math.sin(homeTh), AZ * Math.cos(homeTh));
    const d = Math.max((lat * (compact ? 1.12 : cam.aspect < 0.85 ? 1.1 : 1.5)) / Math.tan(hf / 2), (AY * (compact ? 1.25 : 1.5)) / Math.tan(vf / 2)) + depth * 0.5;
    if (first) { C.th = C.thT = homeTh - (RM ? 0 : 0.5); C.thT = homeTh; C.d = RM ? d : d * 2.3; C.dT = d; }
    else if (Math.abs(C.dT - homeD) < 0.01) C.dT = d;
    homeD = d;
  }
  function reset() { selectLayer(-1); C.thT = homeTh + Math.PI * 2 * Math.round((C.thT - homeTh) / (Math.PI * 2)); C.phT = HOME_PH; C.dT = homeD; C.vTh = C.vPh = 0; C.tgtT.set(0, 0, 0); dirty = true; }
  const ptrs = new Map(); let drag = null, pinch = null, lastTap = { t: 0, x: 0, y: 0 };
  const touched = () => { idleAt = performance.now(); dirty = true; if (!hintEl.classList.contains('gone')) hintGone = hintGone || setTimeout(() => hintEl.classList.add('gone'), 2500); };
  let hintGone = 0;
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); offs.push(() => t.removeEventListener(ev, fn, o)); };
  const offs = [];
  on(canvas, 'pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    ptrs.set(e.pointerId, [e.clientX, e.clientY]); touched();
    if (ptrs.size === 2) { if (compact) { drag = null; return; } const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z: C.dT }; drag = null; return; }
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0, t: performance.now(), lt: performance.now() }; C.vTh = C.vPh = 0; root.classList.add('drag');
  });
  on(canvas, 'pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; C.dT = clamp((pinch.z * pinch.d) / (Math.hypot(a[0] - b[0], a[1] - b[1]) || 1), 0.4, homeD * 2.4); touched(); return; }
    if (!drag) return;
    const mx = e.clientX - drag.x, my = e.clientY - drag.y, now = performance.now(), dt = Math.max(0.004, (now - drag.lt) / 1000);
    drag.x = e.clientX; drag.y = e.clientY; drag.lt = now; drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
    if (drag.moved < 4) return;
    const k = 0.0058, dth = -mx * k, dph = -my * k;
    C.thT += dth; C.phT = clamp(C.phT + dph, 0.1, Math.PI - 0.1);
    C.vTh = C.vTh * 0.6 + (dth / dt) * 0.4; C.vPh = C.vPh * 0.6 + (dph / dt) * 0.4; touched();
  });
  const up = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId); const wasPinch = !!pinch; if (ptrs.size < 2) pinch = null;
    if (drag && !wasPinch && e.type === 'pointerup') {
      const now = performance.now();
      if (drag.moved < 5 && now - drag.t < 450) {
        C.vTh = C.vPh = 0;
        if (compact) { if (opts.onTap) try { opts.onTap(); } catch {} }
        else if (e.pointerType !== 'mouse' && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 28) { lastTap.t = 0; reset(); }
        else { lastTap = { t: now, x: e.clientX, y: e.clientY }; const b = root.getBoundingClientRect(); selectLayer(pick(e.clientX - b.left, e.clientY - b.top)); }
      } else if (now - drag.lt > 90 || RM) C.vTh = C.vPh = 0; else { C.vTh = clamp(C.vTh, -7, 7); C.vPh = clamp(C.vPh, -5, 5); }
    }
    drag = null; root.classList.remove('drag'); touched();
  };
  on(canvas, 'pointerup', up); on(canvas, 'pointercancel', up);
  if (!compact) on(canvas, 'wheel', (e) => { e.preventDefault(); C.dT = clamp(C.dT * Math.exp(clamp(e.deltaY, -120, 120) * (e.ctrlKey ? 0.01 : 0.0016)), 0.4, homeD * 2.4); touched(); }, { passive: false });
  if (!compact) on(canvas, 'dblclick', (e) => { e.preventDefault(); reset(); });
  if (!compact) on(canvas, 'keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); selectLayer(sel < 0 ? (e.key === 'ArrowRight' ? 0 : N - 1) : clamp(sel + (e.key === 'ArrowRight' ? 1 : -1), 0, N - 1)); }
    if (e.key === 'Home' || e.key === '0') reset();
  });
  const PM = new THREE.Matrix4();
  // the layer under the pointer: the nearest head dot on screen, the one closest to the camera winning
  function pick(cx, cy) {
    PM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); const m = PM.elements, lim = coarse ? 26 : 15;
    let best = -1, bs = 1e9;
    for (let i = 0; i < NH; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], w = m[3] * x + m[7] * y + m[11] * z + m[15]; if (w < 0.05) continue;
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2 * W, sy = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2 * Hh, d = Math.hypot(sx - cx, sy - cy);
      if (d > lim) continue; const s = d * 0.5 + w * 4; if (s < bs) { bs = s; best = i; }
    }
    return best < 0 ? -1 : Math.floor(best / H);
  }

  // ---------- size ----------
  function resize() {
    const w = root.clientWidth, h = root.clientHeight; if (!w || !h) return;
    W = w; Hh = h; const pr = Math.min(compact ? 1.5 : 2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    const first = cam.userData.sized !== true; cam.userData.sized = true;
    cam.aspect = w / h; cam.updateProjectionMatrix();
    uPx.value = (h * pr) / (2 * Math.tan((cam.fov * Math.PI) / 360)); uMax.value = 72 * pr;
    root.classList.toggle('narrow', !compact && w < 720);
    fit(first); measure(); dirty = true;
  }
  const ro = new ResizeObserver(resize); ro.observe(root);
  const io = new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; if (onScreen) wake(); }); io.observe(root);
  const onVis = () => { if (!document.hidden) wake(); };
  document.addEventListener('visibilitychange', onVis);
  try { document.fonts && document.fonts.ready.then(() => { if (!disposed) { measure(); dirty = true; } }); } catch {}

  // ---------- frame ----------
  for (let l = DENSE; l < N; l++) route(l, false);
  let raf = 0, last = performance.now(), acc = 0, T = 0, gain = 0, ready = false, unDrive = null;
  const P = [0, 0, 0], V = new THREE.Vector3();
  const project = (x, y, z) => { V.set(x, y, z).project(cam); return V; };
  // opts.driver(fn) -> unregister: the caller's own animation loop calls fn(now) every frame (one loop per page); otherwise our own rAF
  function wake() { if (unDrive || disposed) return; if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function frame(now) {
    raf = 0; if (disposed) return;
    if (document.hidden || !onScreen) return; // paused: wake() restarts the loop
    raf = requestAnimationFrame(frame);
    step(now);
  }
  function driven(now) {
    if (disposed) return false;
    if (document.hidden || !onScreen) { last = now; return; }
    step(now);
  }
  function step(now) {
    if (fpsMs && ready && now - last < fpsMs - 2) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    if (typeof opts.live === 'function') { let v; try { v = opts.live(); } catch {} setLive(v); }

    // state -> rates
    const e01 = S.e == null ? 0.5 : clamp(S.e / 100, 0, 1), a = ACT[S.act] || ACT.w;
    const rate = !S.alive ? 0 : S.fainted ? 0.1 : (0.5 + 3.2 * e01) * a.mul;
    for (const t of TRAITS) {
      const k = t.key, target = !S.alive || S.fainted ? 0 : Math.max(a.lit[k] || 0, pulse[k]);
      lit[k] += (target - lit[k]) * Math.min(1, dt * (RM ? 60 : 6)); pulse[k] *= Math.exp(-dt * 0.8); if (pulse[k] < 0.02) pulse[k] = 0;
    }

    // camera
    const idle = now - idleAt > 2600;
    if (!drag && !pinch) { C.thT += C.vTh * dt; C.phT = clamp(C.phT + C.vPh * dt, 0.1, Math.PI - 0.1); const f = Math.exp(-dt * 3.2); C.vTh *= f; C.vPh *= f; if (!RM && (idle || compact) && sel < 0) C.thT += dt * (compact ? 0.16 : 0.07); }
    const ks = RM ? 1 : Math.min(1, dt * 12), kz = RM ? 1 : Math.min(1, dt * 5);
    const moving = Math.abs(C.thT - C.th) + Math.abs(C.phT - C.ph) + Math.abs(C.dT - C.d) / Math.max(1, C.d) + C.tgt.distanceTo(C.tgtT) > 0.0005;
    C.th += (C.thT - C.th) * ks; C.ph += (C.phT - C.ph) * ks; C.d += (C.dT - C.d) * kz; C.tgt.lerp(C.tgtT, kz);
    const sp = Math.sin(C.ph);
    cam.position.set(C.tgt.x + C.d * sp * Math.sin(C.th), C.tgt.y + C.d * Math.cos(C.ph), C.tgt.z + C.d * sp * Math.cos(C.th)); cam.lookAt(C.tgt); cam.updateMatrixWorld();

    // signals (frozen under reduced motion: the stack is then lit evenly by the current energy)
    if (!RM) {
      T += dt; acc += rate * dt; while (acc >= 1) { acc -= 1; spawn(a.mul); }
      const dk = Math.exp(-dt * 3.4);
      for (let i = 0; i < NP; i++) { const v = I[i] * dk; I[i] = v < FL[i] ? FL[i] : v; }
      const dl = Math.exp(-dt * 4.5);
      for (let l = 0; l < N; l++) { layAct[l] *= dl; actData[l * 4] = Math.min(255, layAct[l] * 255); }
      fi[NS] = Math.max(0.2, fi[NS] * dk); fi[NS + 1] = Math.max(0.2, fi[NS + 1] * dk);
      for (let s = 0; s < NS; s++) {
        const g = sigs[s];
        if (!g.on) { fi[s] = 0; continue; }
        g.p += g.v * dt; g.ang = (g.ang + g.w * dt + Math.PI * 2) % (Math.PI * 2);
        const top = Math.min(Math.floor(g.p), N - 1); while (g.last < top) hit(++g.last, g.ang);
        if (g.p < 0) { ringPos(0, g.ang, P); const f = clamp((g.p + 1.5) / 1.5, 0, 1); fp[s * 3] = IN[0] + (P[0] - IN[0]) * f; fp[s * 3 + 1] = P[1] * f; fp[s * 3 + 2] = P[2] * f; }
        else if (g.p <= N - 1) { ringPos(g.p, g.ang, P); fp[s * 3] = P[0]; fp[s * 3 + 1] = P[1]; fp[s * 3 + 2] = P[2]; }
        else { ringPos(N - 1, g.ang, P); const f = (g.p - (N - 1)) / (N * 0.08 + 1.2); if (f >= 1) { g.on = false; fi[s] = 0; fi[NS + 1] = 0.8; continue; } fp[s * 3] = P[0] + (OUT[0] - P[0]) * f; fp[s * 3 + 1] = P[1] * (1 - f); fp[s * 3 + 2] = P[2] * (1 - f); }
        fi[s] = 0.55;
      }
      aI.needsUpdate = true; aFP.needsUpdate = true; aFI.needsUpdate = true; actTex.needsUpdate = true;
    } else if (dirty) {
      const lvl = !S.alive ? 0 : S.fainted ? 0.05 : 0.15 + 0.3 * e01;
      for (let i = 0; i < NP; i++) I[i] = Math.max(FL[i], i < NH ? lvl : 0);
      for (let l = 0; l < N; l++) actData[l * 4] = lvl * 255;
      aI.needsUpdate = true; actTex.needsUpdate = true;
    }

    // light levels
    const gT = !S.alive ? 0.34 : S.fainted ? 0.5 : 0.72 + 0.4 * e01; gain += (gT - gain) * Math.min(1, dt * (RM ? 60 : 1.6));
    shellU.uGain.value = gain * (sel >= 0 ? 0.5 : 1); shellU.uT.value = T;
    uBase.value = !S.alive ? 0.07 : S.fainted ? 0.1 : 0.14 + 0.12 * e01; uLineBase.value = !S.alive ? 0.22 : 0.4 + 0.2 * e01;
    halo.material.opacity = 0.05 * gain;
    let changed = RM && Math.abs(gT - gain) > 0.002;
    TRAITS.forEach((t, i) => {
      const tv = Number.isFinite(traits[t.key]) ? traits[t.key] : 0.5;
      const v = !S.alive ? 0.03 : (0.05 + 0.2 * tv) * (S.fainted ? 0.4 : 1) + 1.25 * lit[t.key];
      if (Math.abs(v - regI[i]) > 0.002) changed = true;
      regI[i] = v; blobs[i].material.opacity = Math.min(0.5, 0.02 + 0.34 * lit[t.key]) * (sel >= 0 ? 0.3 : 1);
    });

    publish(now);
    if (RM && !dirty && !moving && !changed && !drag && Math.abs(C.vTh) + Math.abs(C.vPh) < 0.001) return; // nothing changed: keep the last frame
    dirty = false;
    renderer.render(scene, cam);
    if (!ready) {
      ready = true;
      for (const d of LATER.splice(0, laterN)) { try { d.dispose(); } catch {} }
      if (opts.onReady) try { opts.onReady(); } catch {}
    }
    if (compact) return; // no labels in the card preview

    // HTML labels follow their regions
    const c = project(0, 0, 0), cz = c.z;
    // a label that would sit on the layer card steps aside
    let cb = null, rb = null; if (sel >= 0) { cb = card.getBoundingClientRect(); rb = root.getBoundingClientRect(); }
    const onCard = (x0, y0, w) => cb && x0 < cb.right - rb.left - 20 && x0 + w > cb.left - rb.left && y0 + 10 > cb.top - rb.top && y0 - 10 < cb.bottom - rb.top;
    for (const x of tl) {
      const p = project(x.a[0], x.a[1], x.a[2]); const px = (p.x + 1) / 2 * W, py = (1 - p.y) / 2 * Hh, pz = p.z;
      const o = project(x.a[0] * 1.24, x.a[1] * 1.24, x.a[2] * 1.24); let qx = (o.x + 1) / 2 * W, qy = (1 - o.y) / 2 * Hh;
      let off = pz > 1 || o.z > 1 || qx < -40 || qx > W + 40 || qy < 30 || qy > Hh - 30;
      const left = qx < px; qx = clamp(left ? qx - x.w : qx, 8, Math.max(8, W - x.w - 8)); qy = clamp(qy, 12, Hh - 12);
      if (!off && onCard(qx, qy, x.w)) off = true;
      const isOn = lit[x.t.key] > 0.35, cls = 'b3-lab' + (isOn ? ' on' : '') + (off ? ' off' : pz > cz + 0.00002 ? ' back' : '');
      if (cls !== x.cls) { x.cls = cls; x.e.className = cls; }
      x.e.style.transform = `translate3d(${qx.toFixed(1)}px,${(qy - 5).toFixed(1)}px,0)`;
      if (off) x.line.style.display = 'none'; else { x.line.style.display = ''; x.line.style.opacity = pz > cz + 0.00002 ? '.3' : isOn ? '1' : '.6'; x.line.setAttribute('x1', px.toFixed(1)); x.line.setAttribute('y1', py.toFixed(1)); x.line.setAttribute('x2', (left ? qx + x.w + 5 : qx - 5).toFixed(1)); x.line.setAttribute('y2', qy.toFixed(1)); }
    }
    for (const x of ends) {
      const p = project(x.p[0], x.p[1], x.p[2]); const px = (p.x + 1) / 2 * W, py = (1 - p.y) / 2 * Hh;
      const ex = clamp(px - x.w / 2, 8, Math.max(8, W - x.w - 8));
      const off = p.z > 1 || px < -20 || px > W + 20 || py < 20 || py > Hh - 40 || onCard(ex, py + 21, x.w), cls = 'b3-lab end' + (off ? ' off' : '');
      if (cls !== x.cls) { x.cls = cls; x.e.className = cls; }
      x.e.style.transform = `translate3d(${ex.toFixed(1)}px,${(py + 16).toFixed(1)}px,0)`;
    }
    if (sel >= 0) {
      const p = project(xOf(sel), 0, 0), b = cb;
      if (p.z > 1) selLine.style.display = 'none'; else { selLine.style.display = ''; selLine.setAttribute('x1', (b.right - rb.left - 8).toFixed(1)); selLine.setAttribute('y1', (b.top - rb.top + 56).toFixed(1)); selLine.setAttribute('x2', ((p.x + 1) / 2 * W).toFixed(1)); selLine.setAttribute('y2', ((1 - p.y) / 2 * Hh).toFixed(1)); }
    }
  }
  const handle = {
    reset, selectLayer,
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(raf); raf = 0; if (unDrive) { try { unDrive(); } catch {} unDrive = null; }
      timers.forEach(clearInterval); clearTimeout(hintGone);
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis); offs.forEach((f) => f());
      // a view that has drawn holds compiled programs: hand its resources to the next view, which frees them after its first frame
      if (ready && !SR.lost) LATER.push(...disposables.splice(0));
      else for (const d of disposables.splice(0)) { try { d.dispose(); } catch {} }
      if (SR.owner === handle) SR.owner = null;
      root.remove();
    },
  };
  SR.owner = handle;
  if (typeof opts.driver === 'function') { try { unDrive = opts.driver(driven); } catch { unDrive = null; } }
  resize(); renderCard(); idleAt = performance.now() - (RM ? 0 : 1200); wake();
  return handle;
}
// diagnostics: how many shader programs the shared renderer holds (stays flat when mounts reuse them)
export const programCount = () => (SHARED && SHARED.renderer.info.programs ? SHARED.renderer.info.programs.length : 0);

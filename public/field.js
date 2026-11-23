// The hero: the meadow drawn as one living brain (canvas #field0), plus the live feed every landing script shares.
//
// One neuron = one living creature (GET /api/world). Lobes = the open model assigned as each creature's brain, laid on
// the surface of a brain-shaped volume in two hemispheres; colour = rarity tier (GET /api/genes); size = energy.
// Synapses: nearest neighbours inside a lobe, plus faint tracts between lobes and threads along a lineage (same name stem).
// Signals: every new duel / share / hatch in GET /api/events runs along the synapses between the creatures involved;
// a seal or a round ripples through the whole volume. Kill zone (GET /api/standing): those creatures drift to the rim in pink.
// Round change: the removed flare once and go dark, the newborn ignite. Heartbeat: one beat a second on the server clock,
// harder in the last five minutes; the dial around the brain sweeps faster as the trial nears.
// Nothing here runs a model: it is a drawing of the simulation's public state.
(function () {
  'use strict';
  const getJ = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // ---------------------------------------------------------------- shared live feed (field.js loads first)
  // One poller per page for /api/world, /api/events and /api/standing; ward.js and landing.js subscribe to it.
  const feed = window.wlFeed || (window.wlFeed = (function () {
    const subs = { world: new Set(), events: new Set(), standing: new Set() }, last = { world: null, events: null, standing: null }, busy = {};
    const pub = (k, v) => { last[k] = v; subs[k].forEach((f) => { try { f(v); } catch (e) {} }); };
    const ok = { world: (v) => v && Array.isArray(v.c), events: Array.isArray, standing: Array.isArray };
    const URL = { world: '/api/world', events: '/api/events', standing: '/api/standing' };
    async function poll(k) { if (document.hidden || busy[k]) return; busy[k] = 1; const v = await getJ(URL[k]); busy[k] = 0; if (ok[k](v)) pub(k, v); }
    const all = () => { poll('world'); poll('events'); poll('standing'); };
    all(); setInterval(() => poll('world'), 1500); setInterval(() => poll('events'), 4000); setInterval(() => poll('standing'), 6000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) all(); });
    document.addEventListener('round', () => { setTimeout(() => poll('world'), 400); setTimeout(() => poll('standing'), 1500); });
    return { on(k, f) { subs[k].add(f); if (last[k]) f(last[k]); return () => subs[k].delete(f); }, get(k) { return last[k]; }, poll };
  })());
  // the brain table, fetched once (cards.js already asks for it)
  window.wlGenes = window.wlGenes || ((typeof PX_GENES !== 'undefined' && PX_GENES) ? PX_GENES : getJ('/api/genes')).then((L) => (Array.isArray(L) ? L : []));
  // one animation loop per page: art.js runs it (and stops it while the tab is hidden); a plain rAF loop otherwise
  window.wlLoop = window.wlLoop || function (f) {
    if (window.Art && Art.tick) return Art.tick(f);
    let on = true; const r = (t) => { if (!on) return; if (f(t, 16) === false) return; requestAnimationFrame(r); }; requestAnimationFrame(r); return () => (on = false);
  };

  const c = document.getElementById('field0'); if (!c) return;
  const g = c.getContext('2d');
  const RM = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  const col3 = (r, gg, b) => { const a = [r, gg, b]; a.css = `rgb(${r},${gg},${b})`; return a; };
  // calm palette: one hue family (mint) by rarity brightness; only legendary keeps a warm accent
  // sober palette: greys by rarity, mint only for the live accent
  const TIER = { legendary: col3(92, 242, 168), epic: col3(200, 200, 196), rare: col3(160, 160, 156), uncommon: col3(120, 120, 117), common: col3(84, 84, 82) };
  const PINK = col3(110, 110, 107), MINT = col3(92, 242, 168), AMBER = col3(190, 190, 186), VIOLET = col3(150, 150, 146), WHITE = col3(236, 236, 232), DARK = col3(52, 52, 50), GHOST = col3(80, 80, 78), HI = col3(236, 236, 232);
  const KIND = { duel: AMBER, share: MINT, hatch: WHITE, round: PINK, seal: VIOLET };
  const KIND_WORD = { duel: 'Duel', share: 'Share', hatch: 'Hatch', round: 'Round', seal: 'Seal' };
  const F = 3.1;                                   // camera distance, in brain radii
  const AX = 1.32, AY = 0.86, AZ = 1.02;           // the brain's semi-axes (front-back, height, width)

  // ---- glow sprites: one small radial per colour, built once, drawn additively ----
  const sprites = new Map();
  function sprite(rgb) {
    let s = sprites.get(rgb); if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = 48; const x = s.getContext('2d');
    const gr = x.createRadialGradient(24, 24, 0, 24, 24, 24), [r, gg, b] = rgb;
    gr.addColorStop(0, `rgba(${r},${gg},${b},.28)`); gr.addColorStop(0.18, `rgba(${r},${gg},${b},.08)`); gr.addColorStop(0.5, `rgba(${r},${gg},${b},.015)`); gr.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, 48, 48); sprites.set(rgb, s); return s;
  }
  // ---- the creature glyph per colour (the hovered neuron shows what it is) ----
  const BIRD = ['.X.......X.', '..X.....X..', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.XXXXXXXXX.', '.XXXX.XXXX.', '..XXXXXXX..', '...X...X...'];
  const birds = new Map();
  function bird(rgb) {
    let s = birds.get(rgb); if (s) return s;
    s = document.createElement('canvas'); s.width = 11; s.height = 9; const x = s.getContext('2d'); x.fillStyle = rgb.css;
    BIRD.forEach((row, y) => { for (let i = 0; i < 11; i++) if (row[i] === 'X') x.fillRect(i, y, 1, 1); });
    birds.set(rgb, s); return s;
  }

  // ---- layout ----
  let W = 0, H = 0, CX = 0, CY = 0, R = 1, narrow = false, dim = 1, D = 1, FONT_A = '', FONT_B = '', FONT_C = '', LX = 0, LY0 = 0, LY1 = 0;
  function fit() {
    const w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
    D = Math.min(2, window.devicePixelRatio || 1);
    if (w * h * D * D > 2.8e6) D = Math.max(1, Math.sqrt(2.8e6 / (w * h)));  // a large canvas: keep the fill rate sane
    W = Math.round(w * D); H = Math.round(h * D); c.width = W; c.height = H; narrow = innerWidth < 861;
    // on wide screens the canvas starts at 18% of the hero (CSS): place the brain against the hero, not the canvas
    const hr = c.parentElement.getBoundingClientRect(), cr = c.getBoundingClientRect(), off = (cr.left - hr.left) * D, HW = hr.width * D;
    if (narrow) { CX = W * 0.62; CY = Math.min(H * 0.42, 300 * D); R = Math.min(W * 0.36, 250 * D); dim = 0.6; }
    else { CX = HW * 0.73 - off; CY = H * 0.47; R = Math.min(H * 0.32, HW * 0.19); dim = 1; }
    // the label column (an anatomical plate): right of the brain, above the meadow window, below the legend
    const win = document.getElementById('meadowWin'), leg = document.querySelector('.lp-leg');
    LX = Math.min(CX + R * AX * 1.12, W - 210 * D);
    LY0 = leg ? (leg.getBoundingClientRect().bottom - cr.top + 34) * D : CY - R;
    LY1 = win ? (win.getBoundingClientRect().top - cr.top - 26) * D : CY + R;
    FONT_A = `600 ${Math.round(9.5 * D)}px Inter, system-ui, sans-serif`; FONT_B = `500 ${Math.round(13 * D)}px Inter, sans-serif`; FONT_C = `600 ${Math.round(12.5 * D)}px Inter, system-ui, sans-serif`;
  }
  let rz = 0; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(fit, 120); }, { passive: true }); fit();
  addEventListener('load', fit); if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  if ('ResizeObserver' in window) new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(fit, 120); }).observe(c.parentElement);

  // ---- the cortex: folded contour lines on each hemisphere (gyri), drawn as dotted traces; they make the volume read as a brain ----
  const NG = 14, GS = 120, gx = new Float32Array(NG * GS), gyv = new Float32Array(NG * GS), gz = new Float32Array(NG * GS);
  for (let k = 0; k < NG; k++) {
    const side = k % 2 ? 1 : -1, ring = k >> 1, t0 = 0.32 + ring * 0.19; // rings around the left-right axis, from the crown of each hemisphere out
    for (let i = 0; i < GS; i++) {
      const ph = (i / GS) * 6.2832, t = t0 + 0.06 * Math.sin(ph * 7 + k * 1.7) + 0.035 * Math.sin(ph * 13 - k);
      const x = Math.sin(t) * Math.cos(ph), y = Math.sin(t) * Math.sin(ph), z = Math.cos(t) * side;
      const f = 1 + 0.03 * Math.sin(ph * 9 + k);
      gx[k * GS + i] = x * AX * f; gyv[k * GS + i] = y * AY * f * (y < 0 ? 0.86 : 1); gz[k * GS + i] = z * AZ * f + side * 0.05;
    }
  }

  // ---- state ----
  const rnd = (seed) => { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const N = new Map();        // id -> neuron
  let NA = [];                // the same neurons as an array (rebuilt when the set changes, never per frame)
  let lobes = new Map(), LA = [], top = [];
  let syn = [], syn0 = [], syn1 = [], tracts = [];  // synapses [a, b, kind] (0 same model, 1 same lineage); tracts between lobe centres [la, lb]
  const sig = [], waves = [];
  let MODELS = {}, KZ = new Set(), real = false, lastRound = null, seen = null, dirty = true;
  const now = () => performance.now() / 1000;
  const stem = (nick) => String(nick || '').split(' ')[0];

  function place() {
    const counts = new Map(); for (const n of N.values()) if (!n.dead) counts.set(n.model, (counts.get(n.model) || 0) + 1);
    const ids = [...counts.keys()].sort((a, b) => {
      const ta = TIER_ORDER[(MODELS[a] || {}).tier] || 0, tb = TIER_ORDER[(MODELS[b] || {}).tier] || 0; return tb - ta || (a < b ? -1 : 1);
    });
    const old = lobes; lobes = new Map();
    ids.forEach((m, i) => {
      const k = ids.length, y = k > 1 ? 1 - (2 * (i + 0.5)) / k : 0, r = Math.sqrt(1 - y * y), a = i * 2.39996, side = i % 2 ? 1 : -1;
      const rad = k > 1 ? 0.64 : 0, M = MODELS[m] || {};
      const L = old.get(m) || { la: 0 };
      L.x = Math.cos(a) * r * rad * AX; L.y = y * rad * AY * 0.92; L.z = Math.abs(Math.sin(a) * r) * rad * AZ * side + side * 0.1;
      L.n = counts.get(m); L.col = TIER[M.tier] || GHOST; L.label = String(M.name || m).toUpperCase(); L.num = String(L.n); L.m = m;
      lobes.set(m, L);
    });
    LA = [...lobes.values()]; top = [...LA].sort((a, b) => b.n - a.n).slice(0, 7);
    for (const n of N.values()) {
      if (n.dead) continue; const L = lobes.get(n.model), r = rnd(Math.abs(n.id) + 7), sp = 0.12 + 0.02 * Math.sqrt(L.n);
      const u = r() * 2 - 1, th = r() * 6.2832, q = Math.cbrt(r()) * sp, s = Math.sqrt(1 - u * u);
      n.bx = L.x + q * s * Math.cos(th); n.by = L.y + q * u; n.bz = L.z + q * s * Math.sin(th); n.rim = 1.05 + r() * 0.1; n.ph = r() * 6.2832; n.L = L;
      if (n.x == null) { n.x = n.bx * 0.15; n.y = n.by * 0.15; n.z = n.bz * 0.15; }
      n.col = n.real ? L.col : GHOST;
    }
    // synapses: two nearest of the same brain; lineage threads; tracts between neighbouring lobes
    syn = []; const key = new Set(), add = (a, b, k) => { const id = a.id < b.id ? a.id + '_' + b.id : b.id + '_' + a.id; if (!key.has(id)) { key.add(id); syn.push([a, b, k]); } };
    const by = new Map(), lin = new Map();
    for (const n of N.values()) { if (n.dead) continue; (by.get(n.model) || by.set(n.model, []).get(n.model)).push(n); if (n.real) { const s = stem(n.nick); (lin.get(s) || lin.set(s, []).get(s)).push(n); } }
    for (const arr of by.values()) for (const a of arr) {
      let b1 = null, b2 = null, d1 = 9, d2 = 9;
      for (const b of arr) { if (b === a) continue; const d = (a.bx - b.bx) ** 2 + (a.by - b.by) ** 2 + (a.bz - b.bz) ** 2; if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = b; } else if (d < d2) { d2 = d; b2 = b; } }
      if (b1) add(a, b1, 0); if (b2) add(a, b2, 0);
    }
    for (const arr of lin.values()) { arr.sort((a, b) => a.gen - b.gen || a.id - b.id); for (let i = 1; i < arr.length; i++) if (arr[i].model !== arr[i - 1].model) add(arr[i - 1], arr[i], 1); }
    tracts = [];
    for (const A of LA) { let b1 = null, b2 = null, d1 = 99, d2 = 99; for (const B of LA) { if (B === A) continue; const d = (A.x - B.x) ** 2 + (A.y - B.y) ** 2 + (A.z - B.z) ** 2; if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = B; } else if (d < d2) { d2 = d; b2 = B; } } if (b1 && A.m < b1.m) tracts.push([A, b1]); if (b2 && A.m < b2.m) tracts.push([A, b2]); }
    // per-lobe synapse lists, so a frame draws each lobe's batch without scanning every synapse
    for (const L of LA) L.syn = [];
    syn0 = []; syn1 = [];
    for (const sy of syn) { if (sy[2]) syn1.push(sy); else { syn0.push(sy); if (sy[0].L && sy[0].L.syn) sy[0].L.syn.push(sy); } }
    NA = [...N.values()];
    dirty = false;
  }
  const TIER_ORDER = { legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };

  // first paint: a quiet placeholder brain, replaced when the meadow answers
  (function seed() { const r = rnd(11); for (let i = 0; i < 140; i++) { const m = 'p' + Math.floor(r() * r() * 11); N.set(-1 - i, { id: -1 - i, real: false, model: m, nick: '', energy: 40 + r() * 50, gen: 0, born: now() - 5 + r() * 1.2, dead: 0, flash: 0 }); } place(); })();

  // ---- data ----
  let genesAsked = 0;
  window.wlGenes.then((L) => { for (const m of L) MODELS[m.id] = m; dirty = true; });
  function refreshGenes() { if (Date.now() - genesAsked < 60000) return; genesAsked = Date.now(); getJ('/api/genes').then((L) => { if (!Array.isArray(L)) return; for (const m of L) MODELS[m.id] = m; dirty = true; }); }
  const legEl = document.getElementById('chLeg'), roundEl = document.getElementById('chRound'), sigEl = document.getElementById('chSig');
  let legTxt = '';
  feed.on('world', (w) => {
    if (!w.c.length) return;
    const t = now(), first = !real, rn = w.round ? w.round.n : null, turned = !first && lastRound != null && rn !== lastRound; lastRound = rn;
    if (first) { for (const n of N.values()) { n.dead = t; n.quiet = true; } real = true; }
    const live = new Set();
    let died = 0;
    for (let i = 0; i < w.c.length; i++) {
      const r = w.c[i], id = r[0]; live.add(id); let n = N.get(id);
      if (!n) { n = { id, real: true, born: first ? t + (i % 40) * 0.025 : t + (turned ? 1.4 : 0), dead: 0, flash: first ? 0.4 : 1.6, newborn: !first }; N.set(id, n); dirty = true; }
      if (n.model !== r[5]) dirty = true;
      n.energy = r[3]; n.model = r[5]; n.nick = r[6]; n.gen = r[8] || 0; if (n.dead) { n.dead = 0; dirty = true; }
    }
    for (const n of N.values()) if (n.real && !n.dead && !live.has(n.id)) { n.dead = t + (turned ? Math.random() * 0.7 : 0); dirty = true; died++; }
    if (turned) { waves.push({ t0: t, col: PINK, k: 1.4 }); say({ kind: 'round', text: `Round ${rn} · ${died} removed. They go dark; the newborn light up.` }); }
    if (w.c.some((r) => !MODELS[r[5]])) refreshGenes();
    if (dirty) place();
    const txt = `The meadow, as one brain · ${live.size} neurons · one per living creature`;
    if (legEl && txt !== legTxt) { legTxt = txt; legEl.textContent = txt; }
    if (roundEl && rn != null) roundEl.textContent = `Round ${rn + 1} · live`;
  });
  feed.on('standing', (s) => { KZ = new Set(s.filter((x) => x.inKillZone).map((x) => x.id)); });
  let sayAt = 0;
  function say(e) { // one line of real activity under the brain
    if (!sigEl) return; const t = performance.now(); if (t - sayAt < 2200 && e.kind !== 'round') return; sayAt = t;
    sigEl.dataset.k = e.kind || ''; sigEl.innerHTML = `<b>${KIND_WORD[e.kind] || 'Signal'}</b>`; sigEl.appendChild(document.createTextNode(' ' + String(e.text || '').replace(/ \([^)]*\)/g, '')));
    if (window.Art && Art.glitchText && !RM) Art.glitchText(sigEl, { ms: 420 });
  }
  function fire(e, delay) {
    const col = KIND[e.kind] || WHITE, who = (e.who || []).map((id) => N.get(id)).filter((n) => n && !n.dead), t = now() + (delay || 0);
    if (who.length >= 2) sig.push({ a: who[0], b: who[1], t0: t, dur: who[0].L === who[1].L ? 1.1 : 1.7, col, lit: 0, hit: 0 });
    else if (who.length === 1) who[0].flash = 1.4;
    else waves.push({ t0: t, col, k: 0.8 });
    setTimeout(() => say(e), Math.max(0, (delay || 0) * 1000));
  }
  feed.on('events', (ev) => {
    if (!real) return;
    const k = (e) => e.at + '|' + e.text;
    if (!seen) { seen = new Set(ev.map(k)); ev.filter((e) => (e.who || []).length >= 2).slice(0, 3).forEach((e, i) => fire(e, 0.9 + i * 0.8)); return; } // open on the three latest real exchanges
    const fresh = ev.filter((e) => !seen.has(k(e))).reverse(); fresh.forEach((e, i) => { seen.add(k(e)); if (i < 8) fire(e, i * 0.4); });
    if (seen.size > 600) seen = new Set(ev.map(k));
  });

  // ---- pointer ----
  let mx = 0, my = 0, px = -1, py = -1, hot = null;
  addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; }, { passive: true });
  c.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; const r = c.getBoundingClientRect(); px = (e.clientX - r.left) * D; py = (e.clientY - r.top) * D; });
  c.addEventListener('pointerleave', () => { px = py = -1; });
  c.addEventListener('click', (e) => { const r = c.getBoundingClientRect(), n = pick((e.clientX - r.left) * D, (e.clientY - r.top) * D); if (n) { if (window.Art && Art.wipeTo) Art.wipeTo('/app?b=' + n.id); else location.href = '/app?b=' + n.id; } });
  function pick(x, y) { let best = null, bd = (15 * D) ** 2; for (let i = 0; i < NA.length; i++) { const n = NA[i]; if (!n.real || n.dead || n.sx == null || n.a < 0.5) continue; const d = (n.sx - x) ** 2 + (n.sy - y) ** 2; if (d < bd) { bd = d; best = n; } } return best; }

  // ---- clock ----
  function clockNow() { // server time and the next trial, from the shared countdown (cards.js); falls back to the local clock
    const t = Date.now() + (typeof skew === 'number' ? skew : 0);
    const left = typeof ROUND !== 'undefined' && ROUND && ROUND.next ? ROUND.next - t : null;
    return { ph: (((t % 1000) + 1000) % 1000) / 1000, urg: left == null ? 0 : Math.max(0, Math.min(1, 1 - left / 300000)), left };
  }

  // ---- projection, allocation-free: P() writes into PX, PY, PK (scale) and PD (depth light) ----
  let sy = 0, cy = 1, sp = 0, cp = 1, PX = 0, PY = 0, PK = 1, PD = 1;
  function P(x, y, z) { const x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp, k = F / (F + z2); PX = CX + x1 * R * k; PY = CY - y1 * R * k; PK = k; PD = Math.max(0.1, Math.min(1, 0.58 - z2 * 0.46)); }
  const qb = (a, b, c2, u) => { const v = 1 - u; return v * v * a + 2 * v * u * b + u * u * c2; };

  // ---- draw ----
  let yaw = 0.9, yawOff = 0, last = 0, visible = true, still = 0, dialA = 0;
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }, { rootMargin: '60px' }).observe(c);
  const LBL = []; for (let i = 0; i < 8; i++) LBL.push({ L: null, x: 0, y: 0, ax: 0, ay: 0, ty: 0 });

  function frame(tms) {
    if (!visible || !W) return true;
    const t = tms / 1000, dtr = last ? Math.min(0.5, t - last) : 0.016, dt = Math.min(0.05, dtr); last = t;
    if (RM) { if (t - still < 1) return true; still = t; }
    const ck = clockNow(), ph = ck.ph, urg = ck.urg, beat = RM ? 0 : Math.exp(-ph * 7);
    if (dirty) place();
    if (!RM) { yaw += dt * 0.07; yawOff += (mx * 0.6 - yawOff) * Math.min(1, dt * 2.2); }
    const pitch = 0.2 + (RM ? 0 : Math.sin(t * 0.11) * 0.06 + my * 0.1), a = yaw + yawOff;
    sy = Math.sin(a); cy = Math.cos(a); sp = Math.sin(pitch); cp = Math.cos(pitch);
    const swell = 1 + beat * (0.01 + 0.018 * urg), ease = RM ? 1 : 1 - Math.exp(-dtr * 2.4); // frame-rate independent
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.clearRect(0, 0, W, H);
    const lw = Math.max(1, Math.round(D));

    // the dial: an instrument ring around the specimen; its sweep runs faster and turns amber, then pink, as the trial nears
    {
      const rr = R * 1.5, n = narrow ? 90 : 144, near = urg > 0;
      dialA += dt * (0.08 + 0.9 * urg * urg);
      const sw = (dialA % 1) * 6.2832, scol = urg > 0.8 ? PINK : near ? AMBER : MINT;
      g.fillStyle = MINT.css;
      for (let i = 0; i < n; i++) {
        const an = (i / n) * 6.2832, x = CX + Math.cos(an) * rr, y = CY + Math.sin(an) * rr * 0.92;
        let d = an - sw; while (d < 0) d += 6.2832; const tail = d > 5.6 ? (d - 5.6) / 0.68 : 0;
        const long = i % (n / 12) === 0, s = (long ? 2 : 1) * lw, len = (long ? 7 : 3) * D;
        g.globalAlpha = (0.08 + 0.5 * tail) * dim;
        if (tail > 0.02) g.fillStyle = scol.css; else g.fillStyle = MINT.css;
        g.fillRect(x - s / 2, y - s / 2, s, long ? len : s);
      }
    }

    // the cortex: gyri contours, two depth passes (back faint, front brighter)
    g.strokeStyle = WHITE.css; g.lineWidth = lw;
    for (let pass = 0; pass < 2; pass++) {
      g.globalAlpha = (pass ? 0.1 : 0.035) * dim * (real ? 1 : 0.7); g.beginPath();
      for (let k = 0; k < NG; k++) {
        for (let i = 0; i < GS; i++) {
          const a0 = k * GS + i, a1 = k * GS + ((i + 1) % GS);
          P(gx[a0] * swell, gyv[a0] * swell, gz[a0] * swell); const x0 = PX, y0 = PY, d0 = PD;
          if ((d0 > 0.5) !== (pass === 1)) continue;
          P(gx[a1] * swell, gyv[a1] * swell, gz[a1] * swell); g.moveTo(x0, y0); g.lineTo(PX, PY);
        }
      }
      g.stroke();
    }

    // neurons: move, project
    for (let i = 0; i < NA.length; i++) {
      const n = NA[i];
      if (n.dead && t - n.dead > (n.quiet ? 0.9 : 7)) { N.delete(n.id); dirty = true; n.a = 0; continue; }
      const kz = n.real && !n.dead && KZ.has(n.id); n.kz = kz; let tx = n.bx, ty = n.by, tz = n.bz;
      if (kz) { tx *= 1.14; ty *= 1.14; tz *= 1.14; } // the kill zone drifts outward, toward the edge of the meadow's mind
      if (n.dead && !n.quiet && t > n.dead + 0.5) ty -= Math.min(0.25, (t - n.dead - 0.5) * 0.04); // the dead sink
      n.x += (tx - n.x) * ease * 0.6; n.y += (ty - n.y) * ease * 0.6; n.z += (tz - n.z) * ease * 0.6;
      P(n.x * swell, n.y * swell, n.z * swell); n.sx = PX; n.sy = PY; n.k = PK; n.d = PD;
      const age = t - n.born; n.a = age <= 0 ? 0 : Math.min(1, age / 0.9);
      if (n.dead) { const da = t - n.dead; n.a = da < 0 ? 1 : n.quiet ? Math.max(0, 1 - da / 0.9) : Math.max(0, 1 - Math.max(0, da - 0.6) / 6.4); }
      if (n.flash > 0.01 && age > 0) n.flash *= Math.pow(0.15, dt); else if (age > 0) n.flash = 0;
    }
    for (let i = 0; i < LA.length; i++) { const L = LA[i]; P(L.x * swell, L.y * swell, L.z * swell); L.sx = PX; L.sy = PY; L.d = PD; }

    g.globalCompositeOperation = 'lighter';
    // tracts between lobes: long faint curves through the white matter
    g.strokeStyle = HI.css; g.globalAlpha = 0.05 * dim; g.lineWidth = lw; g.beginPath();
    for (let i = 0; i < tracts.length; i++) {
      const A = tracts[i][0], B = tracts[i][1];
      for (let j = 0; j <= 10; j++) { const u = j / 10; P(qb(A.x, (A.x + B.x) * 0.2, B.x, u), qb(A.y, (A.y + B.y) * 0.2, B.y, u), qb(A.z, (A.z + B.z) * 0.2, B.z, u)); if (j) g.lineTo(PX, PY); else g.moveTo(PX, PY); }
    }
    g.stroke();

    // synapses, batched: one path per lobe colour, plus one for the kill zone and one for lineage threads
    for (let i = 0; i < LA.length; i++) {
      const L = LA[i]; g.strokeStyle = L.col.css; g.globalAlpha = (0.05 + 0.03 * beat) * dim * (real ? 1 : 0.6); g.beginPath(); let any = false;
      const ls = L.syn || syn0; for (let j = 0; j < ls.length; j++) { const s = ls[j], A = s[0], B = s[1]; if (A.L !== L || A.dead || B.dead || A.kz || B.kz || A.a < 0.3 || B.a < 0.3) continue; g.moveTo(A.sx, A.sy); g.lineTo(B.sx, B.sy); any = true; }
      if (any) g.stroke();
    }
    g.strokeStyle = PINK.css; g.globalAlpha = (0.22 + 0.25 * urg) * dim; g.beginPath();
    for (let j = 0; j < syn0.length; j++) { const s = syn0[j], A = s[0], B = s[1]; if (A.dead || B.dead || !(A.kz || B.kz)) continue; g.moveTo(A.sx, A.sy); g.lineTo(B.sx, B.sy); }
    g.stroke();
    g.strokeStyle = WHITE.css; g.globalAlpha = 0.06 * dim; g.beginPath();
    for (let j = 0; j < syn1.length; j++) { const s = syn1[j], A = s[0], B = s[1]; if (A.dead || B.dead) continue; g.moveTo(A.sx, A.sy); g.lineTo(B.sx, B.sy); }
    g.stroke();

    // neurons: light. A phosphor halo, then a hard square core; the kill zone gets a pink square ring
    for (let i = 0; i < NA.length; i++) {
      const n = NA[i]; if (n.a <= 0) continue;
      const e = n.energy < 0 ? 0.12 : Math.max(0.2, Math.min(1, n.energy / 100)), core = D * (1.3 + 2.4 * e) * n.k * (narrow ? 0.85 : 1);
      const r3 = Math.hypot(n.x / AX, n.y / AY, n.z / AZ), dr = r3 - ph * 1.6, ring = RM ? 0 : Math.exp(-dr * dr * 26) * (1 - ph) * (0.3 + 0.6 * urg);
      let wv = 0; for (let w = 0; w < waves.length; w++) { const W0 = waves[w]; if (t < W0.t0) continue; const q = r3 - (t - W0.t0) * 0.9; wv += Math.exp(-q * q * 30) * W0.k; }
      let col = n.col, al = n.a * n.d * dim * (0.7 + 0.18 * Math.sin(t * 1.3 + n.ph) + ring + wv), size = core * (1 + n.flash * 0.8 + wv * 0.6);
      if (n.dead && !n.quiet) {
        const da = t - n.dead;
        if (da >= 0 && da < 0.6) { // the flare
          const k = da / 0.6; g.globalAlpha = (1 - k) * n.d * dim; g.strokeStyle = WHITE.css; g.lineWidth = lw; const s = core * (3 + 12 * k); g.strokeRect(n.sx - s, n.sy - s, s * 2, s * 2);
          col = WHITE; size = core * (2 - k); al = n.d * dim;
        } else if (da >= 0.6) { // dark: a hollow grey square, sinking and fading
          g.globalCompositeOperation = 'source-over'; g.globalAlpha = n.a * n.d * dim * 0.8; g.strokeStyle = DARK.css; g.lineWidth = lw; const s = Math.max(2 * D, core * 1.2); g.strokeRect((n.sx - s / 2) | 0, (n.sy - s / 2) | 0, s, s); g.globalCompositeOperation = 'lighter'; continue;
        }
      }
      if (n.newborn && t - n.born < 1.6 && t > n.born) { const k = (t - n.born) / 1.6; g.globalAlpha = (1 - k) * dim; g.strokeStyle = MINT.css; g.lineWidth = lw; const s = core * (2 + 9 * k); g.strokeRect(n.sx - s, n.sy - s, s * 2, s * 2); }
      if (n.kz) { col = PINK; if (urg > 0.4) { const s = core * (2.2 + 0.5 * Math.sin(t * 2.6 + n.ph)); g.globalAlpha = n.a * n.d * dim * urg * 0.6; g.strokeStyle = PINK.css; g.lineWidth = lw; g.strokeRect((n.sx - s) | 0, (n.sy - s) | 0, s * 2, s * 2); } }
      const halo = size * 5; g.globalAlpha = Math.min(1, al * 0.18 + n.flash * 0.2); g.drawImage(sprite(col), n.sx - halo, n.sy - halo, halo * 2, halo * 2);
      g.globalAlpha = Math.min(1, al + n.flash * 0.5); g.fillStyle = n.flash > 0.4 ? HI.css : col.css; const s = Math.max(lw, size); g.fillRect((n.sx - s / 2) | 0, (n.sy - s / 2) | 0, Math.ceil(s), Math.ceil(s));
    }

    // signals: real events, running between the creatures involved (through the white matter when lobes differ)
    for (let i = sig.length - 1; i >= 0; i--) {
      const s = sig[i], q = (t - s.t0) / s.dur; if (q < 0) continue;
      const A = s.a, B = s.b; if (q > 1.6 || A.sx == null || B.sx == null) { sig.splice(i, 1); continue; }
      const cxp = (A.x + B.x) * 0.25, cyp = (A.y + B.y) * 0.25, czp = (A.z + B.z) * 0.25, same = A.L === B.L;
      const fade = q < 1 ? 1 : Math.max(0, 1 - (q - 1) / 0.6), head = RM ? 1 : Math.min(1, q * q * (3 - 2 * q));
      g.globalAlpha = 0.4 * fade * dim; g.strokeStyle = s.col.css; g.lineWidth = Math.max(1, D * 0.8); g.beginPath();
      for (let j = 0; j <= 16; j++) { const u = (j / 16) * head; if (same) P(A.x + (B.x - A.x) * u, A.y + (B.y - A.y) * u, A.z + (B.z - A.z) * u); else P(qb(A.x, cxp, B.x, u), qb(A.y, cyp, B.y, u), qb(A.z, czp, B.z, u)); if (j) g.lineTo(PX, PY); else g.moveTo(PX, PY); }
      g.stroke();
      if (q < 1) {
        for (let j = 0; j < 6; j++) { const u = head - j * 0.03; if (u < 0) break; if (same) P(A.x + (B.x - A.x) * u, A.y + (B.y - A.y) * u, A.z + (B.z - A.z) * u); else P(qb(A.x, cxp, B.x, u), qb(A.y, cyp, B.y, u), qb(A.z, czp, B.z, u)); const sz = D * (4 - j * 0.5); g.globalAlpha = (1 - j * 0.16) * dim; g.fillStyle = j ? s.col.css : HI.css; g.fillRect(PX - sz / 2, PY - sz / 2, sz, sz); if (!j) { const hr = D * 16; g.globalAlpha = 0.3 * dim; g.drawImage(sprite(s.col), PX - hr, PY - hr, hr * 2, hr * 2); } }
        if (!s.lit) { s.lit = 1; A.flash = Math.max(A.flash, 0.9); }
      } else if (!s.hit) { s.hit = 1; B.flash = Math.max(B.flash, 1.5); }
    }
    for (let i = waves.length - 1; i >= 0; i--) if (t - waves[i].t0 > 2.6) waves.splice(i, 1);

    g.globalCompositeOperation = 'source-over';
    // lobe labels: the biggest brains named in a column right of the specimen, like an anatomical plate (the copy lives on the left)
    if (false && !narrow && real && LY1 - LY0 > 60 * D) { // lobe labels off (cleaner hero)
      let nl = 0;
      for (let i = 0; i < top.length; i++) {
        const L = top[i], want = L.sx > CX - R * 0.2 && L.d > 0.4 ? 1 : 0; L.la += (want - L.la) * Math.min(1, dt * 3);
        if (L.la < 0.02 || nl >= LBL.length) continue;
        const o = LBL[nl++]; o.L = L; o.ty = Math.max(LY0, Math.min(LY1, CY + (L.sy - CY) * 1.15));
      }
      // keep labels apart vertically (insertion sort, no allocation), then fit them inside the column
      for (let i = 1; i < nl; i++) { const o = LBL[i]; let j = i - 1; while (j >= 0 && LBL[j].ty > o.ty) { LBL[j + 1] = LBL[j]; j--; } LBL[j + 1] = o; }
      const gap = 26 * D; for (let i = 1; i < nl; i++) if (LBL[i].ty - LBL[i - 1].ty < gap) LBL[i].ty = LBL[i - 1].ty + gap;
      const over = nl ? LBL[nl - 1].ty - LY1 : 0; if (over > 0) for (let i = 0; i < nl; i++) LBL[i].ty -= over;
      g.lineWidth = lw; g.textBaseline = 'middle'; g.textAlign = 'left';
      for (let i = 0; i < nl; i++) {
        const o = LBL[i], L = o.L, y1 = o.ty, xk = LX - 18 * D;
        g.globalAlpha = 0.3 * L.la; g.strokeStyle = L.col.css; g.beginPath(); g.moveTo(L.sx, L.sy); g.lineTo(xk, y1); g.lineTo(LX - 6 * D, y1); g.stroke();
        g.globalAlpha = 0.9 * L.la; g.fillStyle = L.col.css; g.fillRect((L.sx - 2 * D) | 0, (L.sy - 2 * D) | 0, 4 * D, 4 * D); g.fillRect((LX - 6 * D) | 0, (y1 - 1.5 * D) | 0, 3 * D, 3 * D);
        g.font = FONT_B; g.fillStyle = '#ededE8'; g.globalAlpha = 0.9 * L.la; g.fillText(L.num, LX + 2 * D, y1); const nw = g.measureText(L.num).width;
        g.font = FONT_A; g.fillStyle = '#a3a3a0'; g.globalAlpha = 0.8 * L.la; g.fillText(L.label, LX + 10 * D + nw, y1);
      }
    }

    // hover: brackets around the neuron, its creature glyph, a leader and its name
    hot = px >= 0 ? pick(px, py) : null; c.style.cursor = hot ? 'pointer' : '';
    if (hot) {
      const x = hot.sx, y = hot.sy, s = 11 * D, k = 4 * D; g.globalAlpha = 1; g.strokeStyle = hot.kz ? PINK.css : MINT.css; g.lineWidth = lw; g.beginPath();
      g.moveTo(x - s, y - s + k); g.lineTo(x - s, y - s); g.lineTo(x - s + k, y - s); g.moveTo(x + s - k, y - s); g.lineTo(x + s, y - s); g.lineTo(x + s, y - s + k);
      g.moveTo(x - s, y + s - k); g.lineTo(x - s, y + s); g.lineTo(x - s + k, y + s); g.moveTo(x + s - k, y + s); g.lineTo(x + s, y + s); g.lineTo(x + s, y + s - k); g.stroke();
      const m = MODELS[hot.model] || {}, l1 = hot.nick || '#' + hot.id, l2 = String((m.name || hot.model) + (hot.kz ? ' · in the kill zone' : '')).toUpperCase();
      g.font = FONT_C; const w1 = g.measureText(l1).width; g.font = FONT_A; const w2 = g.measureText(l2).width;
      const bw = Math.max(w1 + 22 * D, w2) + 24 * D, bh = 44 * D; let bx = x + 22 * D, by = y - bh / 2; if (bx + bw > W - 8 * D) bx = x - 22 * D - bw; by = Math.max(8 * D, Math.min(H - bh - 8 * D, by));
      g.fillStyle = 'rgba(10,10,10,.94)'; g.fillRect(bx, by, bw, bh); g.fillStyle = hot.kz ? PINK.css : MINT.css; g.fillRect(bx, by, 2 * D, bh);
      g.imageSmoothingEnabled = false; g.drawImage(bird(hot.col), bx + 12 * D, by + 9 * D, 11 * Math.round(1.4 * D), 9 * Math.round(1.4 * D)); g.imageSmoothingEnabled = true;
      g.textBaseline = 'alphabetic'; g.fillStyle = '#ededE8'; g.font = FONT_C; g.fillText(l1, bx + 34 * D, by + 19 * D);
      g.fillStyle = hot.kz ? PINK.css : '#6e6e6b'; g.font = FONT_A; g.fillText(l2, bx + 12 * D, by + 35 * D);
    }
    g.globalAlpha = 1;
    return true;
  }
  wlLoop(frame);
  document.fonts && document.fonts.load && document.fonts.load("500 13px 'Chakra Petch'").catch(() => {});
})();

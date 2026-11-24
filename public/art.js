// art.js — the shared animation layer (see the guide at the top of ds.css).
// Load it in <head> WITHOUT defer: it marks html.art before the first paint (so reveals never
// flash) and boots itself on DOMContentLoaded. One requestAnimationFrame loop for the whole page,
// paused while the tab is hidden; prefers-reduced-motion gets one still frame and no motion.
//
//   Art.drawFrame(el, {color, chamfer})      stroke a chamfered frame around el (SVG dashoffset)
//   Art.countUp(el, value, {ms, decimals, prefix, suffix})   count a figure up; final text exact
//   Art.glitchText(el, {ms, delay})          text resolves out of noise, left to right
//   Art.segments(el, text, {color})          draw text as segment numerals on a canvas (hero figures)
//   Art.scan(root)                           register new [data-draw]/[data-count]/[data-seg]/.ds-num
//   Art.reveal(el)                           reveal now (skips the scroll trigger)
//   Art.tick(fn)                             add fn(t, dt) to the shared loop; return false to stop
//   Art.rain.pause() / .resume() / .mode('on'|'dim'|'full'|'off')
//   Art.models                               Promise of the /api/models list (fetched once)
//   Art.wipeTo(url)                          navigate through the scanline wipe
//   Art.reduced                              true when the visitor prefers reduced motion
(() => {
  'use strict';
  if (window.Art) return;
  const D = document, R = D.documentElement, W = window;
  const mq = (q) => { try { return W.matchMedia(q); } catch { return { matches: false, addEventListener() {} }; } };
  const RMQ = mq('(prefers-reduced-motion: reduce)');
  let RM = RMQ.matches;
  R.classList.add('art');
  const now = () => performance.now();
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);
  const staggerOf = (el) => { const v = parseFloat(el.style.getPropertyValue('--i')); return isFinite(v) ? v * 70 : 0; };

  // ------------------------------------------------------------------ the one loop
  const tasks = new Set();
  let raf = 0, last = 0;
  function frame(t) {
    raf = 0;
    const dt = last ? Math.min(64, t - last) : 16; last = t;
    for (const f of tasks) { let keep; try { keep = f(t, dt); } catch (e) { keep = false; } if (keep === false) tasks.delete(f); }
    if (tasks.size && !D.hidden) raf = requestAnimationFrame(frame); else last = 0;
  }
  function wake() { if (!raf && tasks.size && !D.hidden) raf = requestAnimationFrame(frame); }
  function tick(f) { tasks.add(f); wake(); return () => tasks.delete(f); }
  D.addEventListener('visibilitychange', () => { if (D.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; } else wake(); });

  // ------------------------------------------------------------------ data: real model numbers, fetched once
  const models = (() => {
    try { const c = JSON.parse(sessionStorage.getItem('art:models') || 'null'); if (c && Date.now() - c.at < 6e5 && Array.isArray(c.m)) return Promise.resolve(c.m); } catch {}
    return fetch('/api/models').then((r) => (r.ok ? r.json() : null)).then((j) => {
      const m = j && Array.isArray(j.models) ? j.models : [];
      try { sessionStorage.setItem('art:models', JSON.stringify({ at: Date.now(), m })); } catch {}
      return m;
    }).catch(() => []);
  })();

  // ------------------------------------------------------------------ text resolving out of noise
  const NOISE = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=/<>';
  const running = new WeakMap();
  function glitchText(el, o = {}) {
    if (!el) return Promise.resolve();
    if (running.has(el)) return running.get(el);
    const ms = o.ms || 700, delay = o.delay != null ? o.delay : 0;
    const nodes = []; const tw = D.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n, total = 0; while ((n = tw.nextNode())) { if (n.nodeValue.trim()) { nodes.push([n, n.nodeValue, total]); total += n.nodeValue.length; } }
    if (RM || !total || total > 600) return Promise.resolve();
    const h = el.offsetHeight; if (h && !el.style.minHeight) { el.style.minHeight = h + 'px'; el.dataset.artMh = '1'; }
    let cancel = null;
    const p = new Promise((res) => {
      const t0 = now() + delay; let lastStep = -1;
      const stop = tick((t) => {
        const k = (t - t0) / ms;
        if (k < 0) return true;
        const step = Math.floor(t / 45); if (step === lastStep && k < 1) return true; lastStep = step; // ~22 Hz: a signal, not a blur
        const front = Math.floor(easeOut(clamp(k, 0, 1)) * (total + 6));
        for (const [node, orig, off] of nodes) {
          let s = '';
          for (let i = 0; i < orig.length; i++) {
            const c = orig.charCodeAt(i), gi = off + i;
            if (gi < front - 6 || c === 32 || c === 10 || c === 160) s += orig[i];
            else if (gi < front) s += Math.random() < 0.5 ? orig[i] : NOISE[(Math.random() * NOISE.length) | 0];
            else s += Math.random() < 0.18 ? NOISE[(Math.random() * NOISE.length) | 0] : orig[i] === orig[i].toUpperCase() ? ' ' : ' ';
          }
          if (node.nodeValue !== s) node.nodeValue = s;
        }
        if (k >= 1) { finish(); return false; }
        return true;
      });
      function finish() { for (const [node, orig] of nodes) node.nodeValue = orig; if (el.dataset.artMh) { el.style.minHeight = ''; delete el.dataset.artMh; } running.delete(el); res(); }
      cancel = () => { stop(); finish(); };
    });
    p.cancel = cancel;
    running.set(el, p);
    return p;
  }

  // ------------------------------------------------------------------ segment numerals (hero figures)
  // 7 chamfered segments per digit, unlit segments kept as a faint ghost, scanlines cut through.
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };
  const segEls = new Set();
  function segPoly(g, x0, y0, x1, y1, t) { // a hexagon along a horizontal or vertical axis
    const hz = y0 === y1, h = t / 2;
    g.moveTo(x0, y0);
    if (hz) { g.lineTo(x0 + h, y0 - h); g.lineTo(x1 - h, y0 - h); g.lineTo(x1, y0); g.lineTo(x1 - h, y0 + h); g.lineTo(x0 + h, y0 + h); }
    else { g.lineTo(x0 + h, y0 + h); g.lineTo(x0 + h, y1 - h); g.lineTo(x0, y1); g.lineTo(x0 - h, y1 - h); g.lineTo(x0 - h, y0 + h); }
    g.closePath();
  }
  function segDigit(g, ch, x, H, t, on) {
    const w = H * 0.54, gp = t * 0.22, m = H / 2, lit = SEG[ch] || '';
    const S = { a: [x + gp, t / 2, x + w - gp, t / 2], d: [x + gp, H - t / 2, x + w - gp, H - t / 2], g: [x + gp, m, x + w - gp, m],
      f: [x + t / 2, gp, x + t / 2, m - gp], b: [x + w - t / 2, gp, x + w - t / 2, m - gp], e: [x + t / 2, m + gp, x + t / 2, H - gp], c: [x + w - t / 2, m + gp, x + w - t / 2, H - gp] };
    g.beginPath();
    for (const k in S) if (on === lit.includes(k)) segPoly(g, S[k][0], S[k][1], S[k][2], S[k][3], t);
    g.fill();
    return w;
  }
  function segWidth(text, H) { let w = 0; const gap = H * 0.12; for (const ch of text) w += (/[0-9 \-]/.test(ch) ? H * 0.54 : /[.,:]/.test(ch) ? H * 0.16 : ch === '%' ? H * 0.5 : ch === '+' ? H * 0.42 : H * 0.3) + gap; return Math.max(1, w - gap); }
  function segments(el, text, o = {}) {
    if (!el) return;
    text = String(text == null ? el.dataset.seg || el.textContent : text).trim();
    let cv = el.tagName === 'CANVAS' ? el : el.querySelector(':scope > canvas');
    if (!cv) { el.textContent = ''; const sr = D.createElement('span'); sr.className = 'ds-sr'; el.appendChild(sr); cv = D.createElement('canvas'); cv.setAttribute('aria-hidden', 'true'); el.appendChild(cv); }
    const sr = el.querySelector(':scope > .ds-sr'); if (sr && sr.textContent !== text) sr.textContent = text;
    el.dataset.segNow = text; segEls.add(el);
    const cs = getComputedStyle(el), H = Math.max(12, Math.round(parseFloat(cs.fontSize) || 120)), color = o.color || cs.color;
    const dpr = Math.min(2, W.devicePixelRatio || 1), Wd = Math.ceil(segWidth(text, H)) + 2;
    if (cv.width !== Math.round(Wd * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(Wd * dpr); cv.height = Math.round(H * dpr); cv.style.width = Wd + 'px'; cv.style.height = H + 'px'; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, Wd, H);
    const t = Math.max(3, H * 0.115), gap = H * 0.12; let x = 1;
    for (const ch of text) {
      if (/[0-9 \-]/.test(ch)) {
        g.fillStyle = color; g.globalAlpha = 0.075; segDigit(g, '8', x, H, t, true);          // ghost of every segment
        g.globalAlpha = 1; segDigit(g, ch, x, H, t, true); x += H * 0.54 + gap;              // the lit ones
      } else if (/[.,:]/.test(ch)) {
        const s = t * 1.05; g.fillStyle = color; g.globalAlpha = 1;
        if (ch === ':') { g.fillRect(x, H * 0.3 - s / 2, s, s); g.fillRect(x, H * 0.7 - s / 2, s, s); }
        else g.fillRect(x, H - s, s, s);
        if (ch === ',') g.fillRect(x + s * 0.3, H - s * 0.2, s * 0.6, s * 0.55);
        x += H * 0.16 + gap;
      } else if (ch === '%') {
        const s = t * 1.3, w = H * 0.5; g.fillStyle = color; g.globalAlpha = 1;
        g.fillRect(x, H * 0.12, s, s); g.fillRect(x + w - s, H * 0.88 - s, s, s);
        g.beginPath(); g.moveTo(x + w - t * 0.6, H * 0.08); g.lineTo(x + w, H * 0.08 + t * 0.4); g.lineTo(x + t * 0.6, H * 0.92); g.lineTo(x, H * 0.92 - t * 0.4); g.closePath(); g.fill();
        x += w + gap;
      } else if (ch === '+') {
        const w = H * 0.42; g.fillStyle = color; g.beginPath(); segPoly(g, x, H / 2, x + w, H / 2, t); segPoly(g, x + w / 2, H / 2 - w / 2, x + w / 2, H / 2 + w / 2, t); g.fill(); x += w + gap;
      } else x += H * 0.3 + gap;
    }
    // scanlines cut through the figure
    g.globalAlpha = 0.42; g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
    const step = Math.max(3, Math.round(H / 46));
    for (let y = 0; y < H; y += step) g.fillRect(0, y, Wd, 1);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  }
  let segRz = 0;
  W.addEventListener('resize', () => { clearTimeout(segRz); segRz = setTimeout(() => segEls.forEach((el) => { if (el.isConnected) segments(el, el.dataset.segNow); else segEls.delete(el); }), 160); }, { passive: true });

  // ------------------------------------------------------------------ count up
  function countUp(el, value, o = {}) {
    if (!el) return;
    const raw = value != null ? value : el.dataset.count;
    const v = Number(raw); if (!isFinite(v)) return;
    const dec = o.decimals != null ? o.decimals : el.dataset.decimals != null ? +el.dataset.decimals : (String(raw).split('.')[1] || '').length;
    const pre = o.prefix != null ? o.prefix : el.dataset.prefix || '', suf = o.suffix != null ? o.suffix : el.dataset.suffix || '';
    const seg = el.matches('.ds-seg, [data-seg]');
    const fmt = (x) => pre + x.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
    // keep child markup (e.g. <small> units): only the first text node carries the figure
    const target = seg ? null : (() => { for (const c of el.childNodes) if (c.nodeType === 3 && c.nodeValue.trim()) return c; const tn = D.createTextNode(''); el.insertBefore(tn, el.firstChild); return tn; })();
    const put = (x) => { const s = fmt(x); if (seg) segments(el, s); else if (target.nodeValue !== s) target.nodeValue = s; };
    if (RM || v === 0) { put(v); return; }
    const ms = o.ms || 1100, t0 = now() + (o.delay != null ? o.delay : staggerOf(el)), from = o.from || 0, unit = Math.pow(10, -dec);
    put(from);
    tick((t) => {
      const k = clamp((t - t0) / ms, 0, 1);
      if (k >= 1) { put(v); return false; }
      put(Math.round((from + (v - from) * easeOut(k)) / unit) * unit);
      return true;
    });
  }

  // ------------------------------------------------------------------ drawn frames
  const frames = new Set();
  const ro = 'ResizeObserver' in W ? new ResizeObserver((es) => es.forEach((e) => framePath(e.target))) : null;
  function framePath(el) {
    const svg = el.__artFrame; if (!svg) return;
    const w = el.clientWidth, h = el.clientHeight, c = Math.min(el.__artCh, w / 4, h / 4);
    if (!w || !h) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const d = `M${c} .5H${w - .5}V${h - c - .5}L${w - c - .5} ${h - .5}H.5V${c}Z`;
    for (const p of svg.children) p.setAttribute('d', d);
  }
  function drawFrame(el, o = {}) {
    if (!el) return;
    if (!el.__artFrame) {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      const svg = D.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'art-frame'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('preserveAspectRatio', 'none');
      svg.innerHTML = '<path pathLength="1"/><path class="hd" pathLength="1"/>';
      if (o.color) svg.style.setProperty('--fc', o.color);
      el.__artCh = o.chamfer != null ? o.chamfer : 10; el.__artFrame = svg; el.insertBefore(svg, el.firstChild); framePath(el); frames.add(el);
      if (ro) ro.observe(el);
    }
    // two frames later so the transition runs from the undrawn state
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-drawn')));
  }

  // ------------------------------------------------------------------ scroll reveal
  const SEL = '[data-draw],[data-count],[data-seg],.ds-num,.ds-meter';
  function reveal(el) {
    if (el.__artDone) return; el.__artDone = 1;
    const kind = el.dataset.draw;
    if (kind === 'frame') drawFrame(el);
    else if (kind === 'text') { el.classList.add('is-drawn'); glitchText(el, { delay: staggerOf(el) }); }
    else requestAnimationFrame(() => el.classList.add('is-drawn'));
    if (el.dataset.count != null) countUp(el, el.dataset.count);
    else if (el.dataset.seg != null) segments(el, el.dataset.seg);
  }
  const io = 'IntersectionObserver' in W ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); reveal(e.target); } }), { rootMargin: '0px 0px -6% 0px', threshold: 0 }) : null;
  function scan(root) {
    root = root || D;
    const list = [];
    if (root.nodeType === 1 && root.matches(SEL)) list.push(root);
    if (root.querySelectorAll) list.push(...root.querySelectorAll(SEL));
    for (const el of list) {
      if (el.__artSeen) continue; el.__artSeen = 1;
      if (el.dataset.seg != null && !el.querySelector(':scope > canvas')) segments(el, el.dataset.count != null && !RM ? '0' : el.dataset.seg); // draw at once so it holds its space
      if (io && !RM) io.observe(el); else reveal(el);
    }
  }
  // pages render after fetches: pick up new nodes, batched (never per mutation)
  let mo = null, pend = [], moT = 0;
  function watch() {
    if (!('MutationObserver' in W) || mo) return;
    mo = new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && !n.closest('.art-frame')) pend.push(n);
      if (pend.length && !moT) moT = setTimeout(() => { moT = 0; const p = pend; pend = []; for (const n of p) if (n.isConnected) scan(n); }, 120);
    });
    mo.observe(D.body, { childList: true, subtree: true });
  }

  // ------------------------------------------------------------------ signal rain
  // A full-page canvas behind everything (z-index -1). Columns of 3x5 pixel digits taken from real
  // model cards (parameters, MMLU, context) fall slowly; some streams are led by a creature in its
  // brain's tier colour. Near the cursor the digits resolve into creatures and link into a net.
  // Rendered at device pixel ratio 1 and scaled up pixelated (cheap, and crisp as pixel art), at
  // most 30 redraws a second, glyphs blitted from a pre-tinted atlas, no allocation per frame.
  const FONT = { '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
    '6': '111100111101111', '7': '111001001010010', '8': '111101111101111', '9': '111101111001111', '.': '000000000000010', 'B': '110101110101110', 'K': '101101110101101', '%': '101001010100101', ' ': '000000000000000' };
  const BIRD = ['.X.......X.', '..X.....X..', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.XXXXXXXXX.', '.XXXX.XXXX.', '..XXXXXXX..', '...X...X...'];
  const GLYPHS = Object.keys(FONT); const GI = {}; GLYPHS.forEach((k, i) => (GI[k] = i));
  const BIRD_I = GLYPHS.length, NODE_I = BIRD_I + 1, NGLYPH = NODE_I + 1;
  const CW = 12, CH = 14; // cell
  const PAL = ['#5cf2a8', '#d2ffe8', '#ffb81f', '#b056ff', '#2a7bff', '#2fc46b', '#b9bcc4', '#ff3f8e']; // trail, head, tiers..., die
  const TIER_I = { legendary: 2, epic: 3, rare: 4, uncommon: 5, common: 6 };
  const rain = { on: false, paused: false, cv: null, g: null, atlas: null, w: 0, h: 0, cols: 0, density: 0.3, lastDraw: 0, cost: 0, costN: 0, degraded: 0, strs: [], tiers: [] };
  let colHead, colSpeed, colLen, colStr, colTier, colCr, colAct, colOff;
  const MAXN = 40; const nx = new Float32Array(MAXN), ny = new Float32Array(MAXN); let nn = 0;
  const ptr = { x: -1e4, y: -1e4, at: 0, touch: false };
  function buildAtlas() {
    const a = D.createElement('canvas'); a.width = NGLYPH * CW; a.height = PAL.length * CH; const g = a.getContext('2d');
    PAL.forEach((col, r) => {
      g.fillStyle = col;
      GLYPHS.forEach((k, i) => { const b = FONT[k]; for (let p = 0; p < 15; p++) if (b[p] === '1') g.fillRect(i * CW + 3 + (p % 3) * 2, r * CH + 2 + ((p / 3) | 0) * 2, 2, 2); });
      BIRD.forEach((row, y) => [...row].forEach((c, x) => { if (c === 'X') g.fillRect(BIRD_I * CW + x, r * CH + 2 + y, 1, 1); }));
      g.fillRect(NODE_I * CW + 4, r * CH + 5, 3, 3);
    });
    return a;
  }
  const fmtP = (p) => (p >= 100 ? Math.round(p) : p >= 10 ? +p.toFixed(1) : +p.toFixed(2)) + 'B';
  function setData(ms) {
    const s = [], t = [];
    for (const m of ms) {
      const ti = TIER_I[m.tier] || 6;
      if (m.params) { s.push(fmtP(m.params)); t.push(ti); }
      if (m.active) { s.push(fmtP(m.active)); t.push(ti); }
      if (m.mmlu) { s.push(Number(m.mmlu).toFixed(1)); t.push(ti); s.push(Number(m.mmlu).toFixed(1) + '%'); t.push(ti); }
      if (m.ctx) { s.push(m.ctx + 'K'); t.push(ti); }
    }
    // pre-split every string into glyph indexes once (with a gap between repeats)
    rain.strs = s.map((x) => Uint8Array.from([...(x + '  ')].map((c) => (GI[c] != null ? GI[c] : GI[' ']))));
    rain.tiers = t;
  }
  function sizeRain() {
    const cv = rain.cv; if (!cv) return;
    const w = Math.max(1, W.innerWidth), h = Math.max(1, W.innerHeight);
    rain.w = w; rain.h = h; cv.width = w; cv.height = h; // DPR 1 on purpose, scaled pixelated by CSS
    rain.g = cv.getContext('2d', { alpha: true }); rain.g.imageSmoothingEnabled = false;
    const n = Math.ceil(w / CW);
    if (n !== rain.cols) {
      rain.cols = n;
      colHead = new Float32Array(n); colSpeed = new Float32Array(n); colLen = new Uint8Array(n); colStr = new Uint16Array(n);
      colTier = new Uint8Array(n); colCr = new Uint8Array(n); colAct = new Uint8Array(n); colOff = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (Math.random() < rain.density) spawn(i, Math.random() * h);
    }
    rain.density = (w < 640 ? 0.2 : 0.3) / (1 + rain.degraded);
    if (RM) drawRain(now(), true);
  }
  function spawn(i, y) {
    if (!rain.strs.length) return;
    const si = (Math.random() * rain.strs.length) | 0;
    colAct[i] = 1; colStr[i] = si; colTier[i] = rain.tiers[si]; colOff[i] = (Math.random() * 16) | 0;
    colHead[i] = y != null ? y : -Math.random() * 200; colSpeed[i] = 16 + Math.random() * 34; colLen[i] = 6 + ((Math.random() * 14) | 0);
    colCr[i] = Math.random() < 0.16 ? 1 : 0;
  }
  function drawRain(t, still) {
    const g = rain.g, A = rain.atlas, h = rain.h; if (!g || !A) return;
    const t0 = now();
    g.clearRect(0, 0, rain.w, h);
    const px = ptr.x, py = ptr.y, live = !still && (t - ptr.at < 4000 || ptr.touch);
    // no pointer lately: let a slow wandering point stand in, so touch screens see the net too
    let ax = px, ay = py;
    if (!still && !live) { ax = rain.w * (0.5 + 0.34 * Math.sin(t / 7100)); ay = h * (0.5 + 0.3 * Math.sin(t / 5300 + 1)); }
    const RAD = still ? 0 : 150, RAD2 = RAD * RAD, CR2 = 42 * 42;
    const c0 = Math.max(0, ((ax - RAD) / CW) | 0), c1 = Math.min(rain.cols - 1, ((ax + RAD) / CW) | 0);
    nn = 0;
    for (let i = 0; i < rain.cols; i++) {
      if (!colAct[i]) continue;
      const str = rain.strs[colStr[i]]; if (!str) continue;
      const L = str.length, hr = Math.floor(colHead[i] / CH), x = i * CW, near = i >= c0 && i <= c1, len = colLen[i];
      for (let k = 0; k <= len; k++) {
        const row = hr - k; if (row < 0) break; const y = row * CH; if (y > h) continue;
        let gl = str[(row + colOff[i]) % L], pal = 0, a;
        if (k === 0) { pal = 1; a = 0.95; if (colCr[i]) { gl = BIRD_I; pal = colTier[i]; } }
        else a = 0.6 * Math.pow(1 - k / (len + 1), 1.5);
        if (near) {
          const dx = x + 6 - ax, dy = y + 7 - ay, d2 = dx * dx + dy * dy;
          if (d2 < RAD2) {
            const f = 1 - d2 / RAD2;
            if (d2 < CR2) { gl = BIRD_I; pal = colTier[i]; a = Math.max(a, 0.9); }
            else if (row % 3 === 0 && gl !== BIRD_I) { gl = NODE_I; pal = 1; a = Math.max(a, 0.45 + 0.5 * f); if (nn < MAXN) { nx[nn] = x + 6; ny[nn] = y + 7; nn++; } }
            else if (gl !== BIRD_I) { pal = 1; a = Math.max(a, 0.2 + 0.5 * f); }
          }
        }
        if (a < 0.03) continue;
        g.globalAlpha = a;
        g.drawImage(A, gl * CW, pal * CH, CW, CH, x, y, CW, CH);
      }
    }
    // the net: each resolved node links to its two nearest neighbours; the closest ones to the pointer
    if (nn > 1) {
      g.globalAlpha = 0.5; g.strokeStyle = PAL[0]; g.lineWidth = 1; g.beginPath();
      for (let i = 0; i < nn; i++) {
        let b1 = -1, b2 = -1, d1 = 1e9, d2b = 1e9;
        // nearest two nodes in OTHER columns, so the net weaves across the rain instead of along it
        for (let j = 0; j < nn; j++) { const dx = nx[j] - nx[i]; if (dx > -CW && dx < CW) continue; const dy = ny[j] - ny[i], d = dx * dx + dy * dy; if (d < d1) { d2b = d1; b2 = b1; d1 = d; b1 = j; } else if (d < d2b) { d2b = d; b2 = j; } }
        if (b1 >= 0 && d1 < 8100) { g.moveTo(nx[i] + .5, ny[i] + .5); g.lineTo(nx[b1] + .5, ny[b1] + .5); }
        if (b2 >= 0 && d2b < 8100) { g.moveTo(nx[i] + .5, ny[i] + .5); g.lineTo(nx[b2] + .5, ny[b2] + .5); }
      }
      g.stroke();
      if (live) {
        g.globalAlpha = 0.28; g.beginPath();
        for (let i = 0; i < nn; i++) { const dx = nx[i] - ax, dy = ny[i] - ay; if (dx * dx + dy * dy < 90 * 90) { g.moveTo(ax + .5, ay + .5); g.lineTo(nx[i] + .5, ny[i] + .5); } }
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    // watch our own cost; on a slow machine thin the rain (twice at most)
    rain.cost += now() - t0; rain.costN++;
    if (rain.costN >= 90) { const avg = rain.cost / rain.costN; rain.cost = 0; rain.costN = 0; if (avg > 5 && rain.degraded < 2) { rain.degraded++; rain.density /= 2; for (let i = 0; i < rain.cols; i++) if (colAct[i] && Math.random() < 0.5) colAct[i] = 0; } }
  }
  function stepRain(t, dt) {
    if (!rain.on) return false;
    if (rain.paused) return true;
    // spawn rate chosen so that about `density` of the columns are falling at any time
    const h = rain.h, s = dt / 1000, life = (h + 260) / 33, p = s * (rain.density / (1 - rain.density)) / life;
    for (let i = 0; i < rain.cols; i++) {
      if (colAct[i]) { colHead[i] += colSpeed[i] * s; if (colHead[i] - colLen[i] * CH > h) colAct[i] = 0; }
      else if (Math.random() < p) spawn(i);
    }
    if (t - rain.lastDraw >= 33) { rain.lastDraw = t; drawRain(t, false); }
    return true;
  }
  function rainMode() { const b = D.body; const m = (b && b.dataset.artRain) || (D.getElementById('world') ? 'off' : 'on'); return m; }
  function startRain() {
    if (rain.on || rainMode() === 'off') return;
    const cv = D.createElement('canvas'); cv.className = 'art-rain'; cv.setAttribute('aria-hidden', 'true');
    D.body.insertBefore(cv, D.body.firstChild);
    rain.cv = cv; rain.atlas = buildAtlas(); rain.on = true;
    models.then((ms) => { setData(ms); sizeRain(); if (RM) drawRain(now(), true); else tick(stepRain); });
    let rz = 0; W.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(sizeRain, 150); }, { passive: true });
    if (!RM) {
      W.addEventListener('pointermove', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; ptr.at = now(); ptr.touch = e.pointerType === 'touch'; }, { passive: true });
      W.addEventListener('pointerdown', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; ptr.at = now(); }, { passive: true });
      D.documentElement.addEventListener('pointerleave', () => { ptr.at = 0; ptr.touch = false; });
    }
  }
  const rainApi = {
    pause() { rain.paused = true; },
    resume() { rain.paused = false; wake(); },
    mode(m) { if (D.body) D.body.dataset.artRain = m; if (m === 'off') { rain.on = false; if (rain.cv) rain.cv.remove(); rain.cv = null; } else startRain(); },
  };

  // ------------------------------------------------------------------ page transition
  // Native cross-document view transitions (declared in ds.css) when the browser has them;
  // otherwise a short scanline wipe on the way out. Never delays more than 230 ms.
  const nativeVT = 'onpagereveal' in W && !!(W.CSS && CSS.supports && CSS.supports('view-transition-name: a'));
  let wipe = null;
  function wipeTo(url) {
    if (RM || nativeVT) { location.href = url; return; }
    if (!wipe) { wipe = D.createElement('div'); wipe.className = 'art-wipe'; wipe.setAttribute('aria-hidden', 'true'); D.body.appendChild(wipe); void wipe.offsetWidth; }
    wipe.classList.add('on');
    setTimeout(() => { location.href = url; }, 230);
  }
  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
    if (a.target && a.target !== '_self') return; if (a.hasAttribute('download') || a.dataset.noWipe != null) return;
    const href = a.getAttribute('href'); if (!href || href[0] === '#' || /^(javascript|mailto|tel):/i.test(href)) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname && u.search === location.search) return; // same page (hash moves)
    if (RM || nativeVT) return; // the browser does it
    e.preventDefault(); wipeTo(u.href);
  }
  W.addEventListener('pageshow', (e) => { if (wipe) wipe.classList.remove('on'); });

  // ------------------------------------------------------------------ nav: live pulse follows the trial clock, links glitch on hover
  function navLife() {
    const navs = D.querySelectorAll('.ds-nav, body.ds .nav'); if (!navs.length) return;
    const upd = () => {
      if (D.hidden) return;
      let ms = null; try { ms = W.wlRemain ? W.wlRemain() : null; } catch {}
      let dur = 6, soon = false, fin = false;
      if (ms != null && ms > 0) { soon = ms <= 300000; fin = ms <= 60000; dur = ms >= 1800000 ? 6 : fin ? 1.1 : 1.6 + 4.4 * clamp((ms - 60000) / 1740000, 0, 1); }
      navs.forEach((n) => { n.style.setProperty('--pulse', dur.toFixed(2) + 's'); n.classList.toggle('is-soon', soon && !fin); n.classList.toggle('is-final', fin); });
    };
    upd(); setInterval(upd, 3000);
    if (!RM) D.addEventListener('pointerover', (e) => {
      const a = e.target.closest && e.target.closest('.ds-nav__links a, .ds-nav__links button, .ds-nav__go, body.ds .nav a.l, [data-glitch]');
      if (a && !(e.relatedTarget && a.contains(e.relatedTarget))) glitchText(a, { ms: 320 });
    });
    const alive = D.querySelectorAll('[data-art-alive]');
    if (alive.length) fetch('/api/toll').then((r) => (r.ok ? r.json() : null)).then((t) => { if (t && typeof t.alive === 'number') alive.forEach((el) => (el.textContent = t.alive.toLocaleString('en-US'))); }).catch(() => {});
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    startRain();
    scan(D); watch(); navLife();
    D.addEventListener('click', onClick);
    if (!io) D.querySelectorAll(SEL).forEach(reveal);
  }
  try { RMQ.addEventListener('change', (e) => { RM = e.matches; }); } catch {}

  W.Art = { reduced: RM, tick, drawFrame, countUp, glitchText, resolve: glitchText, segments, scan, reveal, models, rain: rainApi, wipeTo };
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();

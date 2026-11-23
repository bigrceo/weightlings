// Landing: the live window into the meadow, the one-hour sequence, the lineage field, the observation deck, the wordmark.
// Every loop runs on the page's one animation loop (wlLoop, i.e. art.js) and draws only while its canvas is on screen.
const DPR = Math.min(2, devicePixelRatio || 1);
const LRM = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
// canvas sizes are read only when a ResizeObserver says they changed, never per frame
const SIZE = new WeakMap(), sro = 'ResizeObserver' in window ? new ResizeObserver((es) => es.forEach((e) => SIZE.delete(e.target))) : null;
function fit(c, dpr = DPR) {
  let sz = SIZE.get(c); if (!sz || !sro) { sz = [c.clientWidth, c.clientHeight]; SIZE.set(c, sz); }
  const W = Math.round(sz[0] * dpr), H = Math.round(sz[1] * dpr); if (c.width !== W || c.height !== H) { c.width = W; c.height = H; } return [c.width, c.height];
}
const visible = new Map();
const io = new IntersectionObserver((es) => es.forEach((e) => visible.set(e.target, e.isIntersecting)), { rootMargin: '100px' });
// draw(ctx, w, h, seconds, dt) on the shared loop, only while the canvas is near the viewport; reduced motion: one frame a second
function loop(canvas, draw, o = {}) {
  if (!canvas) return; io.observe(canvas); if (sro) sro.observe(canvas); const ctx = canvas.getContext('2d'); let t0 = 0, last = 0, lastDraw = -1e9; const every = LRM ? 1000 : o.every || 0;
  window.wlLoop((t) => {
    if (!t0) t0 = t; const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t;
    if (visible.get(canvas) === false || t - lastDraw < every) return true; lastDraw = t;
    const [w, h] = fit(canvas, o.dpr); if (w && h) draw(ctx, w, h, (t - t0) / 1000, dt); return true;
  });
}
let mx = 0, my = 0; addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; }, { passive: true });
const BIRD_ROWS = () => window.WL_ROWS || ['.A.......A.', '..A.....A..', '...KKKKK...', '..KKSKSKK..', '.KKWPKWPKK.', '.KKKKKKKKK.', '.KKKKMKKKK.', '..KKKKKKK..', '...L...L...'];
function birdCanvas(body, rows, dead) {
  const c = document.createElement('canvas'); c.width = 11; c.height = 9; const g = c.getContext('2d');
  const col = dead ? { A: '#6b7770', K: '#6b7770', X: '#020403', L: '#3e4842' } : { A: '#e6eee8', K: body, S: 'rgba(255,255,255,.6)', W: '#ffffff', P: '#020403', M: '#020403', L: '#3e4842' };
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (col[ch]) { g.fillStyle = col[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}

// ---------- the live window into the meadow (GET /api/world via the shared feed): a cropped isometric view, slowly following one creature ----------
{
  const win = $('#meadowWin'), cv = $('#meadowCv');
  if (win && cv && window.wlFeed) {
    const S = 2, TW = 16, TH = 8, MW = 56, MH = 56, PAD = 24, OXg = MH * TW / 2 + PAD;
    const riverJ = (i) => 9 + 4 * Math.sin(i / 6.5) + i * 0.08;
    const GX = (i, j) => (i - j) * TW / 2 + OXg, GY = (i, j) => (i + j) * TH / 2 + PAD;
    // the ground, painted once: grass, sand banks, the river
    const ground = document.createElement('canvas'); ground.width = (MW + MH) * TW / 2 + PAD * 2; ground.height = (MW + MH) * TH / 2 + PAD * 2;
    {
      const g = ground.getContext('2d'); let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const GR = [['#1d4f27', '#22592b', '#1a4723'], ['#24602d', '#2a6b31', '#205628'], ['#2d7235', '#347d3a', '#286630']];
      const WA = [['#173a9c', '#1c43ad', '#14338a'], ['#1f4cc0', '#2656cf', '#1b43ab']], SAND = ['#b9ab74', '#c6b881', '#a99b66'];
      const diamond = (X, Y, pal, i, j) => { for (let k = 0; k < TH; k++) { const half = k < TH / 2 ? (k + 1) * 2 : (TH - k) * 2; g.fillStyle = pal[(k * 7 + i * 3 + j * 5) % 5 === 0 ? 1 : (k + i) % 7 === 0 ? 2 : 0]; g.fillRect(X - half, Y + k, half * 2, 1); } };
      for (let i = 0; i < MW; i++) for (let j = 0; j < MH; j++) {
        const X = GX(i, j), Y = GY(i, j), bd = Math.abs(j - riverJ(i));
        if (bd < 1.4) { diamond(X, Y, WA[bd < 0.7 ? 0 : 1], i, j); continue; }
        if (bd < 2.1) { diamond(X, Y, SAND, i, j); continue; }
        const v = (Math.sin(i * 0.31) + Math.cos(j * 0.27) + Math.sin((i + j) * 0.13)) / 3, pal = GR[v > 0.25 ? 2 : v > -0.2 ? 1 : 0];
        diamond(X, Y, pal, i, j);
        for (let k = 0; k < 3; k++) { g.fillStyle = r() < 0.5 ? pal[2] : '#3f8f3c'; g.fillRect(X + ((r() - 0.5) * 10) | 0, Y + 2 + ((r() * 4) | 0), 1, 1); }
        if (r() < 0.06) { g.fillStyle = ['#ffe36b', '#e6eee8', '#ff9ec7', '#b98cff'][(r() * 4) | 0]; g.fillRect(X + ((r() - 0.5) * 8) | 0, Y + 3, 1, 1); }
      }
    }
    const SPR = {}, sprOf = (tier, down) => { const k = down ? 'down' : tier; return SPR[k] || (SPR[k] = birdCanvas((TIER[tier] || TIER.common)[0], BIRD_ROWS(), down)); };
    const C = new Map(); let sortAt = 0, CA = [], MM = {}, focus = null, focusAt = -1e9, camX = GX(28, 28), camY = GY(28, 28), food = [], graves = [], roundN = null, flashAt = -1e9, seen = null, lastEv = null;
    window.wlGenes.then((L) => { for (const m of L) MM[m.id] = m; });
    const who = $('#mwWho'), cnt = $('#mwCount');
    const BURST = Array.from({ length: 24 }, () => ({ id: 0, t0: -1e9, kind: '' })); let bi = 0;
    window.wlFeed.on('world', (w) => {
      const t = performance.now(), live = new Set();
      for (const r of w.c) {
        live.add(r[0]); let b = C.get(r[0]);
        if (!b) { b = { id: r[0], i: r[1], j: r[2], fi: r[1], fj: r[2], ti: r[1], tj: r[2], t0: t }; C.set(r[0], b); }
        else { b.fi = b.i; b.fj = b.j; b.ti = r[1]; b.tj = r[2]; b.t0 = t; }
        b.e = r[3]; b.model = r[5]; b.nick = r[6]; b.tier = (MM[r[5]] || {}).tier || 'common';
      }
      for (const id of C.keys()) if (!live.has(id)) C.delete(id);
      CA = [...C.values()]; food = w.food || []; graves = w.graves || []; sortAt = 0;
      const rn = w.round ? w.round.n : null; if (roundN != null && rn !== roundN) { flashAt = t; focusAt = -1e9; } roundN = rn;
      if (cnt) cnt.textContent = `${w.c.length} alive`;
    });
    window.wlFeed.on('events', (ev) => {
      const k = (e) => e.at + '|' + e.text;
      if (!seen) { seen = new Set(ev.map(k)); lastEv = ev.find((e) => (e.who || []).length) || null; return; }
      for (const e of ev) { if (seen.has(k(e))) continue; seen.add(k(e)); if (!(e.who || []).length) continue; lastEv = e; for (const id of e.who) { const B = BURST[bi++ % BURST.length]; B.id = id; B.t0 = performance.now(); B.kind = e.kind; } }
      if (seen.size > 600) seen = new Set(ev.map(k));
    });
    function choose(t) {
      let pick = null;
      if (lastEv && Math.random() < 0.6) { const id = lastEv.who[(Math.random() * lastEv.who.length) | 0]; pick = C.get(id) || null; }
      if (!pick && CA.length) { for (let k = 0; k < 6 && !pick; k++) { const b = CA[(Math.random() * CA.length) | 0]; if (b.e >= 0) pick = b; } }
      if (!pick) return; focus = pick.id; focusAt = t;
      const m = MM[pick.model] || {}; if (who) { who.textContent = `Watching ${pick.nick || '#' + pick.id}${m.name ? ' · ' + m.name : ''}`; if (window.Art && Art.glitchText && !LRM) Art.glitchText(who, { ms: 360 }); }
      win.href = '/app?b=' + pick.id;
    }
    const sm = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
    loop(cv, (g, w, h, ts, dt) => {
      const t = performance.now();
      if (!CA.length) { g.fillStyle = '#050907'; g.fillRect(0, 0, w, h); return; }
      if (focus == null || !C.has(focus) || t - focusAt > 9000) choose(t);
      // positions: glide from the last reading to the new one over the poll interval
      for (let k = 0; k < CA.length; k++) { const b = CA[k], q = sm((t - b.t0) / 1500); b.i = b.fi + (b.ti - b.fi) * q; b.j = b.fj + (b.tj - b.fj) * q; b.mv = q < 1 && Math.abs(b.ti - b.fi) + Math.abs(b.tj - b.fj) > 0.08; b.y = GY(b.i, b.j); }
      const F = C.get(focus);
      if (F) { const ci = Math.max(14, Math.min(42, F.i)), cj = Math.max(14, Math.min(42, F.j)), tx = GX(ci, cj), ty = GY(ci, cj) - 6, e = LRM ? 1 : Math.min(1, dt * 1.6); camX += (tx - camX) * e; camY += (ty - camY) * e; }
      camX = Math.max(w / 2 + 8, Math.min(ground.width - w / 2 - 8, camX)); camY = Math.max(h / 2 + 8, Math.min(ground.height - h / 2 - 8, camY));
      const sx = Math.round(camX - w / 2), sy = Math.round(camY - h / 2);
      g.imageSmoothingEnabled = false; g.globalAlpha = 1;
      g.fillStyle = '#050907'; g.fillRect(0, 0, w, h);
      g.drawImage(ground, sx, sy, w, h, 0, 0, w, h);
      // river glints
      g.fillStyle = '#a9c4ff';
      for (let k = 0; k < 40; k++) { const i = (k * 1.37 + ts * 0.6) % MW, j = riverJ(i) + Math.sin(k * 3.1 + ts) * 0.7, x = GX(i, j) - sx, y = GY(i, j) - sy; if (x < 0 || x > w || y < 0 || y > h) continue; g.globalAlpha = 0.25 + 0.35 * Math.abs(Math.sin(ts * 2.1 + k * 1.9)); g.fillRect(x | 0, y | 0, 2, 1); }
      g.globalAlpha = 1;
      // berries and the last round's graves
      for (let k = 0; k < food.length; k++) { const f = food[k], x = (GX(f[0], f[1]) - sx) | 0, y = (GY(f[0], f[1]) - sy) | 0; if (x < -2 || x > w || y < -2 || y > h) continue; g.fillStyle = '#d4183c'; g.fillRect(x - 1, y - 2, 2, 2); g.fillStyle = '#ff8aa0'; g.fillRect(x - 1, y - 2, 1, 1); }
      for (let k = 0; k < graves.length; k++) { const v = graves[k], x = (GX(v[0], v[1]) - sx) | 0, y = (GY(v[0], v[1]) - sy) | 0; if (x < -4 || x > w + 4 || y < -6 || y > h) continue; g.fillStyle = '#7d8794'; g.fillRect(x - 1, y - 5, 3, 5); g.fillStyle = '#a9b3bf'; g.fillRect(x, y - 4, 1, 3); }
      // creatures, back to front
      if (t - sortAt > 400) { sortAt = t; CA.sort((a, z) => a.y - z.y); } // depth order drifts slowly: re-sort a few times a second
      for (let k = 0; k < CA.length; k++) {
        const b = CA[k], x = (GX(b.i, b.j) - sx) | 0, y = (b.y - sy) | 0; if (x < -8 || x > w + 8 || y < -2 || y > h + 12) continue;
        const hop = b.e >= 0 && b.mv && !LRM && ((ts * 7 + b.id) % 2) < 1 ? 1 : 0;
        g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x - 4, y, 9, 1);
        g.drawImage(sprOf(b.tier, b.e < 0), x - 5, y - 9 - hop);
        if (b.id === focus) { // mint brackets on the creature being followed
          g.fillStyle = '#5cf2a8'; const L = x - 8, R = x + 7, T = y - 13, B = y + 2;
          g.fillRect(L, T, 3, 1); g.fillRect(L, T, 1, 3); g.fillRect(R - 2, T, 3, 1); g.fillRect(R, T, 1, 3); g.fillRect(L, B, 3, 1); g.fillRect(L, B - 2, 1, 3); g.fillRect(R - 2, B, 3, 1); g.fillRect(R, B - 2, 1, 3);
        }
      }
      // what just happened: a share rises as pink pixels, a duel throws amber sparks
      for (let k = 0; k < BURST.length; k++) {
        const B = BURST[k], q = (t - B.t0) / 1400; if (q < 0 || q > 1) continue; const b = C.get(B.id); if (!b) continue;
        const x = (GX(b.i, b.j) - sx) | 0, y = (b.y - sy) | 0; g.globalAlpha = 1 - q;
        if (B.kind === 'share') { g.fillStyle = '#ff6b9a'; const yy = y - 14 - q * 10; g.fillRect(x - 2, yy, 2, 1); g.fillRect(x + 1, yy, 2, 1); g.fillRect(x - 2, yy + 1, 5, 1); g.fillRect(x - 1, yy + 2, 3, 1); g.fillRect(x, yy + 3, 1, 1); }
        else { g.fillStyle = '#ffb81f'; const r = 3 + q * 8; for (let a = 0; a < 6; a++) g.fillRect((x + Math.cos(a * 1.05) * r) | 0, (y - 6 + Math.sin(a * 1.05) * r * 0.6) | 0, 1, 1); }
      }
      g.globalAlpha = 1;
      // round change: the window flashes pink once
      const fq = (t - flashAt) / 1400; if (fq >= 0 && fq < 1) { g.globalAlpha = 0.35 * (1 - fq); g.fillStyle = '#ff3f8e'; g.fillRect(0, 0, w, h); g.globalAlpha = 1; }
    }, { dpr: 1 / S });
  }
}

// ---------- one hour: scroll-driven life of a creature ----------
{
  const sec = $('#hour'), cv = $('#hourCv');
  if (sec && cv) {
    const RM = LRM;
    const ROWS = BIRD_ROWS(), DEAD = window.WL_DEAD || ROWS;
    const N = 20, ME = 6, CULL = 7; // 7 of 20 = the 35% of the real cull
    const rnd = (i, k = 1) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
    const PAL = ['#b9bcc4', '#b9bcc4', '#b9bcc4', '#2fc46b', '#2fc46b', '#2a7bff', '#b056ff', '#ffb81f'];
    const C = Array.from({ length: N }, (_, i) => ({ i, fit: 0.25 + rnd(i, 2) * 0.7, col: i === ME ? '#5cf2a8' : PAL[(rnd(i, 3) * PAL.length) | 0] }));
    C[ME].fit = 0.74;
    const order = [...C].sort((a, z) => a.fit - z.fit); order.slice(0, CULL).forEach((c, k) => { c.doomed = true; c.k = k; });
    const alive = C.filter((c) => !c.doomed);
    // pre-rendered sprites (one per colour) and the pixel build order of the hatching creature
    const SPR = new Map(), live = (col) => SPR.get(col) || (SPR.set(col, birdCanvas(col, ROWS, false)), SPR.get(col)), deadSpr = birdCanvas(null, DEAD, true);
    const PIX = []; ROWS.forEach((r, y) => [...r].forEach((ch, x) => ch !== '.' && PIX.push([x, y, ch, (8 - y) + rnd(x * 9 + y, 5) * 2.2]))); PIX.sort((a, z) => a[3] - z[3]);
    const BERRY = Array.from({ length: 46 }, (_, k) => [0.05 + rnd(k, 7) * 0.9, 0.1 + rnd(k, 8) * 0.8, rnd(k, 9)]);
    const cl = (x) => Math.max(0, Math.min(1, x)), ez = (x) => { x = cl(x); return x * x * (3 - 2 * x); }, mix = (a, b, k) => a + (b - a) * k;
    const beats = $$('.hour-beat', sec), rail = $$('.hour-rail i b', sec), clock = $('#hourClock'), count = $('#hourCount');
    const CUTS = [0, 0.22, 0.5, 0.74, 0.87, 1], CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    const HCOL = { A: '#e6eee8', S: 'rgba(255,255,255,.6)', W: '#ffffff', P: '#020403', M: '#020403', L: '#3e4842' };
    let prog = 0, pp = 0, lastBeat = -1, lastClock = '', lastCount = '', SX = 0, SY = 0;
    const onScroll = () => { const r = sec.getBoundingClientRect(); prog = cl(-r.top / Math.max(1, r.height - innerHeight)); };
    addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll); onScroll();
    // the pinned hour carries its own full-screen canvas: the page rain rests while it is on screen
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { const A = window.Art; if (!A || !A.rain) return; if (es[0].isIntersecting) A.rain.pause(); else A.rain.resume(); }, { threshold: 0.02 }).observe(sec);
    function hud(p) {
      let b = 0; while (b < 4 && p >= CUTS[b + 1]) b++;
      if (b !== lastBeat) { lastBeat = b; beats.forEach((e, k) => e.classList.toggle('on', k === b)); sec.dataset.beat = b; if (window.blip && b > 1) window.blip(b === 3 ? 220 : 660); }
      for (let k = 0; k < rail.length; k++) rail[k].style.transform = `scaleX(${cl((p - CUTS[k]) / (CUTS[k + 1] - CUTS[k])).toFixed(3)})`;
      const left = p < CUTS[1] ? 3600 : Math.round(3600 * (1 - ez((p - CUTS[1]) / (CUTS[2] - CUTS[1]))));
      const cs = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0'); if (cs !== lastClock) { lastClock = cs; clock.textContent = cs; }
      const d = cl((p - CUTS[3]) / (1 - CUTS[3])), gone = p < CUTS[3] ? 0 : Math.min(CULL, Math.ceil(cl(d / 0.4) * CULL)), back = Math.floor(ez((d - 0.58) / 0.4) * CULL);
      const ct = p < CUTS[1] * 0.75 ? 'One founder' : gone ? `${N - gone + back} alive · ${gone} removed${back ? ` · ${back} born` : ''}` : `${N} alive`; if (ct !== lastCount) { lastCount = ct; count.textContent = ct; }
    }
    let cw = 0, rh = 0, cols = 10, rows = 2, hh = 0;
    const slot = (i) => { SX = cw * ((i % cols) + 1); SY = hh * 0.5 + (Math.floor(i / cols) - (rows - 1) / 2) * rh; };
    function spr(c, s, cx, cy, u, alpha, flip) { c.globalAlpha = alpha; if (flip) { c.save(); c.translate(0, cy * 2); c.scale(1, -1); } c.drawImage(s, Math.round(cx - 5.5 * u), Math.round(cy - 4.5 * u), 11 * u, 9 * u); if (flip) c.restore(); c.globalAlpha = 1; }
    loop(cv, (c, w, h, t) => {
      pp = RM ? prog : pp + (prog - pp) * 0.14; const p = pp; hud(p);
      c.clearRect(0, 0, w, h); c.imageSmoothingEnabled = false;
      cols = w > h * 1.15 ? 10 : 5; rows = N / cols; cw = w / (cols + 1); hh = h;
      const u = Math.max(1, Math.floor((cw * 0.6) / 11)); rh = Math.min(h / (rows + 1.2), u * 26);
      const a = cl(p / CUTS[1]), b = cl((p - CUTS[1]) / (CUTS[2] - CUTS[1])), tr = cl((p - CUTS[2]) / (CUTS[3] - CUTS[2])), d = cl((p - CUTS[3]) / (1 - CUTS[3]));
      const others = ez((a - 0.72) / 0.28), wig = RM ? 0 : 1, px1 = Math.max(1, DPR);
      // floor marks: a dotted rule per slot, so the ward reads as a counted space
      c.fillStyle = '#5cf2a8'; c.globalAlpha = 0.22 * others;
      for (let i = 0; i < N; i++) { slot(i); for (let x = -5.5 * u; x < 5.5 * u; x += 3 * px1) c.fillRect(SX + x, SY + 6.5 * u, px1, px1); }
      c.globalAlpha = 1;
      // berries, eaten as the hour runs out
      if (p >= CUTS[1] * 0.8 && p < CUTS[2] + 0.02) { const s = u * 1.4; for (const [bx, by, th] of BERRY) { if (b > th * 0.92) continue; c.globalAlpha = 0.85 * others; c.fillStyle = '#d4183c'; c.fillRect(bx * w, by * h, s, s); c.globalAlpha = 0.5 * others; c.fillStyle = '#ffffff'; c.fillRect(bx * w, by * h, s * 0.4, s * 0.4); } c.globalAlpha = 1; }
      const scanX = mix(-0.06 * w, 1.06 * w, tr / 0.82), env = Math.sin(Math.PI * b);
      for (const k of C) {
        slot(k.i); const sx = SX, sy = SY; let x = sx, y = sy, U = u, al = k.i === ME ? 1 : others;
        if (p < CUTS[1] && k.i === ME) { const m = ez((a - 0.72) / 0.28), big = Math.max(u, Math.floor(Math.min(w, h) / 30)); U = Math.round(mix(big, u, m)); x = mix(w / 2, sx, m); y = mix(h * 0.5, sy, m); }
        if (b > 0 && b < 1) { x += Math.sin(b * 7 + k.i * 1.9) * cw * 0.34 * env; y += Math.cos(b * 5.3 + k.i * 2.7) * rh * 0.3 * env - Math.abs(Math.sin(b * 46 + k.i)) * u * 1.6 * env; }
        else if (wig && !(k.doomed && d > 0)) y -= ((t * 2.2 + k.i * 0.37) % 1 < 0.5 ? u * 0.5 : 0) * (p >= CUTS[1] ? 1 : others);
        const scored = p >= CUTS[2] && sx < scanX;
        // energy meter, segmented: fills while foraging, becomes the score at the trial
        if (p >= CUTS[1] && d < 0.5) {
          const bw = 11 * u, f = p < CUTS[2] ? k.fit * ez(b) : k.fit, ba = (1 - ez((d - 0.3) / 0.2)) * (k.doomed && d > 0.02 ? 1 - ez(d / 0.3) : 1), bh = Math.max(1.5, u * 0.7), seg = Math.max(2, u);
          c.globalAlpha = 0.16 * ba; c.fillStyle = '#8cffc8'; for (let q = 0; q < bw; q += seg + px1) c.fillRect(sx - bw / 2 + q, sy + 8.5 * u, seg, bh);
          c.globalAlpha = ba; c.fillStyle = scored ? (k.doomed ? '#ff3f8e' : '#e6eee8') : '#5cf2a8'; for (let q = 0; q < bw * f; q += seg + px1) c.fillRect(sx - bw / 2 + q, sy + 8.5 * u, Math.min(seg, bw * f - q), bh);
          c.globalAlpha = 1;
        }
        if (p < CUTS[1] && k.i === ME && a < 0.72) {
          // hatch: a square closes on an empty point, then the body is written pixel by pixel
          const ring = 1 - ez(a / 0.3); if (ring > 0.01) { c.strokeStyle = '#5cf2a8'; c.globalAlpha = 0.6 * (1 - ring); c.lineWidth = px1; const s = U * (7 + ring * 22); c.strokeRect(x - s, y - s, s * 2, s * 2); c.globalAlpha = 1; }
          const n = Math.floor(PIX.length * ez((a - 0.18) / 0.5)), x0 = x - 5.5 * U, y0 = y - 4.5 * U;
          for (let q = 0; q < n; q++) { const P = PIX[q]; c.fillStyle = q > n - 4 ? '#ffffff' : P[2] === 'K' ? k.col : HCOL[P[2]]; c.fillRect(x0 + P[0] * U, y0 + P[1] * U, U + 0.5, U + 0.5); }
          continue;
        }
        if (k.doomed && d > 0) {
          const q = ez((d / 0.4 - k.k / CULL * 0.7) / 0.3); // one by one, lowest score first
          if (q <= 0) spr(c, live(k.col), x, y, U, 1);
          else { const fade = 1 - ez((d - 0.42) / 0.16); if (fade > 0.01) spr(c, deadSpr, x, y + q * u * 5, U, (1 - q * 0.35) * fade, q > 0.5); }
          // what is left: a pink cross under the slot
          const gq = ez((d - 0.4) / 0.15); if (gq > 0) { c.globalAlpha = 0.7 * gq; c.fillStyle = '#ff3f8e'; c.fillRect(sx - u * 1.5, sy + 11.5 * u, 3 * u, u * 0.8); c.fillRect(sx - u * 0.4, sy + 10.4 * u, u * 0.8, 3 * u); c.globalAlpha = 1; }
          // the slot is refilled by a child of the nearest survivor
          const par = alive[(k.k * 3 + 1) % alive.length]; slot(par.i); const ppx = SX, ppy = SY; const g2 = ez((d - 0.58 - k.k * 0.035) / 0.2);
          if (g2 > 0) { const col = k.k === 2 ? '#b98cff' : par.col; spr(c, live(col), mix(ppx, sx, g2), mix(ppy, sy, g2) - Math.sin(g2 * Math.PI) * u * 6, Math.max(1, Math.round(U * (0.35 + 0.65 * g2))), g2); }
          continue;
        }
        if (scored && k.doomed && tr < 1.01) { const fl = RM ? 1 : 0.55 + 0.45 * Math.sin(t * 9 + k.i); c.globalAlpha = fl; c.fillStyle = '#ff3f8e'; const m = u; for (let q = -1; q <= 1; q++) { c.fillRect(x + q * m - m / 2, y - 8 * u + q * m, m, m); c.fillRect(x + q * m - m / 2, y - 8 * u - q * m, m, m); } c.globalAlpha = 1; }
        spr(c, live(k.col), x, y, U, al * (scored && k.doomed ? 0.75 : 1));
        if (k.i === ME && p >= CUTS[1] * 0.98) { c.strokeStyle = '#5cf2a8'; c.globalAlpha = 0.7; c.lineWidth = px1; const s = 8 * u, L = 2.5 * u; c.beginPath(); for (const [i, j] of CORNERS) { c.moveTo(x + i * s, y + j * s - j * L); c.lineTo(x + i * s, y + j * s); c.lineTo(x + i * s - i * L, y + j * s); } c.stroke(); c.globalAlpha = 1; }
      }
      // the trial: one amber line reads the whole ward, left to right, with a stepped trail (no gradient object per frame)
      if (p >= CUTS[2] && tr < 0.86) { c.fillStyle = '#ffb81f'; const tw = w * 0.12; for (let q = 0; q < 8; q++) { c.globalAlpha = 0.02 * (q + 1); c.fillRect(scanX - tw + (q * tw) / 8, 0, tw / 8, h); } c.globalAlpha = 1; c.fillRect(scanX, 0, px1, h); }
    });
  }
}

// ---------- lineage field (nodes = real lineage count) ----------
{
  let n = 40; const pulses = Array.from({ length: 16 }, () => ({ i: 0, j: 0, di: 0, dj: 0, p: 99 })); let pk = 0;
  const cap = $('#gridCap');
  const refresh = () => api('/api/stats').then((s) => { n = Math.max(12, s.lineages || 0); if (cap) cap.textContent = `${s.lineages} lineages · one node each · ${s.alive} creatures alive`; }).catch(() => {});
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 20000);
  const GC = 14, GR = 14, PX = new Float32Array(GC * GR), PY = new Float32Array(GC * GR);
  loop($('#grid'), (c, w, h, t) => {
    c.clearRect(0, 0, w, h);
    const sw = Math.sin(t * 0.15) * 0.04 + mx * 0.05;
    for (let j = 0; j < GR; j++) for (let i = 0; i < GC; i++) { const x = (i / (GC - 1) - 0.5) * 2, z = j / (GR - 1), s = 1 / (0.6 + z * 1.4); PX[j * GC + i] = w / 2 + (x + sw * (1 - z)) * w * 0.62 * s; PY[j * GC + i] = h * 0.2 + (1 - s) * h * 0.1 + z * h * 0.75 * s * 0.9 + 0.1 * h; }
    c.strokeStyle = '#5cf2a8'; c.globalAlpha = 0.1; c.lineWidth = DPR; c.beginPath();
    for (let i = 0; i < GC; i++) for (let j = 0; j < GR; j++) { const k = j * GC + i; j ? c.lineTo(PX[k], PY[k]) : c.moveTo(PX[k], PY[k]); }
    for (let j = 0; j < GR; j++) for (let i = 0; i < GC; i++) { const k = j * GC + i; i ? c.lineTo(PX[k], PY[k]) : c.moveTo(PX[k], PY[k]); }
    c.stroke();
    for (let j = 0; j < GR; j++) for (let i = 0; i < GC; i++) { const on = ((i * 7 + j * 13) % (GC * GR)) < n, k = j * GC + i, s = (on ? 3.2 : 1.4) * DPR * (1 - j / GR * 0.5); c.fillStyle = on ? '#e6eee8' : '#5cf2a8'; c.globalAlpha = on ? 0.55 + 0.4 * Math.sin(t * 2 + i + j) : 0.2; c.fillRect(PX[k] - s / 2, PY[k] - s / 2, s, s); }
    c.globalAlpha = 1;
    if (!LRM && Math.random() < 0.08) { const P = pulses[pk++ % pulses.length]; P.i = (Math.random() * (GC - 5)) | 0; P.j = (Math.random() * (GR - 5)) | 0; const hz = Math.random() < 0.5; P.di = hz ? 1 : 0; P.dj = hz ? 0 : 1; P.p = 0; }
    c.fillStyle = '#5cf2a8';
    for (const P of pulses) { if (P.p > 4) continue; P.p += 0.04; const f = P.p % 1, a0 = (P.j + P.dj * Math.floor(P.p)) * GC + P.i + P.di * Math.floor(P.p), a1 = (P.j + P.dj * Math.ceil(P.p)) * GC + P.i + P.di * Math.ceil(P.p); const x = PX[a0] + (PX[a1] - PX[a0]) * f, y = PY[a0] + (PY[a1] - PY[a0]) * f; c.fillRect(x - 2 * DPR, y - 2 * DPR, 4 * DPR, 4 * DPR); }
  });
}

// ---------- neural field behind the windows ----------
{
  const NP = 90, PX = new Float32Array(NP), PY = new Float32Array(NP), PA = new Float32Array(NP);
  for (let i = 0; i < NP; i++) { PX[i] = Math.random(); PY[i] = Math.random(); PA[i] = Math.random() * 6.28; }
  loop($('#field'), (c, w, h, t) => {
    c.clearRect(0, 0, w, h);
    if (!LRM) for (let i = 0; i < NP; i++) { PA[i] += (Math.sin(PX[i] * 5 + t * 0.3) + Math.cos(PY[i] * 4 - t * 0.2)) * 0.02; PX[i] = (PX[i] + Math.cos(PA[i]) * 0.0006 + 1) % 1; PY[i] = (PY[i] + Math.sin(PA[i]) * 0.0006 + 1) % 1; }
    const R = 120 * DPR, R2 = R * R; c.lineWidth = DPR * 0.8; c.strokeStyle = '#5cf2a8';
    // three alpha buckets, one path each: no colour string per line
    for (let bkt = 0; bkt < 3; bkt++) {
      const lo = R2 * [0, 0.2, 0.5][bkt], hi = R2 * [0.2, 0.5, 1][bkt]; c.globalAlpha = [0.2, 0.1, 0.04][bkt]; c.beginPath();
      for (let i = 0; i < NP; i++) for (let j = i + 1; j < NP; j++) { const dx = (PX[i] - PX[j]) * w, dy = (PY[i] - PY[j]) * h, d = dx * dx + dy * dy; if (d >= lo && d < hi) { c.moveTo(PX[i] * w, PY[i] * h); c.lineTo(PX[j] * w, PY[j] * h); } }
      c.stroke();
    }
    c.globalAlpha = 0.7; c.fillStyle = '#8cffc8'; for (let i = 0; i < NP; i++) c.fillRect(PX[i] * w - DPR, PY[i] * h - DPR, 2 * DPR, 2 * DPR); c.globalAlpha = 1;
  }, { every: 33 });
}

// ---------- the wordmark: the name in the display face, cut into scanlines that breathe ----------
{
  const m = document.createElement('canvas'), mc = m.getContext('2d'); let runs = null, rw = 0, rh = 0, step = 3;
  function build(w, h) {
    m.width = w; m.height = h; mc.clearRect(0, 0, w, h); mc.fillStyle = '#fff'; mc.textAlign = 'center'; mc.textBaseline = 'middle';
    let fs = h * 1.05; const f = (s) => `700 ${s}px 'Chakra Petch', Inter, sans-serif`; mc.font = f(fs); while (mc.measureText('WEIGHTLINGS').width > w * 0.98) { fs *= 0.97; mc.font = f(fs); }
    mc.fillText('WEIGHTLINGS', w / 2, h * 0.55); const d = mc.getImageData(0, 0, w, h).data;
    step = Math.max(3, Math.round(h / 70)); const R = [];
    for (let y = 0; y < h; y += step) { let x0 = -1; for (let x = 0; x <= w; x += 2) { const on = x < w && d[(y * w + x) * 4 + 3] > 128; if (on && x0 < 0) x0 = x; if (!on && x0 >= 0) { R.push(y, x0, x - x0); x0 = -1; } } }
    runs = Float32Array.from(R); rw = w; rh = h; // the runs are found once; each frame only draws them
  }
  loop($('#word'), (c, w, h, t) => {
    if (!w || !h) return;
    if (!runs || rw !== w || rh !== h) build(w, h);
    c.clearRect(0, 0, w, h);
    for (let k = 0; k < runs.length; k += 3) {
      const y = runs[k], wave = Math.sin(y * 0.05 - t * 3) * 0.5 + 0.5, thick = Math.max(1, step * (0.3 + 0.4 * wave));
      c.fillStyle = wave > 0.86 ? '#5cf2a8' : '#e6eee8'; c.globalAlpha = 0.5 + 0.5 * wave; c.fillRect(runs[k + 1], y, runs[k + 2], thick);
    }
    c.globalAlpha = 1;
  });
  document.fonts?.load("700 100px 'Chakra Petch'").then(() => { runs = null; }).catch(() => {});
}

// ---------- live windows ----------
makeWindows($('#desk'));
$$('[data-hatch]').forEach((b) => (b.onclick = openSummon));
async function refreshFeed() {
  const [g, s] = await Promise.all([api('/api/genes'), api('/api/stats')]);
  $('#feedList').innerHTML = g.map((m) => { const c = TIER[m.tier][0], sv = m.survivalSmoothed != null ? m.survivalSmoothed : m.survival, ok = sv != null && (m.enough != null ? m.enough : m.exposed >= 8); return `<div class="lp-gene"><img src="${m.logo}" alt=""><div><b>${esc(m.name)}</b><small style="color:${c}">${TIER[m.tier][1]} ${stars(TIER[m.tier][2])}</small></div><div class="sv">${ok ? pct(sv) : 'Too few'}<small> · ${m.alive} alive</small></div><div class="ds-meter ds-meter--thin is-drawn"><i style="--v:${ok ? sv.toFixed(3) : 0};--c:${c}"></i></div></div>`; }).join('');
  $('#feedCount').textContent = `${s.alive} alive · ${s.dead} dead`;
  $('#hud').textContent = `OBSERVATION DECK · ${s.alive} ALIVE · ${s.lineages} LINEAGES · GEN ${s.maxGen + 1}`;
}
async function refreshSwarm() {
  const [r, ev] = await Promise.all([api('/api/round'), api('/api/events')]);
  const L = r.last, left = r.next - r.now;
  $('#swarm').innerHTML = `<div class="lp-sw__row"><span class="ds-label ds-label--clock">Next trial</span><span class="ds-label ds-label--bare">Round ${r.n + 1}</span></div>
  <div class="lp-sw__big">${esc(r.upcoming.name)} <span>${fmtLeft(left)}</span></div>
  <p class="lp-sw__what">${esc(r.upcoming.what)}</p>
  ${L ? `<div class="lp-sw__last"><div class="ds-label ds-label--die">Round ${r.n} · ${esc(L.trialName)}</div><div class="lp-sw__toll">${L.died} died · ${L.born} born · ${L.mutations} mutations</div>
    <div class="lp-sw__dom"><img src="${L.dominant.logo || modelLogo(L.dominant.id)}" width="20" height="20" alt=""><span>${esc(L.dominant.name)} dominates (${L.dominant.start - L.dominant.died}/${L.dominant.start} survived)</span></div>
    <a class="ds-link" href="/r/${r.n}">Round card ↗</a></div>` : '<p class="lp-sw__what">No round on record yet. The first trial runs on the hour.</p>'}
  <div class="ds-label ds-label--cr ds-label--sig lp-sw__live">Live</div>${ev.slice(0, 10).map((e) => `<div class="lp-pos ${e.kind === 'duel' ? 'down' : e.kind === 'share' || e.kind === 'hatch' ? 'up' : ''}">${esc(e.text)}</div>`).join('')}`;
  $('#swFoot').textContent = `${r.n} ROUNDS · NO SCRIPT · NO APPEAL`;
}
const quiet = (f) => () => (document.hidden ? Promise.resolve() : f()).catch(() => {});
quiet(refreshFeed)(); quiet(refreshSwarm)(); setInterval(quiet(refreshFeed), 10000); setInterval(quiet(refreshSwarm), 5000);

// Round countdown strip, tier palette, share cards (canvas → PNG + X intent). Loaded after common.js.
const TIER = { legendary: ['#ffb81f', 'Legendary', 5], epic: ['#b056ff', 'Epic', 4], rare: ['#2a7bff', 'Rare', 3], uncommon: ['#2fc46b', 'Uncommon', 2], common: ['#b9bcc4', 'Common', 1] };
const tierX = (t) => TIER[t] || TIER.common;
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
const BRAND = 'WEIGHTLINGS', SITE = location.origin;

// countdown strip
let ROUND = null, skew = 0;
async function loadRound() {
  try { const r = await api('/api/round'); if (!r || r.n == null) return; skew = r.now - Date.now(); const changed = ROUND && ROUND.n !== r.n; ROUND = r; if (changed) document.dispatchEvent(new CustomEvent('round', { detail: r })); } catch {}
}
function fmtLeft(ms) { ms = Math.max(0, ms); const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); }
function tickStrip() {
  const el = $('#strip'); if (!el || !ROUND) return;
  const left = ROUND.next - (Date.now() + skew);
  el.classList.toggle('soon', left < 300000);
  el.innerHTML = `<i class="sdot"></i><span>Round ${ROUND.n + 1}</span><b>${esc(ROUND.upcoming?.name || '')}</b><span>in</span><b class="clock">${fmtLeft(left)}</b>${ROUND.last ? `<a href="/r/${ROUND.n}">Last round: ${ROUND.last.died} died · ${esc(ROUND.last.dominant.name)} dominates →</a>` : ''}`;
  if (left < -4000) loadRound();
}
loadRound(); setInterval(tickStrip, 1000); setInterval(loadRound, 30000);

// ---------- share cards (1200x675) ----------
const imgCache = new Map();
function loadImg(src) { if (!src) return Promise.resolve(null); if (!imgCache.has(src)) imgCache.set(src, new Promise((res) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); setTimeout(() => res(null), 6000); i.src = src; })); return imgCache.get(src); }
// display face: Chakra Petch (the site's display face, ds.css); text face: Inter
const CF_PX = (w) => (s) => `${w} ${s}px 'Chakra Petch', Inter, sans-serif`, CF_IN = (w) => (s) => `${w} ${s}px Inter, sans-serif`;
function cardFonts() { try { return Promise.all(["600 15px Inter", "500 26px Inter", "500 60px 'Chakra Petch'", "600 60px 'Chakra Petch'", "700 28px 'Chakra Petch'"].map((f) => document.fonts.load(f))).catch(() => {}); } catch { return Promise.resolve(); } }
/** Draws text that never exceeds maxW: shrinks the font down to `min`, then trims with an ellipsis. Returns the drawn width. */
function cardFit(g, t, x, y, maxW, mk, size, min = 12) {
  t = String(t ?? ''); g.font = mk(size);
  while (size > min && g.measureText(t).width > maxW) { size -= 2; g.font = mk(size); }
  if (g.measureText(t).width > maxW) { while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); t += '…'; }
  g.fillText(t, x, y); return g.measureText(t).width;
}
const caps = (g, t, x, y, color = '#8a8a90', size = 15, maxW = 1080) => { g.fillStyle = color; g.letterSpacing = '3px'; const w = cardFit(g, String(t).toUpperCase(), x, y, maxW, CF_IN(600), size, 9); g.letterSpacing = '0px'; return w; };
function cardBird(g, x, y, px, color) { g.fillStyle = color; BIRD.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === 'X') g.fillRect(Math.round(x + i * px), Math.round(y + j * px), Math.ceil(px), Math.ceil(px)); })); }
function cardLogo(g, img, x, y, s) { if (!img) return false; try { g.drawImage(img, x, y, s, s); return true; } catch { return false; } }
function cardBase(c, accent) {
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.letterSpacing = '0px'; g.shadowBlur = 0;
  g.fillStyle = '#020403'; g.fillRect(0, 0, W, H);
  // the signal field: a faint dot grid and scanlines, no glow
  g.fillStyle = 'rgba(140,255,200,0.07)'; for (let y = 18; y < H; y += 24) for (let x = 18; x < W; x += 24) g.fillRect(x, y, 1, 1);
  g.fillStyle = 'rgba(140,255,200,0.022)'; for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  // corner brackets, the same cut as every frame on the site
  g.fillStyle = 'rgba(140,255,200,0.34)'; const b = 26, m = 24;
  [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(([x, y, sx, sy]) => { g.fillRect(sx > 0 ? x : x - b, y, b, 1); g.fillRect(x, sy > 0 ? y : y - b, 1, b); });
  cardBird(g, 60, 46, 3, '#e6eee8');
  g.fillStyle = '#e6eee8'; g.letterSpacing = '4px'; g.font = CF_PX(600)(26); g.fillText(BRAND, 106, 71); g.letterSpacing = '0px';
  g.fillStyle = 'rgba(140,255,200,0.26)'; for (let x = 60; x < W - 60; x += 4) g.fillRect(x, 103, 1, 1);
  g.fillStyle = accent; g.fillRect(60, 102, 72, 3);
  caps(g, (CFG.site || location.host).replace(/^https?:\/\//, ''), 60, H - 38, '#a6b2ab', 14, 480);
  g.textAlign = 'right'; caps(g, 'Brains simulated from model cards', W - 60, H - 38, '#6b7770', 12, 520); g.textAlign = 'left';
  return g;
}
const cardDate = (at) => { try { const d = new Date(at); if (isNaN(d)) return ''; return d.toISOString().slice(0, 16).replace('T', ' · ') + ' UTC'; } catch { return ''; } };
async function drawRoundCard(c, r) {
  await cardFonts(); await PX_GENES;
  const d = r.dominant || {}, T = tierX(d.tier), col = T[0], W = c.width;
  const g = cardBase(c, col);
  if (r.at) { g.textAlign = 'right'; caps(g, cardDate(r.at), W - 60, 70, '#77777a', 13, 420); g.textAlign = 'left'; }
  caps(g, `Round ${r.n} · ${r.trialName}`, 60, 152, '#c9c9ce', 16, 640);
  // the toll: one giant numeral
  g.fillStyle = '#fff'; const nw = cardFit(g, String(r.died), 56, 340, 420, CF_PX(600), 210, 90);
  g.fillStyle = '#ff3f8e'; cardFit(g, 'died', 56 + nw + 22, 340, 640 - nw - 22, CF_PX(500), 68, 30);
  g.fillStyle = '#bdbdc2'; cardFit(g, `${r.population} entered · ${r.born} born · ${r.mutations} mutations`, 60, 392, 640, CF_IN(500), 26, 14);
  const k = r.population ? Math.max(0, Math.min(1, r.died / r.population)) : 0;
  for (let x = 0; x < 640; x += 5) { g.fillStyle = x < 640 * k ? '#ff3f8e' : 'rgba(140,255,200,0.12)'; g.fillRect(60 + x, 414, 3, 8); }
  if (r.population) caps(g, `${Math.round(k * 100)}% of the meadow removed`, 60, 448, '#77777a', 13, 640);
  // dominant brain
  caps(g, 'Dominant brain', 60, 500, '#8a8a90', 13, 640);
  const has = cardLogo(g, await loadImg(d.logo || modelLogo(d.id)), 60, 516, 54);
  g.fillStyle = '#fff'; cardFit(g, d.name || '', has ? 130 : 60, 560, has ? 570 : 640, CF_PX(500), 46, 20);
  if (d.start != null) caps(g, `${T[1]} · ${d.start - d.died}/${d.start} survived`, 60, 598, col, 14, 640);
  // survivors by brain
  const X0 = 790, CW = W - 60 - X0;
  caps(g, 'Survivors by brain', X0, 152, '#8a8a90', 13, CW);
  const top = [...(r.models || [])].filter((m) => m.start).sort((a, z) => z.start - z.died - (a.start - a.died)).slice(0, 5);
  let y = 206;
  for (const m of top) {
    const tc = tierX(m.tier)[0], lg = cardLogo(g, await loadImg(m.logo || modelLogo(m.id)), X0, y - 23, 28);
    g.font = CF_IN(600)(22); const ct = `${m.start - m.died}/${m.start}`, cw = g.measureText(ct).width;
    g.fillStyle = tc; g.textAlign = 'right'; g.fillText(ct, W - 60, y); g.textAlign = 'left';
    g.fillStyle = '#e4e4e8'; cardFit(g, m.name, lg ? X0 + 40 : X0, y, CW - (lg ? 40 : 0) - cw - 16, CF_IN(500), 22, 13);
    for (let x = 0; x < CW; x += 5) { g.fillStyle = x < CW * (m.start - m.died) / m.start ? tc : 'rgba(140,255,200,0.12)'; g.fillRect(X0 + x, y + 15, 3, 3); }
    y += 64;
  }
  if (r.block?.number != null) caps(g, `Dice seeded by block ${Number(r.block.number).toLocaleString('en-US')}`, X0, Math.max(y + 16, 548), '#77777a', 12, CW);
}
async function drawBeingCard(c, b) {
  await cardFonts();
  const T = tierX(b.tier), gone = !!b.died || b.alive === false, col = T[0], W = c.width; const g = cardBase(c, gone ? '#6a6a72' : col);
  if (b.id != null) { g.textAlign = 'right'; caps(g, `Specimen ${b.id}`, W - 60, 70, '#77777a', 13, 420); g.textAlign = 'left'; }
  caps(g, `${T[1]} · generation ${(b.gen || 0) + 1}${b.mutated ? ' · mutant' : ''}`, 60, 152, col, 16, 640);
  g.fillStyle = gone ? '#b5b5ba' : '#fff'; cardFit(g, b.nick, 58, 268, 660, CF_PX(600), 108, 40);
  if (gone && b.rdied != null) caps(g, `Removed in round ${b.rdied}`, 60, 308, '#ff3f8e', 14, 640);
  caps(g, 'Brain', 60, 362, '#8a8a90', 13, 640);
  const has = cardLogo(g, await loadImg(b.logo), 60, 378, 50);
  g.fillStyle = '#fff'; cardFit(g, b.modelName || '', has ? 126 : 60, 418, has ? 574 : 640, CF_PX(500), 44, 20);
  g.fillStyle = col; g.font = CF_IN(500)(22); g.fillText(stars(T[2]), 60, 458);
  const st = [['Rounds survived', b.survived], ['Berries', b.eaten], ['Duels won', b.wins], ['Shared', b.shares]];
  st.forEach(([k, v], i) => { const x = 60 + i * 168; g.fillStyle = '#fff'; cardFit(g, String(v ?? 0), x, 570, 150, CF_PX(500), 60, 24); caps(g, k, x, 600, '#77777a', 11, 156); });
  // the creature itself, in its tier colour
  const px = 30, bx = 795, by = 176;
  g.save(); if (!gone) { g.shadowColor = col; g.shadowBlur = 70; } cardBird(g, bx, by, px, gone ? '#3a3a40' : col); g.restore();
  g.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = by; y < by + 9 * px; y += 6) g.fillRect(bx, y, 11 * px, 2);
  g.textAlign = 'center'; caps(g, gone ? 'Line record · deceased' : 'Under observation', bx + 5.5 * px, by + 9 * px + 48, gone ? '#77777a' : col, 12, 330); g.textAlign = 'left';
}
const MODEL_LOGO = {};
const modelLogo = (id) => MODEL_LOGO[id] || '';
const PX_GENES = api('/api/genes').then((L) => { L.forEach((m) => (MODEL_LOGO[m.id] = m.logo)); return L; }).catch(() => []);
function shareX(text, url) { open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank'); }
function downloadCanvas(c, name) { const a = document.createElement('a'); a.download = name; a.href = c.toDataURL('image/png'); a.click(); }

// ---------- small shared page helpers ----------
const pxApi = (p) => api(p).catch(() => null);
const PX_REDUCED = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
/** Counts an element up to a real value (the final text is always the exact value). Runs on the shared art.js loop when present. */
function pxCount(el, v, ms = 900) {
  if (!el) return; v = Number(v) || 0;
  if (window.Art && Art.countUp) { Art.countUp(el, v, { ms, decimals: 0 }); return; }
  if (PX_REDUCED || v <= 0) { el.textContent = v.toLocaleString('en-US'); return; }
  const t0 = performance.now(); const f = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(v * e).toLocaleString('en-US'); if (k < 1) requestAnimationFrame(f); }; requestAnimationFrame(f);
}
const PX_TONE = { pk: 'die', mn: 'sig', am: 'clock', vi: 'mut', die: 'die', sig: 'sig', clock: 'clock', mut: 'mut', dim: 'dim' };
/** Writes a row of figures in the design system: [[label, value, tone, share 0..1 (the underline), suffix, prefix], ...].
 *  opts.id: id prefix for each figure, opts.count: count up (default true), opts.size: 'lg' | 'md' | 'xl'. Returns the figure elements.
 *  Whole numbers print whole; others print with 2 decimals below 1,000 (the same rule as the credit format on /back). */
function pxStats(box, rows, opts = {}) {
  if (!box) return [];
  const pre = opts.id || '', count = opts.count !== false, size = opts.size || 'lg';
  const decOf = (n) => (Number.isInteger(n) || Math.abs(n) >= 1000 ? 0 : 2);
  const fmt = (n, p) => (p || '') + n.toLocaleString('en-US', { minimumFractionDigits: decOf(n), maximumFractionDigits: decOf(n) });
  if (!box.classList.contains('ds-stats')) box.classList.add('ds-stats');
  box.innerHTML = rows.map((s, i) => {
    const tone = PX_TONE[s[2]] ? ' ds-num--' + PX_TONE[s[2]] : '', v = s[3] == null ? 1 : Math.max(0, Math.min(1, Number(s[3]) || 0)), n = Number(s[1]) || 0;
    return `<div class="ds-stat"><span class="ds-num ds-num--${size}${tone}${count ? '' : ' is-drawn'}"${pre ? ` id="${pre}${i}"` : ''} style="--v:${v.toFixed(3)};--i:${i}">${count ? fmt(0, s[5]) : fmt(n, s[5])}${s[4] ? `<small>${esc(s[4])}</small>` : ''}</span><span class="ds-label">${s[0]}</span></div>`;
  }).join('');
  const els = [...box.querySelectorAll('.ds-num')];
  if (count) els.forEach((el, i) => { const n = Number(rows[i][1]) || 0; if (window.Art && Art.countUp) Art.countUp(el, n, { ms: 1100, decimals: decOf(n), prefix: rows[i][5] || '', delay: 120 + i * 90 }); else el.firstChild.nodeValue = fmt(n, rows[i][5]); });
  return els;
}
/** Hero numerals: drawn as segment numerals by art.js, plain text without it. */
function pxSeg(el, text) { if (!el) return; text = String(text); if (window.Art && Art.segments) { el.dataset.seg = text; Art.segments(el, text); } else el.textContent = text; }
/** Sets a heading's text and lets it resolve out of noise. */
function pxSay(el, text) { if (!el) return; el.textContent = text; if (window.Art && Art.glitchText) Art.glitchText(el, { ms: 620 }); }
// the pixel creature as a CSS mask (--bird), so pages can draw many tiny ones cheaply
try { document.documentElement.style.setProperty('--bird', `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 9" shape-rendering="crispEdges">${BIRD.flatMap((row, y) => [...row].map((ch, x) => (ch === 'X' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ''))).join('')}</svg>`)}")`); } catch {}

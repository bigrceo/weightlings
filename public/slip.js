// The printed slip: a narrow paper receipt that prints line by line and ends with a stamp.
// Standalone (no dependency on common.js / cards.js). Exposes:
//   printSlip(container, lines, { stamp, title, sub, follow, instant }) -> { el, done:Promise, cancel() }
//   slipToCanvas(lines, { stamp, title, sub })                          -> 1200x675 <canvas>
//   beingSlip(being, { family, rarity, epitaph, causeName })            -> { lines, title, sub, stamp }
// A line is [label, value] | [label, value, href] | { k, v, href } | { k, text } (full-width text) | { text, href } (full-width link).
// Lines whose value is null/undefined/'' are dropped, so callers can pass API fields straight through.
(() => {
  const MARK = ['.X.......X.', '..X.....X..', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.XXXXXXXXX.', '.XXXX.XXXX.', '..XXXXXXX..', '...X...X...'];
  const BRAND = 'WEIGHTLINGS', STEP = 220;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const has = (v) => v !== null && v !== undefined && v !== '';
  const safeHref = (h) => (typeof h === 'string' && /^(\/|https:\/\/)/.test(h) ? h : null);
  function norm(lines) {
    return (lines || []).map((l) => {
      if (!l) return null;
      if (Array.isArray(l)) return has(l[1]) ? { k: l[0], v: String(l[1]), href: safeHref(l[2]) } : null;
      if (typeof l === 'string') return { text: l };
      if (has(l.text)) return { k: l.k, text: String(l.text), href: safeHref(l.href) };
      return has(l.v) ? { k: l.k, v: String(l.v), href: safeHref(l.href) } : null;
    }).filter(Boolean);
  }
  const stampTone = (s) => (/CULL|EXTINCT|DEAD|REMOVED/i.test(s) ? 'k' : /ALIVE|SURVIV|VERIF|RECORDED$/i.test(s) && !/LEGACY/i.test(s) ? 'g' : 'a');
  const TONE = { k: '#e2125f', g: '#0b9a5d', a: '#b9770a' };
  const markSvg = () => `<svg viewBox="0 0 11 9" shape-rendering="crispEdges" aria-hidden="true">${MARK.flatMap((r, y) => [...r].map((c, x) => (c === 'X' ? `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>` : ''))).join('')}</svg>`;

  function lineEl(l) {
    const d = document.createElement('div');
    if (l.text != null) {
      d.className = 'slip-ln w';
      d.innerHTML = (l.k ? `<span class="k">${esc(l.k)}</span>` : '') + (l.href ? `<a class="go" href="${esc(l.href)}">${esc(l.text)}</a>` : `<p>${esc(l.text)}</p>`);
    } else {
      d.className = 'slip-ln';
      d.innerHTML = `<span class="k">${esc(l.k)}</span><i></i>` + (l.href ? `<a class="v" href="${esc(l.href)}">${esc(l.v)}</a>` : `<span class="v">${esc(l.v)}</span>`);
    }
    return d;
  }

  function printSlip(container, lines, opts = {}) {
    if (!container) return { el: null, done: Promise.resolve(), cancel() {} };
    if (container._slip) container._slip.cancel();
    const L = norm(lines), instant = !!opts.instant || reduced();
    container.innerHTML = '';
    const el = document.createElement('div'); el.className = 'slip' + (instant ? ' now' : '');
    el.setAttribute('role', 'group'); el.setAttribute('aria-label', (opts.title || 'Slip') + (opts.stamp ? ', ' + opts.stamp : ''));
    el.innerHTML = `<div class="slip-paper"><div class="slip-hd">${markSvg()}<b>${BRAND}</b></div>${opts.title ? `<div class="slip-ti">${esc(opts.title)}</div>` : ''}${opts.sub ? `<div class="slip-su">${esc(opts.sub)}</div>` : ''}<div class="slip-rows"></div><div class="slip-ft"></div></div>`;
    container.appendChild(el);
    const rows = el.querySelector('.slip-rows'), ft = el.querySelector('.slip-ft');
    let timers = [], dead = false, finish;
    const done = new Promise((r) => (finish = r));
    const stamp = () => {
      if (opts.stamp) { const s = document.createElement('div'); s.className = 'slip-stamp ' + stampTone(opts.stamp); s.textContent = opts.stamp; ft.appendChild(s); }
      el.classList.add('done'); finish();
    };
    const add = (l) => {
      const d = lineEl(l); rows.appendChild(d);
      if (!instant) {
        const h = d.scrollHeight; d.style.height = '0px'; d.style.opacity = '0';
        requestAnimationFrame(() => { d.style.height = h + 'px'; d.style.opacity = '1'; });
        timers.push(setTimeout(() => { d.style.height = ''; }, 260));
        // the print head passes over the line and the ink resolves out of noise (art.js, when the page has it)
        d.classList.add('pr'); timers.push(setTimeout(() => d.classList.remove('pr'), 300));
        const ink = d.querySelector('.v, p, a.go');
        if (ink && window.Art && Art.glitchText) Art.glitchText(ink, { ms: 260 });
        if (opts.follow) try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
      }
    };
    if (instant) { L.forEach(add); stamp(); }
    else {
      L.forEach((l, i) => timers.push(setTimeout(() => !dead && add(l), 120 + i * STEP)));
      timers.push(setTimeout(() => { if (dead) return; stamp(); if (opts.follow) try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {} }, 120 + L.length * STEP + 160));
    }
    const ctl = { el, done, cancel() { dead = true; timers.forEach(clearTimeout); timers = []; finish(); } };
    container._slip = ctl; return ctl;
  }

  // ---------- 1200x675 image ----------
  function fit(g, t, maxW, mk, size, min) { g.font = mk(size); while (size > min && g.measureText(t).width > maxW) { size -= 1; g.font = mk(size); } if (g.measureText(t).width > maxW) { while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1); t += '…'; } return t; }
  function wrap(g, t, maxW, maxLines) { const out = []; let cur = ''; for (const w of String(t).split(/\s+/)) { const n = cur ? cur + ' ' + w : w; if (g.measureText(n).width > maxW && cur) { out.push(cur); cur = w; } else cur = n; } if (cur) out.push(cur); if (out.length > maxLines) { out.length = maxLines; let s = out[maxLines - 1]; while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1); out[maxLines - 1] = s + '…'; } return out; }
  function bird(g, x, y, px, col) { g.fillStyle = col; MARK.forEach((r, j) => [...r].forEach((c, i) => { if (c === 'X') g.fillRect(Math.round(x + i * px), Math.round(y + j * px), Math.ceil(px), Math.ceil(px)); })); }
  function slipToCanvas(lines, opts = {}) {
    const L = norm(lines), c = document.createElement('canvas'); c.width = 1200; c.height = 675;
    const g = c.getContext('2d'), W = 1200, H = 675, IN = (w) => (s) => `${w} ${s}px Inter, sans-serif`, PXF = (w) => (s) => `${w} ${s}px 'Chakra Petch', Inter, sans-serif`;
    const ls = (v) => { try { g.letterSpacing = v; } catch {} };
    const tone = TONE[stampTone(opts.stamp || '')];
    g.fillStyle = '#020403'; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(140,255,200,0.07)'; for (let y = 18; y < H; y += 24) for (let x = 18; x < W; x += 24) g.fillRect(x, y, 1, 1);
    g.fillStyle = 'rgba(140,255,200,0.022)'; for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    g.fillStyle = 'rgba(140,255,200,0.34)'; [[24, 24, 1, 1], [W - 24, 24, -1, 1], [24, H - 24, 1, -1], [W - 24, H - 24, -1, -1]].forEach(([x, y, sx, sy]) => { g.fillRect(sx > 0 ? x : x - 26, y, 26, 1); g.fillRect(x, sy > 0 ? y : y - 26, 1, 26); });
    // left: wordmark + title
    bird(g, 60, 46, 3, '#e6eee8'); g.fillStyle = '#e6eee8'; g.textBaseline = 'alphabetic'; ls('4px'); g.font = PXF(600)(26); g.fillText(BRAND, 106, 71); ls('0px');
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(60, 103, 500, 1); g.fillStyle = tone; g.fillRect(60, 102, 72, 3);
    if (opts.sub) { ls('3px'); g.fillStyle = '#8a8a90'; g.fillText(fit(g, String(opts.sub).toUpperCase(), 500, IN(600), 15, 9), 60, 250); ls('0px'); }
    if (opts.title) { g.fillStyle = '#fff'; const t = fit(g, String(opts.title), 500, PXF(600), 84, 30); g.fillText(t, 58, 340); }
    if (opts.stamp) { ls('4px'); g.fillStyle = tone; g.fillText(fit(g, String(opts.stamp).toUpperCase(), 500, IN(700), 18, 10), 60, 386); ls('0px'); }
    ls('3px'); g.fillStyle = '#8a8a90'; let host = ''; try { host = location.host; } catch {} g.fillText(fit(g, host.toUpperCase(), 500, IN(600), 14, 9), 60, H - 38);
    g.fillStyle = '#4e4e54'; g.fillText(fit(g, 'BRAINS SIMULATED FROM MODEL CARDS', 500, IN(600), 12, 8), 60, H - 64); ls('0px');
    // right: the paper
    const PW = 470, padX = 30, inner = PW - padX * 2;
    g.font = IN(500)(15);
    const items = L.map((l) => (l.text != null ? { l, wl: wrap(g, l.text, inner, l.href ? 1 : 3) } : { l }));
    const units = items.reduce((s, it) => s + (it.wl ? it.wl.length * 0.8 + (it.l.k ? 0.75 : 0.25) : 1), 0);
    const headH = 96, footH = opts.stamp ? 96 : 34, rh = Math.max(15, Math.min(32, (H - 50 - headH - footH) / Math.max(1, units)));
    const PH = Math.round(headH + units * rh + footH), px0 = 660, py0 = Math.round((H - PH) / 2);
    g.save(); g.translate(px0 + PW / 2, py0 + PH / 2); g.rotate(-0.022); g.translate(-PW / 2, -PH / 2);
    g.save(); g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 50; g.shadowOffsetY = 24; g.fillStyle = '#f3f1ea'; g.fillRect(0, 0, PW, PH); g.restore();
    const pg = g.createLinearGradient(0, 0, PW, 0); pg.addColorStop(0, 'rgba(0,0,0,0.05)'); pg.addColorStop(0.12, 'rgba(0,0,0,0)'); pg.addColorStop(0.9, 'rgba(0,0,0,0)'); pg.addColorStop(1, 'rgba(0,0,0,0.06)'); g.fillStyle = pg; g.fillRect(0, 0, PW, PH);
    g.fillStyle = '#030304'; for (let x = 7; x < PW; x += 14) { g.beginPath(); g.arc(x, 0, 4.4, 0, 7); g.fill(); g.beginPath(); g.arc(x, PH, 4.4, 0, 7); g.fill(); }
    bird(g, padX, 24, 2, '#17171a'); g.fillStyle = '#17171a'; ls('3px'); g.font = IN(700)(12); g.fillText(BRAND, padX + 32, 38); ls('0px');
    if (opts.title) { g.font = IN(700)(19); g.fillText(fit(g, String(opts.title), inner, IN(700), 19, 11), padX, 70); }
    g.strokeStyle = 'rgba(23,23,26,0.55)'; g.lineWidth = 1; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(padX, 84.5); g.lineTo(PW - padX, 84.5); g.stroke();
    let y = headH; const ks = Math.max(8, Math.min(10.5, rh * 0.36)), vs = Math.max(10, Math.min(15, rh * 0.52));
    for (const it of items) {
      const l = it.l;
      if (it.wl) {
        if (l.k) { ls('1.6px'); g.fillStyle = '#6b6a63'; g.font = IN(600)(ks); g.fillText(String(l.k).toUpperCase(), padX, y + rh * 0.55); ls('0px'); y += rh * 0.75; } else y += rh * 0.25;
        g.fillStyle = '#17171a'; g.font = l.href ? IN(700)(Math.max(9, vs - 3)) : `italic 500 ${vs}px Inter, sans-serif`;
        for (const s of it.wl) { g.fillText(l.href ? fit(g, s.toUpperCase(), inner, IN(700), Math.max(9, vs - 3), 8) : s, padX, y + rh * 0.55); y += rh * 0.8; }
        continue;
      }
      const by = y + rh * 0.66;
      g.fillStyle = '#17171a'; g.textAlign = 'right'; const v = fit(g, l.v, inner * 0.62, IN(600), vs, 9); const vw = g.measureText(v).width; g.fillText(v, PW - padX, by); g.textAlign = 'left';
      ls('1.6px'); g.fillStyle = '#6b6a63'; const k = fit(g, String(l.k || '').toUpperCase(), inner - vw - 26, IN(600), ks, 7); const kw = g.measureText(k).width; g.fillText(k, padX, by); ls('0px');
      if (inner - vw - kw > 22) { g.strokeStyle = 'rgba(23,23,26,0.35)'; g.setLineDash([1.5, 4]); g.beginPath(); g.moveTo(padX + kw + 8, by - 2.5); g.lineTo(PW - padX - vw - 8, by - 2.5); g.stroke(); }
      y += rh;
    }
    g.setLineDash([]);
    if (opts.stamp) {
      const s = String(opts.stamp).toUpperCase(); ls('5px'); g.font = IN(800)(30); let fs = 30; while (fs > 14 && g.measureText(s).width > PW * 0.62) { fs -= 1; g.font = IN(800)(fs); }
      const sw = g.measureText(s).width + 30, sh = fs + 26;
      g.save(); g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.86; g.translate(PW - padX - sw / 2 + 6, PH - 58); g.rotate(-0.14);
      g.strokeStyle = tone; g.lineWidth = 4; g.strokeRect(-sw / 2, -sh / 2, sw, sh); g.fillStyle = tone; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, 2.5, 2); g.restore(); ls('0px');
    }
    g.restore();
    return c;
  }

  // ---------- the vital / autopsy slip of one creature ----------
  // `b` is a creature as served by /api/being/:id (or a lineage row); only fields present are printed.
  function beingSlip(b, o = {}) {
    const gone = !!b.died || b.alive === false || b.rdied != null;
    let cause = o.causeName || null;
    if (!cause && b.cause) { try { const t = (typeof ROUND !== 'undefined' && ROUND && ROUND.trials || []).find((t) => t.key === b.cause); cause = t ? t.name : b.cause; } catch { cause = b.cause; } }
    const nick = String(b.nick || ''), fam = o.family || (/\s\S+$/.test(nick) ? nick.replace(/\s+\S+$/, '') : null);
    const duels = b.wins != null && b.losses != null ? b.wins + ' / ' + b.losses : b.wins != null ? b.wins + ' won' : null;
    const lines = [
      ['Name', nick], ['Specimen', b.id], ['Family', fam], ['Generation', b.gen != null ? b.gen + 1 : null],
      ['Brain', b.modelName || (b.modelCard && b.modelCard.name) || b.model], ['Rarity', o.rarity || b.tierName || null], b.mutated ? ['Mutation', 'Brain changed at birth'] : null,
      ['Born after round', b.rborn], ['Trials survived', b.survived], ['Berries eaten', b.eaten], [b.losses != null ? 'Duels won / lost' : 'Duels', duels], ['Shared', b.shares],
      gone ? ['Cause of death', cause] : (b.alive && b.energy != null ? ['Energy now', b.energy] : null), gone ? ['Died in round', b.rdied] : null,
      gone && o.epitaph ? { k: 'Epitaph', text: o.epitaph } : null,
    ];
    return { lines, title: gone ? 'Autopsy slip' : 'Vital slip', sub: nick, stamp: gone ? 'CULLED' : 'ALIVE' };
  }

  window.printSlip = printSlip; window.slipToCanvas = slipToCanvas; window.beingSlip = beingSlip;
  window.slipSave = (lines, opts, name) => { try { const a = document.createElement('a'); a.download = name || 'slip.png'; a.href = slipToCanvas(lines, opts).toDataURL('image/png'); a.click(); } catch {} };
})();

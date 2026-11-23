// Site-wide atmosphere: scanlines, signal glitch, observation line, round strip trace, nav pulse,
// countdown title, final-minute overlay (the sealed minute) and the cull flash.
// Drawn in the ds.css language. GPU-light: no backdrop-filter, no root filter, no per-frame work;
// everything runs off one 250 ms timer and CSS transform/opacity. Uses window.Art (art.js) when present
// for segment numerals and resolving figures; works without it.
// Self-contained. Never throws if an element or endpoint is missing. Every number shown comes from an API.
(() => {
  'use strict';
  if (window.__fx) return; window.__fx = 1;
  const D = document, R = D.documentElement;
  const reduce = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  const el = (tag, cls, html) => { const e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x.toLocaleString('en-US') : null);
  const get = (p) => fetch(p).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const pad = (n) => String(n).padStart(2, '0');
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };
  const isApp = /^\/app\/?$/.test(location.pathname);
  const art = () => (window.Art && typeof window.Art === 'object' ? window.Art : null);

  function boot() {
    const B = D.body; if (!B) return;

    // ---------- 1. overlays: one static scanline/vignette layer, the tear bands, the flash ----------
    const tear = el('div', 'fx-tear'), flash = el('div', 'fx-flash');
    [el('div', 'fx-scan'), tear, flash].forEach((e) => { e.setAttribute('aria-hidden', 'true'); B.appendChild(e); });

    let glitching = 0;
    function glitch(strong) {
      if (reduce || glitching || D.hidden) return;
      glitching = 1;
      const dur = Math.round(150 + Math.random() * 150), n = strong ? 4 : 2;
      let h = '';
      for (let i = 0; i < n; i++) h += `<i style="top:${(Math.random() * 96).toFixed(1)}%;height:${(0.6 + Math.random() * (strong ? 5 : 2.4)).toFixed(1)}%;--x:${(Math.random() * 70).toFixed(0)}%"></i>`;
      tear.innerHTML = h;
      R.style.setProperty('--fx-gd', dur + 'ms'); R.classList.add('fx-glitch');
      setTimeout(() => { R.classList.remove('fx-glitch'); tear.innerHTML = ''; glitching = 0; }, dur + 30);
    }
    (function rare() { setTimeout(() => { if (Math.random() < 0.5) glitch(false); rare(); }, 50000 + Math.random() * 90000); })();

    // ---------- 2. observation line ----------
    const hud = el('div', 'fx-hud' + (isApp ? ' app' : ''), '<span class="dot"></span><span class="t"></span><span class="last"></span>');
    hud.setAttribute('aria-hidden', 'true'); B.appendChild(hud); if (!isApp) R.classList.add('fx-bar');
    const hudT = hud.querySelector('.t'), hudL = hud.querySelector('.last');
    let lastId = null, hudKey = '';
    const resolveFig = (b) => { const A = art(); if (A && A.glitchText && !reduce) try { A.glitchText(b, { ms: 420 }); } catch {} };
    async function loadToll() {
      const t = await get('/api/toll');
      if (t && typeof t === 'object') {
        const vals = [num(t.alive), num(t.dead), num(t.extinct)];
        const key = vals.map((v) => (v == null ? '' : 'x')).join('');
        if (key !== hudKey) { // (re)build the line only when its shape changes
          hudKey = key;
          const parts = [];
          if (vals[0]) parts.push('<i class="mk"></i>OBSERVING <b data-k="0"></b>');
          if (vals[1]) parts.push('<i class="mk dead"></i><b class="die" data-k="1"></b> DEAD');
          if (vals[2]) parts.push(`<span class="xt"><b data-k="2"></b> ${t.extinct === 1 ? 'LINEAGE' : 'LINEAGES'} EXTINCT</span>`);
          hudT.innerHTML = parts.map((p, i) => (i ? `<s${i === 2 ? ' class="xt"' : ''}></s>` : '') + p).join('');
        }
        hudT.querySelectorAll('b[data-k]').forEach((b) => { const v = vals[+b.dataset.k]; if (v != null && b.textContent !== v) { const first = !b.textContent; b.textContent = v; if (!first) resolveFig(b); } });
        if (hudT.innerHTML) hud.classList.add('on');
      }
      const d = await get('/api/dead?limit=1');
      const x = Array.isArray(d) ? d[0] : null;
      if (x && x.id !== lastId) {
        lastId = x.id;
        const rest = [x.modelName && esc(x.modelName), x.causeName && esc(x.causeName)].filter(Boolean).join(' · ');
        const html = (x.nick ? `LAST <b>${esc(x.nick)}</b>` : 'LAST') + (rest ? ` <em>${rest}</em>` : '');
        if (x.nick || rest) { hudL.classList.remove('on'); setTimeout(() => { hudL.innerHTML = html; hudL.classList.add('on'); }, hudL.innerHTML ? 2400 : 60); }
      }
    }
    loadToll(); setInterval(() => { if (!D.hidden) loadToll(); }, 20000);
    try {
      const sb = D.querySelector('.statbar');
      if (sb && 'IntersectionObserver' in window) new IntersectionObserver((es) => hud.classList.toggle('away', es.some((e) => e.isIntersecting)), { threshold: 0 }).observe(sb);
    } catch {}

    // ---------- 3 + 4. round clock: title, strip trace, nav pulse, final minute, completion ----------
    const fin = el('div', 'fx-final' + (isApp ? ' app' : ''), '<i class="sweep" aria-hidden="true"></i><div class="in"><div class="lab"></div><div class="num"><span class="seg"></span></div><div class="meter" aria-hidden="true"><i></i></div><div class="sub"></div><button class="hide" type="button">Hide</button></div>');
    fin.setAttribute('role', 'status');
    B.appendChild(fin);
    const fLab = fin.querySelector('.lab'), fSeg = fin.querySelector('.seg'), fMeter = fin.querySelector('.meter'), fSub = fin.querySelector('.sub');
    let round = null, skew = 0, hiddenFor = null, flashedFor = null, culledFor = null, doneUntil = 0, baseTitle = null, titled = false, lastTxt = '', lastSegKey = '', lastK = '';
    try { hiddenFor = Number(sessionStorage.getItem('fxHide')) || null; } catch {}
    fin.querySelector('.hide').onclick = () => { if (!round) return; hiddenFor = round.n; try { sessionStorage.setItem('fxHide', String(round.n)); } catch {} fin.classList.remove('on'); };
    const remain = () => (round && round.next ? round.next - (Date.now() + skew) : null);
    window.wlRemain = remain; // read by the sound engine in common.js (heartbeat rate) and art.js (nav pulse)

    // draw the count: segment numerals on a canvas when art.js is here, plain display-face text otherwise
    function drawCount(txt, pink) {
      const key = txt + (pink ? 'p' : '');
      if (key === lastSegKey) return; lastSegKey = key;
      const A = art();
      if (A && A.segments) { try { A.segments(fSeg, txt); return; } catch {} }
      fSeg.textContent = txt;
    }

    function complete(r, prevTrial) {
      glitch(true);
      if (hiddenFor === r.n - 1 || hiddenFor === r.n) return;
      if (isApp) { fin.classList.remove('on', 'last10'); doneUntil = Date.now() + 9000; return; } // the meadow plays its own cull sequence and title
      const L = r.last, died = L && (typeof L.died === 'number' ? L.died : Array.isArray(L.died) ? L.died.length : null);
      const okN = !L || L.n == null || L.n === r.n;
      fLab.innerHTML = `ROUND ${esc(r.n)} COMPLETE` + (died != null && okN ? ` · <b>${num(died)} DIED</b>` : '');
      fSub.textContent = prevTrial || ''; fSub.dataset.s = '';
      fin.classList.remove('last10'); fin.classList.add('done', 'on');
      doneUntil = Date.now() + 4000;
      setTimeout(() => { fin.classList.remove('on'); setTimeout(() => fin.classList.remove('done'), 1300); }, 4000);
    }
    function setRound(r) {
      if (!r || typeof r.n !== 'number') return;
      const prev = round;
      if (typeof r.now === 'number') skew = r.now - Date.now();
      round = r;
      if (prev && prev.n !== r.n) complete(r, prev.upcoming && prev.upcoming.name);
    }
    let polling = false;
    async function poll() { if (polling) return; polling = true; try { setRound(await get('/api/round')); } finally { polling = false; } }
    D.addEventListener('round', (e) => { try { setRound(e.detail); } catch {} });
    poll();
    let lastPoll = Date.now();

    // The final minute is the sealed minute: the coming round's input is frozen and its hash is public (/api/commit).
    // Keep this browser's own copy (same key as /verify) so the visitor can later check that the record was not swapped.
    let commit = null, commitAt = 0;
    async function loadCommit() {
      const c = await get('/api/commit'); if (!c || typeof c.roundN !== 'number') return;
      commit = c;
      if (c.pending && /^0x[0-9a-fA-F]{64}$/.test(c.snapshotHash || '')) try { const k = 'wlCommit:' + c.roundN; if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ hash: c.snapshotHash, seenAt: Date.now() })); } catch {}
    }
    const sealed = () => (commit && round && commit.pending && commit.roundN === round.n + 1 && typeof commit.snapshotHash === 'string' ? commit.snapshotHash : null);

    // the strip trace and the nav pulse (only DOM writes when a value actually changes)
    let stripK = '', stripFin = null, navKey = '';
    function chrome(ms) {
      const strip = D.getElementById('strip');
      if (strip) {
        let k = 0;
        if (ms != null && round) {
          const at = round.last && typeof round.last.at === 'number' ? round.last.at : 0;
          let period = at && round.next > at ? round.next - at : 3600000;
          if (period > 3600000 || period < 60000) period = 3600000; // after an outage, measure against the hour
          k = 1 - Math.max(0, Math.min(1, ms / period));
        }
        const ks = k.toFixed(4); if (ks !== stripK) { stripK = ks; strip.style.setProperty('--fx-k', ks); }
        const f = ms != null && ms > 0 && ms <= 60000; if (f !== stripFin) { stripFin = f; strip.classList.toggle('fx-last', f); }
      }
      // plain .nav (art.js drives .ds-nav and body.ds .nav itself): quantised so the pulse does not jump every tick
      let dur = 6, soon = false, fn = false;
      if (ms != null && ms > 0) { soon = ms <= 300000; fn = ms <= 60000; dur = fn ? 1.1 : soon ? 2 : ms <= 900000 ? 3 : ms <= 1800000 ? 4.5 : 6; }
      const key = dur + (soon ? 's' : '') + (fn ? 'f' : '');
      if (key !== navKey) { navKey = key; D.querySelectorAll('.nav').forEach((n) => { if (B.classList.contains('ds')) return; n.style.setProperty('--pulse', dur + 's'); n.classList.toggle('is-soon', soon && !fn); n.classList.toggle('is-final', fn); }); }
    }

    function tick() {
      const now = Date.now(), ms = remain();
      // light polling: 20 s normally, 2 s while waiting for an overdue round to land
      const every = ms != null && ms <= 0 && ms > -180000 ? 2000 : 20000;
      if (now - lastPoll >= every && !D.hidden) { lastPoll = now; poll(); }
      if (ms == null) return;
      if (!D.hidden) chrome(ms);
      const name = (round.upcoming && round.upcoming.name) || '';
      // title
      if (ms > 0 && ms <= 300000) {
        if (!titled) { baseTitle = D.title; titled = true; }
        const t = mmss(ms) + (name ? ' · ' + name : '') + ' — WEIGHTLINGS';
        if (D.title !== t) D.title = t;
      } else if (titled) { titled = false; if (baseTitle != null) D.title = baseTitle; }
      // final minute
      if (now < doneUntil || fin.classList.contains('done')) return;
      const live = ms <= 60000 && ms > -180000 && hiddenFor !== round.n;
      if (live) {
        const pink = ms <= 10000;
        fin.classList.toggle('last10', pink);
        const txt = ms > 0 ? mmss(ms) : '00:00';
        if (txt !== lastTxt) lastTxt = txt;
        drawCount(txt, pink);
        const k = Math.max(0, Math.min(1, ms / 60000)).toFixed(3); if (k !== lastK) { lastK = k; fMeter.style.setProperty('--k', k); }
        const lab = name ? `NEXT TRIAL · <b>${esc(name)}</b>` : 'NEXT TRIAL';
        if (fLab.innerHTML !== lab) fLab.innerHTML = lab;
        if (!sealed() && now - commitAt > 4000 && !D.hidden) { commitAt = now; loadCommit(); }
        const h = sealed();
        const sub = (ms > 0 ? `ROUND ${esc(round.n + 1)}` : 'WAITING FOR THE SEED BLOCK') + (h ? ` · SEALED · <i>${esc(h.slice(0, 10))}…${esc(h.slice(-6))}</i>` : '');
        if (fSub.dataset.s !== sub) { fSub.dataset.s = sub; fSub.innerHTML = sub; }
        fin.classList.add('on');
      } else if (fin.classList.contains('on')) fin.classList.remove('on');
      // cull cue: sound swell lands on zero, then the flash
      if (ms <= 2200 && ms > 0 && culledFor !== round.n) { culledFor = round.n; try { window.wlAudio && window.wlAudio.cull(ms / 1000); } catch {} }
      if (ms <= 0 && ms > -3000 && flashedFor !== round.n) {
        flashedFor = round.n;
        if (!reduce && hiddenFor !== round.n && !D.hidden) { flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go'); }
      }
    }
    setInterval(() => { try { tick(); } catch {} }, 250);
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot); else boot();
})();

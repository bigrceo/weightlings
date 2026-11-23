// Landing (sober): next-cull clock and live agent count. The hero network is drawn by field.js.
(function () {
  'use strict';
  const clock = document.getElementById('sbClock'), alive = document.getElementById('sbAlive');
  let nextAt = 0;
  fetch('/api/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((s) => { const n = s && (s.nextTrialAt || s.nextAt || s.next); if (n) nextAt = typeof n === 'number' ? n : Date.parse(n); if (s && s.alive && alive && alive.textContent === '—') alive.textContent = String(s.alive); }).catch(() => {});
  const pad = (n) => String(n).padStart(2, '0');
  function tick() {
    const now = Date.now(); let t = nextAt > now ? nextAt : Math.ceil(now / 3600000) * 3600000;
    const s = Math.max(0, Math.round((t - now) / 1000)); if (clock) clock.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }
  tick(); setInterval(tick, 1000);
  if (window.wlFeed && alive) wlFeed.on('world', (w) => { const n = (w.c || []).length; alive.textContent = n ? String(n) : '—'; });
})();

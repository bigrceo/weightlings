// Coin block + proof line on the landing. Both stay hidden until they have something real to show:
// the CA block appears once the server knows the token (/api/config), the proof line once paid hires reach a floor.
(() => {
  const $ = (s) => document.getElementById(s);
  const get = (p) => fetch(p, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  async function ca() {
    const c = await get('/api/config');
    if (!c || !/^0x[0-9a-fA-F]{40}$/.test(c.token || '')) return false;
    $('caAddr').textContent = c.token;
    if (c.ticker) $('caTick').textContent = '$' + c.ticker.replace(/^\$/, '');
    const p = $('caPons'); p.href = c.ponsUrl || `https://pons.fun/token/${c.token}`;
    $('caCopy').onclick = () => { navigator.clipboard?.writeText(c.token).then(() => { $('caCopy').textContent = 'Copied'; setTimeout(() => ($('caCopy').textContent = 'Copy CA'), 1500); }).catch(() => {}); };
    $('caBlock').hidden = false;
    return true;
  }
  async function proof() {
    const p = await get('/api/proof');
    if (!p || !(p.paidHires >= 10) || !(p.usdgEarned >= 1)) return;
    $('proofLine').innerHTML = `Live on Robinhood Chain mainnet · <b>${p.paidHires.toLocaleString('en-US')}</b> paid hires · <b>${p.usdgEarned.toFixed(2)} USDG</b> earned by agents · every hire signed`;
    $('proofLine').hidden = false;
  }
  // the CA is checked every 10 s until it shows, so it appears without a reload the moment it is set
  (async function loop() { if (!(await ca())) setTimeout(loop, 10000); })();
  proof();
  // stat row: fill at once from light endpoints (the full loader in ward.js refines it later)
  Promise.all([get('/api/round'), get('/api/stats'), get('/api/markets')]).then(([r, st, mk]) => {
    const set = (id, v) => { const e = $(id); if (e && (e.textContent === '—' || !e.textContent)) { e.textContent = v; e.dataset.v = v; } };
    if (r && r.last && r.last.died != null) set('sbDied', String(r.last.died));
    if (st && st.alive != null) { set('sbAlive', String(st.alive)); set('sbLin', `${st.lineages} lineages`); }
    const ms = mk && (mk.markets || mk); if (Array.isArray(ms) && ms.length) { const top = [...ms].sort((a, z) => z.change24 - a.change24)[0]; set('sbTop', top.name); set('sbTopC', `${top.price.toFixed(3)} · ${top.change24 >= 0 ? '+' : ''}${(top.change24 * 100).toFixed(1)}% 24h`); }
  });
})();

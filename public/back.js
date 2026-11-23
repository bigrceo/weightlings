// Back a creature for the next trial with paper credits (the same free credits as the model exchange). No real money.
// Standalone (no dependency on common.js / cards.js). Exposes:
//   mountBack(slot, being)  -> renders the backing panel for one creature inside `slot` (safe to call again on every drawer re-render)
//   Back                    -> { pid(), get(path), place(id, side, amt), bird(color), tier(t), cr(n), esc, why(position) } used by /back
(() => {
  const MARK = ['.X.......X.', '..X.....X..', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.XXXXXXXXX.', '.XXXX.XXXX.', '..XXXXXXX..', '...X...X...'];
  const TIER = { legendary: '#ffb81f', epic: '#b056ff', rare: '#2a7bff', uncommon: '#2fc46b', common: '#c9ccd4' };
  const STEPS = [10, 25, 50, 100];
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cr = (n) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1000 || Number.isInteger(+n) ? 0 : 2 }));
  const bird = (color) => `<svg class="bk-bird" viewBox="0 0 11 9" shape-rendering="crispEdges" aria-hidden="true" fill="${color}">${MARK.flatMap((r, y) => [...r].map((c, x) => (c === 'X' ? `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>` : ''))).join('')}</svg>`;
  let _pid = null;
  function pid() {
    if (_pid) return _pid;
    try { _pid = localStorage.getItem('wl_pid'); } catch {}
    if (!_pid || !/^[a-z0-9]{8,40}$/.test(_pid)) { _pid = Math.random().toString(36).slice(2, 14) + Date.now().toString(36); try { localStorage.setItem('wl_pid', _pid); } catch {} }
    return _pid;
  }
  const get = (p) => fetch(p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  const place = (id, side, amt) => fetch('/api/back', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: pid(), id, side, amt }) })
    .then((r) => r.json()).catch(() => ({ error: 'The server did not answer. Nothing was placed.' }));
  /** What you would receive for `amt` on `side` if that side wins, given the pool as it stands (it moves until the round is sealed). */
  function implied(pool, side, amt) {
    const mine = (pool[side] || 0) + amt, other = pool[side === 'survive' ? 'die' : 'survive'] || 0;
    return other > 0 ? { pay: ((mine + other) * amt) / mine, matched: true } : { pay: amt, matched: false };
  }
  /** One plain sentence for a settled position. */
  function why(p) {
    const name = esc(p.nick || 'Creature ' + p.being), s = p.side === 'survive' ? 'SURVIVES' : 'DIES';
    if (p.status === 'won') return `Round ${p.round}: ${name} ${p.outcome === 'die' ? 'died' : 'survived'}. Your ${cr(p.amt)} on ${s} paid ${cr(p.payout)} credits.`;
    if (p.status === 'lost') return `Round ${p.round}: ${name} ${p.outcome === 'die' ? 'died' : 'survived'}. Your ${cr(p.amt)} on ${s} is lost to the other side.`;
    if (p.outcome === 'void') return `Round ${p.round} was voided. Your ${cr(p.amt)} credits were returned.`;
    if (p.outcome === 'absent') return `Round ${p.round}: ${name} was not in the sealed snapshot. Your ${cr(p.amt)} credits were returned.`;
    return `Round ${p.round}: ${name} ${p.outcome === 'died-onesided' ? 'died' : 'survived'}. Nobody took the other side, so your ${cr(p.amt)} credits were returned.`;
  }

  // one live panel at a time; choices survive the drawer's re-renders
  const pick = new Map(); // being id -> { side, amt }
  const cache = new Map(); // being id -> { backing, mine, stand, total }
  let live = null;
  function mountBack(slot, being) {
    if (!slot || !being || being.id == null) return;
    if (live) live.stop();
    const id = Number(being.id), me = { stopped: false, t: 0, busy: false, msg: '', stop() { this.stopped = true; clearTimeout(this.t); } };
    live = me;
    slot.classList.add('bk');
    const st = pick.get(id) || { side: null, amt: 25 }; pick.set(id, st);
    const name = esc(being.nick || 'Creature ' + id);

    function draw() {
      const c = cache.get(id);
      if (!c || !c.backing) { slot.innerHTML = '<div class="bk-k">Back ' + name + '</div><div class="bk-dim">Loading the pool…</div>'; return; }
      const b = c.backing, m = c.mine || { open: [], settled: [], credits: null }, pos = m.open.find((p) => p.being === id && p.round === b.round), last = m.settled.find((p) => p.being === id);
      const alive = b.alive && being.alive !== false, tot = (b.survive || 0) + (b.die || 0), sp = tot ? (b.survive / tot) * 100 : 50;
      let h = `<div class="bk-k">${alive ? `Back ${name} for round ${b.round}` : `${name} · backing`}<em>Paper credits</em></div>`;
      if (alive) {
        if (c.stand) h += `<div class="bk-stand ${c.stand.inKillZone ? 'kz' : ''}"><b>#${c.stand.rank}</b><span>of ${c.total} on live standing</span><i>${c.stand.inKillZone ? 'In the kill zone now' : 'Above the line now'}</i></div>`;
        h += `<div class="bk-pool"><div class="bk-bar" style="--s:${sp.toFixed(1)}%"${tot ? '' : ' data-empty'}><i></i></div><div class="bk-pl"><span><b>${cr(b.survive)}</b> on survives</span><span><b>${cr(b.die)}</b> on dies</span></div></div>`;
        if (b.sealed) h += '<div class="bk-seal">Sealed. The block decides.</div>';
        if (pos) {
          const im = implied({ survive: b.survive - (pos.side === 'survive' ? pos.amt : 0), die: b.die - (pos.side === 'die' ? pos.amt : 0) }, pos.side, pos.amt);
          h += `<div class="bk-pos ${pos.side}"><span>Your position</span><b>${cr(pos.amt)} on ${pos.side === 'survive' ? 'SURVIVES' : 'DIES'}</b><small>${im.matched ? 'Pays ' + cr(im.pay) + ' credits if right, at the pool as it stands' : 'Nobody is on the other side yet: your stake comes back unless someone takes it'}</small></div>`;
        } else if (!b.sealed) {
          const im = st.side ? implied(b, st.side, st.amt) : null, short = m.credits != null && m.credits < st.amt;
          h += `<div class="bk-sides"><button type="button" class="bk-b s ${st.side === 'survive' ? 'on' : ''}" data-side="survive">Survives</button><button type="button" class="bk-b d ${st.side === 'die' ? 'on' : ''}" data-side="die">Dies</button></div>`
            + `<div class="bk-amt" role="group" aria-label="Amount">${STEPS.map((a) => `<button type="button" class="${a === st.amt ? 'on' : ''}" data-amt="${a}">${a}</button>`).join('')}</div>`
            + `<div class="bk-line">${im ? (im.matched ? `<b>${cr(st.amt)}</b> on ${st.side === 'survive' ? 'survives' : 'dies'} pays <b>${cr(im.pay)}</b> if right, at the pool as it stands` : `Nobody is on the other side yet: <b>${cr(st.amt)}</b> comes back unless someone takes it`) : 'Pick a side. The winning side splits the whole pool.'}</div>`
            + `<button type="button" class="bk-go" ${!st.side || short || me.busy ? 'disabled' : ''}>${short ? 'Not enough credits' : st.side ? `Back with ${cr(st.amt)} credits` : 'Pick a side'}</button>`;
        }
        h += `<div class="bk-bal"><span>Your balance</span><b>${cr(m.credits)}</b><span>credits</span><a href="/back">All positions</a></div>`;
      }
      if (me.msg) h += `<div class="bk-msg" role="status">${esc(me.msg)}</div>`;
      if (last) h += `<div class="bk-res ${last.status}">${why(last)}</div>`;
      if (!alive && !last) h += '<div class="bk-dim">Only living creatures can be backed.</div>';
      h += '<div class="bk-fine">Paper credits · no real money · settled from the round record. <a href="/verify">Verify</a></div>';
      if (slot.__h !== h) { slot.__h = h; slot.innerHTML = h; } // unchanged polls leave the DOM alone, so a press is never lost to a redraw
    }
    slot.onclick = async (e) => {
      const t = e.target.closest('button'); if (!t || me.stopped) return;
      if (t.dataset.side) { st.side = t.dataset.side; me.msg = ''; return draw(); }
      if (t.dataset.amt) { st.amt = Number(t.dataset.amt); me.msg = ''; return draw(); }
      if (t.classList.contains('bk-go') && st.side && !me.busy) {
        me.busy = true; draw();
        const r = await place(id, st.side, st.amt); me.busy = false;
        me.msg = r && r.error ? r.error : ''; if (me.stopped) return;
        await load(); document.dispatchEvent(new CustomEvent('backed', { detail: r }));
      }
    };
    async function load() {
      const [backing, mine, stand] = await Promise.all([get('/api/backing?id=' + id), get('/api/backs?pid=' + pid()), get('/api/standing')]);
      const c = cache.get(id) || {};
      if (backing && !backing.error) c.backing = backing;
      if (mine && !mine.error) c.mine = mine;
      if (Array.isArray(stand)) { c.stand = stand.find((r) => r.id === id) || null; c.total = stand.length; }
      cache.set(id, c);
      if (!me.stopped && slot.isConnected) draw();
    }
    async function loop() {
      if (me.stopped) return;
      if (!slot.isConnected) return me.stop();
      if (!document.hidden) await load();
      me.t = setTimeout(loop, 6000);
    }
    draw(); loop();
    return me;
  }
  window.mountBack = mountBack;
  window.Back = { pid, get, place, bird, tier: (t) => TIER[t] || TIER.common, cr, esc, why, implied, STEPS };
})();

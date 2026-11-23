// Landing: hatch bar, stat bar, kill-zone belt, last culled, the ward (live block, rarity × lab matrix with live mini-maps and
// replay, trials, record) and the memoriam. Every figure comes from the API; nothing here is invented.
(function () {
  // the entry sequence (#intro) is owned by boot.js
  $('#ask0').onsubmit = (e) => { e.preventDefault(); const v = $('#ask0i').value.trim(); if (!v) return; openSummon(); $('#addr').value = v; summon(v); };
  const LABS = ['Meta', 'Alibaba', 'Google', 'Mistral AI', 'Microsoft', 'DeepSeek'], LABN = { 'Mistral AI': 'Mistral' }, TIERS = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
  let rounds = [], at = 0;
  const ROWS = ['.A.......A.', '..A.....A..', '...KKKKK...', '..KKSKSKK..', '.KKWPKWPKK.', '.KKKKKKKKK.', '.KKKKMKKKK.', '..KKKKKKK..', '...L...L...'];
  const DEAD = ['.A.......A.', '..A.....A..', '...KKKKK...', '..KKKKKKK..', '.KXKXKXKXK.', '.KKXKKKXKK.', '.KXKXKXKXK.', '..KKKKKKK..', '...L...L...'];
  window.WL_ROWS = ROWS; window.WL_DEAD = DEAD; // the hour sequence and the meadow window in landing.js draw the same creature
  const ART = () => window.Art || null;
  const count = (el, v, o) => { // counts the first text node up (keeps a trailing <small> unit)
    if (!el) return; const A = ART(); if (A && A.countUp) { A.countUp(el, v, o); return; }
    const tn = [...el.childNodes].find((n) => n.nodeType === 3); const s = Number(v).toLocaleString('en-US'); if (tn) tn.nodeValue = s; else el.prepend(s);
  };
  const sprs = {};
  function spr(t) {
    if (sprs[t]) return sprs[t];
    const c = document.createElement('canvas'); c.width = 11; c.height = 9; const g = c.getContext('2d'), dead = t === 'dead';
    const col = dead ? { A: '#6b7770', K: '#6b7770', X: '#020403', L: '#3e4842' } : { A: '#e6eee8', K: TIER[t][0], S: '#ffffffaa', W: '#fff', P: '#020403', M: '#020403', L: '#3e4842' };
    (dead ? DEAD : ROWS).forEach((r, y) => [...r].forEach((ch, x) => { if (col[ch]) { g.fillStyle = col[ch]; g.fillRect(x, y, 1, 1); } }));
    return (sprs[t] = c.toDataURL());
  }

  // ---------------------------------------------------------------- the matrix
  function matrix() {
    const r = rounds[at]; if (!r) { $('#matrix').innerHTML = '<p class="ds-fine">No round on record yet. The first trial runs on the hour.</p>'; $('#mLabel').textContent = ''; return; }
    let h = `<div class="lpm-row lpm-h"><span></span>${LABS.map((l) => `<span>${LABN[l] || l}</span>`).join('')}</div>`;
    let i = 0;
    for (const t of TIERS) {
      h += `<div class="lpm-row"><span class="lpm-t" style="--c:${TIER[t][0]}"><i></i>${TIER[t][1]}</span>`;
      for (const l of LABS) {
        const c = r.ward?.[t + '|' + l]; if (!c) { h += '<span class="lp-cell none" aria-hidden="true"></span>'; continue; }
        const d = c.died / c.start, cls = c.died === 0 ? 'ok' : d >= 0.5 ? 'dead' : 'hurt';
        // the latest round: a live mini-map of where these creatures are now; older rounds: one little creature per head
        let pen = '';
        if (at === 0) pen = `<canvas class="mini" data-k="${t}|${l}" title="Live position of these creatures in the meadow. Click to open it."></canvas>`;
        else {
          const k = Math.min(1, 8 / c.start), nd = c.died ? Math.max(1, Math.round(c.died * k)) : 0, na = c.start - c.died ? Math.max(1, Math.round((c.start - c.died) * k)) : 0;
          for (let j = 0; j < na; j++) pen += `<img class="walk" src="${spr(t)}" style="left:${8 + (j / Math.max(1, na)) * 70}%;animation-duration:${2.4 + (j * 37 % 10) / 5}s;animation-delay:-${(j * 53 % 20) / 10}s" alt="">`;
          for (let j = 0; j < nd; j++) pen += `<img class="rip" src="${spr('dead')}" style="left:${4 + (j / Math.max(1, nd)) * 82}%" alt="">`;
        }
        h += `<span class="lp-cell ${cls}" style="--i:${i++ % 12}"><span class="pen${at === 0 ? ' live' : ''}">${pen}</span><b>${c.died === 0 ? 'All alive' : c.died + ' died'}</b><small>${c.start - c.died} of ${c.start} alive</small><i class="lp-cell__m" style="--v:${(c.died / c.start).toFixed(3)}"></i></span>`;
      }
      h += '</div>';
    }
    $('#matrix').innerHTML = h;
    $('#mLabel').textContent = `Round ${r.n} · ${r.trialName} · ${r.died} of ${r.population} died${at === 0 ? ' · latest' : ''}`;
    $('#mNext').disabled = at === 0; $('#mPrev').disabled = at >= rounds.length - 1;
    minis = $$('canvas.mini');
  }

  // live mini-maps: where the creatures of each cell really are right now (river, the rest of the meadow, graves of the last round)
  let world = null, MM = null, minis = [], mxOn = true, lastMini = 0, tick = 0;
  window.wlGenes.then((L) => { MM = Object.fromEntries(L.map((m) => [m.id, m])); });
  window.wlFeed.on('world', (w) => (world = w));
  const mxEl = $('#matrix');
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => { mxOn = es[0].isIntersecting; }, { rootMargin: '80px' }).observe(mxEl);
  const rJ = (i) => 9 + 4 * Math.sin(i / 6.5) + i * 0.08;
  function drawMinis(t) {
    if (!mxOn || !world || !MM || !minis.length || t - lastMini < 125) return true;
    lastMini = t; tick++;
    const D = Math.min(2, devicePixelRatio || 1);
    for (const c of minis) {
      if (!c.isConnected) continue;
      const W = Math.round(c.clientWidth * D), H = Math.round(c.clientHeight * D); if (!W || !H) continue; if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const g = c.getContext('2d'), k = c.dataset.k, sep = k.indexOf('|'), tt = k.slice(0, sep), l = k.slice(sep + 1), X = (i) => (i / 56) * W, Y = (j) => (j / 56) * H, col = TIER[tt][0];
      g.clearRect(0, 0, W, H);
      // ground: a dot grid; the river as a dotted trace
      g.fillStyle = 'rgba(140,255,200,.10)'; for (let i = 4; i < 56; i += 6) for (let j = 4; j < 56; j += 6) g.fillRect(X(i), Y(j), D, D);
      g.fillStyle = 'rgba(42,123,255,.55)'; for (let i = 0; i <= 56; i += 1.5) g.fillRect(X(i), Y(rJ(i)), D * 1.5, D);
      // everyone else, faint
      g.fillStyle = 'rgba(230,238,232,.16)';
      for (const r of world.c) { const m = MM[r[5]]; if (!m || (m.tier === tt && m.lab === l)) continue; g.fillRect(X(r[1]), Y(r[2]), D, D); }
      // graves of the last round, this cell only: small pink crosses
      g.fillStyle = 'rgba(255,63,142,.7)';
      for (const gv of world.graves || []) { const m = MM[gv[2]]; if (!m || m.tier !== tt || m.lab !== l) continue; const x = X(gv[0]), y = Y(gv[1]); g.fillRect(x - 1.5 * D, y - 0.5 * D, 3 * D, D); g.fillRect(x - 0.5 * D, y - 1.5 * D, D, 3 * D); }
      // this cell's creatures, in their tier colour, hopping
      for (const r of world.c) {
        const m = MM[r[5]]; if (!m || m.tier !== tt || m.lab !== l) continue;
        const e = r[3], hop = e < 0 ? 0 : (tick + r[0]) % 16 < 8 ? D : 0, s = 3 * D, x = X(r[1]), y = Y(r[2]);
        g.globalAlpha = 0.25; g.fillStyle = col; g.fillRect(x - s, y - s, s * 2, s * 2);
        g.globalAlpha = 1; g.fillStyle = e < 0 ? '#6b7770' : col; g.fillRect(x - s / 2, y - s / 2 - hop, s, s);
      }
    }
    return true;
  }
  window.wlLoop(drawMinis);
  mxEl.addEventListener('click', (e) => { if (e.target.closest('canvas.mini')) location.href = '/app'; });
  $('#mPrev').onclick = () => { at = Math.min(rounds.length - 1, at + 1); matrix(); };
  $('#mNext').onclick = () => { at = Math.max(0, at - 1); matrix(); };

  // ---------------------------------------------------------------- the ward, the stat bar, trials, record
  let lastKey = '', lastWl = '';
  async function load() {
    const [rs, st, mk, tr] = await Promise.all([api('/api/rounds'), api('/api/stats'), api('/api/markets'), api('/api/trials')]);
    allRounds = rs; const key = (rs[0] && rs[0].n) + ':' + rs.length;
    rounds = rs.filter((r) => r.ward); if (at >= rounds.length) at = 0;
    if (key !== lastKey) matrix();
    const L = rs[0], day = rs.filter((r) => Date.now() - r.at < 86400000), dd = day.reduce((s, r) => s + r.died, 0), dm = day.reduce((s, r) => s + r.mutations, 0);
    const wlHtml = `<div class="ds-panel__hd"><span class="ds-label ds-label--die">${L ? `Round ${L.n} · ${esc(L.trialName)}` : 'No round on record yet'}</span>${L ? `<span class="ds-tag ds-tag--dim">${new Date(L.at).toISOString().slice(11, 16)} UTC</span>` : ''}</div>
      ${L ? `<div class="lp-wl__big"><b class="ds-num ds-num--lg ds-num--die" data-count="${L.died}" style="--v:${(L.died / Math.max(1, L.population)).toFixed(3)}">${L.died}</b><span class="ds-label ds-label--bare">of ${L.population} died</span></div>` : ''}
      <dl>${L?.block ? `<dt>On chain</dt><dd>Block <a class="ds-link" href="https://robinhoodchain.blockscout.com/block/${L.block.number}" target="_blank" rel="noopener">${L.block.number.toLocaleString()}</a> · ${L.block.hash.slice(0, 10)}…</dd>` : ''}
      <dt>Next draw</dt><dd id="wlClock">—</dd>
      <dt>Last 24 h</dt><dd>${day.length} rounds · ${dd} died · ${dm} mutants</dd>
      <dt>Meadow</dt><dd>${st.alive} alive · ${st.lineages} lineages · generation ${st.maxGen + 1}</dd>
      ${L ? `<dt>Dominant</dt><dd>${esc(L.dominant.name)}</dd>` : ''}</dl>
      <div class="ds-btns lp-wl__btns"><a class="ds-btn ds-btn--sig" href="/app">Watch the meadow<i class="arr"></i></a><button class="ds-btn" data-h>Hatch your lineage</button><a class="ds-btn" href="/market">Paper exchange</a></div>`;
    if (wlHtml !== lastWl) { lastWl = wlHtml; $('#wardLive').innerHTML = wlHtml; $('[data-h]').onclick = openSummon; } // rebuilt only when a figure changed, so nothing recounts for nothing
    if (key !== lastKey) {
      $('#trials').innerHTML = tr.map((t, i) => `<div class="lp-trial ds-panel ds-panel--tight" data-draw="frame" style="--i:${i}"><div class="ds-label ds-label--bare">${Object.keys(t.w).join(' · ')}</div><b>${esc(t.name)}</b><p>${esc(t.what)}</p><div class="lp-trial__n"><span class="ds-num ds-num--lg ds-num--die" data-count="${t.killed}">${t.killed}</span><small>killed in ${t.rounds} rounds</small></div>${t.deadliestFor ? `<div class="ds-label ds-label--die">Deadliest for ${esc(t.deadliestFor.name)}</div>` : ''}</div>`).join('');
      $('#rec').innerHTML = rs.slice(0, 8).map((r, i) => `<a class="ds-row lp-rrow" href="/r/${r.n}" data-draw style="--i:${i}"><span class="ds-label ds-label--bare">Round ${r.n}<br>${new Date(r.at).toISOString().slice(11, 16)} UTC</span><b>${esc(r.trialName)}</b><span><i class="d">${r.died} died</i> · ${r.born} born · ${r.mutations} mutants</span><span class="lp-rrow__dom">${esc(r.dominant.name)} dominates</span><span class="ds-meter ds-meter--split ds-meter--thin"><i style="--v:${(1 - r.died / Math.max(1, r.population)).toFixed(3)}"></i></span></a>`).join('') || '<p class="ds-fine">No rounds yet.</p>';
    }
    lastKey = key;
    // stat bar
    const top = [...mk.markets].sort((a, z) => z.change24 - a.change24)[0];
    $('#sbTop').textContent = top ? top.name : '—'; $('#sbTopC').textContent = top ? `${top.price.toFixed(3)} · ${top.change24 >= 0 ? '+' : ''}${(top.change24 * 100).toFixed(1)}% 24h · paper` : '';
    const sa = $('#sbAlive'); if (sa.dataset.v !== String(st.alive)) { sa.dataset.v = st.alive; sa.textContent = '0'; count(sa, st.alive); }
    $('#sbLin').textContent = `${st.lineages} lineages`;
    if (L) {
      const sd = $('#sbDied'); sd.style.setProperty('--v', (L.died / Math.max(1, L.population)).toFixed(3));
      if (sd.dataset.v !== String(L.died)) { sd.dataset.v = L.died; sd.textContent = '0'; count(sd, L.died); }
      const k = Math.round((L.died / L.population) * 20);
      $('#sbXs').innerHTML = Array.from({ length: 20 }, (_, i) => (i < k ? '<i class="x"></i>' : '<i></i>')).sort(() => Math.random() - 0.5).join('');
    }
  }

  // ---------------------------------------------------------------- the dead: a slow band under the hero, the fallen of the latest round in the ward
  const lnk = (w) => '/l/' + esc(String(w || ''));
  const logoOf = (d) => esc(d.logo || modelLogo(d.model) || '');
  const img = (d, cls = '') => (logoOf(d) ? `<img class="${cls}" src="${logoOf(d)}" alt="" loading="lazy" onerror="this.remove()">` : '');
  let deadKey = '', memKey = '';
  async function loadDead() {
    const [dead, toll] = await Promise.all([api('/api/dead?limit=80').catch(() => null), api('/api/toll').catch(() => null)]);
    const band = $('#culled'), mem = $('#memoriam'), okT = toll && typeof toll.dead === 'number';
    const D = Array.isArray(dead) ? dead.filter((d) => d && d.nick) : [];
    if (band) {
      if (!D.length) band.hidden = true;
      else {
        const key = D[0].id + ':' + D.length + ':' + (okT ? toll.dead : '');
        if (key !== deadKey) { // rebuild only when someone new has died, so the scroll never jumps
          deadKey = key;
          const items = D.slice(0, 40).map((d) => `<a href="${lnk(d.wallet)}" title="${esc(d.epitaph || '')}"><i class="ds-mark ds-mark--dead"></i>${img(d)}<s>${esc(d.nick)}</s><span>${esc(d.causeName || d.cause || '')}${d.rdied != null ? ` · round ${esc(d.rdied)}` : ''}</span></a>`).join('');
          $('#culledTrack').innerHTML = `<div class="grp">${items}</div><div class="grp" aria-hidden="true">${items}</div>`;
          $('#culledTrack').style.setProperty('--dur', Math.max(40, Math.min(40, D.length) * 4.5) + 's');
          $('#culledToll').textContent = okT ? `${toll.dead.toLocaleString()} removed${typeof toll.rounds === 'number' ? ` · ${toll.rounds.toLocaleString()} rounds` : ''}` : '';
          band.hidden = false;
        }
      }
    }
    if (mem) {
      const n = D.length ? D[0].rdied : null, F = n == null ? [] : D.filter((d) => d.rdied === n);
      if (!F.length) { mem.hidden = true; return; }
      const R = allRounds.find((r) => r.n === n), total = R ? R.died : F.length, show = F.slice(0, 10), o = toll && toll.oldest;
      const key = n + ':' + F.length + ':' + (okT ? toll.dead : ''); if (key === memKey) return; memKey = key;
      const led = okT ? [['born', 'born', 'sig'], ['dead', 'dead', 'die'], ['extinct', 'lineages extinct', 'mut'], ['mutants', 'mutants', 'mut']].filter(([k]) => typeof toll[k] === 'number').map(([k, l, c], i) => `<span class="ds-stat"><b class="ds-num ds-num--md ds-num--${c}" data-count="${toll[k]}" style="--i:${i}">${toll[k].toLocaleString()}</b><span class="ds-label ds-label--bare">${l}</span></span>`).join('') : '';
      mem.innerHTML = `<div class="mem-head"><div><div class="ds-label ds-label--die ds-label--cr">In memoriam</div><h3 class="ds-h3" data-draw="text">Round ${esc(n)}${R ? ` · ${esc(R.trialName)}` : ''}</h3></div><p class="ds-body">${total} did not pass. ${total > show.length ? `<a href="/r/${esc(n)}">All of them are on the round card →</a>` : ''}</p></div>
      <div class="mem-list">${show.map((d, i) => `<a class="mem-row" href="${lnk(d.wallet)}" data-draw style="--i:${i}"><img class="sp" src="${spr('dead')}" alt=""><div><b><s>${esc(d.nick)}</s></b><span class="ds-label ds-label--bare">${img(d)}${esc(d.modelName || '')}${d.causeName ? ` · ${esc(d.causeName)}` : ''}</span>${d.epitaph ? `<p>${esc(d.epitaph)}</p>` : ''}</div></a>`).join('')}</div>
      ${o && o.nick ? `<p class="mem-oldest"><span class="ds-label ds-label--sig ds-label--cr">Oldest living</span><b>${esc(o.nick)}</b> ${esc(o.modelName || '')}${typeof o.survived === 'number' ? ` · ${o.survived} round${o.survived === 1 ? '' : 's'} survived` : ''}. Still counted.</p>` : ''}
      ${led ? `<div class="mem-ledger"><span class="ds-label">Ledger</span><div class="ds-stats">${led}</div></div>` : ''}`;
      mem.hidden = false;
    }
  }

  // ---------------------------------------------------------------- kill-zone belt: one block per living creature, best to worst, from /api/standing (an indication, not the final score)
  const belt = $('#belt'), beltBox = $('#beltBlocks'), beltTip = $('#beltTip'), beltEls = new Map();
  const noMotion = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  const RAMP = [[92, 242, 168], [255, 184, 31], [255, 63, 142]]; // cold (safe) to hot (about to die)
  const ramp = (k) => { k = Math.max(0, Math.min(1, k)) * 2; const i = k >= 1 ? 1 : 0, f = k - i, a = RAMP[i], b = RAMP[i + 1]; return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`; };
  let beltOk = false;
  function drawBelt(S) {
    if (!belt) return;
    S = Array.isArray(S) ? S.filter((c) => c && c.id != null) : [];
    if (!S.length) { belt.hidden = true; beltOk = false; return; }
    if (S.every((c) => typeof c.rank === 'number')) S = [...S].sort((a, z) => a.rank - z.rank);
    const n = S.length, vals = S.map((c) => c.standing).filter((v) => typeof v === 'number' && isFinite(v));
    const hi = Math.max(...vals), lo = Math.min(...vals), byScore = vals.length === n && hi > lo;
    const flagged = S.some((c) => typeof c.inKillZone === 'boolean'), kz = flagged ? S.filter((c) => c.inKillZone).length : null;
    const r0 = belt.getBoundingClientRect(), flip = beltOk && !noMotion && r0.bottom > 0 && r0.top < innerHeight;
    const before = new Map(); if (flip) for (const [id, a] of beltEls) before.set(id, a.getBoundingClientRect().left);
    const keep = new Set(), frag = document.createDocumentFragment();
    S.forEach((c, i) => {
      const id = String(c.id); keep.add(id);
      let a = beltEls.get(id);
      if (!a) { a = document.createElement('a'); a.href = '/app?b=' + encodeURIComponent(id); a.tabIndex = -1; a.dataset.id = id; beltEls.set(id, a); if (beltOk && !noMotion) a.className = 'new'; }
      a.style.setProperty('--c', ramp(byScore ? (hi - c.standing) / (hi - lo) : n > 1 ? i / (n - 1) : 0));
      a.classList.toggle('kz', flagged ? !!c.inKillZone : false);
      a.dataset.nick = c.nick || ''; a.dataset.model = (MM && MM[c.model] && MM[c.model].name) || c.model || '';
      a.dataset.rank = i + 1; a.setAttribute('aria-label', `${c.nick || 'Creature ' + id}, ${a.dataset.model}, rank ${i + 1} of ${n}`);
      frag.appendChild(a);
    });
    for (const [id, a] of beltEls) if (!keep.has(id)) { a.remove(); beltEls.delete(id); }
    beltBox.appendChild(frag); belt.dataset.n = n;
    const z = $('#beltZone');
    if (kz) { z.style.left = ((n - kz) / n) * 100 + '%'; z.hidden = false; } else z.hidden = true;
    $('#beltN').textContent = `${n} alive${kz != null ? ` · ${kz} in the kill zone` : ''}`;
    belt.hidden = false;
    if (flip) {
      const moved = [];
      for (const [id, a] of beltEls) { const x = before.get(id); if (x == null) continue; const dx = x - a.getBoundingClientRect().left; if (Math.abs(dx) > 0.5) { a.style.transition = 'none'; a.style.transform = `translateX(${dx}px)`; moved.push(a); } }
      if (moved.length) { void beltBox.offsetWidth; requestAnimationFrame(() => moved.forEach((a) => { a.style.transition = ''; a.style.transform = ''; })); }
    }
    beltOk = true;
  }
  if (belt) {
    const tipFor = (a) => {
      if (!a) { beltTip.hidden = true; return; }
      beltTip.innerHTML = `<b>${esc(a.dataset.nick || '#' + a.dataset.id)}</b><span>${esc(a.dataset.model)}</span><i>${esc(a.dataset.rank)} of ${esc(belt.dataset.n)}${a.classList.contains('kz') ? ' · kill zone' : ''}</i>`;
      beltTip.hidden = false;
      const br = beltBox.getBoundingClientRect(), ar = a.getBoundingClientRect(), w = beltTip.offsetWidth;
      beltTip.style.left = Math.max(0, Math.min(br.width - w, ar.left - br.left + ar.width / 2 - w / 2)) + 'px';
    };
    beltBox.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') tipFor(e.target.closest('a')); });
    beltBox.addEventListener('pointerleave', () => tipFor(null));
    window.wlFeed.on('standing', drawBelt);
  }

  // ---------------------------------------------------------------- hire band: the latest signed receipts (if any) and today's count
  async function loadHires() {
    const log = $('#hireLog'); if (!log) return;
    const h = await api('/api/hires?limit=3').catch(() => null); if (!h) return;
    const n = h.budget && typeof h.budget.hiresToday === 'number' ? h.budget.hiresToday : null;
    $('#hireN').textContent = n != null ? `${n} hire${n === 1 ? '' : 's'} started today` : '';
    const list = Array.isArray(h.hires) ? h.hires.filter((x) => x && x.task) : [];
    log.innerHTML = `<div class="ds-panel__hd"><span class="ds-label">Latest signed receipts</span></div>` + (list.length ? list.map((x, i) => `<a class="ds-row lp-hrow" href="/hire" data-draw style="--i:${i}"><span class="ds-label ds-label--cr ds-label--sig">${esc(x.nick || 'Creature ' + x.creatureId)}${x.brain ? ` · <i>${esc(x.brain)}</i>` : ''}</span><b>${esc(x.task.length > 120 ? x.task.slice(0, 118) + '…' : x.task)}</b><span class="ds-fine">${x.tools && x.tools.length ? `${x.tools.length} tool call${x.tools.length === 1 ? '' : 's'} · ` : ''}receipt ${esc(String(x.receiptHash || '').slice(0, 12))}…</span></a>`).join('')
      : `<div class="lp-hsteps">${[['01', 'Pick a living creature', 'Its open model stays its brain in the game; its name and line go on the receipt.'], ['02', 'Claude does the work, in the open', 'Every step streams as it happens: the thinking, each tool call with its exact input, the answer.'], ['03', 'A signed receipt', 'Our server signs the run; your own browser checks the signature.']].map(([n, b, t], i) => `<div class="ds-row" data-draw style="--i:${i}"><span class="ds-num ds-num--sm ds-num--sig ds-num--plain">${n}</span><div><b>${b}</b><p class="ds-fine">${t}</p></div></div>`).join('')}</div><p class="ds-fine lp-hire__none">No public receipt yet today. The first hire run shows here, with every step it took.</p>`);
  }

  const safeDead = () => loadDead().catch(() => {});
  let allRounds = [];
  load().catch(() => {}).then(safeDead); setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 30000); setInterval(() => { if (!document.hidden) safeDead(); }, 60000);
  loadHires().catch(() => {}); setInterval(() => { if (!document.hidden) loadHires().catch(() => {}); }, 60000);
  document.addEventListener('round', () => setTimeout(() => { lastKey = ''; load().catch(() => {}).then(safeDead); window.wlFeed.poll('standing'); }, 2500));
  setInterval(() => {
    if (!ROUND) return; const left = ROUND.next - (Date.now() + skew), l = fmtLeft(left);
    $('#sbClock').textContent = l; $('#sbTrial').textContent = `Round ${ROUND.n + 1} · ${ROUND.upcoming.name}`;
    const w = $('#wlClock'); if (w) w.textContent = `${ROUND.upcoming.name} in ${l}`;
    $('#sbClock').style.setProperty('--v', Math.max(0, Math.min(1, left / 3600000)).toFixed(3));
  }, 1000);
})();

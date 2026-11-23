// Shared: logo, config links, sound, summon modal, draggable windows, agent card rendering.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const short = (w) => (w.startsWith('resident:') ? w.slice(9).toUpperCase() : w.slice(0, 6) + '…' + w.slice(-4));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const api = (p, o) => fetch(p, o).then((r) => r.json());
const EXPL = 'https://robinhoodchain.blockscout.com/address/';

// pixel mark (11x9): a small creature with neuron antennae
const BIRD = ['.X.......X.', '..X.....X..', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.XXXXXXXXX.', '.XXXX.XXXX.', '..XXXXXXX..', '...X...X...'];
function birdSvg(el, color = '#fff') { el.innerHTML = BIRD.flatMap((row, y) => [...row].map((c, x) => (c === 'X' ? `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${color}"/>` : ''))).join(''); }
$$('#logoSvg').forEach((e) => birdSvg(e));

let CFG = {};
api('/api/config').then((c) => {
  CFG = c;
  $$('[data-pons]').forEach((a) => { if (c.ponsUrl) { a.href = c.ponsUrl; a.target = '_blank'; } else { a.href = '#docs'; a.title = 'Token not launched yet'; } });
  $$('[data-x]').forEach((a) => { if (c.xUrl) { a.href = c.xUrl; a.target = '_blank'; } else a.style.display = 'none'; });
});

// dropdown
const dd = $('#dd');
if (dd) { dd.querySelector('button').onclick = (e) => { e.stopPropagation(); dd.classList.toggle('open'); }; document.addEventListener('click', () => dd.classList.remove('open')); }

// ambient sound (generated with WebAudio only, off until the visitor clicks #sound; choice remembered)
let actx = null, master = null, sndOn = false;
const SND_VOL = 0.14;
function soundOn() {
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const t0 = actx.currentTime;
  master = actx.createGain(); master.gain.value = 0; master.connect(actx.destination);
  master.gain.linearRampToValueAtTime(SND_VOL, t0 + 2.5); sndOn = true;
  // low drone: detuned partials through a slowly breathing lowpass
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.7; lp.connect(master);
  const lf = actx.createOscillator(), lfg = actx.createGain(); lf.frequency.value = 0.021; lfg.gain.value = 180; lf.connect(lfg); lfg.connect(lp.frequency); lf.start();
  [[41.2, 'sine', 0.3], [55, 'sine', 0.2], [55.4, 'triangle', 0.1], [82.4, 'triangle', 0.07], [110.3, 'sine', 0.05], [164.8, 'sine', 0.025], [233.1, 'sine', 0.012]].forEach(([f, type, v], i) => {
    const o = actx.createOscillator(); o.type = type; o.frequency.value = f; const g = actx.createGain(); g.gain.value = v;
    const l = actx.createOscillator(), lg = actx.createGain(); l.frequency.value = 0.031 + i * 0.017; lg.gain.value = v * 0.45; l.connect(lg); lg.connect(g.gain);
    o.connect(g); g.connect(lp); o.start(); l.start();
  });
  // "air": looped noise through a wandering bandpass
  const nb = actx.createBuffer(1, actx.sampleRate * 4, actx.sampleRate), nd = nb.getChannelData(0);
  let last = 0; for (let i = 0; i < nd.length; i++) { last = last * 0.86 + (Math.random() * 2 - 1) * 0.14; nd[i] = last * 3; }
  window.__wlNoise = nb;
  const ns = actx.createBufferSource(); ns.buffer = nb; ns.loop = true;
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
  const al = actx.createOscillator(), alg = actx.createGain(); al.frequency.value = 0.043; alg.gain.value = 520; al.connect(alg); alg.connect(bp.frequency); al.start();
  const ag = actx.createGain(); ag.gain.value = 0.11; const agl = actx.createOscillator(), aglg = actx.createGain(); agl.frequency.value = 0.067; aglg.gain.value = 0.05; agl.connect(aglg); aglg.connect(ag.gain); agl.start();
  ns.connect(bp); bp.connect(ag); ag.connect(master); ns.start();
  sndBeat();
}
// soft heartbeat: 60 bpm far from the trial, rising to 130 bpm in the last minute (time left read from fx.js)
function sndThump(t, f, v) { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.16); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.26); }
function sndBpm() { let ms = null; try { ms = window.wlRemain ? window.wlRemain() : null; } catch {} if (ms == null || ms > 1800000) return 60; if (ms <= 60000) return 130; return 60 + 50 * (1 - (ms - 60000) / 1740000); }
function sndBeat() {
  if (!actx) return;
  const bpm = sndBpm(), gap = 60 / bpm;
  if (sndOn && actx.state === 'running' && !document.hidden) { const t = actx.currentTime + 0.03, v = 0.3 + (bpm - 60) / 70 * 0.35; sndThump(t, 62, v); sndThump(t + Math.min(0.22, gap * 0.3), 50, v * 0.6); }
  setTimeout(sndBeat, gap * 1000);
}
// the cull: a reversed swell that lands on a low impact after `lead` seconds
window.wlAudio = {
  cull(lead = 2) {
    if (!actx || !sndOn || actx.state !== 'running') return;
    lead = Math.max(0.3, Math.min(4, lead)); const t = actx.currentTime, z = t + lead;
    const sw = actx.createBufferSource(); sw.buffer = window.__wlNoise; const sf = actx.createBiquadFilter(); sf.type = 'bandpass'; sf.Q.value = 1.2; sf.frequency.setValueAtTime(240, t); sf.frequency.exponentialRampToValueAtTime(2600, z);
    const sg = actx.createGain(); sg.gain.setValueAtTime(0.0001, t); sg.gain.exponentialRampToValueAtTime(0.9, z); sg.gain.setValueAtTime(0.0001, z + 0.02);
    sw.connect(sf); sf.connect(sg); sg.connect(master); sw.start(t); sw.stop(z + 0.05);
    const so = actx.createOscillator(), sog = actx.createGain(); so.type = 'sawtooth'; so.frequency.setValueAtTime(55, t); so.frequency.exponentialRampToValueAtTime(110, z); const sol = actx.createBiquadFilter(); sol.type = 'lowpass'; sol.frequency.value = 500;
    sog.gain.setValueAtTime(0.0001, t); sog.gain.exponentialRampToValueAtTime(0.35, z); sog.gain.setValueAtTime(0.0001, z + 0.02); so.connect(sol); sol.connect(sog); sog.connect(master); so.start(t); so.stop(z + 0.05);
    const io = actx.createOscillator(), ig = actx.createGain(); io.type = 'sine'; io.frequency.setValueAtTime(95, z); io.frequency.exponentialRampToValueAtTime(27, z + 1.4);
    ig.gain.setValueAtTime(0.0001, z); ig.gain.exponentialRampToValueAtTime(1.6, z + 0.015); ig.gain.exponentialRampToValueAtTime(0.0001, z + 3.2); io.connect(ig); ig.connect(master); io.start(z); io.stop(z + 3.3);
    const ib = actx.createBufferSource(); ib.buffer = window.__wlNoise; const il = actx.createBiquadFilter(); il.type = 'lowpass'; il.frequency.setValueAtTime(900, z); il.frequency.exponentialRampToValueAtTime(60, z + 1.8);
    const ibg = actx.createGain(); ibg.gain.setValueAtTime(1.1, z); ibg.gain.exponentialRampToValueAtTime(0.0001, z + 2.2); ib.connect(il); il.connect(ibg); ibg.connect(master); ib.start(z); ib.stop(z + 2.3);
  },
};
window.blip = (f = 880) => { if (!actx || !master || !sndOn) return; const o = actx.createOscillator(), g = actx.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.value = 0.04; g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.12); o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.13); };
const sb = $('#sound');
const sndIcon = () => { const w = $('#sw'); if (w) w.style.opacity = sndOn ? 1 : 0.35; if (sb) { sb.classList.toggle('on', sndOn); sb.setAttribute('aria-pressed', sndOn ? 'true' : 'false'); } };
const sndSave = () => { try { localStorage.setItem('wlSound', sndOn ? '1' : '0'); } catch {} };
function sndToggle() {
  try {
    if (!actx) soundOn();
    else { sndOn = !sndOn; if (actx.state === 'suspended') actx.resume(); master.gain.cancelScheduledValues(actx.currentTime); master.gain.setValueAtTime(master.gain.value, actx.currentTime); master.gain.linearRampToValueAtTime(sndOn ? SND_VOL : 0, actx.currentTime + 0.6); }
  } catch {}
  sndIcon(); sndSave();
}
if (sb) {
  sb.onclick = sndToggle; sb.setAttribute('aria-pressed', 'false');
  // the visitor turned sound on earlier: resume on their first gesture here (browsers need one), only where the toggle exists
  let want = false; try { want = localStorage.getItem('wlSound') === '1'; } catch {}
  if (want) { const first = (e) => { removeEventListener('pointerdown', first, true); removeEventListener('keydown', first, true); if (!actx && !(e.target && e.target.closest && e.target.closest('#sound'))) { try { soundOn(); } catch {} sndIcon(); } }; addEventListener('pointerdown', first, true); addEventListener('keydown', first, true); }
}

// draggable windows
function makeWindows(root) {
  $$('.win', root).forEach((w) => {
    const bar = $('.bar', w);
    let sx, sy, ox, oy;
    const focus = () => { $$('.win', root).forEach((x) => x.classList.remove('focus')); w.classList.add('focus'); };
    w.addEventListener('pointerdown', focus);
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      sx = e.clientX; sy = e.clientY; ox = w.offsetLeft; oy = w.offsetTop; w.style.right = 'auto';
      const mv = (e) => { w.style.left = Math.max(-w.offsetWidth + 80, Math.min(root.clientWidth - 80, ox + e.clientX - sx)) + 'px'; w.style.top = Math.max(0, Math.min(root.clientHeight - 40, oy + e.clientY - sy)) + 'px'; };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    bar.addEventListener('dblclick', () => w.classList.toggle('max'));
    $('[data-max]', w)?.addEventListener('click', () => w.classList.toggle('max'));
    $('[data-min]', w)?.addEventListener('click', () => { const b = $('.body', w); const hid = b.style.display === 'none'; b.style.display = hid ? '' : 'none'; w.dataset.h = w.dataset.h || w.style.height; w.style.height = hid ? w.dataset.h : 'auto'; });
  });
}

// summon modal
const modal = $('#modal');
function openSummon() { modal.classList.add('on'); $('#err').textContent = ''; setTimeout(() => $('#addr').focus(), 50); }
// the shared nav's Hatch buttons: any [data-hatch] a page has not wired itself opens the modal
document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-hatch]'); if (b && !b.onclick && modal) { e.preventDefault(); openSummon(); } });
async function summon(addr) {
  $('#err').style.color = '#999'; $('#err').textContent = 'Hatching your lineage…';
  const r = await api('/api/hatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr.trim() }) });
  if (r.error) { $('#err').style.color = ''; $('#err').textContent = r.error; return; }
  location.href = '/l/' + r.wallet;
}
if (modal) {
  $('[data-close]', modal).onclick = () => modal.classList.remove('on');
  modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('on'); };
  $('#go').onclick = () => summon($('#addr').value);
  $('#addr').onkeydown = (e) => e.key === 'Enter' && summon($('#addr').value);
  $('#conn').onclick = async () => {
    if (!window.ethereum) { $('#err').textContent = 'No browser wallet found. Paste your address instead.'; return; }
    try { const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' }); $('#addr').value = a; summon(a); } catch { $('#err').textContent = 'Connection refused.'; }
  };
}

// agent card
const eth = (x, d = 4) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(Math.abs(x) < 0.001 ? 6 : d) + ' ETH');
const hms = (t) => new Date(t).toTimeString().slice(0, 8);
function agentCard(a) {
  const m = a.metrics, p = a.profile;
  const st = a.status === 'ready' ? ['PROFILE READY', 'ready'] : a.status === 'analyzing' ? ['READING HISTORY', 'an'] : ['QUEUED FOR ANALYSIS', 'q'];
  const pnl = m ? m.realizedEth : null;
  return `<div class="card" data-w="${a.wallet}"><div class="top"><span>${hms(a.updated)}</span><span class="st ${st[1]}">${st[0]}</span></div>
  <div class="who">${p ? esc(p.name) : short(a.wallet)} <small><a href="${EXPL}${a.wallet}" target="_blank">${short(a.wallet)} ↗</a></small> ${a.holder ? '<span class="chip h">HOLDER</span>' : ''}</div>
  ${p ? `<div class="arch">${esc(p.archetype)}</div><p>${esc(p.summary)}</p>` : `<div class="arch" style="color:#888">Awaiting analysis</div><p>Queued for wallet history and AI analysis.</p>`}
  ${m ? `<div class="pnl">Realized PnL · FIFO estimate<br><b class="${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${pnl == null ? 'Insufficient cost basis' : eth(pnl)}</b><br>${m.matchedSales} matched sales · ${m.swaps}-trade window · ${m.stockTransfers} stock transfers</div>` : ''}
  <div class="meta"><span>${m ? m.swaps + ' Pons trades in window' : ''}</span><span>${p ? p.confidence + '% confidence' : ''}${a.calls ? ` · ${a.hits}/${a.calls} calls right` : ''}</span></div></div>`;
}

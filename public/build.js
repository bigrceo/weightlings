// /build: write a job, connect a wallet, sign it (personal_sign), the server checks the signature and founds the lineage,
// then the founder hatches here with its brain and its job. Talks to: GET /api/build/nonce, POST /api/build, GET /api/build/:w, GET /api/genes.
(function () {
  const q = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim(); // same as server/build.mjs
  const TC = { legendary: '#ffb81f', epic: '#b056ff', rare: '#2a7bff', uncommon: '#2fc46b', common: '#c9ccd4' };
  // the same creature as public/ward.js ROWS
  const ROWS = ['.A.......A.', '..A.....A..', '...KKKKK...', '..KKSKSKK..', '.KKWPKWPKK.', '.KKKKKKKKK.', '.KKKKMKKKK.', '..KKKKKKK..', '...L...L...'];
  const EGG = ['...........', '....EEE....', '...EEEEE...', '..EEDEEEE..', '..EEEEEDE..', '..EDEEEEE..', '..EEEEEEE..', '...EEEEE...', '...........'];
  const EX = [
    ['Contract auditor', 'Reads token contracts on Robinhood Chain and flags anything that could trap a buyer.'],
    ['Wallet explainer', 'Explains what a wallet has been doing on chain, in plain words, for someone new to crypto.'],
    ['Launch copywriter', 'Writes short, honest launch posts for small token projects, with no hype and no promises.'],
    ['Stock token analyst', 'Compares Robinhood Chain stock tokens with their real shares and explains any gap in price.'],
  ];
  const job = q('#job'), title = q('#title'), go = q('#go'), step = q('#step'), err = q('#berr');
  let acct = null, busy = false;

  q('#ex').innerHTML = EX.map(([t], i) => `<button type="button" data-i="${i}">${esc(t)}</button>`).join('');
  q('#ex').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const [t, j] = EX[b.dataset.i]; job.value = j; title.value = t; count(); job.focus(); };
  const count = () => { q('#jLen').textContent = `${job.value.length} / 160`; };
  job.addEventListener('input', count);
  job.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); q('#form').requestSubmit(); } });
  const label = () => { go.innerHTML = (acct ? 'Sign and hatch' : 'Connect wallet') + '<i class="arr"></i>'; };

  async function connect() {
    if (!window.ethereum) throw new Error('No browser wallet found. Open this page in a browser with a wallet such as MetaMask or Rabby.');
    const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!a) throw new Error('No account was shared.');
    acct = a.toLowerCase(); label();
    step.textContent = `Connected ${acct.slice(0, 6)}…${acct.slice(-4)}. Your wallet signs a plain message with the job in it. No transaction, no gas.`;
    const r = await fetch('/api/build/' + acct, { cache: 'no-store' }).catch(() => null);
    if (r && r.ok) { const b = await r.json(); if (!job.value.trim()) { job.value = b.job; title.value = b.title || ''; count(); } step.textContent += b.editableAt > Date.now() ? ` Your lineage already has a job; it can change again at ${new Date(b.editableAt).toISOString().slice(11, 16)} UTC.` : ' Your lineage already has a job; signing replaces it.'; }
  }
  const hex = (s) => '0x' + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

  q('#form').onsubmit = async (e) => {
    e.preventDefault(); if (busy) return; err.textContent = '';
    const j = clean(job.value), t = clean(title.value);
    if (j.length < 8) { err.textContent = 'Describe the job in one sentence.'; job.focus(); return; }
    busy = true; go.disabled = true;
    try {
      if (!acct) { await connect(); busy = false; go.disabled = false; return; } // first press connects, second press signs
      const n = await fetch('/api/build/nonce?wallet=' + acct, { cache: 'no-store' }).then((r) => r.json());
      if (!n.nonce) throw new Error(n.error || 'The server did not answer.');
      const msg = `Weightlings: set the job of my lineage to "${j}" (nonce ${n.nonce})`;
      step.textContent = 'Check your wallet: it shows the message to sign.';
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex(msg), acct] });
      step.textContent = 'Checking the signature…';
      const r = await fetch('/api/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: acct, job: j, name: t, nonce: n.nonce, signature }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'The build failed.');
      step.textContent = 'Signed and saved. Only this wallet could have set it.';
      reveal(d);
    } catch (x) { err.textContent = x && x.code === 4001 ? 'You declined in your wallet. Nothing was saved.' : (x && x.message) || 'Something went wrong.'; }
    busy = false; go.disabled = false;
  };

  function paint(rows, col) {
    const g = q('#cr').getContext('2d'); g.clearRect(0, 0, 11, 9);
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (col[ch]) { g.fillStyle = col[ch]; g.fillRect(x, y, 1, 1); } }));
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms));
  async function reveal(d) {
    const c = d.creature, sec = q('#reveal'), cv = q('#cr');
    sec.hidden = false; [...q('.bd-card').children].forEach((x) => x.classList.remove('on'));
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!c) { q('#rvK').textContent = 'Saved'; q('#rvNick').textContent = 'No living creature in this lineage'; q('#rvNick').classList.add('on'); q('#rvJob').innerHTML = `<span class="ds-label ds-label--sig">${esc(d.title || 'Job')}</span>${esc(d.job)}`; q('#rvJob').classList.add('on'); return; }
    const col = TC[c.tier] || TC.common;
    q('#rvK').textContent = 'Hatching'; cv.className = 'egg'; paint(EGG, { E: '#e6eee8', D: col });
    let logo = c.logo;
    try { const g = await fetch('/api/genes').then((r) => r.json()); const m = (Array.isArray(g) ? g : g.models || []).find((x) => x.id === c.model); if (m && m.logo) logo = m.logo; } catch {}
    await wait(1400);
    cv.className = 'born'; paint(ROWS, { A: '#e6eee8', K: col, S: '#ffffffaa', W: '#fff', P: '#020403', M: '#020403', L: '#3e4842' });
    q('#rvK').textContent = c.gen === 0 ? 'Your founder hatched' : 'Your lineage, alive';
    q('#rvNick').textContent = c.nick; await wait(500); q('#rvNick').classList.add('on');
    const b = q('#rvBrain'); b.style.setProperty('--tc', col);
    b.innerHTML = `${logo ? `<img src="${esc(logo)}" alt="" width="28" height="28">` : ''}<span>${esc(c.modelName)}</span><span class="ds-label ds-label--cr">${esc(c.tierName)} ${'★'.repeat(c.stars || 1)}</span>`;
    await wait(700); b.classList.add('on');
    q('#rvJob').innerHTML = `<span class="ds-label ds-label--sig">${esc(d.title || 'Its job')}</span>${esc(d.job)}`;
    await wait(700); q('#rvJob').classList.add('on');
    const text = `I built ${c.nick} on Weightlings: ${d.title ? `a ${d.title} ` : 'an agent '}with a ${c.modelName} brain (${c.tierName}). Its job: ${d.job}`;
    const url = `${location.origin}/app?b=${c.id}`;
    q('#rvAct').innerHTML = `<a class="ds-btn ds-btn--sig" href="/app?b=${c.id}">See it in the meadow<i class="arr"></i></a><a class="ds-btn" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}">Share</a><a class="ds-btn ds-btn--sm" href="/hire?c=${c.id}">Hire it</a>`;
    q('#rvNote').textContent = `${c.hires ? `Hired ${c.hires} time${c.hires === 1 ? '' : 's'} so far. ` : ''}It must still survive the hourly trial like every creature: the job does not change its traits.`;
    await wait(400); q('#rvAct').classList.add('on'); q('#rvNote').classList.add('on');
  }
  window.__buildReveal = reveal; // used by the page test to show the sequence without a wallet
  label(); count();
})();

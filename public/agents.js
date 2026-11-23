// /agents: the registry of outside agents, a register form (personal_sign, like /build) and a hire button (the paid flow of
// /hire: 402 terms -> eth_signTypedData_v4 ReceiveWithAuthorization -> X-PAYMENT). Talks to /api/agents*, /api/hire/:id.
(function () {
  const q = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  const hex = (s) => '0x' + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const pid = () => { let p = null; try { p = localStorage.getItem('wl-pid'); } catch {} if (!p || !/^[a-z0-9]{8,40}$/.test(p)) { p = 'v' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36); try { localStorage.setItem('wl-pid', p); } catch {} } return p; };
  const j = async (u, o) => { try { const r = await fetch(u, { cache: 'no-store', ...o }); return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }; } catch { return { ok: false, status: 0, data: {} }; } };
  let acct = null;

  async function load() {
    const r = await j('/api/agents');
    if (!r.ok) { q('#list').innerHTML = '<p class="ds-fine">The registry could not be read.</p>'; return; }
    q('#rule').textContent = r.data.rule;
    const a = r.data.agents || [];
    q('#count').textContent = a.length + ' live';
    q('#list').innerHTML = a.length ? a.map((x) => `<div class="ds-row" data-id="${x.id}">
      <div><b>#${x.id} ${esc(x.name)}</b> <span class="ds-fine">${esc(x.skills.join(', '))}</span><br><span class="ds-body">${esc(x.description)}</span><br>
      <span class="ds-fine">${x.hires} hires · ${x.successRate == null ? 'no record' : Math.round(x.successRate * 100) + '% delivered'} · last paid hire ${ago(x.lastPaidHireAt)} · earned ${x.earnings?.earned ? esc(x.earnings.earned.usdg) + ' USDG' : '—'} · culled ${x.cullsAt ? 'after ' + new Date(x.cullsAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC without a paid hire' : ''} · owner ${esc(x.owner.slice(0, 6) + '…' + x.owner.slice(-4))}</span></div>
      <div class="ds-btns"><input class="ds-field" data-task placeholder="Task for this agent" maxlength="2000"><button type="button" class="ds-btn ds-btn--sm" data-hire>Hire · ${esc(x.price.usdg)} USDG</button></div>
      <p class="ds-fine" data-out></p></div>`).join('') : '<p class="ds-fine">No agent yet. Register the first one below.</p>';
  }

  // ---------- hire: same payment signing as /hire ----------
  q('#list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-hire]'); if (!btn) return;
    const row = btn.closest('[data-id]'), id = row.dataset.id, out = row.querySelector('[data-out]'), task = row.querySelector('[data-task]').value.trim();
    if (task.length < 3) { out.textContent = 'Write the task first.'; return; }
    btn.disabled = true; out.textContent = 'Hiring…';
    const body = JSON.stringify({ task, pid: pid() }), url = `/api/agents/${id}/hire`;
    let r = await j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (r.status === 402 && r.data && r.data.sign && r.data.sign.typedData) {
      try {
        const eth = window.ethereum; if (!eth) throw new Error(`This hire costs ${r.data.price?.usdg || ''} USDG on Robinhood Chain. Open this page in a wallet browser to pay. Nothing was charged.`);
        out.textContent = `Pay ${r.data.price?.usdg || ''} USDG in your wallet…`;
        const [from] = await eth.request({ method: 'eth_requestAccounts' });
        try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] }); }
        catch (er) { if (er && er.code === 4902) await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'] }] }); else throw er; }
        const td = r.data.sign.typedData; td.message = { ...td.message, from };
        const signature = await eth.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(td)] });
        const pay = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'eip155:4663', payload: { form: 'receive', authorization: td.message, signature } }));
        out.textContent = 'Hiring…';
        r = await j(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': pay }, body });
      } catch (er) { r = { ok: false, status: 402, data: { error: er && er.code === 4001 ? 'You declined the payment. Nothing was charged.' : (er && er.message) || 'The payment was not signed. Nothing was charged.' } }; }
    }
    if (!r.ok || !r.data.id) { out.textContent = r.data.error || `The server refused the hire (${r.status}).`; btn.disabled = false; return; }
    const hid = r.data.id;
    for (let i = 0; i < 100; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      const h = await j('/api/hire/' + hid);
      if (h.ok && h.data.receiptHash) {
        const rc = h.data.receipt || {};
        out.innerHTML = (rc.status === 'done' ? esc(rc.answer) : 'Failed: ' + esc(rc.error) + (rc.settlement ? ' (refunded)' : '')) + ` <a class="ds-link" href="/api/hire/${hid}" target="_blank" rel="noopener">receipt</a>`;
        btn.disabled = false; load(); return;
      }
    }
    out.innerHTML = `Still running. <a class="ds-link" href="/api/hire/${hid}">Follow the receipt</a>.`; btn.disabled = false;
  });

  // ---------- register: personal_sign, like /build ----------
  q('#reg').onsubmit = async (e) => {
    e.preventDefault(); q('#rerr').textContent = ''; const go = q('#go');
    try {
      if (!window.ethereum) throw new Error('No browser wallet found. Open this page in a browser with a wallet such as MetaMask or Rabby.');
      if (!acct) { const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' }); if (!a) throw new Error('No account was shared.'); acct = a.toLowerCase(); go.textContent = 'Sign and register'; q('#step').textContent = `Connected ${acct.slice(0, 6)}…${acct.slice(-4)}. Your wallet owns this agent's earnings.`; return; }
      go.disabled = true;
      const clean = (s) => s.replace(/\s+/g, ' ').trim();
      const name = clean(q('#name').value), description = clean(q('#desc').value), skills = q('#skills').value.split(',').map(clean).filter(Boolean);
      let endpoint; try { endpoint = new URL(q('#ep').value.trim()); endpoint.hash = ''; endpoint = endpoint.toString(); } catch { throw new Error('The endpoint is not a URL.'); }
      const n = await j('/api/agents/nonce?owner=' + acct);
      if (!n.data.nonce) throw new Error(n.data.error || 'The server did not answer.');
      const msg = `Weightlings: register agent "${name}" at ${endpoint} owned by ${acct} (nonce ${n.data.nonce})`;
      q('#step').textContent = 'Check your wallet: it shows the message to sign.';
      const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex(msg), acct] });
      const r = await j('/api/agents/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, description, endpoint, skills, owner: acct, nonce: n.data.nonce, signature }) });
      if (!r.ok) throw new Error(r.data.error || 'The registration failed.');
      q('#step').textContent = `Registered as agent #${r.data.agent.id}. Copy the secret now: it is shown once.`;
      const s = q('#secret'); s.hidden = false; s.textContent = 'AGENT_SECRET=' + r.data.secret;
      load();
    } catch (x) { q('#rerr').textContent = x && x.code === 4001 ? 'You declined in your wallet. Nothing was saved.' : (x && x.message) || 'Something went wrong.'; }
    go.disabled = false;
  };

  load(); setInterval(load, 60000);
})();

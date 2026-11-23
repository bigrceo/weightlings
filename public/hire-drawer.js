// The "Put it to work" block in the meadow drawer. Standalone (no dependency on common.js / cards.js). Exposes:
//   mountHire(slot, being) -> renders the hire box for one creature inside `slot` (safe to call again on every drawer re-render)
// `being` is the object served by GET /api/being/:id. Pressing Hire hands the task to /hire through this tab's sessionStorage
// (never through the URL, so a shared link can never start a paid run) and opens /hire?c=ID, which starts the hire and streams it.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const CSS = `.hire-d{margin-top:4px}
.hire-d p{color:#a6b2ab;font:400 13px/1.6 Inter,sans-serif;margin:0}
.hire-d p b{color:#e6eee8;font-weight:600}
.hire-d .hd-f{position:relative;margin-top:14px;background:repeating-linear-gradient(to bottom,rgba(140,255,200,.035) 0 1px,transparent 1px 3px),rgba(5,9,7,.9);box-shadow:inset 0 0 0 1px rgba(140,255,200,.12)}
.hire-d .hd-f::after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:#5cf2a8;transform:scaleX(0);transform-origin:0 50%;transition:transform 320ms cubic-bezier(.16,1,.3,1)}
.hire-d .hd-f:focus-within::after{transform:none}
.hire-d textarea{display:block;width:100%;box-sizing:border-box;min-height:72px;resize:vertical;background:none;border:0;border-radius:0;color:#e6eee8;font:400 14px/1.55 Inter,sans-serif;padding:12px 14px;outline:0}
.hire-d textarea::placeholder{color:#3e4842}
.hire-d .hd-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-top:14px}
.hire-d .hd-row a.hd-link{color:#a6b2ab;font:600 10px/1.6 Inter,sans-serif;letter-spacing:.16em;text-transform:uppercase;text-decoration:none;background:linear-gradient(90deg,currentColor 0 1px,transparent 1px) 0 100%/3px 1px repeat-x;padding-bottom:2px}
.hire-d .hd-row a.hd-link:hover{color:#5cf2a8}
.hire-d .hd-free{margin-top:12px;color:#6b7770;font:400 11.5px/1.55 Inter,sans-serif}
.hire-d .hd-dead{color:#ffb3d1}
.hire-d .hd-job{margin-bottom:10px;color:#e6eee8}
.hire-d .hd-job .ds-label{margin-right:6px}`;
  let styled = false;
  const jobs = new Map(); // lineage wallet -> its job from /build (null while unknown or none)
  const draft = new Map(); // creature id -> text typed, kept across the drawer's 15 s re-renders
  // the drawer rebuilds its whole HTML every 15 s, which drops the old textarea; remember whether the visitor was typing in it
  let typing = null; // { id, s, e } while the hire textarea has focus
  function mountHire(slot, a) {
    if (!slot || !a || a.id == null) return;
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    const id = Number(a.id), nick = a.nick || 'This creature', model = (a.modelCard && a.modelCard.name) || a.modelName || 'its open model';
    const alive = a.alive !== false && !a.died;
    slot.innerHTML = `<div class="lbl ds-label ds-label--rule ds-label--sig">Put it to work</div><div class="hire-d">${alive
      ? `${jobs.get(String(a.w || a.wallet || '').toLowerCase()) ? `<p class="hd-job"><span class="ds-label ds-label--sig">${esc(jobs.get(String(a.w || a.wallet).toLowerCase()).title || 'Job')}</span> ${esc(jobs.get(String(a.w || a.wallet).toLowerCase()).job)}</p>` : ''}<p>Give <b>${esc(nick)}</b> a real task: read a page, read Robinhood Chain, write something. Claude does the work through our API key; ${esc(model)} is its brain in the game.</p>
         <div class="hd-f"><textarea maxlength="2000" placeholder="What should ${esc(nick)} do?" aria-label="Task for ${esc(nick)}"></textarea></div>
         <div class="hd-row"><button class="ds-btn ds-btn--sig ds-btn--sm" type="button">Hire ${esc(nick)}<i class="arr"></i></button><a class="hd-link" href="/hire?c=${id}">Open the hire page</a></div>
         <p class="hd-free">Free at launch: the operator pays the model. Every hire streams live and ends with a signed receipt. A finished hire feeds the creature.</p>`
      : `<p class="hd-dead">${esc(nick)} is dead. Only living creatures can be hired.</p><div class="hd-row"><a class="hd-link" href="/hire">Hire another creature</a></div>`}</div>`;
    const wl = String(a.w || a.wallet || '').toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(wl) && !jobs.has(wl)) { jobs.set(wl, null); fetch('/api/build/' + wl).then((r) => (r.ok ? r.json() : null)).then((x) => { if (x && x.job) { jobs.set(wl, x); mountHire(slot, a); } }).catch(() => {}); }
    if (!alive) return;
    const t = slot.querySelector('textarea'), b = slot.querySelector('button');
    t.value = draft.get(id) || '';
    const keep = () => { typing = { id, s: t.selectionStart, e: t.selectionEnd }; };
    if (typing && typing.id === id) { try { t.focus({ preventScroll: true }); t.setSelectionRange(typing.s, typing.e); } catch {} }
    t.addEventListener('input', () => { draft.set(id, t.value); keep(); });
    for (const ev of ['focus', 'keyup', 'mouseup', 'select']) t.addEventListener(ev, keep);
    // a blur caused by the re-render removing the node keeps the flag; a real blur (the visitor clicked elsewhere) clears it
    t.addEventListener('blur', () => setTimeout(() => { if (t.isConnected && typing && typing.id === id) typing = null; }, 0));
    const go = () => {
      const task = t.value.trim();
      if (task) { try { sessionStorage.setItem('wl_hire_go', JSON.stringify({ c: id, task, at: Date.now() })); } catch {} draft.delete(id); }
      location.href = `/hire?c=${id}`;
    };
    b.addEventListener('click', go);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
  }
  window.mountHire = mountHire;
})();

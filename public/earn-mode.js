// earn-mode.js: swaps copy to "earn mode" when /api/hire/config reports payments.on === true.
//   <el data-earn="Paid text">Free text</el>   -> text replaced in earn mode
//   <el data-earn-only hidden>...</el>         -> revealed in earn mode
//   <el data-free-only>...</el>                -> hidden in earn mode
// Sets <html data-mode="earn|free">. Fails safe: on any error the page stays in free mode.
(async () => {
  try {
    const r = await fetch('/api/hire/config', { cache: 'no-store' });
    if (!r.ok) throw 0;
    const c = await r.json();
    const earn = !!(c && c.payments && c.payments.on === true && c.payments.configured !== false);
    document.documentElement.dataset.mode = earn ? 'earn' : 'free';
    if (!earn) return;
    document.querySelectorAll('[data-earn]').forEach((el) => { el.textContent = el.getAttribute('data-earn'); });
    document.querySelectorAll('[data-earn-only]').forEach((el) => { el.hidden = false; el.removeAttribute('aria-hidden'); });
    document.querySelectorAll('[data-free-only]').forEach((el) => { el.hidden = true; });
    window.dispatchEvent(new CustomEvent('earnmode', { detail: c.payments }));
  } catch { document.documentElement.dataset.mode = 'free'; }
})();

// Lists the OpenTimestamps proof files kept for the round shown on /verify.
(async function () {
  const box = document.getElementById('otsBox'), txt = document.getElementById('otsText'); if (!box) return;
  let n = Number(new URLSearchParams(location.search).get('n'));
  try {
    if (!n) n = (await (await fetch('/api/round')).json()).n;
    const L = await (await fetch('/api/round/' + n + '/ots')).json();
    if (!Array.isArray(L) || !L.length) return;
    const t = (ms) => new Date(ms).toISOString().slice(11, 19) + ' UTC';
    txt.innerHTML = L.map((o) => `The ${o.kind} hash of round ${n} was sent to a public OpenTimestamps calendar at ${t(o.at)} by our server's clock. <a href="/api/ots/${o.hash}.ots" style="text-decoration:underline">Download the proof file</a>.`).join('<br>') +
      '<br>Check a file at <a href="https://opentimestamps.org" target="_blank" rel="noopener" style="text-decoration:underline">opentimestamps.org</a> with the hash shown in the checks above. The Bitcoin confirmation arrives a few hours after the round; until then the file is a pending calendar receipt. This page does not verify the file itself.';
    box.style.display = '';
  } catch {}
})();

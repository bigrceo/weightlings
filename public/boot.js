// Entry sequence for the landing page. Self-contained: runs right after the #intro markup, before common.js.
// Every value printed here is read from the API at load; a line whose value is missing is simply not printed.
(function () {
  var el = document.getElementById('intro'); if (!el) return;
  var root = document.documentElement, seen = false, reduce = false;
  try { seen = sessionStorage.getItem('wlBoot') === '1'; } catch (e) {}
  try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (seen || reduce || location.hash.length > 1) { el.remove(); return; }
  try { sessionStorage.setItem('wlBoot', '1'); } catch (e) {}

  var BIRD = ['.X.......X.', '..X.....X..', '...XXXXX...', '..XXXXXXX..', '.XX.XXX.XX.', '.XXXXXXXXX.', '.XXXX.XXXX.', '..XXXXXXX..', '...X...X...'];
  var mark = BIRD.map(function (r, y) { return r.split('').map(function (c, x) { return c === 'X' ? '<rect x="' + x + '" y="' + y + '" width="1.02" height="1.02" fill="currentColor"/>' : ''; }).join(''); }).join('');
  el.className = 'intro boot';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Weightlings, entry');
  el.innerHTML = '<div class="boot-in"><div class="boot-head"><svg viewBox="0 0 11 9" aria-hidden="true">' + mark + '</svg><b>Weightlings</b><i>Reading the ward</i></div>' +
    '<div class="boot-sig" aria-hidden="true"><i></i></div>' +
    '<div class="boot-lines" id="bootLines"></div>' +
    '<div class="boot-go" id="bootGo"><button type="button" class="ds-btn ds-btn--sig ds-btn--lg boot-enter" id="bootEnter">Enter<i class="arr"></i></button><button type="button" class="ds-btn ds-btn--sm boot-quiet" id="bootQuiet">Enter without sound</button></div></div>' +
    '<div class="boot-hint">Any key to skip</div>';
  root.classList.add('boot-on');
  var box = document.getElementById('bootLines'), go = document.getElementById('bootGo');

  var num = function (v) { return typeof v === 'number' && isFinite(v); };
  var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var get = function (p) { return fetch(p, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).catch(function () { return null; }); };

  function build(d) {
    var S = d[0] || {}, R = d[1] || {}, T = d[2] || {}, F = d[3] || {}, L = [];
    var skew = num(R.now) ? R.now - d.t : 0;
    var block = num(S.chainBlock) ? S.chainBlock : (S.lastSeedBlock && num(S.lastSeedBlock.number) ? S.lastSeedBlock.number : num(S.lastSeedBlock) ? S.lastSeedBlock : null);
    L.push(['Robinhood Chain', 'Chain 4663' + (block != null ? ' · block ' + fmt(block) : ''), '']);
    var rn = num(R.n) ? R.n : num(S.round) ? S.round : null;
    if (rn != null) L.push(['Round', fmt(rn), '']);
    var nx = num(R.next) ? R.next : S.nextTrialAt ? +new Date(S.nextTrialAt) : null;
    if (num(nx)) { var m = Math.max(0, Math.ceil((nx - (Date.now() + skew)) / 60000)), nm = R.upcoming && R.upcoming.name; L.push(['Next trial', m + ' min' + (nm ? ' · ' + nm : ''), 'c-amber']); }
    var alive = num(S.alive) ? S.alive : num(T.alive) ? T.alive : num(F.alive) ? F.alive : null;
    if (alive != null) L.push(['Creatures alive', fmt(alive), 'c-mint']);
    var dead = num(T.dead) ? T.dead : num(F.dead) ? F.dead : null;
    if (dead != null) L.push(['Total dead', fmt(dead), 'c-pink']);
    if (num(T.extinct)) L.push(['Lineages extinct', fmt(T.extinct), 'c-violet']);
    L.push(['Brains simulated from model cards · no model is run']);
    L.push(['Exchange · paper credits']);
    return L;
  }

  var HEX = '0123456789abcdef', STEP = 300, RES = 430, T0 = 200;
  var rows = [], start = 0, done = false, closed = false, raf = 0;
  function scramble(v, k) { // k in 0..1: characters resolve left to right, spaces and separators stay put
    var n = Math.floor(v.length * k), s = v.slice(0, n);
    for (var i = n; i < v.length; i++) { var c = v[i]; s += c === ' ' || c === '·' || c === ',' ? c : HEX[(Math.random() * 16) | 0]; }
    return s;
  }
  function frame(now) {
    if (closed) return;
    if (!start) start = now;
    var t = now - start - T0, all = true;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], lt = t - i * STEP;
      if (lt < 0) { all = false; continue; }
      if (!r.on) { r.on = true; r.el.classList.add('on'); }
      if (r.val && !r.fin) {
        var k = Math.min(1, lt / RES);
        if (k >= 1) { r.b.textContent = r.val; r.fin = true; r.el.classList.add('done'); }
        else { if (now - (r.last || 0) > 45) { r.b.textContent = scramble(r.val, k); r.last = now; } all = false; }
      }
    }
    if (all && t > (rows.length - 1) * STEP + RES + 150) { ready(); return; }
    raf = requestAnimationFrame(frame);
  }
  function ready() {
    if (done) return; done = true;
    go.classList.add('on');
    var h = el.querySelector('.boot-head i'); if (h) { h.textContent = 'Live'; h.className = 'on'; }
    el.classList.add('ready');
    try { document.getElementById('bootEnter').focus({ preventScroll: true }); } catch (e) {}
  }
  function close() {
    if (closed) return; closed = true;
    cancelAnimationFrame(raf); removeEventListener('keydown', onKey, true);
    root.classList.remove('boot-on'); el.classList.add('out');
    setTimeout(function () { el.remove(); }, 1000);
  }
  function soundIsOn() { try { return !!sndOn; } catch (e) {} var w = document.getElementById('sw'); return !!w && w.style.opacity === '1'; }
  function enter() {
    // common.js may already have resumed the ambience on this same gesture (wlSound = 1); only toggle when it is off
    try { var s = document.getElementById('sound'); if (s && !soundIsOn()) s.click(); } catch (e) {}
    close();
  }
  function onKey(e) {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.metaKey || e.ctrlKey) return;
    var a = document.activeElement;
    if ((e.key === 'Enter' || e.key === ' ') && a && el.contains(a) && a.tagName === 'BUTTON') return; // the focused button handles it
    if (e.key === 'Tab' && done) return;
    e.preventDefault(); close();
  }
  document.getElementById('bootEnter').onclick = enter;
  document.getElementById('bootQuiet').onclick = close;
  addEventListener('keydown', onKey, true);

  function run(d) {
    if (rows.length || closed) return;
    build(d).forEach(function (l, i, A) {
      var r = document.createElement('div'), fact = l.length === 1;
      r.className = 'boot-line' + (fact ? ' fact' + (A[i - 1] && A[i - 1].length > 1 ? ' first-fact' : '') : l[2] ? ' ' + l[2] : '');
      var s = document.createElement('span'); s.textContent = l[0]; r.appendChild(s);
      var b = null; if (!fact) { b = document.createElement('b'); b.textContent = scramble(l[1], 0); r.appendChild(b); }
      box.appendChild(r); rows.push({ el: r, b: b, val: fact ? '' : l[1] });
    });
    raf = requestAnimationFrame(frame);
  }
  // wait for the numbers: start at 1.2 s if the round or the status has answered, and at 3.5 s whatever happened.
  // A line whose value never arrived is left out, not invented.
  var res = [null, null, null, null]; res.t = Date.now(); var left = 3;
  var got = function (i) { return function (v) { res[i] = v; if (i < 3 && --left === 0) run(res); return v; }; };
  get('/api/status').then(function (v) { if (v && !v.error) return got(0)(v); return get('/api/stats').then(function (f) { res[3] = f; got(0)(null); }); });
  get('/api/round').then(function (v) { res.t = Date.now(); got(1)(v); });
  get('/api/toll').then(got(2));
  setTimeout(function () { if (res[0] || res[1]) run(res); }, 1200);
  setTimeout(function () { run(res); }, 3500);
  // a hidden tab gets no animation frames: finish at once when the visitor comes back
  document.addEventListener('visibilitychange', function () { if (!document.hidden && rows.length && !done && !closed) start = performance.now() - 1e5; });
})();

// /hire: put a living creature to work, watch the run live, and check its signed receipt in this browser.
// Loaded after common.js, cards.js and slip.js (uses window.printSlip / window.slipSave only). Everything shown comes from the server's routes:
//   GET  /api/models, /api/world, /api/being/:id, /api/config          (the meadow, already served)
//   GET  /api/hire/budget, else GET /api/hire/config (.budget, .limits)  today's operator budget
//   POST /api/hire {creatureId, task, pid}                             -> 202 {id, stream, receipt}
//   GET  /api/hire/:id/stream                                          SSE: start, call, thinking, text, tool, usage, energy, error, done (resumes with Last-Event-ID)
//   GET  /api/hire/:id                                                 receipt, receiptHash, signature, keyId, ots, system, outputs
//   GET  /api/hire/key                                                 the Ed25519 public key that signs receipts
//   GET  /api/hires                                                    {hires:[...]} the latest hires (public floor)
//   GET  /api/ots/0x<hash>.ots                                         OpenTimestamps proof, when one exists
// Exposes window.WLReceipt = { canon, sha256Hex, check(record, keyDoc) } so another page can run the same checks.
(() => {
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REDUCED = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  async function j(path, opts) {
    try { const r = await fetch(path, { cache: 'no-store', ...opts }); let data = null; try { data = await r.json(); } catch {} return { ok: r.ok, status: r.status, data: data || {} }; }
    catch { return { ok: false, status: 0, data: { error: 'The server did not answer.' } }; }
  }
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const usd = (v, d = 2) => (v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const usdSmall = (v) => (v == null ? null : v > 0 && v < 0.0001 ? '< $0.0001' : usd(v, v < 1 ? 4 : 2));
  const int = (v) => (v == null ? null : Math.round(Number(v)).toLocaleString('en-US'));
  const when = (v) => { if (v == null || v === '') return null; const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); return isNaN(t) ? null : t; };
  const utc = (t) => (t == null ? null : new Date(t).toISOString().slice(0, 19).replace('T', ' ') + ' UTC');
  const ago = (t) => { if (t == null) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.round(s) + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const secs = (ms) => (ms == null ? null : ms < 10000 ? (ms / 1000).toFixed(1) + ' s' : ms < 120000 ? Math.round(ms / 1000) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s');
  const shortH = (h) => { h = String(h || ''); return h.length > 20 ? h.slice(0, 10) + '…' + h.slice(-6) : h; };
  const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((x, p) => (x == null ? x : x[p]), o); if (v != null && v !== '') return v; } return null; };
  function untilUtcMidnight() { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime(); }
  const inHm = (ms) => { ms = Math.max(0, ms); const h = Math.floor(ms / 3600000), m = Math.ceil((ms % 3600000) / 60000); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
  function visitor() {
    let p = null; try { p = localStorage.getItem('wl_pid'); } catch {}
    if (!p || !/^[a-z0-9]{8,40}$/.test(p)) { p = Math.random().toString(36).slice(2, 14) + Date.now().toString(36); try { localStorage.setItem('wl_pid', p); } catch {} }
    return p;
  }

  // ---------- the creature sprite (same pixels and tier colours as the meadow) ----------
  const ROWS = ['.A.......A.', '..A.....A..', '...KKKKK...', '..KKSKSKK..', '.KKWPKWPKK.', '.KKKKKKKKK.', '.KKKKMKKKK.', '..KKKKKKK..', '...L...L...'];
  const TC = { legendary: '#ffb81f', epic: '#b056ff', rare: '#2a7bff', uncommon: '#2fc46b', common: '#c9ccd4' };
  const TN = { legendary: ['Legendary', 5], epic: ['Epic', 4], rare: ['Rare', 3], uncommon: ['Uncommon', 2], common: ['Common', 1] };
  const sprCache = {};
  function spr(tier, dead) {
    const key = (TC[tier] ? tier : 'common') + (dead ? ':d' : '');
    if (!sprCache[key]) {
      const col = { A: '#ffffff', K: dead ? '#4a4a50' : TC[tier] || TC.common, S: '#ffffffaa', W: '#ffffff', P: '#111', M: '#111', L: '#3a2a1a' };
      sprCache[key] = ROWS.flatMap((r, y) => [...r].map((c, x) => (col[c] ? `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${col[c]}"/>` : ''))).join('');
    }
    return `<svg class="spr" viewBox="0 0 11 9" shape-rendering="crispEdges" aria-hidden="true">${sprCache[key]}</svg>`;
  }
  const eCol = (e) => (e < 0 ? '#ffb81f' : e > 40 ? '#5cf2a8' : e >= 25 ? '#ffb81f' : '#ff3f8e');

  // ---------- receipt checks (pure WebCrypto; nothing here trusts the server's own verdict) ----------
  const enc = (s) => new TextEncoder().encode(s);
  const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const sha256Hex = async (s) => hexOf(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc(s) : s));
  const nh = (h) => String(h || '').trim().toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '');
  /** Canonical text of a JSON value: object keys sorted by code point at every depth, no spaces, numbers and strings as JSON.stringify writes them. */
  function canon(v) {
    if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canon(x))).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  function bytesOf(s) {
    s = String(s || '').trim();
    if (/^(0x)?[0-9a-fA-F]+$/.test(s) && (s.replace(/^0x/, '').length % 2 === 0) && s.replace(/^0x/, '').length >= 64) { const h = s.replace(/^0x/, ''); return new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16))); }
    const b = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''); const pad = b + '==='.slice((b.length + 3) % 4);
    const bin = atob(pad); return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  async function importEd(doc, keyId) {
    let k = doc || {};
    const kid = (x) => x.keyId || x.id || x.key_id || x.kid || null;
    if (Array.isArray(k.keys)) k = k.keys.find((x) => keyId && kid(x) === keyId) || k.keys[0] || {};
    if (k.jwk || k.kty) return { key: await crypto.subtle.importKey('jwk', k.jwk || k, { name: 'Ed25519' }, true, ['verify']), id: kid(k) };
    let s = pick(k, 'publicKeyHex', 'public_key_hex', 'publicKey', 'public_key', 'publicKeyPem', 'public_key_pem', 'public_key_b64', 'raw', 'spki', 'pem', 'key');
    if (!s) throw Object.assign(new Error('The server published no public key.'), { name: 'NoKey' });
    s = String(s);
    let bytes;
    if (/-----BEGIN/.test(s)) bytes = bytesOf(s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    else bytes = bytesOf(s);
    const key = bytes.length === 32 ? await crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, true, ['verify']) : await crypto.subtle.importKey('spki', bytes, { name: 'Ed25519' }, true, ['verify']);
    return { key, id: kid(k) };
  }
  /** Reads a hire record as served by GET /api/hire/:id (engine publicHire) into one shape. A few other field names are accepted as fallbacks. */
  function normRec(x) {
    const r = (x && (x.hire || x)) || {};
    let rc = r.receipt && typeof r.receipt === 'object' ? r.receipt : null;
    let hash = pick(r, 'receiptHash', 'receipt_hash', 'hash'), sig = pick(r, 'signature', 'sig');
    if (rc) { // a receipt that carries its own hash/signature: those keys are not part of what was hashed
      const strip = [];
      for (const k of ['receiptHash', 'receipt_hash']) if (!hash && rc[k]) { hash = rc[k]; strip.push(k); }
      for (const k of ['signature', 'sig']) if (!sig && rc[k]) { sig = rc[k]; strip.push(k); }
      if (strip.length) { rc = { ...rc }; strip.forEach((k) => delete rc[k]); }
    }
    // When a receipt exists, everything shown about the hire is read from the receipt only (it is what the hash and signature cover);
    // the server's unsigned top-level fields are used only for a hire that has no receipt yet (running, or an older list row).
    const src = rc || r;
    const c = (rc ? rc.creature : r.creature) || {}, br = (c.brain && typeof c.brain === 'object' ? c.brain : null) || {};
    return {
      id: rc ? rc.id : pick(r, 'id', 'hire_id'),
      status: String(src.status || '').toLowerCase(),
      creature: { id: rc ? rc.creatureId : pick(r, 'creatureId', 'creature_id') ?? pick(c, 'id'), nick: pick(c, 'nick', 'name'), tier: br.tier || (rc ? null : pick(c, 'tier')), model: br.id || (rc ? null : (typeof c.brain === 'string' ? c.brain : null) || pick(c, 'model')), modelName: br.name || (rc ? null : pick(c, 'modelName', 'brainName')), lab: br.lab, wallet: pick(c, 'wallet', 'w'), gen: pick(c, 'gen'), family: pick(c, 'family') },
      task: rc ? (typeof rc.task === 'string' ? rc.task : null) : pick(r, 'task', 'input'), output: rc ? (typeof rc.answer === 'string' ? rc.answer : null) : pick(r, 'answer', 'output'), error: rc ? rc.error || null : pick(r, 'error') || null,
      created: rc ? when(rc.startedAt) : when(pick(r, 'startedAt', 'started_at', 'created_at')), finished: rc ? when(rc.endedAt) : when(pick(r, 'endedAt', 'ended_at', 'finished_at')),
      receipt: rc, hash, sig, keyId: (rc && rc.keyId) || pick(r, 'keyId', 'key_id'), ots: r.ots || null,
      system: typeof r.system === 'string' ? r.system : null, outputs: Array.isArray(r.outputs) ? r.outputs : null,
    };
  }
  /** The receipt's own numbers (engine receipt v weightlings.hire.v1 first). */
  function fields(R) {
    const rc = R.receipt || {}, u = rc.usage || {};
    const steps = Array.isArray(rc.steps) ? rc.steps : [];
    let tools = steps.length ? steps.map((x) => x && (x.tool || x.name)).filter(Boolean) : pick(rc, 'tools_used', 'tools');
    if (!Array.isArray(tools)) tools = []; else tools = tools.map((t) => (typeof t === 'string' ? t : t && (t.name || t.tool))).filter(Boolean);
    const tin = u.input_tokens != null ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : num(pick(rc, 'tokens_in'));
    const t0 = when(pick(rc, 'startedAt', 'started_at')) || R.created, t1 = when(pick(rc, 'endedAt', 'ended_at', 'finished_at')) || R.finished;
    const en = rc.energy && typeof rc.energy === 'object' ? rc.energy : {};
    const paid = rc.paidBy ?? rc.paid_by;
    return {
      model: pick(rc, 'model', 'worker_model'), servedBy: Array.isArray(rc.servedBy) ? rc.servedBy : [], effort: rc.effort || null,
      brain: R.creature.modelName || R.creature.model,
      tin, tout: u.output_tokens != null ? u.output_tokens : num(pick(rc, 'tokens_out')), calls: num(u.calls),
      cost: num(pick(rc, 'costUsd', 'cost_usd')),
      tools, steps, dur: t0 && t1 ? t1 - t0 : num(pick(rc, 'duration_ms')),
      inHash: pick(rc, 'input_hash', 'taskHash'), outHash: pick(rc, 'output_hash', 'answerHash'), systemHash: pick(rc, 'systemHash'),
      eGranted: num(en.granted), eBefore: num(en.before), eAfter: num(en.after), eWhy: en.reason || null,
      at: t1 || R.created, paidBy: paid ?? null,
      payer: paid == null ? null : typeof paid === 'string' ? paid : paid.payer ? `${paid.amount || ''} by ${shortH(paid.payer)}${paid.method ? ` (${paid.method}${paid.tx ? ', tx ' + shortH(paid.tx) : ''})` : ''}`.trim() : 'unknown',
      disclosure: typeof rc.disclosure === 'string' ? rc.disclosure : null, messageIds: Array.isArray(rc.messageIds) ? rc.messageIds : [],
    };
  }
  const tally = (names) => { const m = new Map(); names.forEach((n) => m.set(n, (m.get(n) || 0) + 1)); return [...m].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', '); };

  /** Runs every check on one record. Returns { checks:[{k,title,s,p}], verdict:'VERIFIED'|'MISMATCH'|'UNCHECKED', hash, keyFp }. */
  async function check(R, keyDoc) {
    const out = [], add = (k, title, s, p) => out.push({ k, title, s, p });
    const F = fields(R);
    let matched = null, mine = null;
    if (!crypto || !crypto.subtle) { add('hash', 'Receipt fields hash', 'na', 'This page needs a secure (https) connection to use your browser\'s cryptography.'); return { checks: out, verdict: 'UNCHECKED' }; }
    if (!R.receipt) { add('hash', 'Receipt fields hash', 'bad', 'The server returned no receipt for this hire.'); return { checks: out, verdict: 'MISMATCH' }; }
    // 1. the receipt hash, recomputed from the fields. One form only, the same as the server and verify-receipt.mjs:
    //    SHA-256 of the canonical JSON (keys sorted, no whitespace, undefined dropped).
    const text0 = canon(R.receipt);
    mine = await sha256Hex(text0);
    const stated = nh(R.hash);
    if (stated && mine === stated) matched = { name: 'the fields with keys sorted (canonical JSON)', text: text0, h: mine };
    if (!stated) add('hash', 'Receipt fields hash', 'bad', `The server gave no receipt hash. Your browser computed <b>${mine}</b> from the fields.`);
    else if (matched) add('hash', 'Receipt fields hash', 'ok', `SHA-256 of ${esc(matched.name)}, computed here: <b>${matched.h}</b>. Same as the hash on the receipt.`);
    else add('hash', 'Receipt fields hash', 'bad', `The receipt says <b>${esc(stated)}</b>; your browser computed <b>${mine}</b> from the fields it received. Something in the fields differs from what was hashed.`);
    // 2. the Ed25519 signature, with the published key
    let keyFp = null, sigOk = null;
    try {
      if (!keyDoc) throw Object.assign(new Error('The key route did not answer.'), { name: 'NoKey' });
      const { key, id } = await importEd(keyDoc, R.keyId);
      if (R.keyId && id !== R.keyId) throw Object.assign(new Error(`The receipt names key ${R.keyId}, which the server does not publish.`), { name: 'NoKey' });
      try { keyFp = (await sha256Hex(await crypto.subtle.exportKey('raw', key))).slice(0, 16); } catch {}
      if (!R.sig) { add('sig', 'Ed25519 signature', 'bad', 'The receipt carries no signature.'); sigOk = false; }
      else {
        // the signed message is the 32 raw bytes of the receipt hash, nothing else (receipts.mjs seal)
        const sig = bytesOf(R.sig), h = stated || mine;
        if (h.length === 64 && await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, bytesOf(h))) sigOk = 'the 32-byte receipt hash';
        if (sigOk) add('sig', 'Ed25519 signature', matched ? 'ok' : 'bad', `Valid signature over ${esc(sigOk)}, checked with WebCrypto against key <b>${esc(id || '')}</b>${keyFp ? ` (fingerprint <b>${keyFp}</b>)` : ''}, as published by this site at <a href="/api/hire/key">/api/hire/key</a>. To check without trusting this site, run the standalone verifier with a key you got elsewhere.${matched ? '' : ' But the fields shown here do not hash to what was signed.'}`);
        else add('sig', 'Ed25519 signature', 'bad', `The signature <b>${esc(shortH(R.sig))}</b> does not verify against the published key. Do not trust this receipt.`);
        if (sigOk && !matched) sigOk = false;
        if (R.keyId && id && R.keyId !== id) add('key', 'Signing key', 'bad', `The receipt names key <b>${esc(R.keyId)}</b>; the published key is <b>${esc(id)}</b>.`);
      }
    } catch (e) {
      if (e && e.name === 'NotSupportedError') add('sig', 'Ed25519 signature', 'na', 'This browser cannot check Ed25519 signatures. Chrome 137+, Safari 17+ and Firefox 129+ can. Nothing was assumed.');
      else add('sig', 'Ed25519 signature', 'bad', esc(e && e.name === 'NoKey' ? e.message : 'The published key could not be read: ' + (e && e.message || e)));
      sigOk = e && e.name === 'NotSupportedError' ? null : false;
    }
    // 3 + 4. the task and the answer shown here, against the hashes inside the receipt
    const pair = async (k, title, text, h, what) => {
      if (!h) return add(k, title, 'na', `The receipt carries no hash of the ${what}.`);
      if (text == null) return add(k, title, 'na', `The ${what} is no longer served, so it cannot be hashed here. Its hash stays on the receipt: <b>${esc(nh(h))}</b>.`);
      const got = await sha256Hex(String(text));
      add(k, title, got === nh(h) ? 'ok' : 'bad', got === nh(h) ? `SHA-256 of the ${what} on this page: <b>${got}</b>. Same as in the receipt.` : `The ${what} on this page hashes to <b>${got}</b>; the receipt says <b>${esc(nh(h))}</b>.`);
    };
    const rc = R.receipt;
    if (typeof rc.task === 'string' || typeof rc.answer === 'string') { // the engine writes the task and the answer into the receipt itself
      const words = [typeof rc.task === 'string' ? 'task' : null, typeof rc.answer === 'string' ? 'answer' : null].filter(Boolean).join(' and the ');
      add('text', `The ${words} are inside the signed receipt`, matched ? 'ok' : 'bad', matched ? `The ${words} shown on this page are read from the receipt's own fields, so the hash and the signature above cover them word for word.` : `The fields do not hash to what was signed, so the ${words} shown here are not covered.`);
    } else {
      await pair('task', 'Task matches the receipt', R.task, F.inHash, 'task');
      await pair('answer', 'Answer matches the receipt', R.output, F.outHash, 'answer');
    }
    // 4b. every tool output the server says it fed the model, against the hash in the receipt's steps
    if (F.steps.length) {
      const ok = [], bad = [], miss = [];
      for (const [i, st] of F.steps.entries()) {
        const h = st && st.outputHash, o = R.outputs && R.outputs[i];
        if (!h) continue; if (o == null) { miss.push(i + 1); continue; }
        ((await sha256Hex(String(o))) === nh(h) ? ok : bad).push(i + 1);
      }
      if (bad.length) add('tools', 'Tool outputs match the receipt', 'bad', `Tool ${bad.length === 1 ? 'call' : 'calls'} ${bad.join(', ')}: the output served does not hash to the receipt's outputHash.`);
      else if (ok.length) add('tools', 'Tool outputs match the receipt', 'ok', `${ok.length} of ${F.steps.length} tool ${F.steps.length === 1 ? 'output' : 'outputs'} (the exact text the model was given: pages, chain reads, notes) hashed here and matched each step's outputHash.${miss.length ? ` ${miss.length} not served.` : ''}`);
      else add('tools', 'Tool outputs match the receipt', 'na', 'The tool outputs are not served with this record, so they cannot be hashed here.');
    }
    // 4c. the creature's instructions (system prompt), against systemHash
    if (F.systemHash) {
      if (R.system == null) add('system', 'Instructions match the receipt', 'na', 'The instructions given to the model are not served with this record.');
      else { const g = await sha256Hex(R.system); add('system', 'Instructions match the receipt', g === nh(F.systemHash) ? 'ok' : 'bad', g === nh(F.systemHash) ? `The exact instructions the model received (the creature's persona built from its public traits, and the house rules) hash to <b>${g}</b>, as the receipt says.` : `The instructions served hash to <b>${g}</b>; the receipt says <b>${esc(nh(F.systemHash))}</b>.`); }
    }
    // 5. OpenTimestamps, when the server stamped this receipt hash
    const oh = matched ? matched.h : stated;
    let otsUrl = typeof R.ots === 'string' ? R.ots : R.ots && (R.ots.proof || R.ots.url || R.ots.file) || null;
    if (otsUrl && !/^(\/|https:\/\/)/.test(otsUrl)) otsUrl = null;
    if (!otsUrl && oh && /^[0-9a-f]{64}$/.test(oh)) { const r = await fetch(`/api/ots/0x${oh}.ots`, { method: 'GET', cache: 'no-store' }).catch(() => null); if (r && r.ok) otsUrl = `/api/ots/0x${oh}.ots`; }
    if (otsUrl) add('ots', 'OpenTimestamps proof', 'info', `The receipt hash was sent to public OpenTimestamps calendars. <a href="${esc(otsUrl)}">Download the proof file</a> and check it at <a href="https://opentimestamps.org" target="_blank" rel="noopener">opentimestamps.org</a> against <b>${esc(oh)}</b>. Bitcoin confirms it a few hours after the hire; this page does not check the file itself.`);
    else add('ots', 'OpenTimestamps proof', 'na', R.ots && R.ots.stamped === false ? 'The receipt hash was sent to the public OpenTimestamps calendars when the hire ended. The proof file appears here once a calendar answers; reload this receipt in a minute.' : 'No timestamp proof for this receipt yet.');
    const counted = out.filter((c) => ['hash', 'sig', 'task', 'answer', 'text', 'tools', 'system', 'key'].includes(c.k));
    const verdict = counted.some((c) => c.s === 'bad') ? 'MISMATCH' : matched && sigOk ? 'VERIFIED' : 'UNCHECKED';
    return { checks: out, verdict, hash: oh || mine, keyFp };
  }
  window.WLReceipt = { canon, sha256Hex, check, normRec };

  // ---------- page state ----------
  const P = new URLSearchParams(location.search);
  const RID = P.get('r') && /^[A-Za-z0-9_:.-]{1,100}$/.test(P.get('r')) ? P.get('r') : null;
  const PRE = /^\d{1,9}$/.test(P.get('c') || '') ? Number(P.get('c')) : null;
  const MAXLEN = 2000; // the engine reads at most 2000 characters of a task
  let MODELS = {}, LIVE = [], sel = null, selInfo = null, sortBy = 'tier', BUDGET = null, CONF = {}, recentTx = null, running = false;
  let KEY = null; const keyDoc = () => KEY || (KEY = j('/api/hire/key').then((r) => (r.ok ? r.data : null)));

  // ---------- budget ----------
  async function loadBudget() {
    let r = await j('/api/hire/budget');
    if (r.status === 404) { r = await j('/api/hire/config'); if (r.ok) { CONF.hire = r.data; r = { ok: !!r.data.budget, data: r.data.budget || {} }; } }
    const box = q('#bud');
    if (!r.ok) { BUDGET = null; box.hidden = true; return; }
    const b = r.data || {};
    const limit = num(pick(b, 'capUsd', 'limitUsd', 'limit_usd', 'daily_usd')), spent = num(pick(b, 'spentUsd', 'spent_usd'));
    const left = num(pick(b, 'leftUsd', 'left_usd', 'remaining_usd')) ?? (limit != null && spent != null ? Math.max(0, limit - spent) : null);
    const count = num(pick(b, 'hiresToday', 'hires_today', 'hires'));
    const reset = when(pick(b, 'resetsAt', 'resets_at')) || Date.now() + untilUtcMidnight();
    const open = b.open != null ? !!b.open : left == null || left > 0.0005;
    BUDGET = { limit, spent, left, count, reset, open, you: num(pick(b, 'youLeft', 'visitorLeft', 'you_left', 'visitor.left')), why: pick(b, 'message', 'note') };
    box.hidden = false; box.classList.toggle('out', !open);
    q('#bLeft').textContent = left == null ? '—' : usd(left);
    q('#bLimit').textContent = limit == null ? '—' : usd(limit);
    q('#bCount').textContent = count == null ? '—' : int(count); q('#bCount').parentElement.hidden = count == null;
    q('#bReset').textContent = inHm(reset - Date.now());
    q('#bMeter').style.setProperty('--w', limit ? Math.max(0, Math.min(100, (left / limit) * 100)).toFixed(1) + '%' : '0%');
    const per = CONF.hire && CONF.hire.limits && CONF.hire.limits.perVisitorPerHour;
    q('#bNote').textContent = !open ? `Today's budget is spent. Hires stop until 00:00 UTC, in ${inHm(reset - Date.now())}. Nothing is queued and nothing is charged to anyone.` : BUDGET.you != null ? `You can start ${BUDGET.you} more ${BUDGET.you === 1 ? 'hire' : 'hires'} this hour.` : per ? `While hiring is free, each visitor can start ${per} hires an hour. When the day's budget is spent, hires stop until 00:00 UTC.` : BUDGET.why || '';
    gate();
  }

  // ---------- creatures ----------
  async function loadMeadow() {
    const [m, w, bl] = await Promise.all([Object.keys(MODELS).length ? null : j('/api/models'), j('/api/world'), j('/api/builds?limit=200')]);
    if (bl && bl.ok) { JOBS = {}; (bl.data.builds || []).forEach((x) => (x.living || []).forEach((id) => (JOBS[id] = { job: x.job, title: x.title }))); }
    if (m && m.ok) (m.data.models || []).forEach((x) => (MODELS[x.id] = x));
    if (!w.ok || !Array.isArray(w.data.c)) { if (!LIVE.length) q('#who').innerHTML = '<p class="lab">The meadow is not answering. Try again in a moment.</p>'; return; }
    LIVE = w.data.c.map(([id, , , e, act, mid, nick, holder, gen]) => ({ id, e, act, mid, nick, holder: !!holder, gen, m: MODELS[mid] || { name: mid, tier: 'common' } }));
    if (sel == null) {
      const want = PRE != null ? PRE : null;
      if (want != null) select(want, true);
      else { const best = sorted(LIVE.filter((c) => c.e > 0))[0] || sorted(LIVE)[0]; if (best) select(best.id, true); else q('#who').innerHTML = '<p class="lab">The meadow is empty right now. Creatures hatch as wallets arrive.</p>'; }
    } else if (!LIVE.some((c) => c.id === sel) && selInfo && selInfo.alive) select(sel, true); // it died since: read it again
    else drawWho();
    if (!q('#pick').hidden) drawList();
  }
  const rank = (c) => (TN[c.m.tier] || TN.common)[1];
  function sorted(L) {
    const a = [...L];
    if (sortBy === 'energy') a.sort((x, y) => y.e - x.e || rank(y) - rank(x));
    else if (sortBy === 'name') a.sort((x, y) => String(x.nick).localeCompare(String(y.nick)));
    else a.sort((x, y) => rank(y) - rank(x) || (y.m.mmlu || 0) - (x.m.mmlu || 0) || y.e - x.e);
    return a;
  }
  async function select(id, quiet) {
    sel = id; selInfo = null; drawWho();
    if (!quiet) q('#task').focus();
    const r = await j('/api/being/' + id);
    if (sel !== id) return;
    selInfo = r.ok ? r.data : { error: true };
    drawWho(); drawChips(); gate();
  }
  function current() {
    const c = LIVE.find((x) => x.id === sel);
    const i = selInfo && !selInfo.error ? selInfo : null;
    if (!c && !i) return null;
    const m = (i && i.modelCard) || (c && c.m) || MODELS[i && i.model] || {};
    const alive = c ? true : i ? !!i.alive && !i.died : false;
    return { id: sel, nick: (c && c.nick) || (i && i.nick) || 'Creature ' + sel, tier: m.tier || (i && i.tier) || 'common', model: m.name || (i && i.modelName) || '', logo: m.logo || (i && i.logo) || '', lab: m.lab || '', e: c ? c.e : i && i.energy != null ? (i.down ? -1 : i.energy) : null, alive, gen: c ? c.gen : i && i.gen, wallet: i && (i.w || i.wallet), survived: i && i.survived, holder: c ? c.holder : i && i.source === 'holder' };
  }
  let JOBS = {}; // creature id -> its lineage's job, set on /build
  function drawWho() {
    const c = current(), box = q('#who');
    if (!c) { box.innerHTML = `<p class="lab">${sel != null && selInfo && selInfo.error ? 'No creature with that number.' : 'Loading the creature…'}</p><button type="button" class="linkb" id="chg">Choose a creature</button>`; q('#chg').onclick = togglePick; return; }
    const t = TN[c.tier] || TN.common, col = TC[c.tier] || TC.common;
    const state = !c.alive ? '<span class="gone">Dead · cannot be hired</span>' : c.e != null && c.e < 0 ? '<span class="faint">Alive · fainted</span>' : '<span class="alive">Alive</span>';
    box.classList.toggle('dead', !c.alive); box.style.setProperty('--tc', col + '88');
    box.innerHTML = `${spr(c.tier, !c.alive)}<div><div class="nm">${esc(c.nick)}</div>
      <div class="mm">${c.logo ? `<img src="${esc(c.logo)}" alt="" width="20" height="20">` : ''}<span>${esc(c.model)}</span><span class="t" style="color:${col}">${t[0]} ${'★'.repeat(t[1])}</span>${c.gen != null ? `<span class="lab">Gen ${c.gen + 1}</span>` : ''}</div>
      ${JOBS[c.id] ? `<div class="jb"><span class="ds-label ds-label--sig">${esc(JOBS[c.id].title || 'Job')}</span> ${esc(JOBS[c.id].job)}</div>` : ''}
      <div class="en"><span class="lab">${state}</span>${c.alive && c.e != null ? `<div class="emeter" style="--w:${Math.max(0, c.e)}%;--ec:${eCol(c.e)}"><i></i></div><b>${c.e < 0 ? 'down' : Math.round(c.e) + ' energy'}</b>` : ''}</div></div>
      <button type="button" class="linkb" id="chg" aria-expanded="${!q('#pick').hidden}">${q('#pick').hidden ? 'Choose another' : 'Close the list'}</button>`;
    q('#chg').onclick = togglePick;
    q('#hireB').textContent = c.alive ? `Hire ${c.nick}` : 'Hire';
  }
  function togglePick() { const p = q('#pick'); p.hidden = !p.hidden; drawWho(); if (!p.hidden) { drawList(); q('#q').focus(); } }
  function drawList() {
    const s = q('#q').value.trim().toLowerCase();
    let L = sorted(LIVE);
    if (s) L = L.filter((c) => String(c.nick).toLowerCase().includes(s) || String(c.m.name).toLowerCase().includes(s) || String(c.id) === s);
    const shown = L.slice(0, 80);
    q('#plist').innerHTML = shown.length ? shown.map((c) => { const t = TN[c.m.tier] || TN.common; return `<button type="button" class="prow" role="option" data-id="${c.id}" aria-selected="${c.id === sel}">${spr(c.m.tier)}<span><b>${esc(c.nick)}</b><small>${esc(c.m.name)} · Gen ${c.gen + 1}${c.holder ? ' · holder' : ''}${JOBS[c.id] ? ' · ' + esc(JOBS[c.id].title || JOBS[c.id].job.slice(0, 48)) : ''}</small></span><span class="t" style="color:${TC[c.m.tier] || TC.common}">${t[0]}</span><span class="e"><span class="emeter" style="--w:${Math.max(0, c.e)}%;--ec:${eCol(c.e)}"><i></i></span>${c.e < 0 ? 'down' : Math.round(c.e)}</span></button>`; }).join('') + (L.length > shown.length ? `<p class="pmore">${L.length - shown.length} more. Type a name to narrow the list.</p>` : '')
      : `<p class="pmore">No living creature matches “${esc(s)}”.</p>`;
  }
  q('#plist').addEventListener('click', (e) => { const b = e.target.closest('.prow'); if (!b) return; q('#pick').hidden = true; select(Number(b.dataset.id)); });
  q('#q').addEventListener('input', drawList);
  qa('[data-sort]').forEach((b) => (b.onclick = () => { sortBy = b.dataset.sort; qa('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawList(); }));

  // ---------- examples ----------
  const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  async function findTx() { // one real recent transaction, read from the public Robinhood Chain RPC in this browser
    try {
      const call = (method, params) => fetch('https://rpc.mainnet.chain.robinhood.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json()).then((x) => x.result);
      let n = parseInt(await call('eth_blockNumber', []), 16);
      for (let k = 0; k < 6 && n > 0; k++, n--) { const b = await call('eth_getBlockByNumber', ['0x' + n.toString(16), false]); const txs = (b && b.transactions) || []; if (txs.length > 1) return txs[txs.length - 1]; }
    } catch {}
    return null;
  }
  function examples() {
    const c = current();
    return [
      { label: 'Explain this Robinhood Chain transaction 0x…', text: () => `Explain this Robinhood Chain transaction in plain words: who sent what to whom, and what it did. ${recentTx || '0x'}` },
      { label: 'Summarise this web page', text: () => 'Summarise this web page in five short bullet points: https://en.wikipedia.org/wiki/Natural_selection' },
      { label: 'Is this token contract safe? 0x…', text: () => `Is this token contract safe? Read it on Robinhood Chain and tell me what its owner can still do. ${CONF.token || USDG}` },
      { label: 'Write a tweet about my lineage', text: () => c ? `Write a tweet about my lineage: ${c.nick}, generation ${c.gen != null ? c.gen + 1 : 1}, carries the ${c.model} model card${c.survived != null ? ` and has survived ${c.survived} hourly ${c.survived === 1 ? 'trial' : 'trials'}` : ''}.${c.wallet ? ` Family tree: ${location.origin}/l/${c.wallet}` : ''}` : 'Write a tweet about my lineage.' },
    ];
  }
  function drawChips() {
    q('#chips').innerHTML = examples().map((x, i) => `<button type="button" data-ex="${i}">${esc(x.label).replace('0x…', '<em>0x…</em>')}</button>`).join('');
  }
  q('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ex]'); if (!b) return;
    const t = q('#task'); t.value = examples()[Number(b.dataset.ex)].text(); t.dispatchEvent(new Event('input')); t.focus(); t.setSelectionRange(t.value.length, t.value.length);
  });
  q('#task').addEventListener('input', () => { q('#tLen').textContent = `${q('#task').value.length} / ${MAXLEN}`; gate(); });
  q('#task').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); q('#comp').requestSubmit(); } });

  function gate() {
    const c = current(), b = q('#hireB'), t = q('#task').value.trim();
    let why = '';
    if (running) why = 'A hire is running. Watch it below.';
    else if (BUDGET && !BUDGET.open) why = `Today's operator budget is spent. Hires reopen at 00:00 UTC, in ${inHm(BUDGET.reset - Date.now())}.`;
    else if (!c) why = 'Choose a creature first.';
    else if (!c.alive) why = `${c.nick} is dead. Only living creatures can be hired. Choose another.`;
    else if (t.length < 4) why = 'Type a task, or tap an example above.';
    b.disabled = !!why;
    q('#why').textContent = why || 'Each hire is a real run: real model calls, real web and chain reads. A hire that finishes feeds the creature in the meadow.';
  }

  // ---------- the run ----------
  const ORDER = ['hired', 'think', 'tools', 'answer', 'receipt', 'verified'];
  const R = { id: null, es: null, t0: 0, timer: null, ended: false, think: null, text: '', toolsN: 0, furthest: -1, words: 0, raf: 0, step: 0, cost: null, tok: 0, nick: null, hosts: new Set() };
  function stn(k, s, small) {
    const el = q(`.stn[data-k="${k}"]`); if (!el) return;
    const was = el.dataset.s || '';
    if (s) el.dataset.s = s; if (small != null) el.querySelector('small').textContent = small;
    if (s && s !== was && s !== 'skip' && window.Art && Art.glitchText) Art.glitchText(el.querySelector('b'), { ms: 300 });
    const i = ORDER.indexOf(k); if (s && s !== 'skip' && i > R.furthest) R.furthest = i;
    const lit = qa('.stn').reduce((m, x, idx) => (x.dataset.s && x.dataset.s !== '' ? idx : m), 0);
    q('#line').style.setProperty('--p', String(Math.max(0, lit) / (ORDER.length - 1)));
    q('#line').classList.toggle('bad', qa('.stn').some((x) => x.dataset.s === 'bad'));
  }
  const stnState = (k) => q(`.stn[data-k="${k}"]`).dataset.s || '';
  function finishStn(k) { if (stnState(k) === 'on') stn(k, 'done'); }
  function advanceTo(k) { // every earlier station that was lit is done; earlier unlit ones were skipped
    const i = ORDER.indexOf(k);
    ORDER.slice(0, i).forEach((x) => { const s = stnState(x); if (s === 'on') stn(x, 'done'); else if (!s) stn(x, x === 'hired' ? 'done' : 'skip'); });
    if (stnState(k) !== 'done') stn(k, 'on');
  }
  function ev(cls, html) { const d = document.createElement('div'); d.className = 'ev ' + cls; d.innerHTML = html; q('#feed').appendChild(d); return d; }
  function tickClock() { q('#clock').textContent = secs(Date.now() - R.t0) || '0.0 s'; }
  function startClock(t0) { R.t0 = t0 || Date.now(); clearInterval(R.timer); tickClock(); R.timer = setInterval(tickClock, 100); }
  function stopClock(ms) { clearInterval(R.timer); if (ms != null) q('#clock').textContent = secs(ms); }

  // markdown-lite: paragraphs, bullet and numbered lists, **bold**, `code`, https links. Everything escaped first.
  // A URL in an answer becomes a link only when this hire really read a page on that host (a <page> with a 2xx status in its tool
  // outputs). Any other URL, for example one a visitor planted in the task and the model quoted back, stays plain text.
  const hostOf = (u) => { try { return new URL(u.replace(/&amp;/g, '&')).hostname.toLowerCase(); } catch { return null; } };
  function readHosts(outs) { const s = new Set(); (outs || []).forEach((o) => { const m = /^<page url="([^"]+)" status="2\d\d"/.exec(String(o || '')); const h = m && hostOf(m[1]); if (h) s.add(h); }); return s; }
  function md(t, hosts) {
    const link = (u) => { const v = u.replace(/[.,;:!?]+$/, ''), h = hostOf(v); return (h && hosts && hosts.has(h) ? `<a href="${v}" target="_blank" rel="noopener nofollow ugc">${v}</a>` : `<span class="nv" title="Not a page this hire read">${v}</span>`) + u.slice(v.length); };
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/https:\/\/[^\s<)\]]+/g, link);
    let out = '', list = null, para = [];
    const flushP = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
    const flushL = () => { if (list) { out += `<${list.t}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.t}>`; list = null; } };
    for (const raw of String(t || '').replace(/\r/g, '').split('\n')) {
      const l = raw.trimEnd(); let m;
      if (!l.trim()) { flushP(); flushL(); continue; }
      if ((m = /^\s*#{1,4}\s+(.*)$/.exec(l))) { flushP(); flushL(); out += `<h4>${inline(m[1])}</h4>`; continue; }
      if ((m = /^\s*(?:[-*•])\s+(.*)$/.exec(l))) { flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(l))) { flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
      flushL(); para.push(l.trim());
    }
    flushP(); flushL(); return out;
  }
  function drawAnswer(live) {
    cancelAnimationFrame(R.raf);
    R.raf = requestAnimationFrame(() => { const a = q('#atext'); a.innerHTML = md(R.text, R.hosts); a.classList.toggle('live', !!live); });
  }
  const dl = (input) => {
    if (input == null) return '';
    if (typeof input !== 'object') return `<dl><dt>input</dt><dd>${esc(String(input).slice(0, 600))}</dd></dl>`;
    const rows = Object.entries(input).slice(0, 10).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc((typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 600))}</dd>`).join('');
    return rows ? `<dl>${rows}</dl>` : '';
  };
  const TOOLNAME = { fetch_url: 'Read a web page', read_chain: 'Read Robinhood Chain', remember: 'Write to its memory', recall: 'Read its memory', web_fetch: 'Read a web page' };

  const allowLine = (a) => !a ? '' : [a.pages != null ? `${a.pages} web ${a.pages === 1 ? 'page' : 'pages'}` : null, a.chainReads != null ? `${a.chainReads} chain reads` : null, a.notes != null ? `${a.notes} notes of memory` : null, a.effort ? `${a.effort} effort` : null].filter(Boolean).join(' · ');
  function liveMeta() { const m = q('#liveMeta'); if (m) m.textContent = [R.step > 1 ? `step ${R.step}` : null, R.cost != null ? usdSmall(R.cost) + ' so far' : null, R.tok ? int(R.tok) + ' tokens' : null].filter(Boolean).join(' · '); }
  const H = {
    hired(d) {
      const m = pick(d, 'model'), c = d.creature || {};
      if (c.nick) R.nick = c.nick;
      advanceTo('hired'); stn('hired', 'done', m ? String(m).replace(/^claude-/, '') : 'accepted');
      if (stnState('think') === '') stn('think', 'on');
      const al = allowLine(d.allowance);
      ev('sys', `<div class="lab">Hired${d.startedAt ? ` <em>${esc(utc(when(d.startedAt)) || '')}</em>` : ''}</div><p>${esc(d.disclosure || `Work done by Claude${m ? ` (${m})` : ''} through our API key. ${c.brain || 'The creature\'s open model'} is its brain in the game.`)}</p>${al ? `<p>What its traits allow in this hire: ${esc(al)}.</p>` : ''}`);
    },
    call(d) { R.step = num(d.step) || R.step; if (R.step === 1 && stnState('think') === '') stn('think', 'on'); liveMeta(); },
    usage(d) { R.cost = num(d.totalUsd) ?? R.cost; const u = d.usage || {}; R.tok += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); liveMeta(); },
    think(d) {
      const t = pick(d, 'delta', 'text'); if (t == null) return;
      if (!stnState('tools') && !stnState('answer') && stnState('think') !== 'on') advanceTo('think');
      if (!R.think || R.think.dataset.closed) { R.think = ev('think', '<div class="lab">Thinking <em></em></div><p></p>'); R.words = 0; }
      const p = R.think.querySelector('p'); p.textContent += t; p.scrollTop = p.scrollHeight;
      R.words = (p.textContent.match(/\S+/g) || []).length; R.think.querySelector('em').textContent = R.words + ' words';
      if (stnState('think') === 'on') stn('think', null, R.words + ' words');
    },
    tool(d) {
      if (R.think) R.think.dataset.closed = '1';
      if (R.text.trim()) { ev('sys', `<div class="lab">Said on the way</div><p>${esc(R.text.trim().slice(0, 600))}</p>`); R.text = ''; q('#atext').innerHTML = ''; q('#ans').hidden = true; } // narration before a tool call is not the answer
      const a = q('.stn[data-k="answer"]'); if (a.dataset.s === 'on') { a.dataset.s = ''; a.querySelector('small').textContent = ''; }
      finishStn('think'); advanceTo('tools');
      const name = String(pick(d, 'tool', 'name') || 'tool');
      R.toolsN++; stn('tools', 'on', R.toolsN + (R.toolsN === 1 ? ' call' : ' calls'));
      const prev = pick(d, 'preview'), oh = pick(d, 'outputHash');
      if (name === 'fetch_url' && typeof prev === 'string') readHosts([prev]).forEach((h) => R.hosts.add(h));
      const bad = typeof prev === 'string' && /^(Not allowed|Not saved|Skipped|Unknown tool|The tool input|Error|Refused|Could not|Blocked)/i.test(prev);
      ev('tool', `<div class="lab">${esc(TOOLNAME[name] || name)} <em>${esc(name)}${d.step ? ' · step ' + esc(d.step) : ''}</em></div>${dl(pick(d, 'input'))}${prev != null ? `<p class="res ${bad ? 'bad' : 'ok'}">${esc(String(prev).replace(/\s+/g, ' ').slice(0, 420))}${String(prev).length > 420 ? '…' : ''}</p>` : ''}${oh ? `<p class="res">Output hash ${esc(shortH(oh))}</p>` : ''}`);
    },
    text(d) {
      const t = pick(d, 'delta', 'text'); if (t == null) return;
      if (R.think) R.think.dataset.closed = '1';
      if (stnState('answer') !== 'on') advanceTo('answer');
      if (q('#ans').hidden) { q('#ans').hidden = false; q('#ansMeta').textContent = 'streaming'; }
      R.text += t; drawAnswer(true); stn('answer', null, int(R.text.length) + ' chars');
    },
    energy(d) {
      const b = num(d.before), a = num(d.after);
      if (a == null) { if (d.reason) ev('sys', `<div class="lab">Not fed</div><p>${esc(d.reason)}.</p>`); return; }
      ev('fed', `<div class="lab">Fed in the meadow</div><p>The finished hire fed ${esc(nickNow())}${d.woke ? ' and woke it from a faint' : ''}: energy <b>${b == null ? '—' : Math.round(b)} → ${Math.round(a)}</b>.</p>`);
    },
    fail(d) {
      if (R.ended) return;
      R.ended = true; stopClock();
      const k = ORDER.find((x) => stnState(x) === 'on') || ORDER[Math.max(0, R.furthest + 1)] || 'hired'; stn(k, 'bad');
      ev('fail', `<div class="lab">${d.budget ? 'Budget spent' : 'Stopped'}</div><p>${esc(pick(d, 'error', 'message', 'reason') || 'The hire stopped before it finished.')}</p>`);
      q('#atext').classList.remove('live'); closeStream(); setTimeout(() => R.id && settle(R.id), 600);
    },
  };
  const nickNow = () => (R.nick || 'the creature');
  // ---------- the line in motion: each event the server streams travels as a packet to the station at work ----------
  const SIGC = { hired: '#d2ffe8', call: '#e6eee8', usage: '#6b7770', think: '#b98cff', tool: '#ffb81f', text: '#5cf2a8', energy: '#5cf2a8', fail: '#ff3f8e', done: '#d2ffe8' };
  let lastPk = 0, nEv = 0;
  function signal(h) {
    if (!h) return;
    nEv++; const n = q('#evN'); if (n) n.textContent = `${int(nEv)} ${nEv === 1 ? 'event' : 'events'} streamed by the server`;
    if (REDUCED || document.hidden) return;
    const t = performance.now(); if (!/^(hired|tool|fail|done|energy)$/.test(h) && t - lastPk < 110) return; // deltas arrive many a second: one packet per 110 ms is enough to read
    const line = q('#line'), fx = q('#lnfx'); if (!line || !fx || line.hidden || fx.childElementCount > 24) return;
    lastPk = t;
    const st = qa('.stn'); let ti = st.findIndex((x) => x.dataset.s === 'on'); if (ti < 0) ti = Math.max(0, R.furthest);
    const lr = line.getBoundingClientRect(), a = st[0].querySelector('i').getBoundingClientRect(), b = st[ti].querySelector('i').getBoundingClientRect();
    const x0 = a.left + a.width / 2 - lr.left, dx = Math.max(0, b.left + b.width / 2 - lr.left - x0), y = a.top + a.height / 2 - lr.top;
    const p = document.createElement('i'); p.style.cssText = `left:${x0}px;top:${y}px;background:${SIGC[h] || '#e6eee8'};color:${SIGC[h] || '#e6eee8'}`; fx.appendChild(p);
    if (!p.animate) { p.remove(); return; }
    const an = p.animate([{ transform: 'translateX(0)', opacity: 0 }, { opacity: 1, offset: 0.08 }, { transform: `translateX(${dx}px)`, opacity: 1, offset: 0.92 }, { transform: `translateX(${dx}px)`, opacity: 0 }], { duration: 380 + dx * 1.1, easing: 'cubic-bezier(.65,0,.35,1)' });
    an.onfinish = () => { p.remove(); const s = st[ti]; s.classList.remove('rx'); void s.offsetWidth; s.classList.add('rx'); };
  }
  const EVENTS = { start: 'hired', hired: 'hired', call: 'call', usage: 'usage', thinking: 'think', tool: 'tool', text: 'text', energy: 'energy', error: 'fail', fail: 'fail', done: 'done' };
  function dispatch(type, d) {
    const h = EVENTS[String(type || '').toLowerCase()];
    signal(h);
    if (h === 'done') return onDone(d);
    if (h && H[h]) H[h](d || {});
  }
  const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return { text: s }; } };
  function closeStream() { if (R.es) { try { R.es.close(); } catch {} R.es = null; } }
  function attach(id) {
    closeStream();
    let es; try { es = new EventSource(`/api/hire/${encodeURIComponent(id)}/stream`); } catch { return settle(id); }
    R.es = es;
    Object.keys(EVENTS).filter((n) => n !== 'error').forEach((n) => es.addEventListener(n, (e) => { if (R.es === es) dispatch(n, parse(e.data)); }));
    es.onmessage = (e) => { if (R.es !== es) return; const d = parse(e.data); dispatch(d.type, d); };
    es.addEventListener('error', (e) => {
      if (R.es !== es) return;
      if (e && e.data) { const d = parse(e.data); if (/no such hire/i.test(d.error || '')) { closeStream(); R.ended = true; return showMissing(); } return dispatch('error', d); } // the server's own error event
      // the connection dropped: EventSource reconnects with Last-Event-ID and the server replays only what was missed.
      // If the browser gave up, or it keeps failing, read the record instead.
      R.drops = (R.drops || 0) + 1;
      if (es.readyState === 2 || R.drops > 4) { closeStream(); if (!R.ended) settle(id); }
    });
    es.addEventListener('open', () => { R.drops = 0; });
  }
  let doneOnce = false;
  function onDone(d) {
    if (doneOnce) return; doneOnce = true; closeStream();
    if (!R.ended) { advanceTo('receipt'); stn('receipt', 'on', 'signing'); }
    q('#atext').classList.remove('live');
    settle(R.id); // the record adds the key id and the timestamp status to what the done event carries
  }
  const FINAL = /^(done|ok|ran|billed|complete|completed|succeeded|success|failed|error|refused|stopped|cancelled|canceled)$/;
  async function getRec(id) { let r = await j('/api/hire/' + encodeURIComponent(id)); if (r.status === 404) { const r2 = await j('/api/hires/' + encodeURIComponent(id)); if (r2.ok) r = r2; } return r; }
  let settling = false;
  async function settle(id) { // the record is the authority: poll it until the hire is final, then show it
    if (settling) return; settling = true;
    for (let k = 0; k < 240; k++) {
      const r = await getRec(id);
      if (r.status === 404) { settling = false; return showMissing(); }
      if (r.ok) { const X = normRec(r.data); if (FINAL.test(X.status) && (X.receipt || /fail|error|refus|stop|cancel/.test(X.status))) { settling = false; return final(X, true); } }
      await sleep(k < 20 ? 1000 : 2500);
    }
    settling = false; R.ended = true; stopClock();
    ev('fail', '<div class="lab">Still running</div><p>The hire has not finished after several minutes. Reload this page later; the receipt link stays the same.</p>');
  }
  function showMissing() {
    stopClock(); q('#run').hidden = false; q('#line').hidden = true; q('#clock').textContent = '';
    q('#runT').textContent = 'No such hire'; q('#runTask').textContent = 'This receipt id is not on our server. Check the link.'; q('#again').hidden = false;
  }

  async function final(X, live) {
    R.ended = true; closeStream();
    const F = fields(X);
    stopClock(F.dur != null ? F.dur : X.finished && X.created ? X.finished - X.created : null);
    R.nick = X.creature.nick || R.nick;
    if (!q('#runTask').textContent && X.task != null) q('#runTask').textContent = X.task;
    if (!live) { // a hire opened from a link: replay what the record holds, in order
      const al = allowLine(X.receipt && X.receipt.allowance);
      ev('sys', `<div class="lab">Hired${X.created ? ` <em>${esc(utc(X.created))}</em>` : ''}</div><p>${esc(F.disclosure || 'Work done by Claude through our API key. The creature\'s open model is its brain in the game.')}</p>${al ? `<p>What its traits allowed in this hire: ${esc(al)}.</p>` : ''}`);
      if (F.steps.length) F.steps.forEach((st, i) => H.tool({ tool: st.tool, input: st.input, outputHash: st.outputHash, preview: X.outputs ? X.outputs[i] : null }));
    }
    // stations from the record itself (a hire opened from a link, or a stream that dropped)
    if (!live || stnState('hired') !== 'done') stn('hired', 'done', F.model ? String(F.model).replace(/^claude-/, '') : null);
    ['think', 'tools', 'answer'].forEach((k) => { const s = stnState(k); if (s === 'on') stn(k, 'done'); });
    if (!stnState('think')) stn('think', 'skip');
    if (!stnState('tools')) stn('tools', F.tools.length ? 'done' : 'skip', F.tools.length ? F.tools.length + (F.tools.length === 1 ? ' call' : ' calls') : 'none');
    else if (F.tools.length) stn('tools', null, F.tools.length + (F.tools.length === 1 ? ' call' : ' calls'));
    const failed = /fail|error|refus|stop|cancel/.test(X.status);
    R.hosts = readHosts((X.outputs || []).filter((o, i) => F.steps[i] && F.steps[i].tool === 'fetch_url'));
    if (X.output != null) { R.text = String(X.output); q('#ans').hidden = false; drawAnswer(false); stn('answer', 'done', F.tout != null ? int(F.tout) + ' tokens' : null); }
    else if (failed) { const k = ORDER.find((x) => stnState(x) === 'on' || !stnState(x)) || 'answer'; stn(k, 'bad'); if (!qa('.ev.fail').length) ev('fail', `<div class="lab">Stopped</div><p>${esc(X.error || 'The hire did not finish.')}</p>`); }
    else if (!stnState('answer')) stn('answer', 'skip');
    q('#ansMeta').textContent = [F.model, F.tout != null ? int(F.tout) + ' tokens out' : null].filter(Boolean).join(' · ');
    q('#ansHonest').textContent = `Written by ${F.model || 'Claude'} through our API key. ${X.creature.nick || 'The creature'}'s open model${F.brain ? `, ${F.brain},` : ''} is its brain in the game; it did not write this answer.`;
    if (F.eBefore != null || F.eAfter != null) { if (!qa('.ev.fed').length && F.eAfter != null) H.energy({ before: F.eBefore, after: F.eAfter }); }
    if (!X.receipt) { stn('receipt', failed ? 'bad' : 'skip', 'none'); stn('verified', 'skip'); q('#again').hidden = false; return; }
    stn('receipt', 'done', X.hash ? shortH(nh(X.hash)).slice(0, 8) : null); stn('verified', 'on', 'checking');
    q('#rcpt').hidden = false;
    q('#checks').innerHTML = '<div class="ck" data-s="wait"><h3>Checking the receipt in this browser</h3><span class="st">Working</span></div>';
    const res = await check(X, await keyDoc());
    q('#checks').innerHTML = res.checks.map((c, i) => `<div class="ck" data-draw style="--i:${i}" data-s="${c.s}"><h3>${esc(c.title)}</h3><span class="st">${{ ok: 'Match', bad: 'Fail', na: 'Not checked', info: 'Info', wait: 'Working' }[c.s]}</span><p>${c.p}</p></div>`).join('');
    stn('verified', res.verdict === 'VERIFIED' ? 'done' : res.verdict === 'MISMATCH' ? 'bad' : 'skip', res.verdict === 'VERIFIED' ? 'in your browser' : res.verdict.toLowerCase());
    printReceipt(X, F, res, live);
    q('#again').hidden = false;
  }
  function printReceipt(X, F, res, live) {
    if (!window.printSlip) return;
    const link = `/hire?r=${encodeURIComponent(X.id)}`;
    const lines = [
      ['Hire', shortH(X.id)], ['Creature', X.creature.nick, X.creature.wallet ? `/l/${X.creature.wallet}` : null], ['Brain in the game', F.brain],
      ['Work done by', F.model ? `Claude · ${F.model}` : null], X.status && X.status !== 'done' ? ['Status', X.status] : null, ['Model calls', F.calls], ['Tokens in', int(F.tin)], ['Tokens out', int(F.tout)], ['Cost', usdSmall(F.cost)],
      ['Paid by', F.paidBy === 'operator (launch)' ? 'Operator · free at launch' : F.payer || 'unknown'],
      ['Tools used', F.tools.length ? tally(F.tools) : 'None'], ['Duration', secs(F.dur)], F.eAfter != null ? ['Energy', `${F.eBefore == null ? '—' : Math.round(F.eBefore)} → ${Math.round(F.eAfter)}`] : null,
      ['Date', utc(F.at)], ['Receipt hash', shortH(res.hash)], ['Signature', X.sig ? shortH(String(X.sig)) : null], ['Key', res.keyFp],
      { k: 'Note', text: 'Claude did this work through our API key. The creature\'s open model is its brain in the game.' },
      { text: 'Verify this receipt', href: link },
    ];
    const opts = { title: 'Hire receipt', sub: X.creature.nick || '', stamp: res.verdict, follow: !!live && !REDUCED, instant: !live };
    printSlip(q('#slip'), lines, opts);
    q('#slipAct').hidden = false;
    q('#saveB').onclick = async () => { try { await document.fonts.ready; } catch {} window.slipSave && slipSave(lines, opts, `hire-${String(X.id).slice(0, 10)}.png`); };
    q('#copyB').onclick = async () => { try { await navigator.clipboard.writeText(location.origin + link); q('#copyB').textContent = 'Link copied'; setTimeout(() => (q('#copyB').textContent = 'Copy receipt link'), 1600); } catch { prompt('Receipt link', location.origin + link); } };
  }

  function resetRun() {
    closeStream(); clearInterval(R.timer); Object.assign(R, { id: null, ended: false, think: null, text: '', toolsN: 0, furthest: -1, words: 0, step: 0, cost: null, tok: 0, hosts: new Set() }); if (q('#liveMeta')) q('#liveMeta').textContent = ''; if (q('#evN')) q('#evN').textContent = ''; nEv = 0; doneOnce = false; settling = false;
    qa('.stn').forEach((s) => { s.dataset.s = ''; s.querySelector('small').textContent = ''; }); q('#line').style.setProperty('--p', '0'); q('#line').classList.remove('bad'); q('#line').hidden = false;
    q('#feed').innerHTML = ''; q('#ans').hidden = true; q('#atext').innerHTML = ''; q('#rcpt').hidden = true; q('#slip').innerHTML = ''; q('#slipAct').hidden = true; q('#checks').innerHTML = ''; q('#again').hidden = true;
  }

  q('#comp').addEventListener('submit', async (e) => {
    e.preventDefault(); if (running) return;
    const c = current(), task = q('#task').value.trim().slice(0, MAXLEN);
    if (!c || !c.alive || task.length < 4) return gate();
    running = true; gate(); q('#herr').textContent = ''; const btn = q('#hireB'); btn.textContent = 'Hiring…';
    const r = await j('/api/hire', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creatureId: c.id, task, pid: visitor() }) });
    const id = r.ok && pick(r.data, 'id', 'hire_id', 'hire.id');
    if (!id) {
      running = false; drawWho(); gate();
      q('#herr').textContent = r.data.error || (r.status === 429 ? 'Too many hires from this connection. Try again later.' : r.status === 402 ? 'This hire asks for a payment, which this page does not send yet. Nothing was charged.' : r.status === 503 ? 'Hires are paused right now. Nothing was charged.' : r.status === 404 ? 'Hiring is not open on this server yet.' : r.status ? `The server refused the hire (${r.status}).` : 'The server did not answer. Nothing was started.');
      if (r.status === 503 || r.status === 429) loadBudget();
      return;
    }
    resetRun(); R.id = String(id); R.nick = c.nick; nEv = 0;
    history.replaceState(null, '', `/hire?r=${encodeURIComponent(R.id)}`);
    q('#run').hidden = false; q('#runT').textContent = `${c.nick} is on the job`; q('#runTask').textContent = task;
    q('#run').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
    startClock(); stn('hired', 'on');
    attach(R.id);
    // until the hire is final, keep the button off; reopen the composer for the next one afterwards
    const wait = setInterval(() => { if (R.ended) { clearInterval(wait); running = false; drawWho(); gate(); loadBudget(); loadFloor(); } }, 500);
  });

  // ---------- opened from a receipt link ----------
  async function openReceipt(id) {
    q('#kick').textContent = 'Hire receipt'; q('#h1').textContent = 'A hire, checked by you.';
    q('#sub').textContent = 'This page fetched the hire from our server and checks its receipt here, in your browser: the hash of its fields, the Ed25519 signature, the tool outputs and the instructions the model was given.';
    q('#comp').hidden = true; q('#againB').textContent = 'Hire a creature';
    resetRun(); R.id = id; q('#run').hidden = false; q('#runT').textContent = 'Loading the hire…';
    const r = await getRec(id);
    if (r.status === 404) return showMissing();
    if (!r.ok) { q('#runT').textContent = 'The server did not answer'; q('#runTask').textContent = 'Reload this page in a moment.'; q('#line').hidden = true; return; }
    const X = normRec(r.data); R.nick = X.creature.nick;
    q('#runT').textContent = `${X.creature.nick || 'A creature'} · ${X.creature.tier ? (TN[X.creature.tier] || TN.common)[0] : 'hire'}`;
    q('#runTask').textContent = X.task != null ? X.task : '';
    q('#kickR').textContent = X.created ? utc(X.created) : '';
    if (FINAL.test(X.status) && (X.receipt || /fail|error|refus|stop|cancel/.test(X.status))) return final(X, false);
    // still running: watch it live
    running = true; startClock(X.created || Date.now()); stn('hired', 'on'); attach(id);
  }

  // ---------- the public floor ----------
  async function loadFloor() {
    const r = await j('/api/hires');
    const box = q('#floor');
    if (!r.ok) { box.innerHTML = `<p class="empty">${r.status === 404 ? 'The floor opens with the first hire.' : 'The floor is not answering. It retries on its own.'}</p>`; return; }
    const L = (Array.isArray(r.data) ? r.data : r.data.hires || r.data.items || []).slice(0, 30);
    if (!L.length) { box.innerHTML = '<p class="empty">No hires yet. Be the first: the floor shows every hire with its receipt.</p>'; return; }
    box.innerHTML = L.map((h) => {
      const X = normRec(h), F = fields(X), c = X.creature;
      const nick = c.nick || pick(h, 'nick', 'creatureNick') || 'Creature ' + (c.id ?? '');
      const brain = c.modelName || (MODELS[c.model] || {}).name || pick(h, 'brain') || '';
      const tier = c.tier || pick(h, 'tier') || (MODELS[c.model] || Object.values(MODELS).find((m) => m.name === brain) || {}).tier || 'common';
      const st = X.status, ok = /^(done|ok|complete|completed)$/.test(st), bad = /fail|error|refus|stop|cancel/.test(st);
      const t = X.finished || X.created || when(pick(h, 'endedAt', 'startedAt', 'at'));
      const cost = F.cost ?? num(pick(h, 'costUsd', 'cost_usd')), model = F.model || pick(h, 'model');
      const task = X.task || pick(h, 'taskPreview', 'task') || '';
      return `<a class="frow" href="/hire?r=${encodeURIComponent(X.id || '')}">${spr(tier)}<span><b>${esc(nick)}</b><small>${esc(brain)}${t ? ' · ' + ago(t) : ''}</small></span><span class="tk">${esc(String(task).slice(0, 240))}</span><span class="c">${cost != null ? esc(usdSmall(cost)) : '—'}<small>${esc(model ? String(model).replace(/^claude-/, '') : '')}</small></span><span class="s ${ok ? 'ok' : bad ? 'bad' : 'run'}">${ok ? 'Receipt' : bad ? 'Stopped' : 'Running'}</span></a>`;
    }).join('');
  }

  // ---------- for agents ----------
  const mcp = `claude mcp add --transport http weightlings ${location.origin}/mcp`;
  q('#mcpCmd').innerHTML = `claude mcp add --transport http weightlings <em>${esc(location.origin)}/mcp</em>`;
  q('#mcpCopy').onclick = async () => { try { await navigator.clipboard.writeText(mcp); q('#mcpCopy').textContent = 'Copied'; setTimeout(() => (q('#mcpCopy').textContent = 'Copy'), 1600); } catch { prompt('MCP install', mcp); } };

  // ---------- boot ----------
  j('/api/config').then((r) => { if (r.ok) { CONF = r.data || {}; drawChips(); } });
  drawChips(); gate();
  findTx().then((h) => { recentTx = h; });
  setInterval(() => { if (!document.hidden) loadFloor(); }, 20000);
  if (RID) { loadMeadow().then(loadFloor); openReceipt(RID); }
  else {
    loadBudget(); setInterval(() => { if (!document.hidden) loadBudget(); }, 30000);
    loadMeadow().then(() => {
      loadFloor();
      // a hire started from the meadow drawer: the drawer leaves the task in this tab's sessionStorage (never in the URL, so a link cannot spend the budget)
      let go = null; try { go = JSON.parse(sessionStorage.getItem('wl_hire_go') || 'null'); sessionStorage.removeItem('wl_hire_go'); } catch {}
      if (go && go.c === PRE && typeof go.task === 'string' && Date.now() - go.at < 120000) {
        q('#task').value = go.task.slice(0, MAXLEN); q('#task').dispatchEvent(new Event('input'));
        const tryGo = (n) => { const c = current(); if (c && c.alive && !q('#hireB').disabled) q('#comp').requestSubmit(); else if (n > 0) setTimeout(() => tryGo(n - 1), 400); };
        tryGo(10);
      }
    });
    setInterval(() => { if (!document.hidden && !running) loadMeadow(); }, 20000);
  }
})();

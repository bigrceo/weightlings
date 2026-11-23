// /verify: downloads a round's record, reads its seed block straight from the public Robinhood Chain RPC, downloads the version of the
// rules file the record names (/cull.vN.js), hashes it, runs it and compares. Every number on the page comes from the record, the RPC
// or the recomputation. Uses the globals of common.js / cards.js ($, $$, esc, api, pxApi, PX_GENES, modelLogo, tierX, pxCount, PX_REDUCED).
import { sha256, toHex, nickOf } from '/cull.js'; // helpers only (plain SHA-256, names); the rules themselves are loaded per record below
import { summaryOf } from '/summary.js';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRIAL = { famine: 'Famine', storm: 'Storm', plague: 'Plague', maze: 'Maze' };
const num = (x) => Number(x).toLocaleString('en-US');
const clockT = (ms) => new Date(ms).toISOString().slice(11, 19) + ' UTC';
const dayT = (ms) => { const d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + clockT(ms); };
const pl = (n, w, ws = w + 's') => num(n) + ' ' + (n === 1 ? w : ws);
const short = (h) => (typeof h === 'string' && h.length > 22 ? h.slice(0, 12) + '…' + h.slice(-6) : String(h));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const beat = () => (PX_REDUCED || document.hidden ? null : sleep(240));
const getJson = (p) => fetch(p).then((r) => r.json()).catch(() => null);

/** SHA-256 of bytes, by the browser's own WebCrypto (falls back to the JavaScript one where WebCrypto is unavailable). */
async function shaBytes(bytes) {
  if (!(globalThis.crypto && crypto.subtle)) return toHex(sha256(bytes));
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
async function chain(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error || !j.result) throw new Error((j.error && j.error.message) || 'no such block'); return j.result;
}
const blockByNumber = async (n) => { const b = await chain('eth_getBlockByNumber', ['0x' + n.toString(16), false]); return { number: Number(b.number), hash: b.hash, timestamp: Number(b.timestamp) }; };

/** The rules a record was run with: the file is downloaded once, hashed, and those same bytes are what runs. */
async function loadRules(v) {
  const file = 'cull.v' + v + '.js';
  const res = await fetch('/' + file, { cache: 'no-store' });
  if (!res.ok) throw new Error(file + ' is not served (HTTP ' + res.status + ')');
  const buf = new Uint8Array(await res.arrayBuffer()), hash = await shaBytes(buf);
  let mod = null, exact = true;
  try { const url = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' })); try { mod = await import(url); } finally { URL.revokeObjectURL(url); } }
  catch { mod = await import('/' + file); exact = false; } // a browser that refuses to run a local copy loads the file a second time
  return { file, hash, mod, exact };
}

// commitments this browser saw with its own eyes before a round was drawn (kept locally, compared later)
const seenKey = (n) => 'wlCommit:' + n;
function recall(n) { try { return JSON.parse(localStorage.getItem(seenKey(n)) || 'null'); } catch { return null; } }
function remember(c) { try { if (c && c.pending && c.snapshotHash && !localStorage.getItem(seenKey(c.roundN))) localStorage.setItem(seenKey(c.roundN), JSON.stringify({ hash: c.snapshotHash, seenAt: Date.now(), scheduledAt: c.scheduledAt, seedNotBefore: c.seedNotBefore })); } catch {} }

// ---------- the live line: what is committed right now ----------
let shownN = null, latest = false;
function nowLine(c) {
  const el = $('#now'); if (!el || !c || c.roundN == null) return;
  remember(c);
  let h = '';
  if (c.pending && c.snapshotHash) {
    const kept = recall(c.roundN), other = kept && kept.hash !== c.snapshotHash;
    h = `Round <b>${num(c.roundN)}</b> is sealed. Commitment <b>${esc(c.snapshotHash)}</b> was published at ${clockT(c.committedAt)} by our server's clock. Its dice will be the first Robinhood Chain block at or after <b>${clockT(c.seedNotBefore)}</b>.`
      + (other ? ` <b style="color:#ff3f8e">This browser kept a different commitment for round ${num(c.roundN)}, seen at ${clockT(kept.seenAt)}: ${esc(kept.hash)}.</b>` : ' This browser has kept a copy.')
      + (c.waiting ? ` The round is waiting: ${esc(c.waiting)}.` : '');
  } else if (c.scheduledAt) h = `Round <b>${num(c.roundN)}</b> will be sealed at <b>${clockT(c.scheduledAt)}</b>, one minute before its trial. Its commitment will appear here the moment it is published.`;
  const last = c.records && c.records.last;
  if (last != null && shownN != null && last > shownN && latest) h += ` <a href="/verify?n=${last}">Round ${num(last)} is recorded. Verify it →</a>`;
  el.classList.toggle('sealed', !!c.pending); el.innerHTML = h;
}

// ---------- checks ----------
const CK = {
  commit: ['Snapshot commitment', 'The SHA-256 of the frozen input, computed here with WebCrypto, against the hash stored in the record. A match shows that the record still holds the input it names. It does not show when that hash was published.'],
  rules: ['Rules file', 'The SHA-256 of the cull file this page just downloaded and is running, against the hash inside the commitment.'],
  trial: ['Trial rotation', 'The trial is fixed by the round number: Famine, Storm, Plague, Maze, in that order.'],
  brains: ['Brain table', 'The trait table committed with this round against the one published today at /api/models.'],
  seed: ['Seed block hash', 'The block hash stored in the record against the hash your browser just read from the public Robinhood Chain RPC.'],
  rule: ['Seed block rule', 'The seed must be the first block whose timestamp is at or after the trial second: this block is on or after it, and the block before is not.'],
  ranked: ['Ranking', 'Every creature scored and sorted here, best to worst, against the order our server stored.'],
  dead: ['The dead', 'The weakest 35% of that ranking against the list our server removed.'],
  births: ['The newborn', 'Second chances for extinct lineages, then children bred from the survivors, with their ids, parents, brains and mutations, against what our server hatched.'],
  record: ['Record hash', 'The SHA-256 of the recomputed result (ranking, dead, newborn) against the hash our server stored.'],
  summary: ['Round summary', 'The counts our pages print for this round (entered, died, born, second chances, mutations, each brain, the dominant brain), recounted here from the recomputed result.'],
  chain: ['Chain of rounds', 'Each commitment names the commitment before it and the result hash of that round. Compared here: this record against its own entry in our commitment log, the round before and the round after. The log is kept by our server and is not anchored on chain.'],
  mine: ['Your own copy', 'The commitment this browser saw and kept while the round was still sealed, against the one in the record.'],
};
const WORD = { wait: 'Checking', ok: 'Match', bad: 'Mismatch', na: 'Not checked', info: 'Noted' };
const tally = { ok: 0, bad: 0, na: 0, info: 0 };
function drawChecks(ids) {
  $('#checks').innerHTML = ids.map((id) => `<div class="ck" id="ck-${id}" data-s="wait"><h3>${esc(CK[id][0])}</h3><span class="st">${WORD.wait}</span><p>${esc(CK[id][1])}</p><dl></dl></div>`).join('');
}
/** status: true = match, false = mismatch, null = could not be checked, 'info' = nothing to compare, shown for the reader. rows: [[label, value], …] */
function resolve(id, status, rows, note, word) {
  const el = $('#ck-' + id); if (!el) return;
  const s = status === true ? 'ok' : status === false ? 'bad' : status === 'info' ? 'info' : 'na'; tally[s]++;
  el.dataset.s = s; const stEl = $('.st', el); stEl.textContent = word || WORD[s];
  if (window.Art && Art.glitchText) Art.glitchText(stEl, { ms: 360 }); // the verdict resolves out of noise as it lands
  $('dl', el).innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  if (note) $('p', el).textContent = note;
}
async function run(id, fn) {
  if (!$('#ck-' + id)) return;
  try { await fn(); } catch (e) { resolve(id, null, [['Error', String((e && e.message) || e)]], null); }
  await beat();
}

function fail(title, text, link) {
  $('#rn').hidden = true; $('#eb').textContent = 'Proof';
  $('#sub').innerHTML = `<b style="color:#fff;font-weight:600">${esc(title)}</b> ${esc(text)}${link ? ` <a style="color:#5cf2a8" href="${link[0]}">${esc(link[1])}</a>` : ''}`;
}

async function main() {
  const q = new URLSearchParams(location.search);
  const [c] = await Promise.all([getJson('/api/commit'), PX_GENES]);
  const first = c && c.records ? c.records.first : null, last = c && c.records ? c.records.last : null;
  const asked = q.get('n') != null && q.get('n') !== '' ? Math.floor(Number(q.get('n'))) : null;
  const n = asked != null && Number.isFinite(asked) ? asked : last;
  latest = asked == null; shownN = n;
  nowLine(c);
  setInterval(async () => { if (!document.hidden) nowLine(await getJson('/api/commit')); }, 5000);

  if (n == null) return fail('No recomputable round has been held yet.', 'The next trial will be the first to keep a full record. Its commitment appears above one minute before it is drawn.');
  const r = await getJson('/api/round/' + n + '/record');
  if (!r || r.error) return fail('Round ' + num(n) + ' has not been held.', 'There is no record to recompute.', last != null ? ['/verify?n=' + last, 'Verify round ' + num(last) + ' →'] : null);
  $('#rn').hidden = false; pxSeg($('#rn'), String(r.n).padStart(2, '0'));
  document.title = 'Verify round ' + r.n + ' — WEIGHTLINGS';
  // navigation
  $('#nav').hidden = false; $('#card').href = '/r/' + r.n; $('#raw').href = '/api/round/' + r.n + '/record';
  if (r.n > 1) $('#prev').href = '/verify?n=' + (r.n - 1); else $('#prev').style.display = 'none';
  if (last != null && r.n < last) $('#nxt').href = '/verify?n=' + (r.n + 1); else $('#nxt').style.display = 'none';
  const voided = !!r.voided;
  if (voided) $('#card').style.display = 'none';
  if (r.legacy || !r.snapshot || !r.result || (!r.seedBlock && !voided)) {
    $('#raw').style.display = 'none';
    return fail('Round ' + num(r.n) + ' cannot be recomputed.', 'It was held' + (r.at ? ' on ' + dayT(r.at) : '') + ', before rounds kept their full input. Its result stands on our record alone.', first != null ? ['/verify?n=' + first, 'The first recomputable round is ' + num(first) + ' →'] : null);
  }

  // the rules this round was run with (records written before versions were named are version 1)
  const ver = Number.isInteger(r.v) ? r.v : 1;
  let rules = null;
  try { rules = await loadRules(ver); } catch (e) { return fail('The rules of round ' + num(r.n) + ' could not be loaded.', 'This round was run with rules version ' + ver + ' (' + String((e && e.message) || e) + '). Without that file the round cannot be recomputed here.'); }
  const R = rules.mod, canonical = R.canonical;
  const sha = async (v) => shaBytes(new TextEncoder().encode(canonical(v)));
  const link = $('#rulesLink'); if (link) { link.href = '/' + rules.file; link.textContent = rules.file; }

  const T = r.scheduledAt + R.SEED_DELAY_MS, sb = r.seedBlock;
  $('#eb').textContent = 'Round ' + r.n + ' · ' + (TRIAL[r.trial] || r.trial) + (voided ? ' · voided' : '');
  $('#xkm').textContent = dayT(r.at);
  $('#sub').textContent = voided
    ? `Sealed at ${clockT(r.committedAt)} by our server's clock, then voided: ${r.reason || 'its result could not be written'}. Nobody was removed and nobody was born. The commitment${sb ? ' and the seed block that was read' : ''} stay on record, and the round number was not used again.`
    : `Sealed at ${clockT(r.committedAt)} by our server's clock, drawn from Robinhood Chain block ${num(sb.number)}, under rules version ${ver}. This page downloaded the record and the rules file, read that block from the chain itself, and is running the cull again in your browser.`;
  const mine = recall(r.n);
  const ids = ['commit', 'rules', 'trial', 'brains', ...(sb ? ['seed', 'rule'] : []), ...(voided ? ['record'] : ['ranked', 'dead', 'births', 'record', 'summary']), 'chain', ...(mine ? ['mine'] : [])];
  if (voided) CK.record = ['Void notice', 'The SHA-256 of the void notice (round, commitment, seed block, reason), computed here, against the hash our server stored and the next commitment names.'];
  $('#csec').hidden = false; drawChecks(ids);

  // 1. commitment
  const input = R.commitment({ ...r, roundN: r.n, trialKey: r.trial });
  await run('commit', async () => {
    const h = await sha(input), rows = [['Stored in the record', r.snapshotHash], ['Recomputed in your browser', h]];
    if (ver >= 2) {
      rows.push(['The hash covers', `trial second ${clockT(T)} · first newborn id ${num(r.nextId)} · ${pl(r.snapshot.length, 'creature')} · ${num(r.extinct.length)} of ${pl(r.extinctTotal != null ? r.extinctTotal : r.extinct.length, 'extinct lineage')} · the brain table · the rules file · the round before`]);
      if (r.hour) rows.push(['The hour of foraging', `counted by our server from ${clockT(r.hour.since)}` + (r.hour.restarts ? ` · ${pl(r.hour.restarts, 'server restart')}, ${num(Math.round(r.hour.lostMs / 1000))} s not counted` : ' · no server restart')]);
    } else rows.push(['The hash covers', `${pl(r.snapshot.length, 'creature')} · ${pl(r.extinct.length, 'extinct lineage')} · the brain table. Under rules version 1 it does not cover the trial second, the newborn ids or the rules file.`]);
    resolve('commit', h === r.snapshotHash, rows);
  });
  // 2. the rules file
  await run('rules', async () => {
    const got = ['Downloaded and run by your browser', rules.file + ' · ' + rules.hash], twice = rules.exact ? null : 'The SHA-256 of the cull file this page downloaded, against the hash inside the commitment. This browser would not run the downloaded copy directly, so the file was loaded a second time to run it.';
    if (!r.rules || !r.rules.sha256) return resolve('rules', 'info', [['Inside the commitment', 'nothing: under rules version ' + ver + ' the commitment did not name the rules file'], got], twice, 'Not committed');
    resolve('rules', r.rules.sha256 === rules.hash && r.rules.file === rules.file, [['Inside the commitment', r.rules.file + ' · ' + r.rules.sha256], got], twice);
  });
  // 3. trial
  await run('trial', async () => { const t = R.trialFor(r.n); resolve('trial', t === r.trial, [['In the record', TRIAL[r.trial] || r.trial], ['By the rule, round ' + num(r.n), TRIAL[t] || t]]); });
  // 4. brain table: a table that has changed since is said, not counted as a failure (the committed one is inside the commitment hash)
  await run('brains', async () => {
    const m = await getJson('/api/models');
    if (!m || !Array.isArray(m.models)) return resolve('brains', null, [['Committed with this round', pl(r.models.length, 'model') + ' · ' + await sha(r.models)], ['Published today', 'could not be loaded']]);
    const a = await sha(r.models), b = await sha(R.cullModels(m.models));
    resolve('brains', a === b ? true : 'info', [['Committed with this round', pl(r.models.length, 'model') + ' · ' + a], ['Published today', pl(m.models.length, 'model') + ' · ' + b]],
      a === b ? null : 'The trait table published today differs from the one committed with this round. The recomputation below uses the committed one, which the commitment hash covers.', a === b ? null : 'Changed since');
  });
  // 5 + 6. the seed block, read from the chain by this browser
  let blk = null, prev = null, rpcErr = null;
  if (sb) { try { [blk, prev] = await Promise.all([blockByNumber(sb.number), blockByNumber(sb.number - 1)]); } catch (e) { rpcErr = String((e && e.message) || e); } }
  await run('seed', async () => {
    if (!blk) return resolve('seed', null, [['Stored by our server', 'block ' + num(sb.number) + ' · ' + sb.hash], ['Robinhood Chain RPC', 'unreachable from this browser (' + rpcErr + ')']], 'Your browser could not reach the public RPC, so the seed was not compared with the chain. The lines below use the stored hash.');
    resolve('seed', blk.hash === sb.hash, [['Stored by our server', 'block ' + num(sb.number) + ' · ' + sb.hash], ['Robinhood Chain RPC', 'block ' + num(blk.number) + ' · ' + blk.hash]]);
  });
  await run('rule', async () => {
    const rule = 'first block at or after ' + (T % 1000 ? new Date(T).toISOString().slice(11, 23) + ' UTC' : clockT(T)) + (ver >= 2 ? ' (the trial second, inside the commitment hash)' : ' (the trial second, stored beside the commitment, not inside its hash)');
    if (!blk || !prev) return resolve('rule', null, [['The rule', rule], ['On chain', 'unreachable from this browser']], null);
    const ok = blk.timestamp * 1000 >= T && prev.timestamp * 1000 < T && blk.timestamp === sb.timestamp;
    resolve('rule', ok, [['The rule', rule], ['On chain', `block ${num(prev.number)} at ${clockT(prev.timestamp * 1000)}, block ${num(blk.number)} at ${clockT(blk.timestamp * 1000)}`]]);
  });
  // 7-10. run the round again
  let out = null, ms = 0, err = null;
  if (sb) { try { const t0 = performance.now(); out = R.cull({ roundN: r.n, trialKey: r.trial, seedHash: sb.hash, snapshot: r.snapshot, extinct: r.extinct, cap: r.cap, models: r.models, nextId: r.nextId }); ms = performance.now() - t0; } catch (e) { err = String((e && e.message) || e); } }
  const stored = r.result, digest = async (v) => (await sha(v)).slice(0, 18) + '…';
  const need = (id) => { if (!out) { resolve(id, null, [['Error', 'the cull could not be run here: ' + err]]); return false; } return true; };
  await run('ranked', async () => {
    if (!need('ranked')) return;
    const a = stored.ranked, b = out.ranked;
    resolve('ranked', canonical(a) === canonical(b), [['Stored by our server', `${pl(a.length, 'creature')} · best #${a[0]} · worst #${a[a.length - 1]} · ${await digest(a)}`], ['Recomputed in your browser', `${pl(b.length, 'creature')} · best #${b[0]} · worst #${b[b.length - 1]} · ${await digest(b)}`]]);
  });
  await run('dead', async () => {
    if (!need('dead')) return;
    const a = stored.dead, b = out.dead;
    resolve('dead', canonical(a) === canonical(b), [['Stored by our server', `${num(a.length)} removed · ${await digest(a)}`], ['Recomputed in your browser', `${num(b.length)} removed · ${await digest(b)}`]]);
  });
  const births = (L) => `${num(L.length)} born: ${num(L.filter((x) => !x.reborn).length)} bred, ${pl(L.filter((x) => x.reborn).length, 'second chance')}, ${pl(L.filter((x) => x.mutated).length, 'mutation')}`;
  await run('births', async () => {
    if (!need('births')) return;
    const a = stored.births, b = out.births;
    resolve('births', canonical(a) === canonical(b), [['Stored by our server', `${births(a)} · ${await digest(a)}`], ['Recomputed in your browser', `${births(b)} · ${await digest(b)}`]]);
  });
  await run('record', async () => {
    if (voided) { const h = await sha(stored); return resolve('record', h === r.recordHash, [['Stored by our server', r.recordHash], ['Recomputed in your browser', h], ['Reason given', r.reason || 'none'], ['Write attempts', num(r.attempts || 0)]]); }
    if (!need('record')) return; const h = await sha(R.resultOf(out)); resolve('record', h === r.recordHash, [['Stored by our server', r.recordHash], ['Recomputed in your browser', h]]);
  });
  // 11. the summary the round card, the slip, the gene board and the market are fed from
  const genes = await PX_GENES, G = {}; (Array.isArray(genes) ? genes : []).forEach((m) => (G[m.id] = m));
  const mname = (id) => (G[id] && G[id].name) || id;
  await run('summary', async () => {
    if (!need('summary')) return;
    const g = await getJson('/api/round/' + r.n);
    const mine2 = summaryOf(r.snapshot, R.resultOf(out)), per = (L) => (L || []).map((m) => ({ id: m.id, start: m.start, died: m.died, born: m.born })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const B = { population: mine2.population, died: mine2.died, born: mine2.born, reborn: mine2.reborn, mutations: mine2.mutations, dominant: mine2.dominant, models: per(mine2.models) };
    const line = async (x) => `${num(x.population)} entered · ${num(x.died)} died · ${num(x.born)} born · ${pl(x.reborn, 'second chance')} · ${pl(x.mutations, 'mutation')} · ${mname(x.dominant)} dominant · ${pl(x.models.length, 'brain')} ${await digest(x.models)}`;
    if (!g || g.error) return resolve('summary', null, [['Printed by our pages', 'could not be loaded'], ['Recounted in your browser', await line(B)]]);
    const A = { population: g.population, died: g.died, born: g.born, reborn: g.reborn, mutations: g.mutations, dominant: g.dominant ? g.dominant.id : null, models: per(g.models) };
    resolve('summary', canonical(A) === canonical(B), [['Printed by our pages', await line(A)], ['Recounted in your browser', await line(B)]]);
  });
  // 12. the chain
  await run('chain', async () => {
    const log = await getJson('/api/commits?n=' + r.n);
    if (!Array.isArray(log)) return resolve('chain', null, [['Commitment log', 'could not be loaded']]);
    const at = (k) => log.filter((x) => x.roundN === k), here = at(r.n), before = at(r.n - 1), after = at(r.n + 1);
    const say = (x) => `entry ${num(x.seq)} · ${x.status} · commitment ${short(x.snapshotHash)} · result ${x.recordHash ? short(x.recordHash) : 'none yet'}`;
    const rows = []; let bad = false, links = 0;
    // this record against its own entry: one commitment per round number, the same two hashes
    if (here.length !== 1) { bad = true; rows.push(['This round in the log', here.length ? `${num(here.length)} commitments for one round number` : 'missing']); }
    else { const ok = here[0].snapshotHash === r.snapshotHash && here[0].recordHash === r.recordHash; bad = bad || !ok; rows.push(['This round in the log', say(here[0]) + (ok ? '' : ' · differs from the record')]); }
    // backwards: what this commitment says came before it
    if (ver >= 2) {
      const p = r.prev || null;
      if (!p) { if (before.length) { bad = true; rows.push(['Round before', 'the log holds round ' + num(r.n - 1) + ', but this commitment names no round before it']); } else rows.push(['Round before', 'none: this commitment opens the log']); }
      else if (before.length !== 1) { bad = true; rows.push(['Round before', `this commitment names round ${num(p.roundN)} (${short(p.snapshotHash)}); the log holds ${before.length ? num(before.length) + ' entries' : 'no entry'} for round ${num(r.n - 1)}`]); }
      else { const ok = p.roundN === before[0].roundN && p.snapshotHash === before[0].snapshotHash && p.recordHash === before[0].recordHash; bad = bad || !ok; links++; rows.push(['Round before', (ok ? 'named by this commitment: ' : 'NOT the one this commitment names: ') + say(before[0])]); }
    } else rows.push(['Round before', 'not linked: under rules version 1 a commitment did not name the round before it']);
    // forwards: what the next commitment says about this round
    if (after.length === 1 && after[0].prev) { const ok = after[0].prev.snapshotHash === r.snapshotHash && after[0].prev.recordHash === r.recordHash; bad = bad || !ok; links++; rows.push(['Round after', (ok ? 'its commitment names this round and this result: ' : 'its commitment names a different round ' + num(r.n) + ': ') + say(after[0])]); }
    else if (after.length > 1) { bad = true; rows.push(['Round after', `${num(after.length)} commitments for round ${num(r.n + 1)}`]); }
    else rows.push(['Round after', after.length ? 'not linked: its commitment did not name the round before it' : 'not committed yet']);
    resolve('chain', bad ? false : links ? true : 'info', rows, null, bad || links ? null : ver >= 2 ? 'No link yet' : 'Not linked');
  });
  // 13. the copy this browser kept
  let mineOk = false;
  if (mine) await run('mine', async () => {
    const seed = sb ? sb.timestamp * 1000 : T, early = mine.seenAt < seed;
    const rows = [['Kept by this browser', `${mine.hash} · seen at ${clockT(mine.seenAt)} by your clock, ${early ? 'before' : 'not before'} the ${sb ? 'seed block' : 'trial second'} (${clockT(seed)})` + (mine.seedNotBefore ? ` · dice promised for ${clockT(mine.seedNotBefore)}` : '')], ['In the record', `${r.snapshotHash} · dice drawn for ${clockT(T)}`]];
    if (mine.hash !== r.snapshotHash) return resolve('mine', false, rows);
    if (mine.seedNotBefore != null && mine.seedNotBefore !== T) return resolve('mine', false, rows, 'The commitment is the one this browser kept, but the trial second in the record is not the one that was announced with it.');
    if (!early) return resolve('mine', null, rows, 'This browser first saw the commitment when the seed block already existed, so its copy says nothing about what was fixed beforehand.');
    mineOk = true; resolve('mine', true, rows);
  });

  // ---------- summary ----------
  const total = tally.ok + tally.bad + tally.na;
  const sum = $('#vsum'); sum.classList.toggle('bad', tally.bad > 0); sum.classList.toggle('ok', !tally.bad && !tally.na);
  sum.innerHTML = (voided ? `<b>Round ${num(r.n)} was voided.</b> ` : '')
    + (tally.bad ? `<b>${pl(tally.bad, 'check')} did not match.</b> ` : tally.na ? `<b>${num(tally.ok)} of ${num(total)} checks match</b>; ${num(tally.na)} could not be run from this browser. ` : `<b>All ${num(total)} checks match.</b> `)
    + (tally.info ? `${pl(tally.info, 'line')} had nothing to compare and ${tally.info === 1 ? 'is' : 'are'} marked as such. ` : '')
    + (mineOk ? 'This browser kept its own copy of the commitment from before the seed block, and it is the one in the record. ' : 'None of these checks shows when the commitment was published: that rests on our server\'s clock, unless a browser kept its own copy while the round was sealed. ')
    + (out ? `The ${voided ? 'cull was run' : 'round was recomputed'} here in ${ms < 1 ? ms.toFixed(2) : ms.toFixed(0)} ms from ${pl(r.snapshot.length, 'creature')}, ${pl(r.extinct.length, 'extinct lineage')} and one block hash, using ${num(out.draws)} draws of the dice. The foraging counts inside the snapshot come from our server and are not recomputed.` : '');
  // the underline of each figure is its share: of the meadow for the dead and the born, of the checks for the matches
  const nE = r.snapshot.length, nD = voided ? 0 : (out || stored).dead.length, nB = voided ? 0 : (out || stored).births.length;
  pxStats($('#vs'), [['Entered', nE, ''], ['Removed', nD, 'die', nE ? nD / nE : 0], ['Born', nB, 'sig', nE ? nB / nE : 0], ['Checks matched of ' + total, tally.ok, tally.bad ? 'die' : tally.na ? 'clock' : 'sig', total ? tally.ok / total : 0]], { id: 'vs' });
  if (!out) return;

  // ---------- the ranking and the dead ----------
  const S = {}; r.snapshot.forEach((c) => (S[c.id] = c));
  const deadSet = new Set(out.dead), nAlive = out.survivors.length, f4 = (x) => (x < 0 ? '−' : '') + Math.abs(x).toFixed(4);
  const name = (c) => nickOf(c.wallet, c.gen);
  const cell = (id, i) => { const c = S[id], d = deadSet.has(id), t = tierX(G[c.model] && G[c.model].tier); return `<a class="${d ? 'd' : ''}" style="--c:${t[0]};--k:${i}" href="/l/${esc(c.wallet)}" title="${esc(name(c))} · ${esc(mname(c.model))} · rank ${i + 1} · score ${f4(out.scores[i])}" aria-label="${esc(name(c))}, rank ${i + 1}${d ? ', removed' : ''}"></a>`; };
  // the ranking is drawn in, best first; the cut is drawn as the marks reach it, then the removed follow upside down
  const rk = $('#rank'); rk.classList.add('grow');
  rk.innerHTML = out.ranked.slice(0, nAlive).map(cell).join('') + (out.dead.length ? `<span class="cut" style="--cd:${nAlive * 7}ms">The cut · ${num(out.dead.length)} ${voided ? 'below it' : 'removed'}</span>` : '') + out.ranked.slice(nAlive).map((id, k) => cell(id, nAlive + k)).join('');
  if (out.dead.length && nAlive) { const a = S[out.ranked[nAlive - 1]], b = S[out.ranked[nAlive]];
    $('#rsum').innerHTML = (voided ? '<b>Not applied.</b> This round was voided. Below is what the cull returns for the committed snapshot and the seed block that was read; none of it was carried out. ' : '')
      + `Best to worst, one mark per creature, coloured by tier. The line fell between <b>${esc(name(a))}</b>, last to survive on a score of ${f4(out.scores[nAlive - 1])}, and <b>${esc(name(b))}</b>, first ${voided ? 'below the cut' : 'removed'} on ${f4(out.scores[nAlive])}.`; }
  $('#rsec').hidden = false;
  if (voided) return;

  const row = (id, k) => { const i = out.ranked.indexOf(id), c = S[id], lg = modelLogo(c.model);
    return `<div class="fl-row" data-draw style="--i:${Math.min(k || 0, 10)}"><i class="cx"></i><b><a href="/l/${esc(c.wallet)}">${esc(name(c))}</a></b><span class="mdl">${lg ? `<img src="${lg}" alt="">` : ''}${esc(mname(c.model))}</span><span class="lab rt">No. ${id} · rank ${i + 1} of ${out.ranked.length} · score ${f4(out.scores[i])}</span>`
      + `<span class="ep">Generation ${c.gen + 1}. In its last hour: ate ${pl(c.eaten, 'berry', 'berries')}, won ${pl(c.wins, 'duel')}, shared ${num(c.shares)}, fainted ${c.faints === 1 ? 'once' : num(c.faints) + ' times'}.</span></div>`; };
  const worstFirst = [...out.dead].reverse(), FIRST = 16;
  const same = canonical(out.dead) === canonical(stored.dead);
  $('#dead').innerHTML = (same ? '' : '<p class="vsum bad"><b>This list is what your browser computed. It differs from the list our server stored.</b></p>')
    + worstFirst.slice(0, FIRST).map(row).join('') + (worstFirst.length > FIRST ? `<div id="dmore" hidden>${worstFirst.slice(FIRST).map(row).join('')}</div><button type="button" class="ds-btn ds-btn--sm more" id="dbtn">Show all ${num(worstFirst.length)} removed</button>` : '');
  const btn = $('#dbtn'); if (btn) btn.onclick = () => { $('#dmore').hidden = false; btn.remove(); if (window.Art) Art.scan($('#dmore')); };
  $('#dsec').hidden = false;
}
main().catch((e) => { try { fail('This page could not run.', String((e && e.message) || e)); } catch {} });

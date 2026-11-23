#!/usr/bin/env node
// Operator commands for hires, run beside the server on the same data directory (on Railway: railway ssh, then run it).
//   node server/hire/admin.mjs hide <hireId>          keep a hire off the public floor and creature cards (its receipt stays reachable by id)
//   node server/hire/admin.mjs unhide <hireId>
//   node server/hire/admin.mjs notes <creatureId>     a creature's shared memory, each note with the hire that wrote it
//   node server/hire/admin.mjs forget <noteId>        delete one note
//   node server/hire/admin.mjs forget-hire <hireId>   delete every note a hire wrote
//   node server/hire/admin.mjs keys                   every receipt signing key ever used
// It opens the database only (not store.mjs, which closes running hires when it loads), so it is safe while the server runs.
import { db } from '../db.mjs';

const [cmd, arg] = process.argv.slice(2);
const hireId = (x) => { if (!/^h[0-9a-f]{20}$/.test(String(x || ''))) { console.error('give a hire id like h0123456789abcdef0123'); process.exit(2); } return x; };
const intArg = (x, what) => { if (!/^\d+$/.test(String(x || ''))) { console.error(`give a ${what} number`); process.exit(2); } return Number(x); };
try { db.exec('ALTER TABLE hires ADD COLUMN hidden INTEGER DEFAULT 0'); } catch {}
db.exec('CREATE TABLE IF NOT EXISTS hire_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, creature_id INTEGER, at INTEGER, note TEXT, hire_id TEXT)');

switch (cmd) {
  case 'hide': case 'unhide': {
    const r = db.prepare('UPDATE hires SET hidden=? WHERE id=?').run(cmd === 'hide' ? 1 : 0, hireId(arg));
    console.log(r.changes ? `${arg} is ${cmd === 'hide' ? 'hidden from' : 'back on'} the floor.` : 'No hire with that id.');
    break;
  }
  case 'notes': {
    const rows = db.prepare('SELECT id, at, hire_id, note FROM hire_memory WHERE creature_id=? ORDER BY id DESC').all(intArg(arg, 'creature'));
    if (!rows.length) console.log('No notes.');
    for (const n of rows) console.log(`#${n.id}  ${new Date(n.at).toISOString().slice(0, 16)}  ${n.hire_id}  ${n.note}`);
    break;
  }
  case 'forget': console.log(db.prepare('DELETE FROM hire_memory WHERE id=?').run(intArg(arg, 'note')).changes ? 'Deleted.' : 'No note with that number.'); break;
  case 'forget-hire': console.log(`Deleted ${db.prepare('DELETE FROM hire_memory WHERE hire_id=?').run(hireId(arg)).changes} note(s).`); break;
  case 'keys': {
    let rows = []; try { rows = db.prepare('SELECT key_id, public_key_hex, first_used FROM hire_keys ORDER BY first_used').all(); } catch {}
    if (!rows.length) console.log('No key recorded yet (the server records its key when it starts).');
    for (const k of rows) console.log(`${k.key_id}  ${k.public_key_hex}  since ${new Date(k.first_used).toISOString()}`);
    break;
  }
  default:
    console.log('commands: hide <hireId> | unhide <hireId> | notes <creatureId> | forget <noteId> | forget-hire <hireId> | keys');
    process.exit(cmd ? 2 : 0);
}

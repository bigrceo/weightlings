import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(dir, { recursive: true });
export const db = new DatabaseSync(path.join(dir, 'murmur.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS coins (token TEXT PRIMARY KEY, curve TEXT UNIQUE, pair TEXT, deployer TEXT, block INTEGER, sym TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS trades (tx TEXT, li INTEGER, wallet TEXT, token TEXT, side INTEGER, quote REAL, tokens REAL, eth REAL, block INTEGER, ts INTEGER, PRIMARY KEY (tx, li));
CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet, block);
CREATE INDEX IF NOT EXISTS trades_token ON trades(token, block);
CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts);
CREATE TABLE IF NOT EXISTS stagg (wallet TEXT, sym TEXT, ain REAL DEFAULT 0, aout REAL DEFAULT 0, n INTEGER DEFAULT 0, f INTEGER, l INTEGER, PRIMARY KEY (wallet, sym));
CREATE TABLE IF NOT EXISTS agents (wallet TEXT PRIMARY KEY, holder INTEGER DEFAULT 0, balance REAL DEFAULT 0, status TEXT, stage TEXT, created INTEGER, updated INTEGER,
  metrics TEXT, profile TEXT, memory TEXT DEFAULT '[]', score INTEGER DEFAULT 0, calls INTEGER DEFAULT 0, hits INTEGER DEFAULT 0, traits TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS agents_updated ON agents(updated);
CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, token TEXT, sym TEXT, question TEXT, price0 REAL, price1 REAL, gradedAt INTEGER, data TEXT, outcome TEXT);
CREATE TABLE IF NOT EXISTS asks (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, ip TEXT, q TEXT, data TEXT);
`);
export const kv = {
  get: (k, d = null) => { const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : d; },
  set: (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)),
};

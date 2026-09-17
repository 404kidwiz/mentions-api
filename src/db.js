// 404 Mentions API — SQLite store: businesses (keys), calls, credits
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'mentions.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  daily_cap INTEGER NOT NULL DEFAULT 500,
  credits INTEGER NOT NULL DEFAULT 25,          -- prepaid billable calls
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  agent TEXT,
  product TEXT,
  window TEXT,
  source TEXT,
  status TEXT NOT NULL,                        -- 200 | 400 | 429 | 404
  billed INTEGER NOT NULL DEFAULT 0,           -- 1 = billed, 0 = sandbox/error
  posts INTEGER,
  complaints INTEGER,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_biz ON calls(business_id, created_at);
`);

const newKey = () => 'biz_' + require('crypto').randomBytes(6).toString('base64url');

const createBusiness = db.prepare(
  'INSERT INTO businesses (key, name, daily_cap, credits) VALUES (?, ?, ?, ?)'
);
const getBusinessByKey = db.prepare('SELECT * FROM businesses WHERE key = ?');
const getBusiness = db.prepare('SELECT * FROM businesses WHERE id = ?');
const listBusinesses = db.prepare('SELECT * FROM businesses ORDER BY id');

const decCredits = db.prepare(
  'UPDATE businesses SET credits = credits - 1 WHERE id = ? AND credits > 0'
);
const addCredits = db.prepare('UPDATE businesses SET credits = credits + ? WHERE id = ?');

const callsToday = db.prepare(`
  SELECT COUNT(*) AS n FROM calls
  WHERE business_id = ? AND billed = 1
    AND created_at >= date('now')
`);

const insertCall = db.prepare(`
  INSERT INTO calls (business_id, agent, product, window, source, status, billed, posts, complaints, latency_ms)
  VALUES (@business_id, @agent, @product, @window, @source, @status, @billed, @posts, @complaints, @latency_ms)
`);
const stats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM calls) AS calls_total,
    (SELECT COUNT(*) FROM calls WHERE billed = 1 AND created_at >= date('now')) AS calls_today,
    (SELECT COUNT(*) FROM businesses) AS businesses,
    (SELECT COUNT(*) FROM calls WHERE status = '200') AS ok_calls
`);
const recentCalls = db.prepare(
  'SELECT * FROM calls ORDER BY id DESC LIMIT ?'
);

module.exports = {
  db, newKey, createBusiness, getBusinessByKey, getBusiness, listBusinesses,
  decCredits, addCredits, callsToday, insertCall, stats, recentCalls,
};

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
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,                      -- Stripe event id (evt_...)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
const stripeEventSeen = db.prepare('SELECT id FROM stripe_events WHERE id = ?');
const recordStripeEvent = db.prepare('INSERT INTO stripe_events (id) VALUES (?)');

// Atomic billing: cap-check + credit debit + receipt insert in ONE transaction.
// Returns remaining credits, or 'CAP' / 'NO_CREDITS'. No charge can occur
// without its receipt, and concurrent requests cannot exceed cap or credits.
const billCall = db.transaction((businessId, dailyCap, callRow) => {
  const biz = getBusiness.get(businessId);
  if (!biz) return 'NO_BUSINESS';
  const used = callsToday.get(businessId).n;
  if (used >= dailyCap) return 'CAP';
  if (biz.credits <= 0) return 'NO_CREDITS';
  const upd = db.prepare('UPDATE businesses SET credits = credits - 1 WHERE id = ? AND credits > 0').run(businessId);
  if (upd.changes !== 1) return 'NO_CREDITS';
  insertCall.run(callRow);
  return getBusiness.get(businessId).credits;
});

module.exports = {
  db, newKey, createBusiness, getBusinessByKey, getBusiness, listBusinesses,
  decCredits, addCredits, callsToday, insertCall, stats, recentCalls, billCall,
  stripeEventSeen, recordStripeEvent,
};

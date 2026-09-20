// 404 Mentions API — one endpoint, every agent.
// GET /v1/mentions?product=...&days=90   (header: Authorization: Bearer biz_...)
// Rules: sandbox calls free (sample=true), errors never billed, daily caps enforced.
// Billing is atomic: cap-check, debit, and receipt happen in one SQLite transaction
// AFTER collection succeeds — no charge without a receipt, no unbilled success.
const fastify = require('fastify')({ logger: true });
const store = require('./db');
const { collectMentions } = require('./collectors');

const PORT = process.env.PORT || 8787;
const OPS_TOKEN = process.env.OPS_TOKEN || null; // required for /ops routes

function authKey(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : req.headers['x-api-key'] || null;
}

// --- Operator auth ---------------------------------------------------------
function requireOps(req, reply) {
  if (!OPS_TOKEN) return reply.code(503).send({ error: 'operator routes disabled (no OPS_TOKEN set)' });
  const got = authKey(req);
  if (got !== OPS_TOKEN) return reply.code(401).send({ error: 'invalid operator token' });
}

// --- Simple per-key rate limit (guards sandbox resource exhaustion) --------
const RATE = { windowMs: 60_000, max: 30 };
const rateBuckets = new Map();
function rateLimited(id) {
  const now = Date.now();
  let b = rateBuckets.get(id);
  if (!b || now - b.start > RATE.windowMs) { b = { start: now, n: 0 }; rateBuckets.set(id, b); }
  b.n += 1;
  if (rateBuckets.size > 10_000) { // keep memory bounded
    for (const [k, v] of rateBuckets) if (now - v.start > RATE.windowMs) rateBuckets.delete(k);
  }
  return b.n > RATE.max;
}

// --- Main endpoint ---------------------------------------------------------
fastify.get('/v1/mentions', async (req, reply) => {
  const started = Date.now();
  const { product, days: daysRaw, sample, agent } = req.query;
  const days = parseInt(daysRaw || '90', 10);
  const isSandbox = sample === 'true' || sample === '1';

  // Validate input types BEFORE any billing work (arrays from repeated params crash sqlite)
  if (typeof product !== 'string' || product.length < 2) {
    return reply.code(400).send({ error: 'missing product', hint: '?product=<name>&days=90' });
  }
  if (agent !== undefined && typeof agent !== 'string') {
    return reply.code(400).send({ error: 'invalid agent param (repeat?)' });
  }
  if (isNaN(days) || days < 1 || days > 365) {
    return reply.code(400).send({ error: 'window too long', hint: 'days must be 1-365' });
  }

  const key = authKey(req);
  if (!key) return reply.code(401).send({ error: 'missing key', hint: 'Authorization: Bearer biz_...' });
  const biz = store.getBusinessByKey.get(key);
  if (!biz) return reply.code(401).send({ error: 'invalid key' });

  if (rateLimited(`${biz.id}:${isSandbox ? 'sbx' : 'live'}`)) {
    return reply.code(429).send({ error: 'rate limit', retry_after_s: 60 });
  }

  // Pre-check credits/cap for fast rejection (authoritative check happens in transaction)
  if (!isSandbox && (biz.credits <= 0 || store.callsToday.get(biz.id).n >= biz.daily_cap)) {
    store.insertCall.run({
      business_id: biz.id, agent: String(agent || 'unknown').slice(0, 50),
      product: product.slice(0, 100), window: `${days}d`, source: isSandbox ? 'sandbox' : 'live',
      status: '429', billed: 0, posts: null, complaints: null, latency_ms: Date.now() - started,
    });
    return reply.code(429).send({ error: biz.credits <= 0 ? 'no credits' : 'daily cap reached', cap: biz.daily_cap });
  }

  let data;
  try {
    data = await collectMentions(product, days);
  } catch (e) {
    // Upstream failure — never billed, always receipted.
    store.insertCall.run({
      business_id: biz.id, agent: String(agent || 'unknown').slice(0, 50),
      product: product.slice(0, 100), window: `${days}d`, source: 'live', status: '502',
      billed: 0, posts: null, complaints: null, latency_ms: Date.now() - started,
    });
    return reply.code(502).send({ error: 'upstream failure', detail: String(e.message || e) });
  }

  // Bill atomically: cap-check + debit + receipt in ONE transaction.
  let billed, creditsLeft;
  if (!isSandbox) {
    const res = store.billCall.transactionSafe(biz.id, biz.daily_cap, {
      business_id: biz.id, agent: String(agent || 'unknown').slice(0, 50),
      product: product.slice(0, 100), window: `${days}d`, source: 'live', status: '200',
      posts: data.total, complaints: data.complaints, latency_ms: Date.now() - started,
    });
    if (res === 'CAP') return reply.code(429).send({ error: 'daily cap reached', cap: biz.daily_cap });
    if (res === 'NO_CREDITS') return reply.code(429).send({ error: 'no credits', hint: 'top up at https://404mentions.com' });
    billed = 1; creditsLeft = res;
  } else {
    store.insertCall.run({
      business_id: biz.id, agent: String(agent || 'unknown').slice(0, 50),
      product: product.slice(0, 100), window: `${days}d`, source: 'sandbox', status: '200',
      billed: 0, posts: null, complaints: null, latency_ms: Date.now() - started,
    });
    billed = 0; creditsLeft = biz.credits;
  }

  return {
    product, window: `${days}d`,
    total_mentions: data.total,
    complaints_flagged: data.complaints,
    sources: data.sources,          // counts are post-window-filter
    truncated: data.truncated,      // true when search result cap was hit
    sample: isSandbox,
    mentions: isSandbox ? data.mentions.slice(0, 5) : data.mentions,
    credits_remaining: creditsLeft,
  };
});

// --- Operator endpoints (token-protected) -----------------------------------
fastify.get('/ops/stats', { preHandler: requireOps }, async () => {
  const s = store.stats.get();
  return { ...s, listed_in: ['skills.sh', 'agentskills.io', 'clawhub'] };
});

fastify.post('/ops/businesses', { preHandler: requireOps }, async (req) => {
  const { name, daily_cap, credits } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) throw { statusCode: 400, message: 'name required' };
  const cap = daily_cap === undefined ? 500 : parseInt(daily_cap, 10);
  const cred = credits === undefined ? 25 : parseInt(credits, 10);
  if (isNaN(cap) || cap < 0 || cap > 1_000_000) throw { statusCode: 400, message: 'daily_cap must be 0-1000000' };
  if (isNaN(cred) || cred < 0 || cred > 1_000_000) throw { statusCode: 400, message: 'credits must be 0-1000000' };
  const key = store.newKey();
  const info = store.createBusiness.run(key, name.slice(0, 80), cap, cred);
  return { id: info.lastInsertRowid, key, name: name.slice(0, 80), daily_cap: cap, credits: cred }; // key shown ONCE at creation
});

fastify.post('/ops/businesses/:id/credits', { preHandler: requireOps }, async (req) => {
  const { amount } = req.body || {};
  const n = parseInt(amount, 10);
  if (isNaN(n) || n <= 0 || n > 1_000_000) throw { statusCode: 400, message: 'amount must be 1-1000000' };
  const b = store.getBusiness.get(req.params.id);
  if (!b) throw { statusCode: 404, message: 'business not found' };
  store.addCredits.run(n, req.params.id);
  const after = store.getBusiness.get(req.params.id);
  return { id: after.id, name: after.name, credits: after.credits }; // no key echo
});

fastify.get('/ops/receipts', { preHandler: requireOps }, async (req) => {
  const n = parseInt(req.query.limit || '25', 10);
  if (isNaN(n) || n < 1 || n > 100) throw { statusCode: 400, message: 'limit must be 1-100' };
  return store.recentCalls.all(n);
});

const start = async () => {
  await fastify.listen({ port: PORT, host: process.env.RAILWAY_STATIC_URL ? '0.0.0.0' : '127.0.0.1' });
  console.log(`404 Mentions API on :${PORT}${OPS_TOKEN ? ' (ops enabled)' : ' (ops DISABLED — set OPS_TOKEN)'}`);
};
start();

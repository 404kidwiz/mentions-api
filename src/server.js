// 404 Mentions API — one endpoint, every agent.
// GET /v1/mentions?product=...&days=90   (header: Authorization: Bearer ***)
// Rules: sandbox calls free (sample=true), errors never billed, daily caps enforced.
// Billing is atomic: cap-check, debit, and receipt happen in one SQLite transaction
// AFTER collection succeeds — no charge without a receipt, no unbilled success.
const fastify = require('fastify')({ logger: true });
const store = require('./db');
const collectors = require('./collectors');

const PORT = process.env.PORT || 8787;
const OPS_TOKEN = process.env.OPS_TOKEN || null; // required for /ops routes
const HOST = process.env.HOST || (process.env.RAILWAY_STATIC_URL ? '0.0.0.0' : '127.0.0.1');

// Test seam: inject stub collectors via COLLECTORS_MODULE (used by src/server.test.js).
// In production this always resolves to the real ./collectors.
const collectMentions = process.env.COLLECTORS_MODULE
  ? require(process.env.COLLECTORS_MODULE).collectMentions
  : collectors.collectMentions;

function authKey(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : req.headers['x-api-key'] || null;
}

// --- Operator auth ---------------------------------------------------------
// NOTE: must be async — in Fastify v5 a sync preHandler that neither calls
// done() nor returns a Promise hangs the request lifecycle.
async function requireOps(req, reply) {
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
// Sweep expired buckets every window so the map never lingers at low traffic.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now - v.start > RATE.windowMs) rateBuckets.delete(k);
}, RATE.windowMs).unref();

// --- Schemas (JSON Schema; TypeBox optional for TS codebases) --------------
const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: true, // hints pass through
};

const mentionsQuery = {
  type: 'object',
  properties: {
    product: { type: 'string', minLength: 2, maxLength: 100 },
    days: { type: 'integer', minimum: 1, maximum: 365, default: 90 },
    sample: { type: 'string', enum: ['true', '1', 'false', '0'] },
    agent: { type: 'string', maxLength: 50 },
  },
  required: ['product'],
  additionalProperties: false,
};

const mentionItem = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    title: { type: 'string' },
    text: { type: 'string' },
    created_utc: { type: 'number' },
    url: { type: 'string' },
    num_comments: { type: 'number' },
    subreddit: { type: 'string' },
    score: { type: 'number' },
    points: { type: 'number' },
  },
  additionalProperties: true,
};

const mentionsResponse = {
  type: 'object',
  properties: {
    product: { type: 'string' },
    window: { type: 'string' },
    total_mentions: { type: 'integer' },
    complaints_flagged: { type: 'integer' },
    sources: {
      type: 'object',
      properties: {
        reddit: { type: ['integer', 'null'] },
        hn: { type: ['integer', 'null'] },
      },
    },
    truncated: { type: 'boolean' },
    mentions: { type: 'array', items: mentionItem },
    sample: { type: 'boolean' },
    credits_remaining: { type: 'integer' },
  },
  required: ['product', 'window', 'total_mentions', 'complaints_flagged', 'mentions', 'sample'],
};

// --- Main endpoint ---------------------------------------------------------
fastify.get('/v1/mentions', {
  schema: {
    querystring: mentionsQuery,
    response: {
      200: mentionsResponse,
      400: errorResponse,
      401: errorResponse,
      429: errorResponse,
      502: errorResponse,
    },
  },
}, async (req, reply) => {
  const started = Date.now();
  const { product, sample, agent } = req.query;
  const days = req.query.days; // coerced integer by schema
  const isSandbox = sample === 'true' || sample === '1';

  const key = authKey(req);
  if (!key) return reply.code(401).send({ error: 'missing key', hint: 'Authorization: Bearer <key>' });
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
    const res = store.billCall(biz.id, biz.daily_cap, {
      business_id: biz.id, agent: String(agent || 'unknown').slice(0, 50),
      product: product.slice(0, 100), window: `${days}d`, source: 'live', status: '200', billed: 1,
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

const createBusinessBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    daily_cap: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 500 },
    credits: { type: 'integer', minimum: 0, maximum: 1_000_000, default: 25 },
  },
  required: ['name'],
  additionalProperties: false,
};

fastify.post('/ops/businesses', {
  preHandler: requireOps,
  schema: {
    body: createBusinessBody,
    response: {
      200: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          key: { type: 'string' },
          name: { type: 'string' },
          daily_cap: { type: 'integer' },
          credits: { type: 'integer' },
        },
      },
    },
  },
}, async (req) => {
  const { name, daily_cap: cap, credits: cred } = req.body; // schema-coerced w/ defaults
  const key = store.newKey();
  const info = store.createBusiness.run(key, name.slice(0, 80), cap, cred);
  return { id: Number(info.lastInsertRowid), key, name: name.slice(0, 80), daily_cap: cap, credits: cred }; // key shown ONCE at creation
});

fastify.post('/ops/businesses/:id/credits', {
  preHandler: requireOps,
  schema: {
    params: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
    body: {
      type: 'object',
      properties: { amount: { type: 'integer', minimum: 1, maximum: 1_000_000 } },
      required: ['amount'],
      additionalProperties: false,
    },
    response: {
      200: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' }, credits: { type: 'integer' } },
      },
      404: errorResponse,
    },
  },
}, async (req) => {
  const b = store.getBusiness.get(req.params.id);
  if (!b) throw { statusCode: 404, message: 'business not found' };
  store.addCredits.run(req.body.amount, req.params.id);
  const after = store.getBusiness.get(req.params.id);
  return { id: after.id, name: after.name, credits: after.credits }; // no key echo
});

fastify.get('/ops/receipts', {
  preHandler: requireOps,
  schema: {
    querystring: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
      additionalProperties: false,
    },
  },
}, async (req) => {
  return store.recentCalls.all(req.query.limit);
});

const start = async () => {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`404 Mentions API on :${PORT}${OPS_TOKEN ? ' (ops enabled)' : ' (ops DISABLED — set OPS_TOKEN)'}`);
};

module.exports = { fastify, store, authKey, rateLimited, start };

if (require.main === module) start();

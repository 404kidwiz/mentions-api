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
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const CREDITS_PER_DOLLAR = parseInt(process.env.CREDITS_PER_DOLLAR || '10', 10); // $10 pack = 100 calls

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
  return { ...s, listed_in: [] }; // populated as registry listings go live
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

// --- Stripe billing webhook --------------------------------------------------
// Payment Link carries client_reference_id=<api key> so a purchase maps to the
// right business. On checkout.session.completed we credit:
//   credits = amount_total (cents) / 100 * CREDITS_PER_DOLLAR
// Idempotent: the Stripe event id is recorded; replays credit nothing.
// Signature verification uses req.rawBody (instance-level rawBody: true).
//
// Setup (one-time, needs Stripe auth):
//   1. STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set in Railway vars
//   2. Webhook endpoint: https://<host>/v1/billing/webhook
//      events: checkout.session.completed
//   3. Payment Link: line_items[0][price]=<price id>&client_reference_id
//      is appended by the buy page as ?client_reference_id=<key>
// NOTE: instance-level rawBody:true is broken in fastify 5.12.4 (rawBody never
// populated). Instead we install a custom JSON parser that keeps the raw string
// on req.rawBody for every application/json route. /ops body schemas still work
// because we JSON.parse before calling done — req.body remains an object.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body; // exact bytes as received — required for Stripe HMAC
  try { done(null, JSON.parse(body)); }
  catch (e) { e.statusCode = 400; done(e, undefined); }
});

// New-customer flow: paid session with no (or unknown) client_reference_id
// → auto-issue a business + key, credit the purchase, and persist the key on the
//   Stripe session metadata so the redirect/success page can show it.
// Requires STRIPE_SECRET_KEY write access to update session metadata.
const autoIssueKey = (session, credits, log) => {
  const name = (session.customer_details && session.customer_details.email)
    ? session.customer_details.email
    : 'stripe-buyer';
  const info = store.createBusiness.run(store.newKey(), name, 500, credits);
  const biz = store.getBusiness.get(info.lastInsertRowid);
  // Best-effort: stamp the key onto the session so success-page/ops can surface it
  try {
    require('stripe')(STRIPE_SECRET_KEY).checkout.sessions.update(session.id, {
      metadata: { api_key: biz.key, credits_added: String(credits) },
    }).catch((e) => log && log.warn({ err: e.message, session: session.id }, 'session metadata update failed'));
  } catch (e) {
    if (log) log.warn({ err: e.message }, 'stripe sdk unavailable for metadata update');
  }
  return biz;
};

fastify.post('/v1/billing/webhook', {
  schema: {
    response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
  },
}, async (req, reply) => {
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    return reply.code(503).send({ error: 'billing disabled (Stripe env not set)' });
  }

  const stripe = require('stripe')(STRIPE_SECRET_KEY);

  // Verify signature over the raw body
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    req.log.warn({ err: e.message }, 'stripe signature verification failed');
    return reply.code(400).send({ error: 'invalid signature' });
  }

  if (event.type !== 'checkout.session.completed') {
    return { received: true }; // acknowledge other events without action
  }

  const session = event.data.object;
  const apiKey = session.client_reference_id;
  const eventId = event.id;

  // Idempotency: never credit the same Stripe event twice
  const seen = store.stripeEventSeen.get(eventId);
  if (seen) return { received: true };
  store.recordStripeEvent.run(eventId);

  const dollars = (session.amount_total || 0) / 100;
  const credits = Math.floor(dollars * CREDITS_PER_DOLLAR);
  if (credits <= 0) {
    req.log.error({ eventId, amount_total: session.amount_total }, 'unusable amount_total');
    return { received: true };
  }

  const biz = apiKey ? store.getBusinessByKey.get(apiKey) : null;
  if (biz) {
    store.addCredits.run(credits, biz.id);
    req.log.info({ eventId, biz: biz.id, dollars, credits }, 'credits added via Stripe');
    return { received: true };
  }

  // No matching key → first purchase by a new customer: auto-issue key + credits
  const newBiz = autoIssueKey(session, credits, req.log);
  req.log.info({ eventId, biz: newBiz.id, dollars, credits, key: newBiz.key }, 'new customer: key auto-issued');
  return { received: true };
});

// --- Purchase success page ----------------------------------------------------
// Stripe Payment Link redirects here after payment (?session_id=...). We look up
// the session and show the buyer their API key (set by the webhook via metadata)
// plus a ready-to-copy curl. Falls back to a friendly "processing" page if the
// webhook hasn't landed yet (buyer can refresh).
const successHtml = (key, credits) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Your API key — 404 Mentions</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{background:#0a0a0f;color:#e8e8f0;font-family:-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .card{background:#12121a;border:1px solid #1e1e2e;border-radius:16px;padding:40px;max-width:560px;width:92%}
 h1{font-size:26px;margin:0 0 6px} p{color:#9494a8;font-size:15px}
 .key{background:#0d0d14;border:1px solid #7c5cff;border-radius:10px;padding:14px;font-family:monospace;font-size:16px;color:#00d4aa;margin:18px 0;word-break:break-all}
 pre{background:#0d0d14;border-radius:10px;padding:14px;font-size:13px;overflow-x:auto;color:#c8c8dc}
 a{color:#7c5cff}
</style></head><body><div class="card">
<h1>✅ Payment received — ${credits} credits added</h1>
<p>Save this API key. It's shown only once here (also in your Stripe receipt email context), and credits never expire.</p>
<div class="key">${key}</div>
<pre>curl "https://mentions-api-404-production.up.railway.app/v1/mentions?product=linear.app&days=30" \\
  -H "Authorization: Bearer ${key}"</pre>
<p>Free preview calls: add <b>&amp;sample=true</b> — never billed.<br>
Top up anytime: <a href="https://buy.stripe.com/dRmdR8cJQ3mMdek1wh2Fa00?client_reference_id=${key}">buy 100 more credits</a></p>
</div></body></html>`;

fastify.get('/billing/success', async (req, reply) => {
  if (!STRIPE_SECRET_KEY) return reply.code(503).send({ error: 'billing disabled' });
  const sid = req.query && req.query.session_id;
  if (!sid || !/^cs_(test_)?[A-Za-z0-9]+$/.test(sid)) {
    return reply.code(400).send({ error: 'missing session_id' });
  }
  let session;
  try {
    session = await require('stripe')(STRIPE_SECRET_KEY).checkout.sessions.retrieve(sid);
  } catch (e) {
    return reply.code(404).send({ error: 'session not found' });
  }
  const key = session.metadata && session.metadata.api_key;
  if (key) {
    reply.type('text/html').send(successHtml(key, session.metadata.credits_added || '100'));
  } else {
    // Webhook not landed yet — ask the buyer to refresh in a few seconds
    reply.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Processing…</title></head><body style="background:#0a0a0f;color:#e8e8f0;font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center"><p>Finalizing your purchase… this page refreshes automatically (5s).</p></body></html>`);
  }
});

const start = async () => {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`404 Mentions API on :${PORT}${OPS_TOKEN ? ' (ops enabled)' : ' (ops DISABLED — set OPS_TOKEN)'}${STRIPE_SECRET_KEY ? ' (billing enabled)' : ''}`);
};

module.exports = { fastify, store, authKey, rateLimited, start };

if (require.main === module) start();

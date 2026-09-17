// 404 Mentions API — one endpoint, every agent.
// GET /v1/mentions?product=...&days=90   (header: Authorization: Bearer biz_...)
// Rules: sandbox calls free (sample=true), errors never billed, daily caps enforced.
const fastify = require('fastify')({ logger: true });
const store = require('./db');
const { collectMentions } = require('./collectors');

const PORT = process.env.PORT || 8787;

function authKey(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : req.headers['x-api-key'] || null;
}

fastify.get('/v1/mentions', async (req, reply) => {
  const started = Date.now();
  const { product, days: daysRaw, sample, agent } = req.query;
  const days = parseInt(daysRaw || '90', 10);
  const isSandbox = sample === 'true' || sample === '1';

  if (!product || product.length < 2) {
    return reply.code(400).send({ error: 'missing product', hint: '?product=<name>&days=90' });
  }
  if (isNaN(days) || days < 1 || days > 365) {
    return reply.code(400).send({ error: 'window too long', hint: 'days must be 1-365' });
  }

  const key = authKey(req);
  if (!key) return reply.code(401).send({ error: 'missing key', hint: 'Authorization: Bearer biz_...' });
  const biz = store.getBusinessByKey.get(key);
  if (!biz) return reply.code(401).send({ error: 'invalid key' });

  const log = (status, billed, posts, complaints) => {
    store.insertCall.run({
      business_id: biz.id, agent: agent || 'unknown', product: String(product).slice(0, 100),
      window: `${days}d`, source: isSandbox ? 'sandbox' : 'live', status, billed, posts, complaints,
      latency_ms: Date.now() - started,
    });
  };

  if (!isSandbox) {
    if (biz.credits <= 0) {
      log('429', 0, 0, 0);
      return reply.code(429).send({ error: 'no credits', hint: 'top up at https://404mentions.com' });
    }
    const usedToday = store.callsToday.get(biz.id).n;
    if (usedToday >= biz.daily_cap) {
      log('429', 0, 0, 0);
      return reply.code(429).send({ error: 'daily cap reached', cap: biz.daily_cap });
    }
  }

  let data;
  try {
    data = await collectMentions(String(product), days);
  } catch (e) {
    log('400', 0, 0, 0); // errors never billed
    return reply.code(502).send({ error: 'upstream failure', detail: String(e.message || e) });
  }

  let billed = 0;
  if (!isSandbox) {
    const ok = store.decCredits.run(biz.id);
    billed = ok.changes === 1 ? 1 : 0;
    if (!billed) {
      log('429', 0, data.total, data.complaints);
      return reply.code(429).send({ error: 'no credits' });
    }
  }

  log('200', billed, isSandbox ? null : data.total, isSandbox ? null : data.complaints);

  return {
    product, window: `${days}d`,
    total_mentions: data.total,
    complaints_flagged: data.complaints,
    sources: data.sources,
    sample: isSandbox,
    mentions: isSandbox ? data.mentions.slice(0, 5) : data.mentions,
    credits_remaining: isSandbox ? biz.credits : store.getBusiness.get(biz.id).credits,
  };
});

// Operator endpoints
fastify.get('/ops/stats', async () => {
  const s = store.stats.get();
  return { ...s, listed_in: ['skills.sh', 'agentskills.io', 'clawhub'] };
});

fastify.post('/ops/businesses', async (req) => {
  const { name, daily_cap, credits } = req.body || {};
  if (!name) throw { statusCode: 400, message: 'name required' };
  const key = store.newKey();
  const info = store.createBusiness.run(key, String(name).slice(0, 80), daily_cap || 500, credits ?? 25);
  return { id: info.lastInsertRowid, key, name, daily_cap: daily_cap || 500, credits: credits ?? 25 };
});

fastify.post('/ops/businesses/:id/credits', async (req) => {
  const { amount } = req.body || {};
  const n = parseInt(amount, 10);
  if (isNaN(n) || n <= 0) throw { statusCode: 400, message: 'amount must be positive' };
  store.addCredits.run(n, req.params.id);
  return store.getBusiness.get(req.params.id);
});

fastify.get('/ops/receipts', async (req) => {
  const n = Math.min(parseInt(req.query.limit || '25', 10), 100);
  return store.recentCalls.all(n);
});

const start = async () => {
  await fastify.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`404 Mentions API on :${PORT}`);
};
start();

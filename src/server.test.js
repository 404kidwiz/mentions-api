// 404 Mentions API — inject() test suite (no port, no network, no env hang).
// Run: node --test src/server.test.js   (needs COLLECTORS_MODULE stub)
//
// Strategy: the server supports a COLLECTORS_MODULE env seam that swaps the
// collector implementation. We generate a stub module in a temp dir that
// returns deterministic mentions, so billing/auth/cap logic is tested fully
// offline against a throwaway SQLite DB (DATA_DIR pointed at a tmp folder).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Build the stub collector BEFORE requiring the server -------------------
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentions-stub-'));
let stubMode = 'ok'; // ok | fail | slow
fs.writeFileSync(path.join(stubDir, 'collectors-stub.js'), `
let mode = 'ok';
module.exports = {
  setMode(m) { mode = m; },
  async collectMentions(product, days) {
    if (mode === 'fail') throw new Error('stub: all sources failed');
    return {
      mentions: [
        { source: 'reddit', title: 'x is broken', text: 'refund please', created_utc: ${Math.floor(Date.now() / 1000) - 100}, url: 'https://reddit.com/r/t/1', num_comments: 2, subreddit: 't', score: 5 },
        { source: 'hn', title: 'nice tool', text: 'love it', created_utc: ${Math.floor(Date.now() / 1000) - 200}, url: 'https://news.ycombinator.com/item?id=1', points: 3, num_comments: 0 },
      ],
      total: 2,
      complaints: 1,
      sources: { reddit: 1, hn: 1 },
      truncated: false,
      partial_failure: null,
    };
  },
};
`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentions-data-'));
process.env.DATA_DIR = dataDir;
process.env.COLLECTORS_MODULE = path.join(stubDir, 'collectors-stub.js');
process.env.OPS_TOKEN = 'test-ops-token';
delete process.env.PORT; // never bind: inject() doesn't need it

const { fastify, store } = require('./server');
const stub = require(process.env.COLLECTORS_MODULE);

// --- Fixtures ---------------------------------------------------------------
const KEY = 'biz_testkey123';
let bizId;
test.before(async () => {
  const info = store.createBusiness.run(KEY, 'Test Biz', 2, 3); // cap 2/day, 3 credits
  bizId = Number(info.lastInsertRowid);
});

test.after(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${KEY}` };
const call = (query, extraHeaders = {}) =>
  fastify.inject({ method: 'GET', url: `/v1/mentions${query}`, headers: { ...auth, ...extraHeaders } });

// --- Validation (schema layer) ---------------------------------------------
test('400: missing product', async () => {
  const r = await call('');
  assert.equal(r.statusCode, 400);
});

test('400: product too short', async () => {
  const r = await call('?product=x');
  assert.equal(r.statusCode, 400);
});

test('400: days out of range', async () => {
  const r = await call('?product=widget&days=999');
  assert.equal(r.statusCode, 400);
});

test('400: days non-numeric rejected by schema coercion', async () => {
  const r = await call('?product=widget&days=abc');
  assert.equal(r.statusCode, 400);
});

// --- Auth -------------------------------------------------------------------
test('401: no key', async () => {
  const r = await fastify.inject({ method: 'GET', url: '/v1/mentions?product=widget' });
  assert.equal(r.statusCode, 401);
});

test('401: invalid key', async () => {
  const r = await fastify.inject({ method: 'GET', url: '/v1/mentions?product=widget', headers: { authorization: 'Bearer nope' } });
  assert.equal(r.statusCode, 401);
});

test('401 also via x-api-key path works when valid', async () => {
  const r = await fastify.inject({ method: 'GET', url: '/v1/mentions?product=widget&sample=true', headers: { 'x-api-key': KEY } });
  assert.equal(r.statusCode, 200);
});

// --- Sandbox (free, capped at 5 mentions) ----------------------------------
test('sandbox call: free, sampled to 5, not billed', async () => {
  const r = await call('?product=widget&sample=true');
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.sample, true);
  assert.ok(b.mentions.length <= 5);
  assert.equal(b.credits_remaining, 3); // unchanged
});

// --- Live billing (atomic) --------------------------------------------------
test('live call bills exactly 1 credit', async () => {
  const r = await call('?product=widget');
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.sample, false);
  assert.equal(b.credits_remaining, 2);
});

test('upstream failure: 502, never billed, receipt written', async () => {
  stub.setMode('fail');
  const before = JSON.parse((await fastify.inject({ method: 'GET', url: '/ops/receipts?limit=100', headers: { authorization: 'Bearer test-ops-token' } })).body);
  const r = await call('?product=widget');
  assert.equal(r.statusCode, 502);
  const after = JSON.parse((await fastify.inject({ method: 'GET', url: '/ops/receipts?limit=100', headers: { authorization: 'Bearer test-ops-token' } })).body);
  assert.equal(after.length, before.length + 1);
  assert.equal(after[0].status, '502');
  assert.equal(after[0].billed, 0);
  stub.setMode('ok');
});

test('daily cap reached: 429, not billed', async () => {
  // cap is 2/day; one live call already used. This is the 2nd (ok), then 3rd must CAP.
  const r2 = await call('?product=widget');
  assert.equal(r2.statusCode, 200);
  const r3 = await call('?product=widget');
  assert.equal(r3.statusCode, 429);
  const b = JSON.parse(r3.body);
  assert.match(b.error, /daily cap/);
});

test('no credits: 429', async () => {
  // fresh business with 0 credits
  store.createBusiness.run('biz_zero', 'Zero', 500, 0);
  const r = await fastify.inject({ method: 'GET', url: '/v1/mentions?product=widget', headers: { authorization: 'Bearer biz_zero' } });
  assert.equal(r.statusCode, 429);
  assert.match(JSON.parse(r.body).error, /no credits/);
});

// --- Rate limit -------------------------------------------------------------
test('rate limit kicks in after 30 calls/min per key+mode', async () => {
  store.createBusiness.run('biz_ratelimit', 'RL', 100000, 100000);
  let saw429 = false;
  for (let i = 0; i < 35; i++) {
    const r = await fastify.inject({ method: 'GET', url: '/v1/mentions?product=widget&sample=true', headers: { authorization: 'Bearer biz_ratelimit' } });
    if (r.statusCode === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, 'expected a 429 within 35 rapid calls');
});

// --- Ops routes -------------------------------------------------------------
test('ops: 503 without token config is bypassed — invalid token 401', async () => {
  const r = await fastify.inject({ method: 'GET', url: '/ops/stats', headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.statusCode, 401);
});

test('ops: stats with valid token', async () => {
  const r = await fastify.inject({ method: 'GET', url: '/ops/stats', headers: { authorization: 'Bearer test-ops-token' } });
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.ok('calls_total' in b);
});

test('ops: create business validates body via schema (missing name → 400)', async () => {
  const r = await fastify.inject({
    method: 'POST', url: '/ops/businesses',
    headers: { authorization: 'Bearer test-ops-token', 'content-type': 'application/json' },
    payload: { daily_cap: 10 },
  });
  assert.equal(r.statusCode, 400);
});

test('ops: create business happy path returns key once', async () => {
  const r = await fastify.inject({
    method: 'POST', url: '/ops/businesses',
    headers: { authorization: 'Bearer test-ops-token', 'content-type': 'application/json' },
    payload: { name: 'New Biz', daily_cap: 10, credits: 5 },
  });
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.match(b.key, /^biz_/);
  assert.equal(b.credits, 5);
});

test('ops: add credits rejects bad amount via schema', async () => {
  const r = await fastify.inject({
    method: 'POST', url: `/ops/businesses/${bizId}/credits`,
    headers: { authorization: 'Bearer test-ops-token', 'content-type': 'application/json' },
    payload: { amount: -5 },
  });
  assert.equal(r.statusCode, 400);
});

test('ops: add credits happy path', async () => {
  const r = await fastify.inject({
    method: 'POST', url: `/ops/businesses/${bizId}/credits`,
    headers: { authorization: 'Bearer test-ops-token', 'content-type': 'application/json' },
    payload: { amount: 10 },
  });
  assert.equal(r.statusCode, 200);
  assert.ok(JSON.parse(r.body).credits >= 10);
});

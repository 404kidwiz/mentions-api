#!/usr/bin/env node
// Edge-case matrix v2: auth, ops-lockdown, caps, concurrency, validation.
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const OPS = process.env.OPS_TOKEN || '';
const j = (r) => r.json();
let fails = 0;
const assert = (name, cond, extra) => {
  if (!cond) { console.error('FAIL:', name, JSON.stringify(extra)); fails++; }
  else console.log('PASS:', name);
};

(async () => {
  // 1. ops routes locked without/bad token
  let r = await fetch(`${BASE}/ops/stats`);
  assert('ops/stats no token rejected', r.status === 401 || r.status === 503);
  r = await fetch(`${BASE}/ops/stats`, { headers: { Authorization: 'Bearer wrong' } });
  assert('ops/stats bad token rejected', r.status === 401 || r.status === 503);

  // 2. create with ops token; key shown once at creation
  r = await fetch(`${BASE}/ops/businesses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPS}` },
    body: JSON.stringify({ name: 'edge', daily_cap: 2, credits: 2 }),
  });
  const biz = await j(r);
  assert('create with ops token works', r.status === 200 && !!biz.id && !!biz.key);
  const k = { Authorization: `Bearer ${biz.key}` };

  // 3. daily_cap=0 preserved
  const capZero = await j(await fetch(`${BASE}/ops/businesses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPS}` },
    body: JSON.stringify({ name: 'capzero', daily_cap: 0, credits: 5 }),
  }));
  assert('daily_cap=0 preserved', capZero.daily_cap === 0);

  // 4. invalid credits rejected
  r = await fetch(`${BASE}/ops/businesses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPS}` },
    body: JSON.stringify({ name: 'bad', credits: 'unlimited' }),
  });
  assert('credits="unlimited" rejected', r.status === 400);

  // 5. receipts limit bypass rejected
  r = await fetch(`${BASE}/ops/receipts?limit=-1`, { headers: { Authorization: `Bearer ${OPS}` } });
  assert('limit=-1 rejected', r.status === 400);

  // 6. top-up does NOT echo the key
  r = await fetch(`${BASE}/ops/businesses/${biz.id}/credits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPS}` },
    body: JSON.stringify({ amount: 1 }),
  });
  const topped = await j(r);
  assert('top-up works', r.status === 200 && topped.credits === 3);
  assert('top-up does not echo key', !topped.key);

  // 7. repeated agent param → 400 before billing (not 500 after)
  r = await fetch(`${BASE}/v1/mentions?product=desk&agent=a&agent=b`, { headers: k });
  assert('repeated agent param → 400', r.status === 400, await j(r).catch(() => ({})));

  // 8. invalid key + no auth
  r = await fetch(`${BASE}/v1/mentions?product=desk`, { headers: { Authorization: 'Bearer biz_bogus' } });
  assert('invalid key → 401', r.status === 401);
  r = await fetch(`${BASE}/v1/mentions?product=desk`);
  assert('no auth → 401', r.status === 401);

  // 9. bad window
  r = await fetch(`${BASE}/v1/mentions?product=desk&days=400`, { headers: k });
  assert('days=400 → 400', r.status === 400);

  // 10. CONCURRENCY: fire 5 parallel live calls with 2 credits & cap 2 → exactly 2 succeed
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    fetch(`${BASE}/v1/mentions?product=desk&days=7`, { headers: k }).then(x => x.status)
  ));
  const ok200 = results.filter(s => s === 200).length;
  assert('concurrent: exactly 2 billed (credits=2)', ok200 === 2, results);
  assert('concurrent: 3 rejected with 429', results.filter(s => s === 429).length === 3, results);

  // 11. receipts exist for every billed call (no charge without receipt)
  const receipts = await j(await fetch(`${BASE}/ops/receipts?limit=10`, { headers: { Authorization: `Bearer ${OPS}` } }));
  const billed = receipts.filter(x => x.business_id === biz.id && x.billed === 1).length;
  assert('billed receipts == 2', billed === 2, billed);

  // 12. sandbox still free
  r = await fetch(`${BASE}/v1/mentions?product=desk&days=7&sample=true`, { headers: k });
  assert('sandbox free at 0 credits', r.status === 200);

  console.log(fails ? `EDGE: ${fails} FAILURES` : 'EDGE: ALL PASS');
  process.exit(fails ? 1 : 0);
})();

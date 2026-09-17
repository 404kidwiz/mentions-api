#!/usr/bin/env node
// Edge-case matrix: auth, caps, invalid key, window bounds.
const BASE = 'http://127.0.0.1:8791';
const j = (r) => r.json();
const assert = (name, cond, extra) => {
  if (!cond) { console.error('FAIL:', name, JSON.stringify(extra)); process.exitCode = 1; }
  else console.log('PASS:', name);
};

(async () => {
  // invalid key
  let r = await fetch(`${BASE}/v1/mentions?product=desk`, { headers: { Authorization: 'Bearer biz_bogus' } });
  assert('invalid key -> 401', r.status === 401, await j(r));

  // no auth
  r = await fetch(`${BASE}/v1/mentions?product=desk`);
  assert('no auth -> 401', r.status === 401, await j(r));

  // valid biz + bad window
  const biz = await j(await fetch(`${BASE}/ops/businesses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'edge', daily_cap: 2, credits: 2 }),
  }));
  r = await fetch(`${BASE}/v1/mentions?product=desk&days=400`, { headers: { Authorization: `Bearer ${biz.key}` } });
  assert('days=400 -> 400', r.status === 400, await j(r));

  // exhaust credits (2 calls, cap 2)
  const k = { Authorization: `Bearer ${biz.key}` };
  r = await fetch(`${BASE}/v1/mentions?product=desk&days=7`, { headers: k });
  assert('call 1 billed', r.status === 200 && (await j(r)).credits_remaining === 1);
  r = await fetch(`${BASE}/v1/mentions?product=desk&days=7`, { headers: k });
  assert('call 2 billed', r.status === 200 && (await j(r)).credits_remaining === 0);
  r = await fetch(`${BASE}/v1/mentions?product=desk&days=7`, { headers: k });
  assert('credits exhausted -> 429', r.status === 429, await j(r));

  // top-up then call again
  await fetch(`${BASE}/ops/businesses/${biz.id}/credits`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 1 }),
  });
  r = await fetch(`${BASE}/v1/mentions?product=desk&days=7&sample=true`, { headers: k });
  assert('sandbox works at 0 credits (cap counts billed only)', r.status === 200, await j(r));

  console.log(process.exitCode ? 'EDGE: FAILURES' : 'EDGE: ALL PASS');
})();

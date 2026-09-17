#!/usr/bin/env node
// E2E verification: fresh business, sandbox call, billed call, receipt audit.
const BASE = 'http://127.0.0.1:8791';
const j = (r) => r.json();

(async () => {
  const biz = await j(await fetch(`${BASE}/ops/businesses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'verify brand' }),
  }));
  console.log('KEY:', biz.key, '| credits:', biz.credits);

  const sbx = await j(await fetch(`${BASE}/v1/mentions?product=sony wh-1000xm5&days=180&sample=true&agent=verify`,
    { headers: { Authorization: `Bearer ${biz.key}` } }));
  console.log('SANDBOX:', sbx.total_mentions, 'mentions |', sbx.complaints_flagged, 'complaints | sample:', sbx.sample, '| credits left:', sbx.credits_remaining);

  const live = await j(await fetch(`${BASE}/v1/mentions?product=sony wh-1000xm5&days=180&agent=verify`,
    { headers: { Authorization: `Bearer ${biz.key}` } }));
  console.log('LIVE   :', live.total_mentions, 'mentions |', live.complaints_flagged, 'complaints | credits left:', live.credits_remaining, '| sources:', JSON.stringify(live.sources));

  const receipts = await j(await fetch(`${BASE}/ops/receipts?limit=4`));
  for (const r of receipts) {
    console.log(`RECEIPT #${r.id}: ${r.status} | billed=${r.billed} | ${r.product} ${r.window} | ${r.posts} posts | ${r.latency_ms}ms | ${r.created_at}`);
  }

  const s = await j(await fetch(`${BASE}/ops/stats`));
  console.log('STATS:', JSON.stringify(s));
})();

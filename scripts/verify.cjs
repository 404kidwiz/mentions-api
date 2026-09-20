#!/usr/bin/env node
// E2E verification: fresh business, sandbox call, billed call, receipt audit.
// Keys are REDACTED in all output.
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const OPS = process.env.OPS_TOKEN || '';
const j = (r) => r.json();
const mask = (k) => k.slice(0, 6) + '…REDACTED';

(async () => {
  const biz = await j(await fetch(`${BASE}/ops/businesses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${OPS}` },
    body: JSON.stringify({ name: 'verify brand' }),
  }));
  if (!biz.key) { console.error('create failed:', biz); process.exit(1); }
  console.log('KEY:', mask(biz.key), '| credits:', biz.credits);

  const sbx = await j(await fetch(`${BASE}/v1/mentions?product=sony wh-1000xm5&days=180&sample=true&agent=verify`,
    { headers: { Authorization: `Bearer ${biz.key}` } }));
  console.log('SANDBOX:', sbx.total_mentions, 'mentions |', sbx.complaints_flagged, 'complaints | sample:', sbx.sample, '| credits left:', sbx.credits_remaining);

  const live = await j(await fetch(`${BASE}/v1/mentions?product=sony wh-1000xm5&days=180&agent=verify`,
    { headers: { Authorization: `Bearer ${biz.key}` } }));
  console.log('LIVE   :', live.total_mentions, 'mentions |', live.complaints_flagged, 'complaints | credits left:', live.credits_remaining, '| sources:', JSON.stringify(live.sources), '| truncated:', live.truncated);
  if (sbx.credits_remaining !== live.credits_remaining + 1) {
    console.error('BILLING FAIL: sandbox/live credit delta wrong'); process.exit(1);
  }

  const receipts = await j(await fetch(`${BASE}/ops/receipts?limit=4`, { headers: { Authorization: `Bearer ${OPS}` } }));
  for (const r of receipts) {
    console.log(`RECEIPT #${r.id}: ${r.status} | billed=${r.billed} | ${r.product} ${r.window} | ${r.posts ?? '-'} posts | ${r.latency_ms}ms`);
  }
  const billedCount = receipts.filter(r => r.billed === 1).length;
  if (billedCount < 1) { console.error('BILLING FAIL: no billed receipt for live call'); process.exit(1); }

  const s = await j(await fetch(`${BASE}/ops/stats`, { headers: { Authorization: `Bearer ${OPS}` } }));
  console.log('STATS:', JSON.stringify(s));
  console.log('VERIFY: PASS');
})();

#!/usr/bin/env node
// Verify the PRODUCTION deployment end-to-end.
const BASE = 'https://mentions-api-404-production.up.railway.app';
const j = (r) => r.json();
(async () => {
  const biz = await j(await fetch(`${BASE}/ops/businesses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'production check' }),
  }));
  console.log('KEY:', biz.key, '| credits:', biz.credits);

  const sbx = await j(await fetch(`${BASE}/v1/mentions?product=ray-ban meta glasses&days=365&sample=true&agent=prodcheck`,
    { headers: { Authorization: `Bearer ${biz.key}` } }));
  console.log('SANDBOX:', sbx.total_mentions, 'mentions |', sbx.complaints_flagged, 'complaints | credits:', sbx.credits_remaining);

  const live = await j(await fetch(`${BASE}/v1/mentions?product=ray-ban meta glasses&days=365&agent=prodcheck`,
    { headers: { Authorization: `Bearer ${biz.key}` } }));
  console.log('LIVE   :', live.total_mentions, 'mentions |', live.complaints_flagged, 'complaints | credits:', live.credits_remaining);

  const noauth = await fetch(`${BASE}/v1/mentions?product=test`, {});
  console.log('NO AUTH:', noauth.status, '(expect 401)');

  const s = await j(await fetch(`${BASE}/ops/stats`));
  console.log('STATS:', JSON.stringify(s));
  if (live.total_mentions >= 0 && noauth.status === 401) console.log('PRODUCTION VERIFY: PASS');
  else { console.log('PRODUCTION VERIFY: FAIL'); process.exit(1); }
})();

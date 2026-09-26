# 404 Mentions API

One endpoint. Every agent. Social listening for any product — pay per call.

**Live:** https://mentions-api-404-production.up.railway.app

**Get a key / top up:** https://buy.stripe.com/dRmdR8cJQ3mMdek1wh2Fa00 — $10 = 100 credits (append `?client_reference_id=<your_api_key>` so credits land on your key automatically).

**What it does:** `GET /v1/mentions?product=<name>&days=90` returns total mentions, complaint count, and post samples from public sources (Hacker News via Algolia; Reddit ready to enable with an app credential).

**Use when:** an agent needs to know what people said about a product/brand/topic over a time window — complaints, sentiment signals, post counts, sample links.

## Calling it

```
curl "https://<host>/v1/mentions?product=standing%20desk&days=90" \
  -H "Authorization: Bearer biz_YOURKEY"
```

- Free sandbox call: add `&sample=true` (5 sample posts, never billed)
- Window: 1–365 days
- Errors are never billed
- Daily caps per key (default 500 billable calls/day)

## Response

```json
{
  "product": "standing desk",
  "window": "90d",
  "total_mentions": 67,
  "complaints_flagged": 3,
  "sources": { "hn": 67, "reddit": null },
  "sample": false,
  "mentions": [ { "title": "...", "url": "...", "points": 15, "created_utc": 0 } ],
  "credits_remaining": 24
}
```

## Operator endpoints (you)

- `POST /ops/businesses` `{name, daily_cap?, credits?}` → creates key
- `POST /ops/businesses/:id/credits` `{amount}` → top-up (Stripe hook target)
- `GET /ops/stats`, `GET /ops/receipts?limit=25`

## Run

```
PORT=8791 node src/server.js     # sqlite at ./data/mentions.db
node scripts/verify.cjs          # e2e check
```

## Pricing

$20 prepaid = 500 credits (1 credit = 1 billable call, errors excluded).

## Roadmap

- [ ] Reddit source: create app at reddit.com/prefs/apps → client_id/secret → OAuth app-only grant (~15 min)
- [ ] Deploy: Fly.io / Railway, public HTTPS URL
- [ ] Stripe: Payment Link + webhook → `POST /ops/businesses/:id/credits`
- [ ] Registry listings: skills.sh, agentskills.io, clawhub
- [ ] Rate limit by IP too; add /v1/mentions:summary cheap tier

---
name: mentions-api
description: Track where a product is mentioned across Reddit and Hacker News via the 404 Mentions API. Use when the user asks "who's talking about X", "find mentions of my product", competitive monitoring, or launch-reaction tracking. Returns recent mentions with source, score, and links; sandbox calls are free.
license: MIT
compatibility: Requires network access and an API key from https://404mentions.com (free sandbox samples without billing)
---

# 404 Mentions API — product mention tracking

Find where a product or topic is being discussed on Reddit and Hacker News.

## Endpoint

GET `https://mentions-api-404-production.up.railway.app/v1/mentions`

Header: `Authorization: Bearer <API_KEY>`

| Param | Values | Notes |
| --- | --- | --- |
| `product` | any name, e.g. `linear.app` | ≥2 chars, required |
| `days` | 1–365 | lookback window, default 7 |
| `sample` | `true` | sandbox mode — free, no credits billed |

## Quick test (no key needed for a feel of the shape — get a key at 404mentions.com)

```bash
curl -H "Authorization: Bearer $MENTIONS_KEY" \
  "https://mentions-api-404-production.up.railway.app/v1/mentions?product=linear.app&days=30"
```

Response: recent mentions (`source`, `title`, `url`, `score`, `created`), plus `credits_remaining`.

## Workflow

1. Run with `sample=true` first to preview results for free.
2. Remove `sample` for the full live pull — bills 1 credit per call.
3. Daily cap enforced server-side; errors are never billed.

## Getting a key / topping up

- Keys and credit packs: **https://404mentions.com** — $10 = 100 credits via Stripe.
- Top-up link pattern: append `?client_reference_id=<your_api_key>` to the buy link so credits land on your key automatically.

## Tips

- Query the bare domain (`linear.app`) rather than the brand word — matches more Reddit/HN titles.
- Rate limit: 429 means slow down; 401 means bad key.

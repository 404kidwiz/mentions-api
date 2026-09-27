# PRODUCT.md — 404 Mentions API

## What it is
A credit-metered REST API that answers "who is talking about my product?" — one GET endpoint scans Hacker News (Reddit partial) for mentions of any product/domain/brand and returns structured JSON (totals, complaint counts, post samples with scores + permalinks).

## Who it's for
1. **Primary: AI agents and their operators.** Claude/Codex/OpenClaw agents doing competitive research, launch monitoring, customer discovery. They install the skill, learn the endpoint, call it. The landing page's job is to convince the *human operator* the API is legit and the funnel is safe.
2. **Secondary: indie/SaaS builders** who want cheap social listening without a $99/mo SaaS.

## What the visitor must do
Decide and act: buy $10 → 100 credits via Stripe. (Free sandbox = no key billing; used as trust-builder, not primary CTA.)

## Truths that must not be faked
- One endpoint: GET /v1/mentions?product=…&days=1-365
- sample=true → free, real preview posts, never billed
- Live call = 1 credit; errors never billed; daily cap per key
- $10 one-time = 100 credits, never expire
- Key auto-issued on payment (Stripe webhook → success page shows it)
- HN works; Reddit currently degrades to partial_failure (datacenter IP) — honest status, never billed for failed sources
- Registries: skills.sh + ClawHub; repo github.com/404kidwiz/mentions-api

## Surface: landing page (docs/index.html → GH Pages)
Mode: **Persuade**. Visitor success = click the Stripe buy link understanding exactly what 100 credits buys.

## Brand
404 Technologies / "The Wiz" / @404kidwiz. Dark, terminal-native, developer-honest. The product IS a terminal-shaped API — the design should feel like it belongs on a hacker's machine, not a marketing agency's portfolio.

# Show HN draft — 404 Mentions API

**Title (under 80 chars):**
Show HN: 404 Mentions – One API call to find every Hacker News mention of your product

**URL:** https://404kidwiz.github.io/mentions-api/

**Text (Show HN posts can include a text body):**

Hi — I built a small API that answers one question: who is talking about my product?

One GET request scans Hacker News for any product or domain and returns mention totals, complaint counts, and post samples (title, score, permalink) as JSON. $10 once = 100 calls, no subscription, credits never expire. There's a free sandbox on the landing page — no key needed, try it right in the page.

Why: I kept wanting "Google Alerts but for HN, as an API" when checking on side projects, and nothing fit. So this is deliberately tiny — one endpoint, three params, honest failure modes (errors never bill, blocked sources degrade to partial_failure).

Built for AI agents primarily — it ships as an installable skill, so Claude/Codex agents can check mentions of anything during research tasks. Humans with curl work fine too.

Would genuinely appreciate feedback on: the pricing ($0.10/call feels right for agent budgets?), what sources to add next (Reddit is in progress), and whether a "watch mode" (daily digest of new mentions for a product) would be worth building.

---

**Follow-up comments ready:**
- On data freshness: "Search is live per call — we hit the Algolia HN API (stories + comments) and Reddit, filtered to your 1–365 day window."
- On why not free: "Free tier = unlimited sandbox calls with 5 sample posts. Paid tier exists because agents burn through calls and I didn't want a meter anxiety subscription."
- On roadmap: "Reddit OAuth is landing this week (HN-only today). Watch-mode digests and a Slack webhook delivery are next if there's demand."

// Collectors — legal/allowable sources only.
// Reddit: public JSON endpoints (www.reddit.com/search.json) with UA header.
// Hacker News: official Algolia API (free, documented).
const UA = '404mentions/1.0 (agent-api; contact: 404kidwiz@gmail.com)';

async function fetchJSON(url, timeoutMs = 10000, extraHeaders = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// Reddit: OAuth app-only (client_credentials) when REDDIT_CLIENT_ID/SECRET are set;
// falls back to public JSON endpoints (currently 403-blocked in most environments).
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || null;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || null;

let redditToken = null; // { token, expiresAt }
async function redditOAuthToken() {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return null;
  if (redditToken && Date.now() < redditToken.expiresAt - 60_000) return redditToken.token;
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`reddit oauth HTTP ${res.status}`);
  const j = await res.json();
  redditToken = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return redditToken.token;
}

// Reddit search — max ~100 posts per query.
async function redditMentions(product, limit = 100) {
  const q = encodeURIComponent(product);
  const token = await redditOAuthToken();
  const base = token
    ? `https://oauth.reddit.com/search?q=${q}`
    : `https://www.reddit.com/search.json?q=${q}`;
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const j = await fetchJSON(`${base}&sort=new&t=year&limit=${Math.min(limit, 100)}`, 10000, headers);
  const posts = (j.data && j.data.children) || [];
  return posts.map(p => ({
    source: 'reddit',
    title: p.data.title || '',
    text: (p.data.selftext || '').slice(0, 500),
    subreddit: p.data.subreddit,
    score: p.data.score,
    created_utc: p.data.created_utc,
    url: 'https://reddit.com' + p.data.permalink,
    num_comments: p.data.num_comments || 0,
  }));
}

// Hacker News via Algolia — official free API, supports date ranges. Stories + comments.
async function hnSearch(product, days, tags) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const q = encodeURIComponent(product);
  const j = await fetchJSON(
    `https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=${tags}&numericFilters=created_at_i>${since}&hitsPerPage=100`
  );
  return (j.hits || []).map(h => ({
    source: 'hn',
    title: h.title || h.story_title || (h.comment_text || '').slice(0, 120) || '',
    text: (h.comment_text || h.url || '').slice(0, 300),
    points: h.points,
    created_utc: h.created_at_i,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    num_comments: h.num_comments || 0,
  }));
}

async function hnMentions(product, days = 90) {
  const [stories, comments] = await Promise.allSettled([
    hnSearch(product, days, 'story'),
    hnSearch(product, days, 'comment'),
  ]);
  const out = [];
  if (stories.status === 'fulfilled') out.push(...stories.value);
  if (comments.status === 'fulfilled') out.push(...comments.value);
  if (!out.length && comments.status === 'rejected' && stories.status === 'rejected') {
    throw stories.reason || comments.reason;
  }
  return out;
}

const COMPLAINT_RE = /\b(broke|broken|refund|scam|terrible|awful|worst|return(ed|ing)?|cancel|disappointed|issue|problem|defect|faulty|never again|waste)\b/i;
function isComplaint(m) {
  return COMPLAINT_RE.test(m.title) || COMPLAINT_RE.test(m.text);
}

async function collectMentions(product, days) {
  const [reddit, hn] = await Promise.allSettled([redditMentions(product), hnMentions(product, days)]);
  const all = [];
  if (reddit.status === 'fulfilled') all.push(...reddit.value);
  if (hn.status === 'fulfilled') all.push(...hn.value);
  // If EVERY configured source failed, that's an upstream failure — never bill.
  if (!all.length && reddit.status === 'rejected' && hn.status === 'rejected') {
    throw new Error(`all sources failed: ${String(hn.reason || reddit.reason)}`);
  }
  // filter by window
  const sinceMs = Date.now() - days * 86400 * 1000;
  const inWindow = all.filter(m => (m.created_utc || 0) * 1000 >= sinceMs);
  const complaints = inWindow.filter(isComplaint).length;
  // source counts reflect FILTERED (in-window) results, not raw search hits
  const inWinReddit = inWindow.filter(m => m.source === 'reddit').length;
  const inWinHn = inWindow.filter(m => m.source === 'hn').length;
  // truncated = we hit a search-result cap, so counts are bounded, not exhaustive
  const truncated =
    (reddit.status === 'fulfilled' && reddit.value.length >= 100) ||
    (hn.status === 'fulfilled' && hn.value.length >= 200);
  return {
    mentions: inWindow.slice(0, 200),
    total: inWindow.length,
    complaints,
    sources: {
      reddit: reddit.status === 'fulfilled' ? inWinReddit : null,
      hn: hn.status === 'fulfilled' ? inWinHn : null,
    },
    truncated: !!truncated,
    partial_failure: reddit.status === 'rejected' || hn.status === 'rejected' || null,
  };
}

module.exports = { collectMentions, isComplaint };

// Collectors — legal/allowable sources only.
// Reddit: public JSON endpoints (www.reddit.com/search.json) with UA header.
// Hacker News: official Algolia API (free, documented).
const UA = '404mentions/1.0 (agent-api; contact: 404kidwiz@gmail.com)';

async function fetchJSON(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// Reddit public search JSON — max ~100 posts per query.
async function redditMentions(product, limit = 100) {
  const q = encodeURIComponent(product);
  const j = await fetchJSON(`https://www.reddit.com/search.json?q=${q}&sort=new&t=year&limit=${Math.min(limit, 100)}`);
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
    url: `https://news.ycombinator.com/item?id=${h.story_id || h.objectID}`,
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
  // filter by window
  const sinceMs = Date.now() - days * 86400 * 1000;
  const inWindow = all.filter(m => (m.created_utc || 0) * 1000 >= sinceMs);
  const complaints = inWindow.filter(isComplaint).length;
  return {
    mentions: inWindow.slice(0, 200),
    total: inWindow.length,
    complaints,
    sources: {
      reddit: reddit.status === 'fulfilled' ? reddit.value.length : null,
      hn: hn.status === 'fulfilled' ? hn.value.length : null,
    },
  };
}

module.exports = { collectMentions, isComplaint };

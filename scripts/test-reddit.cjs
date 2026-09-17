// Test Reddit app-only OAuth (installed-client grant) vs old public JSON
const UA = '404mentions/1.0 (agent-api; contact: 404kidwiz@gmail.com)';

async function test() {
  // 1. token
  const basic = Buffer.from('pWAkNcD9R7_TlAqZTM7iGw:').toString('base64');
  const devId = require('crypto').createHash('md5').update('404mentions').digest('hex');
  const tr = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: `grant_type=https://oauth.reddit.com/grants/installed_client&device_id=${devId}`,
  });
  const tok = await tr.json();
  console.log('token status:', tr.status, 'type:', tok.token_type, tok.error || '', 'len:', (tok.access_token||'').length);
  if (!tok.access_token) return;

  // 2. search with token
  const sr = await fetch('https://oauth.reddit.com/search?q=standing%20desk&limit=3&sort=new&t=year', {
    headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': UA },
  });
  console.log('search status:', sr.status);
  if (sr.ok) {
    const j = await sr.json();
    console.log('posts:', j.data.children.length, j.data.children.map(c => c.data.subreddit));
  } else {
    console.log((await sr.text()).slice(0, 200));
  }
}
test().catch(e => console.error('FAIL', e.message));

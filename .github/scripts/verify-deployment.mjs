// Manual deployment verification: credentials and sessions remain in memory.
// Reads application data, connects to realtime services, and logs out afterward.
import assert from 'node:assert/strict';

const origin = process.env.EDGECHAT_SITE_URL;
let token = '';
let stage = 'configuration';
let failed = false;

async function request(path, { method = 'GET', body, authenticated = false } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  return response;
}

async function realtime(path) {
  const url = new URL(path, origin);
  url.protocol = 'wss:';
  url.searchParams.set('token', token);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(false), 20000);
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (ok) resolve();
      else reject(new Error('Realtime verification failed'));
    }
    socket.addEventListener('message', (event) => {
      try { finish(JSON.parse(event.data).type === 'ready'); }
      catch { finish(false); }
    });
    socket.addEventListener('error', () => finish(false));
    socket.addEventListener('close', () => finish(false));
  });
}

try {
  assert.equal(new URL(origin).protocol, 'https:');
  assert.ok(process.env.EDGECHAT_ADMIN_USERNAME);
  assert.ok(process.env.EDGECHAT_ADMIN_PASSWORD);
  stage = 'HTTPS and frontend';
  const page = await request('/');
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /<div id="app"><\/div>/);
  stage = 'health and public database access';
  assert.equal((await (await request('/api/health')).json()).ok, true);
  assert.ok((await (await request('/api/site')).json()).site);
  stage = 'anonymous access protection';
  assert.equal((await fetch(new URL('/api/admin/overview', origin), {
    signal: AbortSignal.timeout(20000),
  })).status, 401);
  stage = 'administrator login';
  const login = await (await request('/api/auth/login', {
    method: 'POST',
    body: {
      username: process.env.EDGECHAT_ADMIN_USERNAME,
      password: process.env.EDGECHAT_ADMIN_PASSWORD,
    },
  })).json();
  token = login.token;
  assert.ok(token);
  assert.equal(login.session.isAdmin, true);
  assert.equal(login.session.displayName, process.env.EDGECHAT_ADMIN_DISPLAY_NAME);
  stage = 'session and administrator access';
  await request('/api/auth/session', { authenticated: true });
  await request('/api/admin/overview', { authenticated: true });
  stage = 'channel database access';
  const { channels } = await (await request('/api/channels', { authenticated: true })).json();
  const general = channels.find((channel) => channel.isGeneral && channel.isMember);
  assert.ok(general);
  stage = 'channel realtime handshake';
  await realtime(`/api/ws/${general.kind}/${general.id}`);
  stage = 'inbox realtime handshake';
  await realtime('/api/inbox/ws');
  console.log('PASS: HTTPS, frontend, health, D1, administrator login/display name, KV session, access control, channel and inbox WebSocket ready frames.');
} catch {
  failed = true;
  // Do not print exception objects, response bodies, passwords, or session URLs.
  console.error(`FAIL: ${stage}`);
} finally {
  if (token) {
    try {
      await request('/api/auth/logout', { method: 'POST', authenticated: true });
      console.log('PASS: verification session logged out.');
    } catch {
      failed = true;
      console.error('FAIL: verification session logout');
    }
    token = '';
  }
}
process.exitCode = failed ? 1 : 0;

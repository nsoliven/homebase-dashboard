import { Integrations } from './integrations.mjs';
import http from 'node:http';
import https from 'node:https';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Store, hash } from './store.mjs';
import { Monitor } from './monitor.mjs';
import { Auth, cookie, setCookie, sessionCookie, loginCookie } from './auth.mjs';
import { sanitizeFeed } from './model.mjs';
import { RefreshCoordinator, SOURCE_ID } from './refresh.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const redirect = (res, location, cookies) => { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookies ? { 'Set-Cookie': cookies } : {}) }); res.end(); };
const body = req => new Promise((resolveBody, reject) => {
  let length = 0, chunks = [];
  req.on('data', chunk => { length += chunk.length; if (length > 1_000_000) { reject(new Error('too_large')); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('invalid_json')); } });
  req.on('error', reject);
});

export function createApp(config, store, monitor, auth = new Auth(config.oidc, store)) {
  const integrations = new Integrations(config);
  const dist = resolve(config.dist || 'dist');
  const limiter = new Map();
  const origin = new URL(config.publicUrl).origin;
  const refresh = new RefreshCoordinator({ config, store, monitor, integrations });
  const collectorFor = req => { const provided = (req.headers.authorization || '').replace(/^Bearer /, ''); return Object.entries(config.collectors || {}).find(([, c]) => timingSafeEqual(Buffer.from(hash(c.key)), Buffer.from(hash(provided)))); };
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const url = new URL(req.url, config.publicUrl);
    try {
      if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok', version: '1.0.0' });
      if (url.pathname === '/api/ingest' && req.method === 'POST') {
        const [, collector] = collectorFor(req) || [];
        if (!collector) return json(res, 401, { error: 'Unauthorized collector.' });
        const payload = await body(req);
        if (!collector.scopes.includes(payload.scope)) return json(res, 403, { error: 'Collector scope denied.' });
        if (!Number.isFinite(payload.observedAt) || Math.abs(Date.now() - payload.observedAt) > 120_000) return json(res, 400, { error: 'Measurement timestamp is invalid.' });
        const data = sanitizeFeed(payload.scope, payload.data);
        store.feed(payload.scope, monitor.prepareFeed ? monitor.prepareFeed(payload.scope, data, payload.observedAt) : data, payload.observedAt);
        refresh.ingested(payload.scope, payload.observedAt);
        return json(res, 200, { accepted: true });
      }
      // Long-poll for the bridge: scope names only, limited to the collector's own scopes.
      if (url.pathname === '/api/ingest/requests' && req.method === 'GET') {
        const [name, collector] = collectorFor(req) || [];
        if (!collector) return json(res, 401, { error: 'Unauthorized collector.' });
        const wait = Number(url.searchParams.get('wait') ?? 20) * 1000;
        return json(res, 200, await refresh.next(name, collector.scopes, Number.isFinite(wait) ? wait : 20_000));
      }
      const session = store.getSession(cookie(req, sessionCookie));
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { user: session?.user || null, csrf: session?.csrf || null, configured: Boolean(config.oidc?.issuer) });
      if (url.pathname === '/auth/login' && req.method === 'GET') {
        const ip = req.socket.remoteAddress, window = Math.floor(Date.now() / 60000), key = `${ip}:${window}`;
        if (limiter.size > 1000) limiter.clear();
        limiter.set(key, (limiter.get(key) || 0) + 1);
        if (limiter.get(key) > 30) return json(res, 429, { error: 'Please wait before trying again.' });
        const result = await auth.begin();
        return redirect(res, result.url, setCookie(loginCookie, result.browser, 600));
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        const result = await auth.complete(cookie(req, loginCookie), `${origin}${req.url}`);
        return redirect(res, '/', [setCookie(sessionCookie, result.token, 43200), setCookie(loginCookie, '', 0)]);
      }
      if (url.pathname.startsWith('/api/') && !session) return json(res, 401, { error: 'Sign in to Homebase.' });
      if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['x-homebase-csrf'] !== session?.csrf)) return json(res, 403, { error: 'Request verification failed.' });
      if (url.pathname === '/api/logout' && req.method === 'POST') { store.logout(cookie(req, sessionCookie)); res.setHeader('Set-Cookie', setCookie(sessionCookie, '', 0)); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/integrations' && req.method === 'GET') return json(res, 200, await integrations.snapshot());
      const icon=url.pathname.match(/^\/api\/(apps|branding)\/([a-z0-9-]{1,80})\/icon$/);
      if(icon&&['GET','HEAD'].includes(req.method)) {
        const asset=integrations.icon(icon[1],icon[2]);
        if(!asset)return json(res,404,{error:'Icon unavailable.'});
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
        res.writeHead(200,{'Content-Type':asset.type,'Content-Length':asset.data.length,'Cache-Control':'private, no-store'});
        return res.end(req.method==='HEAD'?undefined:asset.data);
      }
      const launch = url.pathname.match(/^\/api\/apps\/([a-z0-9-]{1,80})\/open$/);
      if (launch && req.method === 'GET') { const app = integrations.applications().find(a=>a.id===launch[1]); return app ? redirect(res,app.url) : json(res,404,{error:'Application unavailable.'}); }
      if (url.pathname === '/api/snapshot' && req.method === 'GET') return json(res, 200, { ...monitor.snapshot(), refresh: refresh.capabilities() });
      if (url.pathname === '/api/compute' && req.method === 'GET') {
        if (url.searchParams.get('live') === '1') refresh.markLive('compute');
        return json(res, 200, monitor.live ? monitor.live() : { compute: null, series: [] });
      }
      const sourceRefresh = url.pathname.match(/^\/api\/refresh\/([^/]{1,48})$/);
      if (sourceRefresh && req.method === 'POST') {
        let id; try { id = decodeURIComponent(sourceRefresh[1]); } catch { id = ''; }
        if (!SOURCE_ID.test(id)) return json(res, 400, { error: 'Unknown source.' });
        const result = await refresh.request(id);
        const status = { updated: 200, pending: 202, throttled: 429, unavailable: 409, failed: 502 }[result.status] || 200;
        if (result.status === 'throttled') res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        return json(res, status, { ...result, snapshot: { ...monitor.snapshot(), refresh: refresh.capabilities() }, ...(id === 'proxy' ? { integrations: await integrations.snapshot() } : {}), ...(id === 'compute' && monitor.live ? { live: monitor.live() } : {}) });
      }
      if (url.pathname === '/api/history' && req.method === 'GET') {
        const range = url.searchParams.get('range') || '24h', guest = url.searchParams.get('guest');
        if (!['1h', '24h', '7d'].includes(range) || (guest && !/^\d{1,9}$/.test(guest))) return json(res, 400, { error: 'Invalid chart request.' });
        return json(res, 200, await monitor.history(range, guest));
      }
      if (url.pathname === '/api/refresh' && req.method === 'POST') { await monitor.poll(); return json(res, 200, { ...monitor.snapshot(), refresh: refresh.capabilities() }); }
      if (url.pathname === '/api/acknowledge' && req.method === 'POST') {
        const payload = await body(req), snapshot = monitor.snapshot();
        const alert = snapshot.alerts.find(a => a.id === payload.id), agent = snapshot.agents.find(a => `agent:${a.id}` === payload.id);
        if (!alert && !agent) return json(res, 404, { error: 'Item no longer exists.' });
        store.acknowledge(payload.id, alert ? alert.signature : `${agent.status}:${agent.updatedAt}`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return json(res, 404, { error: 'Not found.' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      let path;
      try { path = resolve(dist, `.${decodeURIComponent(url.pathname)}`); } catch { return json(res, 400, { error: 'Invalid path.' }); }
      if (path !== dist && !path.startsWith(dist + sep)) return json(res, 403, { error: 'Invalid path.' });
      if (!existsSync(path) || !statSync(path).isFile()) {
        if (extname(path)) return json(res, 404, { error: 'Not found.' });
        path = resolve(dist, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(path).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) return res.end();
      // No upstream error bodies, command output, credentials, or auth codes in logs.
      json(res, url.pathname.startsWith('/auth/') ? 400 : 502, { error: url.pathname.startsWith('/auth/') ? 'Sign-in could not complete. Retry or ask your administrator to check Homebase access.' : 'The request could not complete. Please retry.' });
    }
  };
  handler.refresh = refresh;
  return handler;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const config = JSON.parse(readFileSync(process.env.HOMEBASE_CONFIG || '/etc/homebase/config.json', 'utf8'));
  const store = new Store(config.database || '/var/lib/homebase/homebase.sqlite');
  const monitor = new Monitor(config, store);
  const app = createApp(config, store, monitor);
  const server = config.tls ? https.createServer({ key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) }, app) : http.createServer(app);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  server.listen(config.port || 4318, config.bind || '127.0.0.1', () => console.log('Homebase service ready.'));
  monitor.poll(); const poller = setInterval(() => monitor.poll(), 30000);
  const shutdown = () => { clearInterval(poller); app.refresh.close(); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

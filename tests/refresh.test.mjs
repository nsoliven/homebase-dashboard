import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { Monitor } from '../server/monitor.mjs';
import { createApp } from '../server/index.mjs';
import { RefreshCoordinator } from '../server/refresh.mjs';

const collectors = fileURLToPath(new URL('../collectors/', import.meta.url));
const config = { publicUrl: 'http://127.0.0.1', collectors: { bridge: { key: 'synthetic-collector-key', scopes: ['host', 'compute'] } } };

async function serve() {
  const store = new Store(':memory:'), monitor = new Monitor(config, store, () => Promise.reject(new Error('offline')));
  const app = createApp(config, store, monitor, {}), server = http.createServer(app);
  server.requestTimeout = 15000;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, session = store.session({ id: 'test', name: 'Test user' });
  const post = path => fetch(base + path, { method: 'POST', headers: { Cookie: `__Host-homebase=${session.token}`, Origin: 'http://127.0.0.1', 'X-Homebase-CSRF': session.csrf } });
  const close = async () => { app.refresh.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); };
  return { base, store, post, close, session };
}

// Runs the real bridge scheduler with a fake fixed collector for 'host'.
function bridge(base, seconds) {
  const code = `
import importlib.util, sys, threading, time
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1] + 'bridge.py')
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
delivery = bridge.Delivery({'endpoint': sys.argv[2] + '/api/ingest', 'key': 'synthetic-collector-key'})
sources = {'host': bridge.Source(lambda forced: {'name': 'forced' if forced else 'scheduled'}, interval=600),
           'unrequested': bridge.Source(lambda forced: {'name': 'never'}, interval=600)}
stop = threading.Event(); threading.Timer(float(sys.argv[3]), stop.set).start()
bridge.Scheduler(sources, delivery, log=lambda m: print(m, flush=True)).run(stop)
`;
  return spawn('python3', ['-I', '-c', code, collectors, base, String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('refresh hands a known scope to the listening bridge and waits for its new reading', async () => {
  const s = await serve();
  let output = '';
  const child = bridge(s.base, 6);
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  try {
    assert.equal((await s.post('/api/refresh/host')).status, 409, 'not refreshable before the bridge listens');
    const deadline = Date.now() + 4000;
    while (s.store.getFeed('host')?.data.name !== 'scheduled' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(s.store.getFeed('host').data.name, 'scheduled');
    const before = s.store.getFeed('host').observed;
    await new Promise(r => setTimeout(r, 300));
    const response = await s.post('/api/refresh/host'), result = await response.json();
    assert.equal(response.status, 200, output);
    assert.equal(result.status, 'updated');
    assert.ok(result.observedAt > before);
    assert.equal(s.store.getFeed('host').data.name, 'forced');
    assert.equal(result.snapshot.refresh.host.available, true);
    const again = await s.post('/api/refresh/host');
    assert.equal(again.status, 429); assert.ok(Number(again.headers.get('Retry-After')) > 0);
  } finally { child.kill(); await s.close(); }
});

test('only configured scopes are refreshable; malformed and passive sources are refused', async () => {
  const s = await serve();
  try {
    for (const id of ['host%3Bid', '..%2F..', 'a'.repeat(60)]) assert.ok([400, 404].includes((await s.post(`/api/refresh/${id}`)).status), id);
    for (const id of ['router', 'nas', 'claude-statusline', 'proxy', 'proxmox']) {
      const r = await s.post(`/api/refresh/${id}`), body = await r.json();
      assert.equal(r.status, 409, id); assert.equal(body.status, 'unavailable'); assert.ok(body.reason.length > 10);
    }
    const unauth = await fetch(s.base + '/api/refresh/host', { method: 'POST' });
    assert.equal(unauth.status, 401);
    const noCsrf = await fetch(s.base + '/api/refresh/host', { method: 'POST', headers: { Cookie: `__Host-homebase=${s.session.token}`, Origin: 'http://127.0.0.1' } });
    assert.equal(noCsrf.status, 403);
    assert.equal((await fetch(s.base + '/api/ingest/requests?wait=0', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  } finally { await s.close(); }
});

test('collector long-poll returns only its own scopes and live intervals expire', async () => {
  let now = 1_000_000;
  const store = new Store(':memory:');
  const r = new RefreshCoordinator({ config: { collectors: { a: { scopes: ['host', 'compute'] }, b: { scopes: ['router'] } } }, store, monitor: {}, integrations: {}, now: () => now });
  r.pending.add('router'); r.pending.add('host');
  assert.deepEqual((await r.next('a', ['host', 'compute'], 0)).refresh, ['host']);
  assert.deepEqual((await r.next('b', ['router'], 0)).refresh, ['router']);
  const waiting = r.next('a', ['host', 'compute'], 20_000);
  assert.equal(r.markLive('compute'), true);
  const woke = await waiting;
  assert.deepEqual(woke.refresh, ['compute']); assert.equal(woke.live.compute.intervalMs, 3000);
  now += 13_000;
  assert.deepEqual((await r.next('a', ['host', 'compute'], 0)).live, {});
  assert.equal(r.markLive('router'), false, 'only scopes with a live profile');
  store.close();
});

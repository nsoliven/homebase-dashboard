import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../server/store.mjs';
import { Monitor } from '../server/monitor.mjs';
import { createApp } from '../server/index.mjs';
import { metricHistory, metricSpec, metricValues, percentile } from '../server/metrics.mjs';

const fan = '0123456789abcdef', temp = 'fedcba9876543210';
const view = { stale: false, gpu: { temperature: 61, utilization: 40, memoryUsed: 2048, memoryTotal: 8192, powerDraw: 120, coreClock: 1800, memoryClock: 7000, fan: 40, encoder: 5, decoder: 1 },
  cpu: { utilization: 30, power: 90, clockAverage: 4800 }, board: { tctl: 70, ccds: [{ id: 1, temperature: 66 }], fans: [{ id: fan, name: 'CPU Fan', rpm: 1200 }], temperatures: [{ id: temp, name: 'VRM MOS', value: 48 }] } };
const nearest = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.ceil(s.length * q) - 1]; };
// Deterministic, unordered values with a single known peak.
const series = n => Array.from({ length: n }, (_, i) => (i * 7919) % 1000 / 10);

test('metric IDs resolve only through the allowlist', () => {
  for (const id of ['gpu.temperature', 'cpu.tctl', 'cpu.ccd.1', `board.fan.${fan}`, `board.temp.${temp}`]) assert.ok(metricSpec(id, view), id);
  for (const id of ["gpu.temperature';--", '__proto__', 'constructor', 'toString', 'gpu.secret', 'cpu.ccd.2', 'cpu.ccd.99', `board.fan.${'a'.repeat(16)}`, 'board.fan.xyz', `board.temp.${fan}`, ''])
    assert.equal(metricSpec(id, view), null, id);
  assert.ok(metricSpec('cpu.ccd.2', view, id => id === 'cpu.ccd.2'), 'stored history keeps a sensor reachable');
  assert.equal(metricSpec(`board.fan.${fan}`, view).label, 'CPU Fan');
  const values = metricValues(view);
  assert.equal(values['gpu.memory'], 25); assert.equal(values[`board.fan.${fan}`], 1200); assert.equal(values['cpu.ccd.1'], 66);
  assert.deepEqual(metricValues({ ...view, stale: true }), {});
});

test('24 h and 1 h statistics use every raw sample with exact nearest-rank P95/P99', () => {
  const store = new Store(':memory:'), now = Date.now(), values = series(2880);
  values.forEach((v, i) => store.recordMetrics({ 'gpu.temperature': v }, now - (2879 - i) * 30_000));
  store.recordMetrics({ 'gpu.temperature': 999 }, now - 2879 * 30_000);  // duplicate timestamp is ignored
  const spec = metricSpec('gpu.temperature', view), day = metricHistory(store, spec, '24h', now);
  assert.equal(day.statistics.count, 2880);
  assert.equal(day.statistics.max, Math.max(...values)); assert.equal(day.statistics.min, Math.min(...values));
  assert.equal(day.statistics.p99, nearest(values, 0.99)); assert.equal(day.statistics.p95, nearest(values, 0.95));
  assert.ok(Math.abs(day.statistics.average - values.reduce((a, b) => a + b, 0) / values.length) < 1e-9);
  assert.equal(day.statistics.peakAt, now - (2879 - values.indexOf(Math.max(...values))) * 30_000);
  assert.equal(day.statistics.current, values.at(-1));
  assert.ok(day.points.length <= 289, 'downsampled to 5-minute points');
  assert.equal(Math.max(...day.points.map(p => p.max)), day.statistics.max, 'band keeps the true peak');
  const hour = metricHistory(store, spec, '1h', now);
  assert.equal(hour.statistics.count, 120); assert.equal(hour.points.length, 120);
  assert.equal(hour.statistics.p99, nearest(values.slice(-120), 0.99));
  store.close();
});

test('7 d history comes from 5-minute buckets with exact percentiles and bounded retention', () => {
  const store = new Store(':memory:'), now = Date.now(), n = 7 * 2880, values = series(n);
  values.forEach((v, i) => store.recordMetrics({ 'cpu.tctl': v }, now - (n - 1 - i) * 30_000));
  const raw = store.metricRaw('cpu.tctl', 0, now).length;
  assert.ok(raw <= 25 * 120 + 1, 'raw tier holds about 25 hours');
  const week = metricHistory(store, metricSpec('cpu.tctl', view), '7d', now);
  assert.equal(week.statistics.count, n);
  assert.equal(week.statistics.p99, nearest(values, 0.99)); assert.equal(week.statistics.max, Math.max(...values));
  assert.ok(week.points.length <= 337 && week.points.length >= 330, `${week.points.length} 30-minute points`);
  assert.ok(week.points.every(p => p.min <= p.avg && p.avg <= p.max));
  store.recordMetrics({ 'cpu.tctl': 1 }, now - 9 * 86400_000);
  store.pruneMetrics(now, true);
  assert.equal(store.metricBuckets('cpu.tctl', 0, now - 8 * 86400_000).length, 0, 'buckets older than 8 days are pruned');
  assert.equal(store.metricRaw('cpu.tctl', 0, now - 25 * 3600_000 - 1).length, 0);
  assert.equal(percentile([], 0.99), null);
  store.close();
});

test('legacy history keys backfill once', () => {
  const store = new Store(':memory:'), now = Date.now();
  for (let i = 0; i < 10; i++) store.history({ 'gpu.temperature': 50 + i, [`fan.${fan}`]: 1000 + i, 'host.temperature': 60 }, now - (10 - i) * 30_000);
  const map = { 'gpu.temperature': ['gpu.temperature'], [`board.fan.${fan}`]: [`fan.${fan}`], 'cpu.tctl': ['compute.tctl', 'host.temperature'] };
  assert.equal(store.backfillMetrics(map, now), 10);
  assert.equal(store.backfillMetrics(map, now), 0);
  const h = metricHistory(store, metricSpec(`board.fan.${fan}`, view), '1h', now);
  assert.equal(h.statistics.count, 10); assert.equal(h.statistics.max, 1009);
  assert.equal(metricHistory(store, metricSpec('cpu.tctl', view), '1h', now).statistics.average, 60);
  store.close();
});

test('metric API requires a session and rejects unknown IDs and ranges', async () => {
  const store = new Store(':memory:'), monitor = new Monitor({ publicUrl: 'http://127.0.0.1' }, store, () => Promise.reject(new Error('offline')));
  store.feed('compute', view, Date.now());
  monitor.recordCompute(monitor.computeView());
  const server = http.createServer(createApp({ publicUrl: 'http://127.0.0.1' }, store, monitor, {}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, session = store.session({ id: 't', name: 'T' }), headers = { Cookie: `__Host-homebase=${session.token}` };
  try {
    assert.equal((await fetch(`${base}/api/metrics/gpu.temperature`)).status, 401);
    const ok = await fetch(`${base}/api/metrics/gpu.temperature?range=24h`, { headers }), body = await ok.json();
    assert.equal(ok.status, 200); assert.equal(body.metric.unit, '°C'); assert.equal(body.statistics.current, 61);
    assert.equal((await fetch(`${base}/api/metrics/board.fan.${fan}?range=7d`, { headers })).status, 200);
    for (const path of ['gpu.temperature?range=30d', 'gpu.temperature?range=constructor', 'gpu.secret', 'GPU.temperature', "gpu.temperature'--", 'cpu.ccd.4'])
      assert.ok([400, 404].includes((await fetch(`${base}/api/metrics/${path}`, { headers })).status), path);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); }
});

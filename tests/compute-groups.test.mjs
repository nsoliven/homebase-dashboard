import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store } from '../server/store.mjs';
import { Monitor } from '../server/monitor.mjs';
import { createApp } from '../server/index.mjs';
import { decodeThrottle, throttleSummary } from '../server/gpu-reasons.mjs';
import { energy, groupDetail, groupOf, pstateTime, throttleTime, timeAtLimit } from '../server/compute-groups.mjs';
import { metricValues } from '../server/metrics.mjs';

const fan = '0123456789abcdef', temp = 'fedcba9876543210';
const thread = (cpu, core, ccd, load) => ({ cpu, core, ccd, load, mhz: 5000 + cpu });
const view = { stale: false, observedAt: Date.now(),
  gpu: { pstate: 'P2', temperature: 66, utilization: 90, memoryUsed: 4096, memoryTotal: 8192, powerDraw: 250, powerLimit: 270, powerMaxLimit: 270, coreClock: 1900, coreClockMax: 2100, memoryClock: 7000, fan: 55, encoder: 30, decoder: 10, throttle: 4, encoderSessions: 1, encoderFps: 60, encoderLatency: 900, pcieGen: 4, pcieWidth: 16, pcieGenMax: 4, pcieWidthMax: 16, driver: '1.2.3', vbios: '94.04.3A.40.DB' },
  processes: [{ pid: 1, name: 'worker', memory: 2048, container: 209, containerName: 'sample-worker' }, { pid: 2, name: 'encode', memory: 1024, container: 209 }],
  cpu: { model: 'Sample CPU', utilization: 40, load: [3, 2, 1], threadCount: 4, coreCount: 2, clockAverage: 5001, clockMax: 5003, power: 120,
    threads: [thread(0, 0, 0, 80), thread(1, 1, 0, 60), thread(2, 8, 1, 20), thread(3, 9, 1, 0)] },
  board: { tctl: 80, vcore: 1.2, name: 'Sample board', ccds: [{ id: 1, temperature: 78 }, { id: 2, temperature: 70 }], fans: [{ id: fan, name: 'CPU Fan', rpm: 1500, maxRpm: 2000, role: 'fan', confirmed: true, label: 'sample / fan1' }], temperatures: [{ id: temp, name: 'VRM MOS', value: 50 }] } };

test('throttle reasons decode to plain words', () => {
  assert.deepEqual(decodeThrottle(0), []);
  assert.deepEqual(decodeThrottle(0x5).map(r => r.key), ['idle', 'powerCap']);
  assert.deepEqual(decodeThrottle(0x60).map(r => r.label), ['Thermal limit (driver)', 'Thermal limit (hardware)']);
  assert.equal(decodeThrottle(0x1000).at(-1).key, 'other');
  for (const bad of [-1, 1.5, '4', null, undefined]) assert.equal(decodeThrottle(bad), null);
  assert.equal(throttleSummary(0), 'Nothing is limiting clocks'); assert.equal(throttleSummary(4), 'Power cap');
});

test('energy integrates 30-second samples; time at limit, P-states and throttle time count real samples', () => {
  const store = new Store(':memory:'), now = Date.now();
  for (let i = 0; i < 120; i++) store.recordMetrics({ 'gpu.power': i < 10 ? 260 : 200, 'gpu.powerLimit': 270, 'gpu.pstate': i < 30 ? 0 : 8, 'gpu.throttle': i < 10 ? 4 : i < 30 ? 0 : 1 }, now - (119 - i) * 30_000);
  const e = energy(store, 'gpu.power', '1h', now);
  assert.equal(e.samples, 120);
  assert.ok(Math.abs(e.kwh - (10 * 260 + 110 * 200) * 30 / 3.6e6) < 1e-12);
  assert.equal(timeAtLimit(store, '1h', 0.95, null, now).ms, 10 * 30_000, '≥ 95 % of 270 W is ≥ 256.5 W');
  assert.deepEqual(pstateTime(store, '1h', now), [{ state: 'P0', ms: 30 * 30_000 }, { state: 'P8', ms: 90 * 30_000 }]);
  const t = throttleTime(store, '1h', now);
  assert.equal(t.noneMs, 20 * 30_000); assert.equal(t.reasons.find(r => r.key === 'powerCap').ms, 10 * 30_000); assert.equal(t.reasons.find(r => r.key === 'idle').ms, 90 * 30_000);
  // 7-day view reads the same samples from 5-minute buckets.
  assert.ok(Math.abs(energy(store, 'gpu.power', '7d', now).kwh - e.kwh) < 1e-9);
  assert.equal(timeAtLimit(store, '7d', 0.95, null, now).ms, 10 * 30_000);
  // Two days of 100 W in buckets only (older than the raw tier) is 4.8 kWh.
  const s2 = new Store(':memory:');
  for (let i = 0; i < 2 * 2880; i++) s2.recordMetrics({ 'gpu.power': 100 }, now - 2 * 86400_000 - i * 30_000);
  assert.ok(Math.abs(energy(s2, 'gpu.power', '7d', now).kwh - 4.8) < 1e-9);
  store.close(); s2.close();
});

test('group IDs resolve only through the allowlist and carry facts and metrics', () => {
  const store = new Store(':memory:'), now = Date.now();
  store.recordMetrics(metricValues(view), now - 30_000);
  for (const id of ['gpu.secret', '__proto__', 'cpu.ccd.9', `board.fan.${'a'.repeat(16)}`, "gpu.power'", 'cpu.ccd.1.load', 'gpu.power.x']) assert.equal(groupDetail(store, view, id, '24h', { now }), null, id);
  assert.equal(groupDetail(store, view, 'gpu.power', '30d', { now }), null);
  const power = groupDetail(store, view, 'gpu.power', '1h', { now });
  assert.deepEqual(power.metrics.map(m => m.id), ['gpu.power']);
  assert.equal(power.metrics[0].current, 250);
  assert.ok(power.facts.some(f => f.label === 'Maximum power limit' && f.value === '270 W'));
  assert.equal(power.limiters[0].key, 'powerCap'); assert.equal(power.derived.energy.samples, 1);
  const ccd = groupDetail(store, view, 'cpu.ccd.2', '1h', { now });
  assert.deepEqual(ccd.cores.map(c => c.core), [8, 9]); assert.deepEqual(ccd.threadMetrics, ['cpu.thread.2', 'cpu.thread.3']);
  assert.equal(ccd.metrics.find(m => m.id === 'cpu.ccd.2.load').current, 10);
  const procs = groupDetail(store, view, 'gpu.processes', '1h', { now });
  assert.equal(procs.metrics[0].id, 'gpu.vram.ct.209'); assert.equal(procs.metrics[0].current, 3);
  assert.ok(groupDetail(store, view, `board.fan.${fan}`, '7d', { now }).facts.some(f => f.value === '75%'));
  assert.ok(groupDetail(store, view, 'gpu.state', '1h', { now }).facts.some(f => f.label === 'VBIOS' && f.value === '94.04.3A.40.DB'));
  assert.equal(groupDetail(store, { ...view, gpu: null }, 'gpu.core', '1h', { now }), null);
  assert.ok(!JSON.stringify(groupDetail(store, view, 'gpu.processes', '1h', { now })).includes('"pid"'), 'no process IDs in group detail');
  store.close();
});

test('metrics map to their groups for deep links', () => {
  assert.equal(groupOf('gpu.power'), 'gpu.power'); assert.equal(groupOf('gpu.coreClock'), 'gpu.core');
  assert.equal(groupOf('cpu.thread.3', view), 'cpu.ccd.2'); assert.equal(groupOf('cpu.ccd.1.clock'), 'cpu.ccd.1');
  assert.equal(groupOf(`board.temp.${temp}`), 'cpu.board'); assert.equal(groupOf('gpu.vram.ct.209'), 'gpu.processes');
  assert.equal(groupOf('nope'), null);
});

test('group API requires a session and validates IDs and ranges', async () => {
  const store = new Store(':memory:'), monitor = new Monitor({ publicUrl: 'http://127.0.0.1' }, store, () => Promise.reject(new Error('offline')));
  store.feed('compute', view, Date.now()); monitor.recordCompute(monitor.computeView());
  const server = http.createServer(createApp({ publicUrl: 'http://127.0.0.1' }, store, monitor, {}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, s = store.session({ id: 't', name: 'T' }), headers = { Cookie: `__Host-homebase=${s.token}` };
  try {
    assert.equal((await fetch(`${base}/api/compute/groups/gpu.power`)).status, 401);
    const r = await fetch(`${base}/api/compute/groups/gpu.power?range=24h`, { headers }), body = await r.json();
    assert.equal(r.status, 200); assert.equal(body.title, 'Board power'); assert.ok(body.derived.energy.samples >= 1);
    assert.equal((await fetch(`${base}/api/compute/groups/cpu.ccd.1?range=7d`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/metrics/cpu.thread.0?range=1h`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/metrics/gpu.throttle?range=1h`, { headers })).status, 404, 'internal metrics are not chartable');
    for (const path of ['gpu.power?range=1y', 'gpu.secret', 'cpu.ccd.9', 'GPU.power']) assert.ok([400, 404].includes((await fetch(`${base}/api/compute/groups/${path}`, { headers })).status), path);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); }
});

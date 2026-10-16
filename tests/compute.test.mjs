import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ComputeTracker, computeView, sanitizeCompute } from '../server/compute.mjs';
import { chartValues, sanitizeFeed } from '../server/model.mjs';
import { Store } from '../server/store.mjs';

const thread = (cpu, core, busyTicks, idleTicks) => ({ cpu, core, ccd: cpu < 2 ? 0 : 1, mhz: 4000 + cpu * 100, stat: [busyTicks, 0, 0, idleTicks, 0, 0, 0, 0] });
const raw = (step, extra = {}) => ({
  gpu: { name: 'Sample GPU', driver: '1.2.3', pstate: 'P2', temperature: 61, utilization: 74, memoryUsed: 4096, memoryTotal: 8192, powerDraw: 180.5, powerLimit: 270, fan: 48, coreClock: 1905, memoryClock: 7000, secret: 'NEVER_EXPORT' },
  processes: [{ pid: 4242, name: 'worker', memory: 2048, container: 109, args: 'NEVER_EXPORT' }, { pid: 'x', name: 'bad' }],
  cpu: { model: 'Sample CPU', stat: [100 + step * 50, 0, 0, 1000 + step * 50, 0, 0, 0, 0], load: [1, 2, 3], energy: 1_000_000 + step * 50_000_000, energyRange: 1e12,
    threads: [thread(0, 0, 10 + step * 9, 100 + step), thread(1, 0, 10, 100 + step * 10), thread(2, 1, 5 + step * 5, 5 + step * 5)], environ: 'NEVER_EXPORT' },
  board: { name: 'Sample board', tctl: 70, ccds: [{ id: 1, temperature: 66 }], fans: [{ id: 'fan-a', name: 'CPU Fan', rpm: 1200 }, { id: 'fan-b', rpm: -5 }], temperatures: [{ id: 't', name: 'VRM', value: 48 }] },
  ...extra,
});

test('compute payload passes only through its allowlist', () => {
  const s = sanitizeFeed('compute', raw(0));
  assert.ok(!JSON.stringify(s).includes('NEVER_EXPORT'));
  assert.equal(s.processes.length, 1); assert.equal(s.board.fans.length, 1);
  assert.equal(sanitizeCompute({ gpu: { pstate: 'rm -rf', temperature: 999, utilization: 101 } }).gpu.pstate, null);
  assert.equal(sanitizeCompute({ gpu: { temperature: 999 } }).gpu.temperature, null);
  assert.equal(sanitizeCompute({ gpuError: 'x' }).gpuError, null);
});

test('per-thread load and package power come from consecutive real counters only', () => {
  const tracker = new ComputeTracker(null);
  const first = tracker.derive(sanitizeCompute(raw(0)), 1_000_000);
  assert.equal(first.cpu.utilization, null); assert.equal(first.cpu.power, null);
  assert.ok(first.cpu.threads.every(t => t.load === null));
  const second = tracker.derive(sanitizeCompute(raw(1)), 1_002_000);
  assert.deepEqual(second.cpu.threads.map(t => Math.round(t.load)), [90, 0, 50]);
  assert.equal(second.cpu.utilization, 50);
  assert.equal(second.cpu.power, 25);
  assert.equal(second.cpu.coreCount, 2); assert.equal(second.cpu.threadCount, 3);
  assert.ok(!('stat' in second.cpu) && second.cpu.threads.every(t => !('stat' in t)));
  const gap = tracker.derive(sanitizeCompute(raw(2)), 1_200_000);
  assert.equal(gap.cpu.utilization, null, 'no rate across a gap of more than two minutes');
});

test('processes are named by container and sparkline history skips stale readings', () => {
  const tracker = new ComputeTracker(null), view = tracker.derive(sanitizeCompute(raw(0)), 1000);
  const joined = computeView({ data: view, observed: 1000, stale: false }, [{ type: 'lxc', vmid: 109, name: 'sample-worker' }], { channels: [{ id: 'fan-a', role: 'fan', maxRpm: 2000 }] });
  assert.equal(joined.processes[0].containerName, 'sample-worker');
  assert.equal(joined.board.fans[0].maxRpm, 2000);
  assert.equal(chartValues({ sources: [], vms: [], compute: joined })['gpu.temperature'], 61);
  assert.equal(chartValues({ sources: [], vms: [], compute: { ...joined, stale: true } })['gpu.temperature'], null);
  const store = new Store(':memory:');
  store.history({ 'gpu.temperature': 55, 'compute.cpu': 12 }, Date.now() - 60_000);
  store.history({ 'gpu.temperature': 56 }, Date.now() - 3_600_000);
  const seeded = new ComputeTracker(store).recent();
  assert.equal(seeded.length, 1); assert.equal(seeded[0].gpuTemperature, 55); assert.equal(seeded[0].gpuPower, null);
  store.close();
});

test('the hypervisor probe parses nvidia-smi output without inventing missing fields', () => {
  const probe = fileURLToPath(new URL('../collectors/read-compute.py', import.meta.url));
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('probe', sys.argv[1]); probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
gpu = probe.parse_gpu('Sample GPU, 1.2.3, P8, 45, N/A, 0, 0, 0, 0, 57, 8192, 20.90, 270.00, 210, 405, 0\\n')
limits = probe.parse_gpu('2100, 7001, 270.00, 4, 16, 0x0000000000000004, 4, 16, 2, 59.5, 812, 94.04.3A.40.DB', probe.LIMIT_FIELDS)
apps = probe.parse_apps('123, /usr/bin/sample, 512\\nnot a row\\n')
print(json.dumps({'gpu': gpu, 'limits': limits, 'short': probe.parse_gpu('a, b'), 'apps': apps, 'commands': probe.COMMANDS}))
`;
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', code, probe], { encoding: 'utf8' }));
  assert.equal(out.gpu.memoryTemperature, null); assert.equal(out.gpu.temperature, 45); assert.equal(out.gpu.pstate, 'P8');
  assert.equal(out.limits.throttle, 4); assert.equal(out.short, null);
  assert.equal(out.limits.encoderSessions, 2); assert.equal(out.limits.pcieGenMax, 4); assert.equal(out.limits.vbios, '94.04.3A.40.DB');
  const fields = out.commands.limits[1];
  for (const banned of ['serial', 'uuid', 'pci.bus', 'pci.device']) assert.ok(!fields.includes(banned), banned);
  assert.deepEqual(out.apps.map(a => [a.pid, a.name, a.memory]), [[123, 'sample', 512]]);
  for (const argv of Object.values(out.commands)) assert.equal(argv[0], 'nvidia-smi');
});

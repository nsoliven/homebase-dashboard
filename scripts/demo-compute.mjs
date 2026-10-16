// Synthetic GPU/CPU readings for the isolated demo. Never reads real hardware.
// Two scenarios: an idle host and a simulated sustained GPU + CPU load.
import { coolingStatus } from '../server/cooling.mjs';
import { metricValues } from '../server/metrics.mjs';

let scenario = 'idle';
export const setScenario = name => { if (['idle', 'load'].includes(name)) scenario = name; return scenario; };
const wave = (t, period, amp) => Math.sin(t / period) * amp;
const jitter = (t, seed, amp) => (Math.sin(t / 997 + seed * 12.9898) * 43758.5453 % 1) * amp;
const cooling = { channels: [
  { id: 'd0000000000000f1', role: 'fan', confirmed: true, maxRpm: 2450 }, { id: 'd0000000000000f2', role: 'pump', confirmed: true, maxRpm: 3200 },
  ...[2, 3, 4, 5].map(n => ({ id: `d0000000000000a${n}`, role: 'fan', confirmed: true, maxRpm: 2000 })),
] };

function reading(ts, mode) {
  const load = mode === 'load', t = ts / 1000;
  const gpuUtil = load ? 95 + wave(t, 7, 3) : Math.max(0, 1 + wave(t, 9, 1));
  const gpuTemp = load ? 71 + wave(t, 40, 1.5) : 44 + wave(t, 60, .6);
  const gpu = {
    name: 'NVIDIA GeForce RTX 3070', driver: '595.104.02', pstate: load ? 'P2' : 'P8', temperature: Math.round(gpuTemp), memoryTemperature: null,
    utilization: Math.round(gpuUtil), memoryUtilization: load ? Math.round(58 + wave(t, 5, 6)) : 0, encoder: load ? Math.round(34 + wave(t, 6, 5)) : 0, decoder: load ? Math.round(12 + wave(t, 8, 3)) : 0,
    memoryUsed: load ? 6550 : 57, memoryTotal: 8192, powerDraw: +(load ? 226 + wave(t, 4, 9) : 20.9 + wave(t, 11, .3)).toFixed(2), powerLimit: 270, powerMaxLimit: 270,
    coreClock: load ? Math.round(1950 + wave(t, 5, 25)) : 210, memoryClock: load ? 7000 : 405, coreClockMax: 2100, memoryClockMax: 7001,
    fan: load ? Math.round(62 + wave(t, 30, 2)) : 0, pcieGen: load ? 4 : 1, pcieWidth: 16, throttle: load ? (Math.sin(t / 40) > 0.2 ? 4 : 0) : 1,
    pcieGenMax: 4, pcieWidthMax: 16, encoderSessions: load ? 2 : 0, encoderFps: load ? Math.round(118 + wave(t, 9, 4)) : 0, encoderLatency: load ? Math.round(2400 + wave(t, 7, 300)) : 0, vbios: '94.04.3A.40.DB',
  };
  const threads = Array.from({ length: 24 }, (_, i) => {
    const core = i % 12, ccd = core < 6 ? 0 : 1, base = load ? (ccd ? 72 : 88) : (ccd ? 4 : 9);
    return { cpu: i, core: core < 6 ? core : core + 2, ccd, mhz: load ? 5050 + wave(t + i, 3, 60) : 4700 + wave(t + i, 5, 300), load: Math.max(0, Math.min(100, base + wave(t + i * 3, 2.3, load ? 10 : 6) + jitter(t, i, 6))) };
  });
  const util = threads.reduce((a, x) => a + x.load, 0) / threads.length;
  const fans = [['d0000000000000f1', 'CPU Fan', load ? 2050 : 1180], ['d0000000000000f2', 'Pump Fan', 3200], ['d0000000000000a1', 'System Fan #1', 0], ...[2, 3, 4, 5].map(n => [`d0000000000000a${n}`, `System Fan #${n}`, (load ? 1480 : 820) + n * 40]), ['d0000000000000a6', 'System Fan #6', 0]]
    .map(([id, name, rpm]) => ({ id, name, label: `sample / ${name}`, rpm: rpm ? Math.round(rpm + wave(t, 13, 12)) : 0 }));
  return {
    gpu, gpuError: null,
    processes: load ? [{ pid: 31337, name: 'python3', memory: 5120, container: 209, containerName: 'render-worker' }, { pid: 31402, name: 'ffmpeg', memory: 1300, container: 209, containerName: 'render-worker' }] : [],
    cpu: { model: 'AMD Ryzen 9 7900X 12-Core Processor', load: load ? [18.6, 16.2, 12.4] : [1.21, 1.35, 1.4], threads, threadCount: 24, coreCount: 12, utilization: util, power: load ? 152 + wave(t, 6, 6) : 41 + wave(t, 9, 2),
      clockAverage: threads.reduce((a, x) => a + x.mhz, 0) / 24, clockMax: Math.max(...threads.map(x => x.mhz)) },
    board: { name: 'Sample X870E board', tctl: load ? 90.5 + wave(t, 20, 1) : 52 + wave(t, 30, 1), vcore: load ? 1.284 : 1.032, ccds: [{ id: 1, temperature: load ? 88.4 : 48.6 }, { id: 2, temperature: load ? 85.9 : 46.1 }],
      fans: coolingStatus(fans, cooling).fans,
      temperatures: [['VRM MOS', load ? 58.5 : 44], ['PCH', 41.5], ['CPU Socket', load ? 47 : 39.5], ['System', 38.5]].map(([name, value], i) => ({ id: `d0000000000000e${i}`, name, value })) },
  };
}

/** Seven days of synthetic 30-second samples through the real metric tiers.
 * Evenings run a simulated GPU job so the 24 h and 7 d views have shape. */
export function seedHistory(store, now = Date.now()) {
  const n = 7 * 2880;
  for (let i = 0; i < n; i++) {
    const ts = now - (n - 1 - i) * 30_000, hour = new Date(ts).getHours(), busy = (hour >= 19 && hour < 23) || (hour === 13 && new Date(ts).getDay() % 2 === 0);
    const values = metricValues({ ...reading(ts, busy ? 'load' : 'idle'), stale: false });
    values['gpu.vram.ct.209'] ??= 0;
    store.recordMetrics(values, ts);
  }
}
export function view() { const ts = Date.now(); return { ...reading(ts, scenario), observedAt: ts - 1200, stale: false }; }
export function live() {
  const now = Date.now(), series = [];
  // Load scenario: idle for the first nine minutes, then the simulated job.
  for (let ts = now - 15 * 60_000; ts <= now; ts += 3000) {
    const mode = scenario === 'load' && ts > now - 6 * 60_000 ? 'load' : 'idle', r = reading(ts, mode);
    series.push({ ts, gpuTemperature: r.gpu.temperature, gpuUtilization: r.gpu.utilization, gpuPower: r.gpu.powerDraw, gpuMemory: r.gpu.memoryUsed / r.gpu.memoryTotal * 100, cpuTemperature: r.board.tctl, cpuUtilization: r.cpu.utilization });
  }
  return { generatedAt: now, compute: view(), series };
}

import { coolingStatus } from './cooling.mjs';

const text = (v, max = 120) => typeof v === 'string' ? v.slice(0, max) : null;
const number = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
const counters = v => Array.isArray(v) && v.length === 8 && v.every(n => Number.isSafeInteger(n) && n >= 0) ? v : null;
export const SERIES_WINDOW_MS = 15 * 60_000;
export const SERIES_KEYS = ['gpuTemperature', 'gpuUtilization', 'gpuPower', 'gpuMemory', 'cpuTemperature', 'cpuUtilization'];
// History keys written every monitor poll; they also seed sparklines after a restart.
export const HISTORY_KEYS = { gpuTemperature: 'gpu.temperature', gpuUtilization: 'gpu.utilization', gpuPower: 'gpu.power', gpuMemory: 'gpu.memory', cpuTemperature: 'compute.tctl', cpuUtilization: 'compute.cpu' };

// Collector boundary for the compute probe: explicit fields only.
export function sanitizeCompute(p) {
  const g = p.gpu && typeof p.gpu === 'object' ? p.gpu : null;
  const gpu = g ? {
    name: text(g.name, 80), driver: /^[\d.]{1,20}$/.test(g.driver || '') ? g.driver : null, pstate: /^P\d{1,2}$/.test(g.pstate || '') ? g.pstate : null,
    temperature: number(g.temperature, 0, 150), memoryTemperature: number(g.memoryTemperature, 0, 150),
    utilization: number(g.utilization, 0, 100), memoryUtilization: number(g.memoryUtilization, 0, 100),
    encoder: number(g.encoder, 0, 100), decoder: number(g.decoder, 0, 100),
    memoryUsed: number(g.memoryUsed, 0, 1e6), memoryTotal: number(g.memoryTotal, 0, 1e6),
    powerDraw: number(g.powerDraw, 0, 2000), powerLimit: number(g.powerLimit, 0, 2000), powerMaxLimit: number(g.powerMaxLimit, 0, 2000),
    coreClock: number(g.coreClock, 0, 10000), memoryClock: number(g.memoryClock, 0, 30000),
    coreClockMax: number(g.coreClockMax, 0, 10000), memoryClockMax: number(g.memoryClockMax, 0, 30000),
    fan: number(g.fan, 0, 100), pcieGen: number(g.pcieGen, 0, 10), pcieWidth: number(g.pcieWidth, 0, 32),
    throttle: Number.isSafeInteger(g.throttle) && g.throttle >= 0 ? g.throttle : null,
  } : null;
  const c = p.cpu && typeof p.cpu === 'object' ? p.cpu : {};
  const b = p.board && typeof p.board === 'object' ? p.board : {};
  return {
    gpu, gpuError: ['unavailable', 'unreadable'].includes(p.gpuError) ? p.gpuError : null,
    processes: Array.isArray(p.processes) ? p.processes.slice(0, 32).map(a => ({ pid: Number.isSafeInteger(a.pid) && a.pid > 0 ? a.pid : null, name: text(a.name, 60) || 'process', memory: number(a.memory, 0, 1e6), container: Number.isSafeInteger(a.container) && a.container > 0 && a.container < 1e9 ? a.container : null })).filter(a => a.pid) : [],
    cpu: {
      model: text(c.model, 100), stat: counters(c.stat), load: Array.isArray(c.load) && c.load.length === 3 && c.load.every(n => number(n, 0, 10000) !== null) ? c.load : null,
      energy: number(c.energy), energyRange: number(c.energyRange),
      threads: Array.isArray(c.threads) ? c.threads.slice(0, 512).map(t => ({ cpu: Number.isSafeInteger(t.cpu) && t.cpu >= 0 ? t.cpu : null, core: Number.isSafeInteger(t.core) && t.core >= 0 ? t.core : null, ccd: Number.isSafeInteger(t.ccd) && t.ccd >= 0 ? t.ccd : null, mhz: number(t.mhz, 0, 20000), stat: counters(t.stat) })).filter(t => t.cpu !== null) : [],
    },
    board: {
      name: text(b.name, 120), tctl: number(b.tctl, 0, 150), vcore: number(b.vcore, 0, 3),
      ccds: Array.isArray(b.ccds) ? b.ccds.slice(0, 16).map(x => ({ id: number(x.id, 0, 64), temperature: number(x.temperature, 0, 150) })).filter(x => x.id !== null && x.temperature !== null) : [],
      fans: Array.isArray(b.fans) ? b.fans.slice(0, 32).map(f => ({ id: text(f.id, 80), name: text(f.name, 100), label: text(f.label, 100), rpm: number(f.rpm, 0, 20000) })).filter(f => f.id && f.rpm !== null) : [],
      temperatures: Array.isArray(b.temperatures) ? b.temperatures.slice(0, 30).map(t => ({ id: text(t.id, 80), name: text(t.name, 100), value: number(t.value, 0, 150) })).filter(t => t.id && t.value !== null) : [],
    },
  };
}

const busy = (now, before) => {
  if (!now || !before) return null;
  const idle = (now[3] + now[4]) - (before[3] + before[4]), total = now.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0);
  return total > 0 && idle >= 0 && idle <= total ? (1 - idle / total) * 100 : null;
};

/** Derives utilization and package power from consecutive cumulative counters.
 * The first sample (or one after a gap > 2 minutes) has no rate: it stays null. */
export class ComputeTracker {
  constructor(store) { this.store = store; this.previous = null; this.series = []; this.seeded = false; }
  derive(raw, observed) {
    const prev = this.previous && observed > this.previous.observed && observed - this.previous.observed <= 120_000 ? this.previous : null;
    this.previous = { raw, observed };
    const before = new Map((prev?.raw.cpu.threads || []).map(t => [t.cpu, t.stat]));
    const threads = raw.cpu.threads.map(({ stat, ...t }) => ({ ...t, load: busy(stat, before.get(t.cpu)) }));
    let power = null;
    if (prev && Number.isFinite(raw.cpu.energy) && Number.isFinite(prev.raw.cpu.energy)) {
      let delta = raw.cpu.energy - prev.raw.cpu.energy;
      if (delta < 0 && raw.cpu.energyRange) delta += raw.cpu.energyRange;
      const watts = delta / 1e6 / ((observed - prev.observed) / 1000);
      power = delta >= 0 && watts < 2000 ? watts : null;
    }
    const mhz = threads.map(t => t.mhz).filter(Number.isFinite);
    const { stat, energy, energyRange, threads: _t, ...cpu } = raw.cpu;
    return {
      gpu: raw.gpu, gpuError: raw.gpuError, processes: raw.processes, board: raw.board,
      cpu: { ...cpu, threads, threadCount: threads.length, coreCount: new Set(threads.map(t => `${t.ccd}:${t.core}`)).size || null,
        utilization: busy(stat, prev?.raw.cpu.stat), power, clockAverage: mhz.length ? mhz.reduce((a, b) => a + b, 0) / mhz.length : null, clockMax: mhz.length ? Math.max(...mhz) : null },
    };
  }
  record(view, observed) {
    this.seed();
    const point = { ts: observed, ...sample(view) };
    if (this.series.at(-1)?.ts >= observed) return;
    this.series.push(point);
    this.trim(observed);
  }
  seed() {
    if (this.seeded || !this.store?.recent) return;
    this.seeded = true;
    const keys = Object.entries(HISTORY_KEYS);
    this.series = this.store.recent(Date.now() - SERIES_WINDOW_MS).map(row => ({ ts: row.ts, ...Object.fromEntries(keys.map(([k, h]) => [k, Number.isFinite(row.values[h]) ? row.values[h] : null])) }))
      .filter(p => SERIES_KEYS.some(k => p[k] !== null));
  }
  trim(now = Date.now()) { const from = now - SERIES_WINDOW_MS; while (this.series.length && (this.series[0].ts < from || this.series.length > 900)) this.series.shift(); }
  recent() { this.seed(); this.trim(); return this.series; }
}

export function sample(view) {
  const g = view?.gpu;
  return { gpuTemperature: g?.temperature ?? null, gpuUtilization: g?.utilization ?? null, gpuPower: g?.powerDraw ?? null,
    gpuMemory: g && g.memoryTotal > 0 && Number.isFinite(g.memoryUsed) ? g.memoryUsed / g.memoryTotal * 100 : null,
    cpuTemperature: view?.board?.tctl ?? null, cpuUtilization: view?.cpu?.utilization ?? null };
}

/** Joins the stored view with Proxmox names and configured cooling roles. */
export function computeView(feed, resources = [], cooling = {}) {
  if (!feed) return null;
  const names = new Map(resources.filter(r => r.type === 'lxc').map(r => [r.vmid, r.name]));
  const d = feed.data;
  return { ...d, observedAt: feed.observed, stale: feed.stale,
    processes: (d.processes || []).map(p => ({ ...p, containerName: p.container ? names.get(p.container) || null : null })),
    board: { ...d.board, fans: coolingStatus(d.board?.fans || [], cooling).fans } };
}

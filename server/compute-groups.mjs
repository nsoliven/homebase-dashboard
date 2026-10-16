// Group details for the GPU & CPU showcase: which metrics belong together, the
// facts we know about each part, and statistics derived from stored samples.
// Group IDs resolve only through GROUP_ID plus the current compute view.
import { BUCKET_MS, RANGES, ccdList, metricSpec, metricValues } from './metrics.mjs';
import { THROTTLE_REASONS, decodeThrottle, throttleSummary } from './gpu-reasons.mjs';

export const SAMPLE_MS = 30_000; // every stored sample stands for one 30-second poll
export const GROUP_ID = /^(?:gpu\.(?:power|core|memory|cooling|video|state|processes)|cpu\.(?:package|utilization|clocks|board)|cpu\.ccd\.\d{1,2}|board\.fan\.[0-9a-f]{16})$/;
const FIXED = {
  'gpu.power': 'gpu.power', 'gpu.temperature': 'gpu.core', 'gpu.utilization': 'gpu.core', 'gpu.coreClock': 'gpu.core',
  'gpu.memory': 'gpu.memory', 'gpu.memoryClock': 'gpu.memory', 'gpu.memoryUtilization': 'gpu.memory', 'gpu.fan': 'gpu.cooling',
  'gpu.encoder': 'gpu.video', 'gpu.decoder': 'gpu.video', 'gpu.encoderSessions': 'gpu.video', 'gpu.encoderFps': 'gpu.video', 'gpu.encoderLatency': 'gpu.video',
  'cpu.tctl': 'cpu.package', 'cpu.power': 'cpu.package', 'cpu.vcore': 'cpu.package',
  'cpu.utilization': 'cpu.utilization', 'cpu.load1': 'cpu.utilization', 'cpu.load5': 'cpu.utilization', 'cpu.load15': 'cpu.utilization',
  'cpu.clock': 'cpu.clocks', 'cpu.clockMax': 'cpu.clocks',
};

/** The group a metric belongs to (shared with the browser for deep links). */
export function groupOf(metric, view) {
  if (Object.hasOwn(FIXED, metric)) return FIXED[metric];
  let m;
  if ((m = /^cpu\.ccd\.(\d{1,2})(?:\.(?:load|clock))?$/.exec(metric))) return `cpu.ccd.${m[1]}`;
  if ((m = /^cpu\.thread\.(\d{1,3})$/.exec(metric))) { const c = ccdList(view).find(x => x.threads.some(t => t.cpu === Number(m[1]))); return c ? `cpu.ccd.${c.n}` : 'cpu.utilization'; }
  if (/^board\.temp\.[0-9a-f]{16}$/.test(metric)) return 'cpu.board';
  if (/^board\.fan\.[0-9a-f]{16}$/.test(metric)) return metric;
  if (/^gpu\.vram\.ct\.\d{1,9}$/.test(metric)) return 'gpu.processes';
  return null;
}

const num = (v, d = 1) => Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
export function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return h < 24 ? `${h} h${rest ? ` ${rest} min` : ""}` : `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

function samplesIn(store, id, range, now) {
  const r = RANGES[range], from = now - r.duration;
  if (r.source === 'raw') { const rows = store.metricRaw(id, from, now); return { rows, values: rows.map(x => x.value) }; }
  const buckets = store.metricBuckets(id, from - BUCKET_MS, now).filter(b => b.bucket + BUCKET_MS > from);
  return { buckets, values: buckets.flatMap(b => b.samples) };
}

/** Energy from power samples: each 30-second sample covers its 30-second poll. */
export function energy(store, id, range, now = Date.now()) {
  const w = samplesIn(store, id, range, now), joules = w.values.reduce((a, v) => a + v * SAMPLE_MS / 1000, 0);
  return { kwh: joules / 3.6e6, samples: w.values.length, coverageMs: w.values.length * SAMPLE_MS, rangeMs: RANGES[range].duration };
}
/** Time with power at or above `share` of the limit recorded with the same poll. */
export function timeAtLimit(store, range, share = 0.95, fallbackLimit = null, now = Date.now()) {
  const power = samplesIn(store, 'gpu.power', range, now), limit = samplesIn(store, 'gpu.powerLimit', range, now);
  let count = 0;
  if (power.rows) {
    const byTs = new Map(limit.rows.map(x => [x.ts, x.value]));
    for (const p of power.rows) { const l = byTs.get(p.ts) ?? fallbackLimit; if (l > 0 && p.value >= share * l) count++; }
  } else {
    const byBucket = new Map(limit.buckets.map(b => [b.bucket, b.max]));
    for (const b of power.buckets) { const l = byBucket.get(b.bucket) ?? fallbackLimit; if (l > 0) count += b.samples.filter(v => v >= share * l).length; }
  }
  return { ms: count * SAMPLE_MS, samples: power.values.length, share };
}
export function pstateTime(store, range, now = Date.now()) {
  const counts = new Map();
  for (const v of samplesIn(store, 'gpu.pstate', range, now).values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => a[0] - b[0]).map(([v, c]) => ({ state: `P${v}`, ms: c * SAMPLE_MS }));
}
export function throttleTime(store, range, now = Date.now()) {
  const counts = new Map(); let none = 0, total = 0;
  for (const mask of samplesIn(store, 'gpu.throttle', range, now).values) {
    const reasons = decodeThrottle(Math.round(mask)); if (!reasons) continue;
    total++; if (!reasons.length) none++;
    for (const r of reasons) counts.set(r.key, (counts.get(r.key) || 0) + 1);
  }
  const label = key => THROTTLE_REASONS.find(r => r.key === key) || { label: 'Other reason', detail: '' };
  return { totalMs: total * SAMPLE_MS, noneMs: none * SAMPLE_MS, reasons: [...counts].map(([key, c]) => ({ key, label: label(key).label, detail: label(key).detail, ms: c * SAMPLE_MS })).sort((a, b) => b.ms - a.ms) };
}

/** Builds one group's detail, or null for an unknown or absent group. */
export function groupDetail(store, view, id, range, { now = Date.now(), thermalLimit = null } = {}) {
  if (typeof id !== 'string' || !GROUP_ID.test(id) || !RANGES[range] || !view) return null;
  const known = name => store.hasMetric(name), current = metricValues(view), g = view.gpu, cpu = view.cpu || {}, b = view.board || {};
  const metrics = ids => ids.map(m => metricSpec(m, view, known)).filter(Boolean).map(s => ({ ...s, current: current[s.id] ?? null }));
  const fact = (label, value, note) => ({ label, value, ...(note ? { note } : {}) });
  const gpuOnly = () => { if (!g) return null; return true; };
  let out = null;
  switch (true) {
    case id === 'gpu.power': if (!gpuOnly()) break; {
      const share = g.powerLimit > 0 ? g.powerDraw / g.powerLimit * 100 : null;
      out = { title: 'Board power', eyebrow: 'GPU', metrics: metrics(['gpu.power']),
        header: [fact('Draw', `${num(g.powerDraw)} W`), fact('Of limit', `${num(share, 0)}%`), fact('P-state', g.pstate || '—')],
        derived: { energy: energy(store, 'gpu.power', range, now), atLimit: timeAtLimit(store, range, 0.95, g.powerLimit, now), throttle: throttleTime(store, range, now) },
        facts: [fact('Power draw', `${num(g.powerDraw)} W`), fact('Power limit', `${num(g.powerLimit, 0)} W`), fact('Maximum power limit', `${num(g.powerMaxLimit, 0)} W`),
          fact('Share of limit', `${num(share, 0)}%`), fact('Performance state', g.pstate || '—'), fact('Clock limiters now', throttleSummary(g.throttle))],
        limiters: decodeThrottle(g.throttle) };
    } break;
    case id === 'gpu.core': if (!gpuOnly()) break;
      out = { title: 'Core', eyebrow: 'GPU', metrics: metrics(['gpu.temperature', 'gpu.utilization', 'gpu.coreClock']),
        header: [fact('Temperature', `${num(g.temperature, 0)}°C`), fact('Load', `${num(g.utilization, 0)}%`), fact('Core clock', `${num(g.coreClock, 0)} MHz`)],
        derived: { pstates: pstateTime(store, range, now), throttle: throttleTime(store, range, now) },
        facts: [fact('Temperature', `${num(g.temperature, 0)}°C`), fact('Hotspot', 'Not exposed by nvidia-smi on this card'), fact('Load', `${num(g.utilization, 0)}%`),
          fact('Core clock', `${num(g.coreClock, 0)} of ${num(g.coreClockMax, 0)} MHz max${g.coreClockMax > 0 ? ` (${num(g.coreClock / g.coreClockMax * 100, 0)}%)` : ''}`),
          fact('Performance state', g.pstate || '—'), fact('Clock limiters now', throttleSummary(g.throttle))],
        limiters: decodeThrottle(g.throttle) };
      break;
    case id === 'gpu.memory': if (!gpuOnly()) break;
      out = { title: 'Video memory', eyebrow: 'GPU', metrics: metrics(['gpu.memory', 'gpu.memoryClock', 'gpu.memoryUtilization']),
        header: [fact('Used', `${num(g.memoryUsed / 1024)} / ${num(g.memoryTotal / 1024, 0)} GiB`), fact('Memory clock', `${num(g.memoryClock, 0)} MHz`), fact('Bus', `${num(g.memoryUtilization, 0)}%`)],
        facts: [fact('Used', `${num(g.memoryUsed / 1024, 2)} GiB (${num(g.memoryUsed, 0)} MiB)`), fact('Total', `${num(g.memoryTotal / 1024, 0)} GiB`),
          fact('Share used', `${num(g.memoryTotal > 0 ? g.memoryUsed / g.memoryTotal * 100 : null)}%`),
          fact('Memory clock', `${num(g.memoryClock, 0)} of ${num(g.memoryClockMax, 0)} MHz max`), fact('Memory bus utilization', `${num(g.memoryUtilization, 0)}%`),
          fact('Memory temperature', Number.isFinite(g.memoryTemperature) ? `${num(g.memoryTemperature, 0)}°C` : 'Not reported by this card')] };
      break;
    case id === 'gpu.cooling': if (!gpuOnly()) break;
      out = { title: 'Cooling', eyebrow: 'GPU', metrics: metrics(['gpu.fan']),
        header: [fact('Fan target', `${num(g.fan, 0)}%`), fact('GPU', `${num(g.temperature, 0)}°C`)],
        facts: [fact('Fan target', `${num(g.fan, 0)}%`, 'nvidia-smi reports the requested duty; tachometer RPM is not exposed for this card.'),
          fact('Mode', g.fan === 0 ? 'Zero-RPM: fans stopped while cool' : 'Fans spinning'), fact('GPU temperature', `${num(g.temperature, 0)}°C`), fact('Hotspot', 'Not exposed by nvidia-smi on this card')] };
      break;
    case id === 'gpu.video': if (!gpuOnly()) break;
      out = { title: 'Video engines', eyebrow: 'GPU', metrics: metrics(['gpu.encoder', 'gpu.decoder', 'gpu.encoderSessions', 'gpu.encoderFps', 'gpu.encoderLatency']),
        header: [fact('Encoder', `${num(g.encoder, 0)}%`), fact('Decoder', `${num(g.decoder, 0)}%`), fact('Sessions', num(g.encoderSessions, 0))],
        facts: [fact('NVENC utilization', `${num(g.encoder, 0)}%`), fact('NVDEC utilization', `${num(g.decoder, 0)}%`), fact('Encoder sessions', num(g.encoderSessions, 0)),
          fact('Encoder average FPS', g.encoderSessions > 0 ? num(g.encoderFps, 0) : 'No active session'), fact('Encoder average latency', g.encoderSessions > 0 ? `${num(g.encoderLatency, 0)} µs` : 'No active session')] };
      break;
    case id === 'gpu.state': if (!gpuOnly()) break;
      out = { title: 'State & link', eyebrow: 'GPU', metrics: metrics(['gpu.coreClock', 'gpu.memoryClock']),
        header: [fact('P-state', g.pstate || '—'), fact('PCIe', Number.isFinite(g.pcieGen) ? `Gen ${num(g.pcieGen, 0)} ×${num(g.pcieWidth, 0)}` : '—')],
        derived: { pstates: pstateTime(store, range, now), throttle: throttleTime(store, range, now) },
        facts: [fact('Performance state', g.pstate || '—', 'P0 is maximum performance; P8 is idle.'),
          fact('PCIe link now', Number.isFinite(g.pcieGen) ? `Gen ${num(g.pcieGen, 0)} ×${num(g.pcieWidth, 0)}` : 'Not reported'),
          fact('PCIe link maximum', Number.isFinite(g.pcieGenMax) ? `Gen ${num(g.pcieGenMax, 0)} ×${num(g.pcieWidthMax, 0)}` : 'Not reported', 'The link drops to a lower generation at idle to save power.'),
          fact('Clock limiters now', throttleSummary(g.throttle)), fact('Driver', g.driver || '—'), fact('VBIOS', g.vbios || 'Not reported')],
        limiters: decodeThrottle(g.throttle) };
      break;
    case id === 'gpu.processes': if (!gpuOnly()) break; {
      const cts = [...new Set([...(view.processes || []).map(p => p.container).filter(Number.isInteger), ...[...store.metricIds.keys()].map(n => /^gpu\.vram\.ct\.(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number)])].sort((a, c) => a - c);
      out = { title: 'Using the GPU', eyebrow: 'GPU', metrics: metrics([...cts.map(ct => `gpu.vram.ct.${ct}`), 'gpu.memory']),
        header: [fact('Processes', String((view.processes || []).length)), fact('VRAM used', `${num(g.memoryUsed / 1024)} GiB`)],
        processes: (view.processes || []).map(p => ({ name: p.name, container: p.container, containerName: p.containerName, memoryGiB: Number.isFinite(p.memory) ? p.memory / 1024 : null, metric: p.container ? `gpu.vram.ct.${p.container}` : null })),
        facts: [fact('Compute processes', String((view.processes || []).length)), fact('VRAM used (all)', `${num(g.memoryUsed / 1024, 2)} GiB of ${num(g.memoryTotal / 1024, 0)} GiB`),
          fact('Per-container history', cts.length ? cts.map(ct => `CT ${ct}`).join(', ') : 'No container has used the GPU yet', 'Summed from nvidia-smi process memory; host-only processes are listed but not charted.')] };
    } break;
    case id === 'cpu.package':
      out = { title: 'Package · Tctl', eyebrow: 'CPU', metrics: metrics(['cpu.tctl', 'cpu.power', 'cpu.vcore']),
        header: [fact('Tctl', `${num(b.tctl)}°C`), fact('Package', `${num(cpu.power, 0)} W`), fact('Vcore', `${num(b.vcore, 3)} V`)],
        derived: { energy: energy(store, 'cpu.power', range, now) },
        facts: [fact('Model', cpu.model || '—'), fact('Tctl', `${num(b.tctl)}°C`), fact('Rated limit', thermalLimit ? `${thermalLimit}°C` : 'Not known for this model', thermalLimit ? 'Boost runs close to this limit by design.' : undefined),
          ...(b.ccds || []).map(c => fact(`CCD ${c.id}`, `${num(c.temperature)}°C`)), fact('Package power', Number.isFinite(cpu.power) ? `${num(cpu.power)} W (RAPL energy counter)` : 'Measuring'),
          fact('Core voltage', Number.isFinite(b.vcore) ? `${num(b.vcore, 3)} V` : 'Not reported')] };
      break;
    case id.startsWith('cpu.ccd.'): {
      const n = Number(id.slice(8)), c = ccdList(view).find(x => x.n === n);
      if (!c) break;
      const loads = c.threads.map(t => t.load).filter(Number.isFinite), mhz = c.threads.map(t => t.mhz).filter(Number.isFinite);
      const cores = [...new Set(c.threads.map(t => t.core))].sort((a, z) => a - z).map(core => ({ core, threads: c.threads.filter(t => t.core === core).sort((a, z) => a.cpu - z.cpu).map(t => ({ cpu: t.cpu, load: t.load, mhz: t.mhz, metric: `cpu.thread.${t.cpu}` })) }));
      out = { title: `CCD ${n}`, eyebrow: 'CPU', metrics: metrics([`cpu.ccd.${n}`, `cpu.ccd.${n}.load`, `cpu.ccd.${n}.clock`]),
        header: [fact('Temperature', `${num(c.temperature)}°C`), fact('Avg load', `${num(current[`cpu.ccd.${n}.load`], 0)}%`), fact('Avg clock', `${num(current[`cpu.ccd.${n}.clock`], 0)} MHz`)],
        cores, threadMetrics: c.threads.map(t => `cpu.thread.${t.cpu}`),
        facts: [fact('Temperature', `${num(c.temperature)}°C (Tccd${n})`), fact('Cores · threads', `${cores.length} · ${c.threads.length}`), fact('Average load', `${num(current[`cpu.ccd.${n}.load`])}%`),
          fact('Busiest thread', loads.length ? `${num(Math.max(...loads), 0)}%` : '—'), fact('Average clock', `${num(current[`cpu.ccd.${n}.clock`], 0)} MHz`), fact('Peak thread clock', mhz.length ? `${num(Math.max(...mhz), 0)} MHz` : '—')] };
    } break;
    case id === 'cpu.utilization':
      out = { title: 'Utilization', eyebrow: 'CPU', metrics: metrics(['cpu.utilization', 'cpu.load1', 'cpu.load5', 'cpu.load15']),
        header: [fact('Utilization', `${num(cpu.utilization, 0)}%`), fact('Load 1 · 5 · 15', cpu.load ? cpu.load.map(v => num(v, 2)).join(' · ') : '—')],
        facts: [fact('Utilization', `${num(cpu.utilization)}%`), fact('Load average', cpu.load ? `${num(cpu.load[0], 2)} / ${num(cpu.load[1], 2)} / ${num(cpu.load[2], 2)}` : '—', 'Runnable plus waiting tasks over 1, 5 and 15 minutes.'),
          fact('Threads', String(cpu.threadCount ?? '—')), fact('Load per thread', cpu.load && cpu.threadCount ? num(cpu.load[0] / cpu.threadCount, 2) : '—', 'Above 1.0 means work is waiting for a CPU.')] };
      break;
    case id === 'cpu.clocks': {
      const cores = ccdList(view).flatMap(c => [...new Set(c.threads.map(t => t.core))].sort((a, z) => a - z).map(core => { const ts = c.threads.filter(t => t.core === core); return { ccd: c.n, core, cpus: ts.map(t => t.cpu).sort((a, z) => a - z), mhz: ts.reduce((a, t) => a + (t.mhz || 0), 0) / ts.length, load: ts.reduce((a, t) => a + (t.load || 0), 0) / ts.length }; }));
      out = { title: 'Clocks', eyebrow: 'CPU', metrics: metrics(['cpu.clock', 'cpu.clockMax']), coreClocks: cores,
        header: [fact('Average', `${num(cpu.clockAverage, 0)} MHz`), fact('Peak thread', `${num(cpu.clockMax, 0)} MHz`)],
        facts: [fact('Average clock', `${num(cpu.clockAverage, 0)} MHz`), fact('Peak thread clock', `${num(cpu.clockMax, 0)} MHz`), fact('Cores · threads', `${cpu.coreCount ?? '—'} · ${cpu.threadCount ?? '—'}`), fact('Source', '/proc/cpuinfo current frequency per thread')] };
    } break;
    case id === 'cpu.board': {
      const temps = b.temperatures || [];
      out = { title: 'Board', eyebrow: 'CPU', metrics: metrics(temps.map(t => `board.temp.${t.id}`)),
        header: temps.slice(0, 3).map(t => fact(t.name === 'PCH' ? 'Chipset' : t.name, `${num(t.value)}°C`)),
        facts: [fact('Board', b.name || 'Not reported'), ...temps.map(t => fact(t.name === 'PCH' ? 'Chipset (PCH)' : t.name, `${num(t.value)}°C`)), fact('Core voltage', Number.isFinite(b.vcore) ? `${num(b.vcore, 3)} V` : 'Not reported')] };
    } break;
    case id.startsWith('board.fan.'): {
      const f = (b.fans || []).find(x => `board.fan.${x.id}` === id);
      if (!f && !known(id)) break;
      const share = f?.maxRpm ? f.rpm / f.maxRpm * 100 : null;
      out = { title: f?.name || 'Board fan', eyebrow: 'Board fan', metrics: metrics([id]),
        header: [fact('Speed', `${num(f?.rpm, 0)} RPM`), fact('Of reference', share === null ? '—' : `${num(share, 0)}%`)],
        facts: [fact('Speed', `${num(f?.rpm, 0)} RPM`), fact('Reference speed', f?.maxRpm ? `${num(f.maxRpm, 0)} RPM` : 'Not configured'), fact('Share of reference', share === null ? '—' : `${num(share, 0)}%`),
          fact('Role', !f || f.role === 'unassigned' ? 'Not configured' : `${f.role === 'pump' ? 'Pump' : 'Fan'}${f.confirmed ? '' : ' · inferred'}`), fact('Channel', f?.label || '—')] };
    } break;
  }
  if (!out) return null;
  return { id, range, observedAt: view.observedAt ?? null, ...out };
}

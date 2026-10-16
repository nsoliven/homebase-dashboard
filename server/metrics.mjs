// Per-metric compute history. Metric IDs resolve only through the fixed table
// below (plus sensor IDs the hypervisor currently reports); SQL always binds
// values and never sees request text.
export const RAW_RETENTION_MS = 25 * 3600_000;      // 30-second samples, a bit over 24 h
export const BUCKET_MS = 5 * 60_000;                 // 5-minute buckets for 7 days
export const BUCKET_RETENTION_MS = 8 * 86400_000;
export const RANGES = { '1h': { duration: 3600_000, step: 30_000, source: 'raw' }, '24h': { duration: 86400_000, step: BUCKET_MS, source: 'raw' }, '7d': { duration: 604800_000, step: 30 * 60_000, source: 'buckets' } };
export const METRIC_ID = /^[a-z][a-z0-9.]{2,48}$/;
const SENSOR = /^[0-9a-f]{16}$/;
const vram = g => g && g.memoryTotal > 0 && Number.isFinite(g.memoryUsed) ? g.memoryUsed / g.memoryTotal * 100 : null;

/** Fixed metrics: label, unit, chart ceiling, and how to read it from the compute view. */
export const STATIC_METRICS = {
  'gpu.temperature': { group: 'GPU', label: 'GPU temperature', unit: '°C', read: v => v.gpu?.temperature, legacy: ['gpu.temperature'] },
  'gpu.utilization': { group: 'GPU', label: 'GPU load', unit: '%', max: 100, read: v => v.gpu?.utilization, legacy: ['gpu.utilization'] },
  'gpu.memory': { group: 'GPU', label: 'Video memory used', unit: '%', max: 100, read: v => vram(v.gpu), legacy: ['gpu.memory'] },
  'gpu.power': { group: 'GPU', label: 'GPU board power', unit: 'W', read: v => v.gpu?.powerDraw, legacy: ['gpu.power'] },
  'gpu.coreClock': { group: 'GPU', label: 'GPU core clock', unit: 'MHz', read: v => v.gpu?.coreClock },
  'gpu.memoryClock': { group: 'GPU', label: 'GPU memory clock', unit: 'MHz', read: v => v.gpu?.memoryClock },
  'gpu.fan': { group: 'GPU', label: 'GPU fan duty', unit: '%', max: 100, read: v => v.gpu?.fan },
  'gpu.encoder': { group: 'GPU', label: 'NVENC encoder', unit: '%', max: 100, read: v => v.gpu?.encoder },
  'gpu.decoder': { group: 'GPU', label: 'NVDEC decoder', unit: '%', max: 100, read: v => v.gpu?.decoder },
  'cpu.tctl': { group: 'CPU', label: 'CPU package (Tctl)', unit: '°C', read: v => v.board?.tctl, legacy: ['compute.tctl', 'host.temperature'] },
  'cpu.utilization': { group: 'CPU', label: 'CPU utilization', unit: '%', max: 100, read: v => v.cpu?.utilization, legacy: ['compute.cpu'] },
  'cpu.power': { group: 'CPU', label: 'CPU package power', unit: 'W', read: v => v.cpu?.power },
  'cpu.clock': { group: 'CPU', label: 'CPU average clock', unit: 'MHz', read: v => v.cpu?.clockAverage },
  'gpu.memoryUtilization': { group: 'GPU', label: 'Memory bus utilization', unit: '%', max: 100, read: v => v.gpu?.memoryUtilization },
  'gpu.encoderSessions': { group: 'GPU', label: 'Encoder sessions', unit: 'sessions', read: v => v.gpu?.encoderSessions },
  'gpu.encoderFps': { group: 'GPU', label: 'Encoder average FPS', unit: 'fps', read: v => v.gpu?.encoderFps },
  'gpu.encoderLatency': { group: 'GPU', label: 'Encoder average latency', unit: 'µs', read: v => v.gpu?.encoderLatency },
  'cpu.vcore': { group: 'CPU', label: 'CPU core voltage', unit: 'V', read: v => v.board?.vcore },
  'cpu.clockMax': { group: 'CPU', label: 'CPU peak thread clock', unit: 'MHz', read: v => v.cpu?.clockMax },
  'cpu.load1': { group: 'CPU', label: 'Load average · 1 min', unit: '', read: v => v.cpu?.load?.[0] },
  'cpu.load5': { group: 'CPU', label: 'Load average · 5 min', unit: '', read: v => v.cpu?.load?.[1] },
  'cpu.load15': { group: 'CPU', label: 'Load average · 15 min', unit: '', read: v => v.cpu?.load?.[2] },
};
// Recorded for derived statistics (P-state time, throttle time, power-limit share);
// not chartable on their own, so not exposed through /api/metrics.
export const INTERNAL_METRICS = {
  'gpu.pstate': v => { const m = /^P(\d{1,2})$/.exec(v.gpu?.pstate || ''); return m ? Number(m[1]) : null; },
  'gpu.throttle': v => v.gpu?.throttle,
  'gpu.powerLimit': v => v.gpu?.powerLimit,
};

/** CCDs in display order: sorted L3 IDs mapped to the Tccd sensor numbers. */
export function ccdList(view) {
  const threads = view?.cpu?.threads || [], l3 = [...new Set(threads.map(t => t.ccd))].filter(Number.isInteger).sort((a, b) => a - b);
  return l3.map((id, i) => ({ n: view?.board?.ccds?.[i]?.id ?? i + 1, l3: id, temperature: view?.board?.ccds?.[i]?.temperature ?? null, threads: threads.filter(t => t.ccd === id) }));
}
const avg = list => { const v = list.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/** Resolves an ID to its spec, or null. Sensor-backed IDs must be reported now or have stored samples. */
export function metricSpec(id, view, known = () => false) {
  if (typeof id !== 'string' || !METRIC_ID.test(id)) return null;
  if (Object.hasOwn(STATIC_METRICS, id)) { const { read, legacy, ...spec } = STATIC_METRICS[id]; return { id, ...spec }; }
  const ccd = id.match(/^cpu\.ccd\.(\d{1,2})(?:\.(load|clock))?$/);
  if (ccd) {
    const n = Number(ccd[1]);
    if (!(n >= 1 && n <= 16 && (ccdList(view).some(c => c.n === n) || view?.board?.ccds?.some(c => c.id === n) || known(id)))) return null;
    return ccd[2] === 'load' ? { id, group: 'CPU', label: `CCD ${n} average load`, unit: '%', max: 100 } : ccd[2] === 'clock' ? { id, group: 'CPU', label: `CCD ${n} average clock`, unit: 'MHz' } : { id, group: 'CPU', label: `CCD ${n} temperature`, unit: '°C' };
  }
  const thread = id.match(/^cpu\.thread\.(\d{1,3})$/);
  if (thread) { const n = Number(thread[1]); return n < 512 && (view?.cpu?.threads?.some(t => t.cpu === n) || known(id)) ? { id, group: 'CPU', label: `CPU ${n} load`, unit: '%', max: 100 } : null; }
  const vramCt = id.match(/^gpu\.vram\.ct\.(\d{1,9})$/);
  if (vramCt) { const ct = Number(vramCt[1]), p = view?.processes?.find(x => x.container === ct); return p || known(id) ? { id, group: 'GPU', label: `VRAM · CT ${ct}${p?.containerName ? ` ${p.containerName}` : ''}`, unit: 'GiB' } : null; }
  const sensor = id.match(/^board\.(fan|temp)\.([0-9a-f]{16})$/);
  if (sensor && SENSOR.test(sensor[2])) {
    const list = sensor[1] === 'fan' ? view?.board?.fans : view?.board?.temperatures, item = list?.find(x => x.id === sensor[2]);
    if (!item && !known(id)) return null;
    return sensor[1] === 'fan' ? { id, group: 'Board', label: item?.name || 'Board fan', unit: 'RPM' } : { id, group: 'Board', label: item?.name ? `${item.name} temperature` : 'Board temperature', unit: '°C' };
  }
  return null;
}

/** Every metric value in a fresh compute view, keyed by metric ID. */
export function metricValues(view) {
  if (!view || view.stale) return {};
  const out = {};
  for (const [id, m] of Object.entries(STATIC_METRICS)) { const v = m.read(view); if (Number.isFinite(v)) out[id] = v; }
  for (const [id, read] of Object.entries(INTERNAL_METRICS)) { const v = read(view); if (Number.isFinite(v)) out[id] = v; }
  for (const c of view.board?.ccds || []) if (Number.isInteger(c.id) && Number.isFinite(c.temperature)) out[`cpu.ccd.${c.id}`] = c.temperature;
  for (const c of ccdList(view)) {
    const load = avg(c.threads.map(t => t.load)), clock = avg(c.threads.map(t => t.mhz));
    if (Number.isFinite(load)) out[`cpu.ccd.${c.n}.load`] = load;
    if (Number.isFinite(clock)) out[`cpu.ccd.${c.n}.clock`] = clock;
  }
  for (const t of view.cpu?.threads || []) if (Number.isInteger(t.cpu) && Number.isFinite(t.load)) out[`cpu.thread.${t.cpu}`] = t.load;
  const perCt = {};
  for (const p of view.processes || []) if (Number.isInteger(p.container) && Number.isFinite(p.memory)) perCt[p.container] = (perCt[p.container] || 0) + p.memory / 1024;
  if (view.gpu) for (const [ct, gib] of Object.entries(perCt)) out[`gpu.vram.ct.${ct}`] = gib;
  for (const f of view.board?.fans || []) if (SENSOR.test(f.id) && Number.isFinite(f.rpm)) out[`board.fan.${f.id}`] = f.rpm;
  for (const t of view.board?.temperatures || []) if (SENSOR.test(t.id) && Number.isFinite(t.value)) out[`board.temp.${t.id}`] = t.value;
  return out;
}

/** Legacy `history` keys that hold the same readings, for a one-time backfill. */
export function legacyKeys(view) {
  const map = {};
  for (const [id, m] of Object.entries(STATIC_METRICS)) if (m.legacy) map[id] = m.legacy;
  for (const f of view?.board?.fans || []) if (SENSOR.test(f.id)) map[`board.fan.${f.id}`] = [`fan.${f.id}`];
  for (const t of view?.board?.temperatures || []) if (SENSOR.test(t.id)) map[`board.temp.${t.id}`] = [`temperature.${t.id}`];
  return map;
}

/** Nearest-rank percentile of an ascending array (matches statistics.mjs P99). */
export function percentile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : null; }

export function stats(values, peakAt = null, lowAt = null) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { count: sorted.length, average: sorted.reduce((a, b) => a + b, 0) / sorted.length, min: sorted[0], max: sorted.at(-1), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), peakAt, lowAt };
}

function aggregate(samples, step) {
  const buckets = new Map();
  for (const s of samples) {
    const key = Math.floor(s.ts / step) * step, b = buckets.get(key);
    if (!b) buckets.set(key, { ts: key + step / 2, min: s.min, max: s.max, sum: s.sum, count: s.count });
    else { b.min = Math.min(b.min, s.min); b.max = Math.max(b.max, s.max); b.sum += s.sum; b.count += s.count; }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts).map(b => ({ ts: b.ts, min: b.min, max: b.max, avg: b.sum / b.count }));
}

/** Range query: chart points (min/avg/max) plus statistics over every stored sample in range. */
export function metricHistory(store, spec, range, now = Date.now()) {
  const r = RANGES[range];
  if (!r) throw new Error('Invalid range');
  const from = now - r.duration;
  let points, values, peakAt = null, lowAt = null, current = null, first = null, last = null;
  if (r.source === 'raw') {
    const rows = store.metricRaw(spec.id, from, now);
    values = rows.map(x => x.value);
    let hi = -Infinity, lo = Infinity;
    for (const x of rows) { if (x.value > hi) { hi = x.value; peakAt = x.ts; } if (x.value < lo) { lo = x.value; lowAt = x.ts; } }
    points = r.step === 30_000 ? rows.map(x => ({ ts: x.ts, min: x.value, avg: x.value, max: x.value })) : aggregate(rows.map(x => ({ ts: x.ts, min: x.value, max: x.value, sum: x.value, count: 1 })), r.step);
    current = rows.at(-1)?.value ?? null; first = rows[0]?.ts ?? null; last = rows.at(-1)?.ts ?? null;
  } else {
    const rows = store.metricBuckets(spec.id, from - BUCKET_MS, now).filter(b => b.bucket + BUCKET_MS > from);
    values = rows.flatMap(b => b.samples);
    let hi = -Infinity, lo = Infinity;
    for (const b of rows) { if (b.max > hi) { hi = b.max; peakAt = b.maxTs; } if (b.min < lo) { lo = b.min; lowAt = b.minTs; } }
    points = aggregate(rows.map(b => ({ ts: b.bucket, min: b.min, max: b.max, sum: b.sum, count: b.count })), r.step);
    const latest = store.metricRaw(spec.id, now - BUCKET_MS * 2, now).at(-1);
    current = latest?.value ?? null; first = rows[0]?.bucket ?? null; last = rows.at(-1)?.lastTs ?? null;
  }
  const summary = stats(values, peakAt, lowAt);
  return { metric: spec, range, from, to: now, step: r.step, resolution: { '1h': '30-second samples', '24h': '30-second samples, charted as 5-minute min / avg / max', '7d': '5-minute buckets of 30-second samples, charted per 30 minutes' }[range],
    points, statistics: summary ? { ...summary, current, first, last } : null };
}

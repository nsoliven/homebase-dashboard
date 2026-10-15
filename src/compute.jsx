import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Boxes, Fan, Gpu, Microchip } from 'lucide-react';
import { age, fmt, isNumber } from './api.js';
import { Badge, Dialog, Dot, Empty, Meter, Panel } from './components.jsx';
import { useComputeLive, useNow } from './hooks.js';
import { RefreshButton } from './refresh.jsx';

/* ---------- motion: one rAF loop, data-driven speeds, nothing decorative ---------- */
const spinners = new Set();
let frame = null, last = 0;
const prefersReduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function tick(t) {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
  last = t;
  let moving = false;
  for (const s of spinners) {
    // Ease toward the measured speed so a new reading spins up or down smoothly.
    s.speed += (s.target - s.speed) * Math.min(1, dt * 1.8);
    if (s.target === 0 && Math.abs(s.speed) < 0.003) s.speed = 0;
    if (s.speed) { s.angle = (s.angle + s.speed * 360 * dt) % 360; s.el.style.transform = `rotate(${s.angle.toFixed(2)}deg)`; moving = true; }
  }
  frame = moving || [...spinners].some(s => s.target) ? requestAnimationFrame(tick) : null;
  if (!frame) last = 0;
}
function kick() { if (!frame && spinners.size && !document.hidden) { last = 0; frame = requestAnimationFrame(tick); } }
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', kick);

/** Rotates `ref` at `revsPerSecond` while `enabled`. Reduced motion: static. */
function useSpin(ref, revsPerSecond, enabled) {
  const spinner = useRef(null);
  useEffect(() => {
    if (!enabled || !ref.current || prefersReduced()) return;
    const s = { el: ref.current, angle: spinner.current?.angle || 0, speed: spinner.current?.speed || 0, target: revsPerSecond || 0 };
    spinner.current = s; spinners.add(s); kick();
    return () => { spinners.delete(s); };
  }, [enabled]);
  useEffect(() => { if (spinner.current) { spinner.current.target = revsPerSecond || 0; kick(); } }, [revsPerSecond]);
}
function useOnScreen(ref) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '120px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return visible;
}

/* ---------- scales ---------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Temperature tint for the glow: cool accent, then violet, then amber near limits.
function tempColor(t) {
  if (!isNumber(t)) return '#9aa3bd';
  const stops = [[40, [69, 104, 213]], [62, [131, 113, 173]], [80, [196, 132, 40]], [92, [201, 83, 77]]];
  if (t <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [t0, a] = stops[i - 1], [t1, b] = stops[i], f = (t - t0) / (t1 - t0);
    return `rgb(${a.map((x, j) => Math.round(x + (b[j] - x) * f)).join(',')})`;
  }
  return `rgb(${stops.at(-1)[1]})`;
}
// Sequential single-hue ramp for load (light -> deep accent).
const heat = load => isNumber(load) ? `color-mix(in oklab, #2c49b8 ${Math.round(clamp(load, 0, 100))}%, #e6eaf7)` : '#3a3d45';
const gib = mib => isNumber(mib) ? mib / 1024 : null;
const shortGpu = name => (name || 'GPU').replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, 'GeForce ');
const shortCpu = model => (model || 'CPU').replace(/^AMD\s+/i, '').replace(/\s+\d+-Core Processor$/i, '');
const throttleText = bits => !isNumber(bits) ? null : bits === 0 ? 'No clock limiter active' : bits & 0x60 ? 'Thermal slowdown' : bits & 0x88 ? 'Hardware slowdown' : bits & 0x4 ? 'Power cap reached' : bits & 0x1 ? 'Idle clocks' : 'Clock limiter active';

/* ---------- sparkline ---------- */
export function Sparkline({ series, k, unit = "", width = 132, height = 28, max, label, stretch = false }) {
  const points = series.filter(p => isNumber(p[k]));
  if (points.length < 2) return <div className="sparkline sparkline-empty" style={{ height }}>Collecting history</div>;
  const from = Date.now() - 15 * 60_000, to = Math.max(points.at(-1).ts, from + 1);
  const values = points.map(p => p[k]), lo = Math.min(...values), hi = Math.max(...values);
  // Unbounded series keep a minimum span so sensor noise is not magnified into drama.
  const span = Math.max(hi - lo, 2, Math.abs(hi) * 0.15), mid = (hi + lo) / 2;
  const top = max ?? mid + span / 2, bottom = max !== undefined ? 0 : mid - span / 2;
  const x = ts => clamp((ts - from) / (to - from), 0, 1) * width, y = v => height - 3 - (v - bottom) / (top - bottom || 1) * (height - 6);
  const steps = points.slice(1).map((p, i) => p.ts - points[i].ts).sort((a, b) => a - b), gap = Math.max(90_000, (steps[Math.floor(steps.length / 2)] || 0) * 3);
  const segments = []; let current = [];
  points.forEach((p, i) => { if (i && p.ts - points[i - 1].ts > gap) { segments.push(current); current = []; } current.push(p); });
  segments.push(current);
  const end = points.at(-1);
  return <svg className={`sparkline ${stretch ? "stretch" : ""}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio={stretch ? "none" : undefined} role="img" aria-label={`${label}: last 15 minutes, low ${fmt(lo)}${unit}, high ${fmt(hi)}${unit}`}>
    <title>{`${label} · last 15 min · low ${fmt(lo)}${unit} · high ${fmt(hi)}${unit}`}</title>
    {segments.filter(s => s.length > 1).map((s, i) => { const d = s.map((p, j) => `${j ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' '); return <g key={i}><path d={`${d} L${x(s.at(-1).ts).toFixed(1)},${height} L${x(s[0].ts).toFixed(1)},${height} Z`} className="sparkline-area" /><path d={d} className="sparkline-line" vectorEffect="non-scaling-stroke" /></g>; })}
    {!stretch && <circle cx={x(end.ts)} cy={y(end[k])} r="2.4" className="sparkline-end" />}
  </svg>;
}

/* ---------- Tesla-style callouts with leader lines ---------- */
function Callout({ n, side, title, children, calloutRef }) {
  return <div className="callout" data-side={side} ref={calloutRef}><div className="callout-head"><span className="callout-index">{n}</span><span className="eyebrow">{title}</span></div>{children}</div>;
}
function useLeaders(stageRef, artRef, anchors, viewBox, deps) {
  const callouts = useRef({}), [lines, setLines] = useState([]);
  const measure = useCallback(() => {
    const stage = stageRef.current, art = artRef.current;
    if (!stage || !art) return;
    const s = stage.getBoundingClientRect(), a = art.getBoundingClientRect();
    if (getComputedStyle(stage).getPropertyValue('--leaders').trim() !== '1') { setLines([]); return; }
    const next = Object.entries(anchors).flatMap(([key, [ax, ay]]) => {
      const el = callouts.current[key]; if (!el) return [];
      const c = el.getBoundingClientRect(), side = el.dataset.side, head = el.querySelector('.callout-head').getBoundingClientRect();
      const px = side === 'left' ? c.right - s.left + 6 : c.left - s.left - 6, py = head.top + head.height / 2 - s.top;
      const tx = a.left - s.left + ax / viewBox[0] * a.width, ty = a.top - s.top + ay / viewBox[1] * a.height;
      const ex = px + (side === 'left' ? 18 : -18);
      return [{ key, d: `M${px.toFixed(1)},${py.toFixed(1)} H${ex.toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}`, px, py, tx, ty }];
    });
    setLines(next);
  }, [anchors, viewBox]);
  useLayoutEffect(measure, deps);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !stageRef.current) return;
    const observer = new ResizeObserver(() => measure()); observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [measure]);
  const register = key => el => { callouts.current[key] = el; };
  return [lines, register];
}
function Leaders({ lines }) {
  return <svg className="leaders" aria-hidden="true">{lines.map(l => <g key={l.key}><path d={l.d} /><circle cx={l.px} cy={l.py} r="2" className="leader-end" /><circle cx={l.tx} cy={l.ty} r="7.5" className="leader-halo" /><circle cx={l.tx} cy={l.ty} r="3" className="leader-dot" /></g>)}</svg>;
}
function Marker({ n, x, y }) { return <g className="art-marker" transform={`translate(${x} ${y})`}><circle r="8" /><text y="3.2" textAnchor="middle">{n}</text></g>; }

/* ---------- GPU illustration ---------- */
const GPU_BOX = [520, 236];
const GPU_ANCHORS = { memory: [228, 60], cooling: [132, 116], state: [11, 172], power: [316, 13], core: [263, 132], video: [304, 190] };
function Blades({ count, r }) {
  return Array.from({ length: count }, (_, i) => <path key={i} transform={`rotate(${i * 360 / count})`} d={`M0,-${r * 0.24} C${r * 0.24},-${r * 0.36} ${r * 0.48},-${r * 0.66} ${r * 0.36},-${r * 0.96} C${r * 0.18},-${r * 0.92} ${r * 0.04},-${r * 0.62} -${r * 0.1},-${r * 0.25} Z`} className="gpu-blade" />);
}
function GpuFan({ cx, cy, r, revs, enabled }) {
  const rotor = useRef(null);
  useSpin(rotor, revs, enabled);
  return <g transform={`translate(${cx} ${cy})`}>
    <circle r={r + 4} className="gpu-fan-ring" /><circle r={r} fill="url(#gpu-well)" />
    {[0.55, 0.8].map(f => <circle key={f} r={r * f} className="gpu-fan-grille" />)}
    <g ref={rotor} className="rotor"><circle r={r} fill="transparent" /><Blades count={11} r={r - 3} /><circle r={r * 0.24} className="gpu-hub" /><circle r={r * 0.1} className="gpu-hub-cap" /></g>
  </g>;
}
function GpuArt({ gpu, artRef, animate }) {
  const util = gpu?.utilization ?? 0, glow = tempColor(gpu?.temperature), revs = isNumber(gpu?.fan) ? gpu.fan / 100 * 3.2 : 0;
  return <svg ref={artRef} className="gpu-art" viewBox={`0 0 ${GPU_BOX[0]} ${GPU_BOX[1]}`} role="img" aria-label={`Illustration of the ${shortGpu(gpu?.name)}; fans at ${fmt(gpu?.fan, 0)}%, ${fmt(util, 0)}% load`}>
    <defs>
      <linearGradient id="gpu-metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f6f7f9" /><stop offset=".45" stopColor="#cdd0d7" /><stop offset="1" stopColor="#e5e7ec" /></linearGradient>
      <linearGradient id="gpu-plate" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#30333b" /><stop offset="1" stopColor="#15171b" /></linearGradient>
      <radialGradient id="gpu-well"><stop offset="0" stopColor="#24262c" /><stop offset="1" stopColor="#0d0e11" /></radialGradient>
      <filter id="gpu-blur" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="16" /></filter>
    </defs>
    <ellipse cx="262" cy="222" rx="232" ry="14" className="art-shadow" />
    <ellipse cx="262" cy="214" rx="214" ry="18" filter="url(#gpu-blur)" className="art-glow" style={{ fill: glow, opacity: 0.1 + clamp(util, 0, 100) / 100 * 0.55 }} />
    <rect x="4" y="12" width="15" height="208" rx="3" fill="url(#gpu-metal)" className="gpu-outline" />
    {[0, 1, 2, 3, 4, 5, 6].map(i => <rect key={i} x="8" y={30 + i * 24} width="7" height="16" rx="2" className="gpu-vent" />)}
    <rect x="70" y="212" width="190" height="9" rx="2" className="gpu-fingers" /><rect x="108" y="212" width="4" height="9" className="gpu-notch" />
    <rect x="298" y="8" width="36" height="12" rx="2.5" className="gpu-connector" />
    {[0, 1, 2, 3, 4, 5].map(i => <rect key={i} x={302 + i * 5} y="11" width="3" height="5" rx="1" className="gpu-pin" />)}
    <rect x="18" y="16" width="492" height="198" rx="18" fill="url(#gpu-metal)" className="gpu-outline" />
    <rect x="28" y="26" width="472" height="178" rx="12" fill="url(#gpu-plate)" />
    <path d="M206,26 L232,92 L294,92 L320,26 Z M206,204 L232,140 L294,140 L320,204 Z" className="gpu-x" />
    <line x1="176" x2="350" y1="18.5" y2="18.5" className="gpu-lightbar" style={{ stroke: glow, opacity: 0.35 + clamp(util, 0, 100) / 100 * 0.65 }} />
    <text x="263" y="112" textAnchor="middle" className="gpu-brand-small">GEFORCE</text>
    <text x="263" y="128" textAnchor="middle" className="gpu-brand">{(gpu?.name || 'RTX').match(/RTX\s*\d{4}\s*\w*/i)?.[0]?.toUpperCase() || 'GPU'}</text>
    <GpuFan cx={132} cy={116} r={70} revs={revs} enabled={animate} />
    <GpuFan cx={394} cy={116} r={70} revs={revs} enabled={animate} />
    {Object.entries(GPU_ANCHORS).map(([k, [x, y]], i) => <Marker key={k} n={GPU_ORDER.indexOf(k) + 1} x={x} y={y} />)}
  </svg>;
}
const GPU_ORDER = ['memory', 'cooling', 'state', 'power', 'core', 'video'];

/* ---------- CPU illustration ---------- */
const CPU_BOX = [360, 300];
const CPU_ANCHORS = { ccd0: [112, 104], package: [180, 181], clocks: [120, 228], load: [296, 60], ccd1: [248, 104], board: [334, 278] };
const CPU_ORDER = ['ccd0', 'package', 'clocks', 'load', 'ccd1', 'board'];
function coreSlots(threads, ccd) {
  const cores = [...new Set(threads.filter(t => t.ccd === ccd).map(t => t.core))].sort((a, b) => a - b);
  return cores.map(core => ({ core, threads: threads.filter(t => t.ccd === ccd && t.core === core).sort((a, b) => a.cpu - b.cpu) }));
}
function Ccd({ x, y, slots, label }) {
  const total = Math.max(8, slots.length), rows = Math.ceil(total / 2), h = (128 - 12 - (rows - 1) * 4) / rows;
  const slot = i => ({ sx: x + (i % 2 ? 84 : 6), sy: y + 6 + Math.floor(i / 2) * (h + 4) });
  return <g>
    <rect x={x} y={y} width="120" height="128" rx="6" className="cpu-die" />
    <rect x={x + 40} y={y + 6} width="40" height="116" rx="3" className="cpu-cache" />
    <text x={x + 60} y={y + 66} textAnchor="middle" className="cpu-die-text">L3</text>
    {Array.from({ length: total }, (_, i) => {
      const { sx, sy } = slot(i), core = slots[i];
      if (!core) return <rect key={i} x={sx} y={sy} width="30" height={h} rx="2.5" className="cpu-core-off"><title>Inactive core position</title></rect>;
      const loads = core.threads.map(t => t.load), w = (30 - (core.threads.length - 1)) / core.threads.length;
      return <g key={i}><title>{`${label} · core ${core.core} · ${core.threads.map(t => `CPU ${t.cpu} ${isNumber(t.load) ? `${fmt(t.load, 0)}%` : 'measuring'}`).join(' · ')}${isNumber(core.threads[0]?.mhz) ? ` · ${fmt(core.threads[0].mhz, 0)} MHz` : ''}`}</title>
        {core.threads.map((t, j) => <rect key={t.cpu} x={sx + j * (w + 1)} y={sy} width={w} height={h} rx="2.5" className="cpu-thread" style={{ fill: heat(loads[j]) }} />)}</g>;
    })}
  </g>;
}
function CpuArt({ cpu, board, artRef }) {
  const threads = cpu?.threads || [], ccds = [...new Set(threads.map(t => t.ccd))].filter(isNumber).sort((a, b) => a - b);
  const util = cpu?.utilization ?? 0, glow = tempColor(board?.tctl);
  return <svg ref={artRef} className="cpu-art" viewBox={`0 0 ${CPU_BOX[0]} ${CPU_BOX[1]}`} role="img" aria-label={`Diagram of the ${shortCpu(cpu?.model)} package with per-thread load`}>
    <defs><filter id="cpu-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="18" /></filter>
      <pattern id="cpu-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="#4a4e58" strokeWidth="1.4" /></pattern></defs>
    <rect x="40" y="34" width="280" height="240" rx="30" filter="url(#cpu-blur)" className="art-glow" style={{ fill: glow, opacity: 0.08 + clamp(util, 0, 100) / 100 * 0.5 }} />
    <rect x="20" y="14" width="320" height="272" rx="12" className="cpu-substrate" />
    {[[26, 60], [26, 196], [322, 60], [322, 196]].map(([cx, cy]) => Array.from({ length: 8 }, (_, i) => <rect key={`${cx}-${cy}-${i}`} x={cx} y={cy + i * 6} width="12" height="3.6" rx="1" className="cpu-cap" />))}
    {[0, 1].map(i => <Ccd key={i} x={i ? 188 : 52} y={36} slots={ccds[i] !== undefined ? coreSlots(threads, ccds[i]) : []} label={`CCD ${i + 1}`} />)}
    <text x="112" y="183" textAnchor="middle" className="cpu-label">CCD 1</text><text x="248" y="183" textAnchor="middle" className="cpu-label">CCD 2</text>
    <rect x="96" y="194" width="168" height="72" rx="6" className="cpu-iod" />
    <text x="180" y="226" textAnchor="middle" className="cpu-die-text strong">I/O DIE</text>
    <text x="180" y="242" textAnchor="middle" className="cpu-die-text">DDR5 · PCIE · IGPU</text>
    {Object.entries(CPU_ANCHORS).map(([k, [x, y]]) => <Marker key={k} n={CPU_ORDER.indexOf(k) + 1} x={x} y={y} />)}
  </svg>;
}

function FanDial({ fan, animate }) {
  const rotor = useRef(null), pump = fan.role === 'pump' || /pump/i.test(fan.name);
  useSpin(rotor, clamp(fan.rpm / 1000, 0, 4), animate);
  const share = fan.maxRpm ? fan.rpm / fan.maxRpm * 100 : null;
  return <div className="fan-dial" title={`${fan.name} · ${fmt(fan.rpm, 0)} RPM${fan.maxRpm ? ` of ${fmt(fan.maxRpm, 0)} RPM reference` : ''}${fan.role === 'unassigned' ? ' · role not configured' : ''}`}>
    <svg viewBox="-20 -20 40 40" aria-hidden="true"><circle r="18.5" className="fan-dial-ring" /><g ref={rotor} className="rotor"><circle r="17" fill="transparent" />{pump
      ? Array.from({ length: 6 }, (_, i) => <path key={i} transform={`rotate(${i * 60})`} d="M0,-4 Q7,-9 4,-15 L1,-15 Q2,-9 -2,-4 Z" className="fan-dial-blade" />)
      : Array.from({ length: 7 }, (_, i) => <path key={i} transform={`rotate(${i * 360 / 7})`} d="M0,-4 C5,-7 9,-12 6,-16 C3,-16 0,-11 -2,-4 Z" className="fan-dial-blade" />)}<circle r="4" className="fan-dial-hub" /></g></svg>
    <div><span>{fan.name}</span><strong>{fmt(fan.rpm, 0)}<small> RPM</small></strong>{isNumber(share) && <small className="fan-share">{fmt(share, 0)}% of ref.</small>}</div>
  </div>;
}

/* ---------- stages ---------- */
function Stage({ className, art, left, right, anchors, viewBox, deps }) {
  const stage = useRef(null), artRef = useRef(null);
  const [lines, register] = useLeaders(stage, artRef, anchors, viewBox, deps);
  return <div className={`compute-stage ${className}`} ref={stage}>
    <div className="callout-column left">{left(register)}</div>
    <div className="stage-art">{art(artRef)}</div>
    <div className="callout-column right">{right(register)}</div>
    <Leaders lines={lines} />
  </div>;
}

function GpuStage({ c, series, animate }) {
  const g = c.gpu, memoryPct = g && g.memoryTotal > 0 ? g.memoryUsed / g.memoryTotal * 100 : null, powerPct = g && g.powerLimit > 0 ? g.powerDraw / g.powerLimit * 100 : null;
  if (!g) return <Empty icon={Gpu} title="GPU readings unavailable" text={c.gpuError === 'unreadable' ? 'nvidia-smi answered in an unexpected format. No values are guessed.' : 'nvidia-smi did not answer on the host. The card may be passed through to a VM or its driver may be unloaded.'} />;
  const n = k => GPU_ORDER.indexOf(k) + 1;
  return <Stage className="gpu-stage" anchors={GPU_ANCHORS} viewBox={GPU_BOX} deps={[c.observedAt, series.length]}
    art={ref => <GpuArt gpu={g} artRef={ref} animate={animate} />}
    left={reg => <>
      <Callout n={n('memory')} side="left" title="Video memory" calloutRef={reg('memory')}><div className="callout-value"><strong>{fmt(gib(g.memoryUsed))}</strong><small> / {fmt(gib(g.memoryTotal), 0)} GiB</small></div><Meter value={memoryPct} label="GPU memory used" /><p>{fmt(g.memoryClock, 0)} MHz{isNumber(g.memoryUtilization) ? ` · bus ${fmt(g.memoryUtilization, 0)}% busy` : ''}<br />{isNumber(g.memoryTemperature) ? `Memory ${fmt(g.memoryTemperature, 0)}°C` : 'Memory temperature not reported'}</p></Callout>
      <Callout n={n('cooling')} side="left" title="Cooling" calloutRef={reg('cooling')}><div className="callout-value"><strong>{fmt(g.fan, 0)}</strong><small>% fan</small></div><p>{g.fan === 0 ? 'Zero-RPM mode · fans stopped' : 'Fan duty target from the driver'}<br />Hotspot not exposed by nvidia-smi</p></Callout>
      <Callout n={n('state')} side="left" title="State & link" calloutRef={reg('state')}><div className="callout-value"><strong>{g.pstate || '—'}</strong><small> {g.pstate === 'P0' ? 'max performance' : g.pstate === 'P8' ? 'idle' : 'performance state'}</small></div><p>{isNumber(g.pcieGen) ? `PCIe Gen ${fmt(g.pcieGen, 0)} ×${fmt(g.pcieWidth, 0)} now` : 'PCIe link not reported'}<br />{throttleText(g.throttle) || 'Clock limiter not reported'}{g.driver ? ` · driver ${g.driver}` : ''}</p></Callout>
    </>}
    right={reg => <>
      <Callout n={n('power')} side="right" title="Board power" calloutRef={reg('power')}><div className="callout-value"><strong>{fmt(g.powerDraw)}</strong><small> W</small></div><Meter value={powerPct} tone={powerPct > 92 ? 'amber' : 'accent'} label="GPU power draw of limit" /><p>of {fmt(g.powerLimit, 0)} W limit{isNumber(powerPct) ? ` · ${fmt(powerPct, 0)}%` : ''}</p><Sparkline series={series} k="gpuPower" unit=" W" label="GPU power" /></Callout>
      <Callout n={n('core')} side="right" title="Core" calloutRef={reg('core')}><div className="callout-pair"><div className="callout-value"><strong>{fmt(g.temperature, 0)}</strong><small>°C</small></div><div className="callout-value"><strong>{fmt(g.utilization, 0)}</strong><small>% load</small></div></div><p>{fmt(g.coreClock, 0)} MHz{isNumber(g.coreClockMax) ? ` of ${fmt(g.coreClockMax, 0)} max` : ''}</p><div className="spark-pair"><span>Temp</span><Sparkline series={series} k="gpuTemperature" unit="°C" label="GPU temperature" /><span>Load</span><Sparkline series={series} k="gpuUtilization" unit="%" max={100} label="GPU utilization" /></div></Callout>
      <Callout n={n('video')} side="right" title="Video engines" calloutRef={reg('video')}><div className="callout-pair"><div className="callout-value"><strong>{fmt(g.encoder, 0)}</strong><small>% enc</small></div><div className="callout-value"><strong>{fmt(g.decoder, 0)}</strong><small>% dec</small></div></div><p>NVENC / NVDEC utilization</p></Callout>
    </>} />;
}

function CpuStage({ c, series, thermalLimit }) {
  const cpu = c.cpu || {}, b = c.board || {}, threads = cpu.threads || [];
  const ccdIds = [...new Set(threads.map(t => t.ccd))].filter(isNumber).sort((x, y) => x - y);
  const ccd = i => { const list = threads.filter(t => t.ccd === ccdIds[i]), loads = list.map(t => t.load).filter(isNumber), mhz = list.map(t => t.mhz).filter(isNumber); return { cores: new Set(list.map(t => t.core)).size, load: loads.length ? loads.reduce((a, v) => a + v, 0) / loads.length : null, mhz: mhz.length ? mhz.reduce((a, v) => a + v, 0) / mhz.length : null, temperature: b.ccds?.[i]?.temperature ?? null }; };
  const temps = Object.fromEntries((b.temperatures || []).map(t => [t.name, t.value]));
  const n = k => CPU_ORDER.indexOf(k) + 1;
  const ccdCallout = (i, reg, side) => { const d = ccd(i); return <Callout n={n(i ? 'ccd1' : 'ccd0')} side={side} title={`CCD ${i + 1}`} calloutRef={reg(i ? 'ccd1' : 'ccd0')}><div className="callout-value"><strong>{fmt(d.temperature)}</strong><small>°C</small></div><p>{d.cores ? `${d.cores} cores` : 'No cores reported'} · {isNumber(d.load) ? `${fmt(d.load, 0)}% avg load` : 'measuring load'}<br />{isNumber(d.mhz) ? `${fmt(d.mhz, 0)} MHz average` : 'Clock not reported'}</p></Callout>; };
  return <Stage className="cpu-stage" anchors={CPU_ANCHORS} viewBox={CPU_BOX} deps={[c.observedAt, series.length]}
    art={ref => <CpuArt cpu={cpu} board={b} artRef={ref} />}
    left={reg => <>
      {ccdCallout(0, reg, 'left')}
      <Callout n={n('package')} side="left" title="Package · Tctl" calloutRef={reg('package')}><div className="callout-value"><strong>{fmt(b.tctl)}</strong><small>°C</small></div><p>{thermalLimit ? `${thermalLimit}°C rated limit · boost runs close to it` : 'Control temperature'}<br />{isNumber(cpu.power) ? `${fmt(cpu.power, 0)} W package` : 'Package power measuring'}{isNumber(b.vcore) ? ` · ${fmt(b.vcore, 3)} V core` : ''}</p><Sparkline series={series} k="cpuTemperature" unit="°C" label="CPU package temperature" /></Callout>
      <Callout n={n('clocks')} side="left" title="Clocks" calloutRef={reg('clocks')}><div className="callout-value"><strong>{fmt(cpu.clockAverage, 0)}</strong><small> MHz avg</small></div><p>Peak thread {fmt(cpu.clockMax, 0)} MHz<br />{cpu.coreCount || '—'} cores · {cpu.threadCount || '—'} threads</p></Callout>
    </>}
    right={reg => <>
      <Callout n={n('load')} side="right" title="Utilization" calloutRef={reg('load')}><div className="callout-value"><strong>{fmt(cpu.utilization, 0)}</strong><small>%</small></div><p>Load average {cpu.load ? cpu.load.map(v => fmt(v, 2)).join(' · ') : '—'}<br /><span className="muted-inline">1 · 5 · 15 minutes</span></p><Sparkline series={series} k="cpuUtilization" unit="%" max={100} label="CPU utilization" /></Callout>
      {ccdCallout(1, reg, 'right')}
      <Callout n={n('board')} side="right" title="Board" calloutRef={reg('board')}><div className="callout-value"><strong>{fmt(temps['VRM MOS'])}</strong><small>°C VRM</small></div><p>{['PCH', 'CPU Socket', 'System'].filter(k => isNumber(temps[k])).map(k => `${k === 'PCH' ? 'Chipset' : k} ${fmt(temps[k], 0)}°C`).join(' · ') || 'Board temperatures not reported'}<br /><span className="muted-inline">{b.name || 'Motherboard sensors'}</span></p></Callout>
    </>} />;
}

function Processes({ processes }) {
  return <div className="gpu-processes"><span className="eyebrow"><Boxes size={12} /> Using the GPU</span>
    {processes.length ? processes.map(p => <span className="process-chip" key={p.pid}><strong>{p.name}</strong><small>{p.container ? `CT ${p.container}${p.containerName ? ` · ${p.containerName}` : ''}` : 'host'} · {isNumber(p.memory) ? `${fmt(p.memory / 1024)} GiB` : 'memory n/a'}</small></span>)
      : <span className="process-none">No compute processes right now</span>}</div>;
}
function BoardFans({ fans, animate }) {
  const spinning = fans.filter(f => f.rpm > 0), idle = fans.length - spinning.length;
  if (!fans.length) return null;
  return <div className="board-fans"><span className="eyebrow"><Fan size={12} /> Board fans · nct6687</span><div className="fan-dials">{spinning.map(f => <FanDial key={f.id} fan={f} animate={animate} />)}</div>{idle > 0 && <small className="muted-inline">{idle} header{idle === 1 ? '' : 's'} at 0 RPM · unused or stopped</small>}</div>;
}

function liveState(c, now) {
  if (!c) return { tone: 'gray', label: 'Not connected' };
  const seconds = (now - c.observedAt) / 1000;
  return c.stale ? { tone: 'amber', label: 'Stale' } : seconds < 12 ? { tone: 'green', label: 'Live' } : { tone: 'blue', label: 'Every 30 s' };
}

/** The showcase panel: GPU and CPU stages with live, data-driven motion. */
export function ComputeShowcase({ snapshot, open, thermalLimit }) {
  const root = useRef(null), visible = useOnScreen(root), now = useNow(1000);
  const [live] = useComputeLive(visible && Boolean(snapshot.refresh?.compute || snapshot.compute));
  const c = live.compute || snapshot.compute, series = live.series || [];
  const status = liveState(c, now), animate = visible && !c?.stale;
  const source = snapshot.sources.find(s => s.id === 'compute');
  return <div ref={root} className="showcase-wrap"><Panel id="showcase" title="GPU & CPU" icon={Microchip} className="showcase-panel"
    action={<div className="showcase-actions"><Badge tone={status.tone === 'green' ? 'success' : status.tone === 'amber' ? 'warning' : 'neutral'}><Dot tone={status.tone} />{status.label}</Badge><button className="text-button" onClick={() => open({ type: 'compute' })}>Details <ArrowUpRight size={14} /></button></div>}
    refresh={<RefreshButton sources={['compute']} label="Refresh GPU and CPU readings" />}>
    {!c ? <Empty icon={Gpu} title="GPU & CPU telemetry is not connected" text={source?.message || 'The bridge sends readings from the hypervisor once the compute collector is enabled.'} /> : <>
      <section className="showcase-section" aria-label="Graphics card">
        <div className="showcase-heading"><div><span className="eyebrow">Graphics · {c.processes?.[0]?.containerName ? `shared with ${c.processes[0].containerName}` : 'hypervisor host'}</span><h3>{shortGpu(c.gpu?.name)}</h3></div><span className="showcase-observed">Observed {age(c.observedAt)}{c.gpu?.driver ? ` · driver ${c.gpu.driver}` : ''}</span></div>
        <GpuStage c={c} series={series} animate={animate} />
        {c.gpu && <Processes processes={c.processes || []} />}
      </section>
      <section className="showcase-section" aria-label="Processor">
        <div className="showcase-heading"><div><span className="eyebrow">Processor · per-thread load</span><h3>{shortCpu(c.cpu?.model)}</h3></div><span className="heat-legend" aria-label="Thread load scale from 0 to 100 percent"><small>0%</small><i /><small>100%</small></span></div>
        <CpuStage c={c} series={series} thermalLimit={thermalLimit} />
        <BoardFans fans={c.board?.fans || []} animate={animate} />
      </section>
      <div className="panel-footnote"><span>{status.label === 'Live' ? 'Collecting every 3 s while this panel is visible' : 'Collected every 30 s in the background'}</span><span>Spin speed follows reported fan duty / RPM</span></div>
    </>}
  </Panel></div>;
}

/** Details modal: every reading as text, larger trends, and the process list. */
export function ComputeDetail({ snapshot, close, thermalLimit }) {
  const [live] = useComputeLive(true); useNow(1000);
  const c = live.compute || snapshot.compute, series = live.series || [], g = c?.gpu, cpu = c?.cpu || {}, b = c?.board || {};
  const row = (label, value) => <React.Fragment key={label}><span>{label}</span><strong>{value}</strong></React.Fragment>;
  return <Dialog title="GPU & CPU" close={close} actions={<RefreshButton sources={['compute']} label="Refresh GPU and CPU readings" showStatus />}>
    {!c ? <Empty icon={Gpu} title="GPU & CPU telemetry is not connected" /> : <>
      <div className="detail-subtitle"><Badge tone={c.stale ? 'warning' : 'success'}>{c.stale ? 'Stale reading' : 'Current reading'}</Badge><span>Observed {age(c.observedAt)} · hypervisor host</span></div>
      <section className="detail-section"><div className="detail-section-heading"><Gpu size={16} /><h3>{shortGpu(g?.name)}</h3><span>nvidia-smi</span></div>
        {g ? <><div className="trend-grid">{[['gpuTemperature', 'Temperature', '°C'], ['gpuUtilization', 'Utilization', '%', 100], ['gpuPower', 'Board power', ' W'], ['gpuMemory', 'Memory used', '%', 100]].map(([k, label, unit, max]) => <div key={k}><span>{label}</span><Sparkline series={series} k={k} unit={unit} max={max} width={220} height={44} label={label} stretch /></div>)}</div>
          <div className="integration-spec">{[
            row('Temperature', `${fmt(g.temperature, 0)}°C · memory ${isNumber(g.memoryTemperature) ? `${fmt(g.memoryTemperature, 0)}°C` : 'not reported'}`),
            row('Utilization', `${fmt(g.utilization, 0)}% core · ${fmt(g.memoryUtilization, 0)}% memory bus`),
            row('Video memory', `${fmt(gib(g.memoryUsed))} of ${fmt(gib(g.memoryTotal))} GiB`),
            row('Power', `${fmt(g.powerDraw)} W of ${fmt(g.powerLimit, 0)} W limit${isNumber(g.powerMaxLimit) ? ` (max ${fmt(g.powerMaxLimit, 0)} W)` : ''}`),
            row('Clocks', `${fmt(g.coreClock, 0)} MHz core · ${fmt(g.memoryClock, 0)} MHz memory`),
            row('Fan', `${fmt(g.fan, 0)}%${g.fan === 0 ? ' · zero-RPM idle' : ''}`),
            row('Video engines', `${fmt(g.encoder, 0)}% encode · ${fmt(g.decoder, 0)}% decode`),
            row('State', `${g.pstate || '—'} · ${throttleText(g.throttle) || 'limiter not reported'}`),
            row('PCIe link', isNumber(g.pcieGen) ? `Gen ${fmt(g.pcieGen, 0)} ×${fmt(g.pcieWidth, 0)}` : 'Not reported'),
            row('Driver', g.driver || '—'),
          ]}</div>
          <Processes processes={c.processes || []} /></> : <Empty title="GPU readings unavailable" />}
      </section>
      <section className="detail-section"><div className="detail-section-heading"><Microchip size={16} /><h3>{shortCpu(cpu.model)}</h3><span>/proc · hwmon</span></div>
        <div className="trend-grid">{[['cpuTemperature', 'Package Tctl', '°C'], ['cpuUtilization', 'Utilization', '%', 100]].map(([k, label, unit, max]) => <div key={k}><span>{label}</span><Sparkline series={series} k={k} unit={unit} max={max} width={220} height={44} label={label} stretch /></div>)}</div>
        <div className="integration-spec">{[
          row('Package', `${fmt(b.tctl)}°C Tctl${thermalLimit ? ` · ${thermalLimit}°C rated limit` : ''}`),
          ...(b.ccds || []).map(x => row(`CCD ${x.id}`, `${fmt(x.temperature)}°C`)),
          row('Utilization', `${fmt(cpu.utilization)}% · load ${cpu.load ? cpu.load.map(v => fmt(v, 2)).join(' / ') : '—'}`),
          row('Package power', isNumber(cpu.power) ? `${fmt(cpu.power)} W (RAPL energy counter)` : 'Measuring'),
          row('Core voltage', isNumber(b.vcore) ? `${fmt(b.vcore, 3)} V` : 'Not reported'),
          row('Clocks', `${fmt(cpu.clockAverage, 0)} MHz average · ${fmt(cpu.clockMax, 0)} MHz peak`),
          ...(b.temperatures || []).map(t => row(t.name, `${fmt(t.value)}°C`)),
          ...(b.fans || []).map(f => row(f.name, `${fmt(f.rpm, 0)} RPM`)),
        ]}</div>
        <div className="thread-table" role="table" aria-label="Per-thread load">{(cpu.threads || []).map(t => <div key={t.cpu} role="row" title={`CPU ${t.cpu} · core ${t.core} · CCD ${isNumber(t.ccd) ? t.ccd + 1 : '—'}`}><span role="cell">{t.cpu}</span><i role="cell" style={{ background: heat(t.load) }} /><strong role="cell">{isNumber(t.load) ? `${fmt(t.load, 0)}%` : '—'}</strong></div>)}</div>
        <p className="muted-note">Per-thread load and package power are differences between two consecutive readings. The first reading after a gap shows them as measuring rather than estimating.</p>
      </section>
    </>}
  </Dialog>;
}

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Boxes, ChevronRight, Gpu, History, Microchip, X } from 'lucide-react';
import { age, fmt, isNumber } from './api.js';
import { Badge, Dialog, Dot, Empty, Meter, Panel } from './components.jsx';
import { useComputeLive, useNow } from './hooks.js';
import { RefreshButton } from './refresh.jsx';
import { BandChart, formatValue, useMetric } from './metrics.jsx';
import { groupOf } from '../server/compute-groups.mjs';

/* ---------- motion: one rAF loop, data-driven speeds, nothing decorative ---------- */
// Visual speed is capped below the wagon-wheel threshold (blade pitch / frame),
// and a rotational blur takes over as speed rises, so fans never strobe.
export const MAX_RPS = 2;
const spinners = new Set();
let frame = null, last = 0;
const prefersReduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const blurFor = rps => smoothstep(0.3, 1.8, rps);
/** Opacity-only blend from crisp blades to trailing copies and a blur disc. */
function applyBlur(rotor, rps, cache) {
  const b = blurFor(rps);
  if (cache && Math.abs(cache.blur - b) < 0.008 && !(b === 0 && cache.blur !== 0)) return;
  if (cache) cache.blur = b;
  const crisp = rotor.querySelector('.fan-crisp'), disc = rotor.querySelector('.fan-disc'), ghosts = rotor.querySelectorAll('.fan-ghost');
  if (crisp) crisp.style.opacity = (1 - 0.82 * b).toFixed(3);
  if (disc) disc.style.opacity = (0.94 * b).toFixed(3);
  ghosts.forEach((g, i) => { g.style.opacity = (b * (i ? 0.2 : 0.36)).toFixed(3); });
}
function tick(t) {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
  last = t;
  let moving = false;
  for (const s of spinners) {
    // Ease toward the measured speed so a new reading ramps rather than jumps.
    s.speed += (s.target - s.speed) * Math.min(1, dt * 1.1);
    if (s.target === 0 && Math.abs(s.speed) < 0.003) s.speed = 0;
    if (s.speed) { s.angle = (s.angle + s.speed * 360 * dt) % 360; s.el.style.transform = `rotate(${s.angle.toFixed(2)}deg)`; moving = true; }
    applyBlur(s.el, s.speed, s);
  }
  frame = moving || [...spinners].some(s => s.target) ? requestAnimationFrame(tick) : null;
  if (!frame) last = 0;
}
function kick() { if (!frame && spinners.size && !document.hidden) { last = 0; frame = requestAnimationFrame(tick); } }
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', kick);

/** Spins `ref` at `rps` while `enabled`. Reduced motion: no spin, static blur proportional to speed. */
function useSpin(ref, rps, enabled) {
  const spinner = useRef(null), target = clamp(rps || 0, 0, MAX_RPS);
  useEffect(() => {
    if (!enabled || !ref.current || prefersReduced()) return;
    const s = { el: ref.current, angle: spinner.current?.angle || 0, speed: spinner.current?.speed ?? 0, target, blur: -1 };
    spinner.current = s; spinners.add(s); kick();
    return () => { spinners.delete(s); spinner.current = { angle: s.angle, speed: s.speed }; };
  }, [enabled]);
  useEffect(() => {
    if (spinner.current && spinners.has(spinner.current)) { spinner.current.target = target; kick(); }
    else if (ref.current) applyBlur(ref.current, target);
  }, [target, enabled]);
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
const heat = load => isNumber(load) ? `color-mix(in oklab, #6a85ff ${Math.round(clamp(load, 0, 100))}%, #1c2232)` : '#3a3d45';
const gib = mib => isNumber(mib) ? mib / 1024 : null;
const shortGpu = name => (name || 'GPU').replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, 'GeForce ');
const shortCpu = model => (model || 'CPU').replace(/^AMD\s+/i, '').replace(/\s+\d+-Core Processor$/i, '');
const throttleText = bits => !isNumber(bits) ? null : bits === 0 ? 'No clock limiter active' : bits & 0x60 ? 'Thermal slowdown' : bits & 0x88 ? 'Hardware slowdown' : bits & 0x4 ? 'Power cap reached' : bits & 0x1 ? 'Idle clocks' : 'Clock limiter active';

/* ---------- sparkline ---------- */
export function Sparkline({ series, k, unit = '', width = 132, height = 28, max, label, stretch = false }) {
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
  return <svg className={`sparkline ${stretch ? 'stretch' : ''}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio={stretch ? 'none' : undefined} role="img" aria-label={`${label}: last 15 minutes, low ${fmt(lo)}${unit}, high ${fmt(hi)}${unit}`}>
    <title>{`${label} · last 15 min · low ${fmt(lo)}${unit} · high ${fmt(hi)}${unit}`}</title>
    {segments.filter(s => s.length > 1).map((s, i) => { const d = s.map((p, j) => `${j ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' '); return <g key={i}><path d={`${d} L${x(s.at(-1).ts).toFixed(1)},${height} L${x(s[0].ts).toFixed(1)},${height} Z`} className="sparkline-area" /><path d={d} className="sparkline-line" vectorEffect="non-scaling-stroke" /></g>; })}
    {!stretch && <circle cx={x(end.ts)} cy={y(end[k])} r="2.4" className="sparkline-end" />}
  </svg>;
}

/* ---------- interactive parts: hotspots, spotlight, popover ---------- */
const Shape = ({ s, ...props }) => s.circle ? <circle cx={s.circle[0]} cy={s.circle[1]} r={s.circle[2]} {...props} /> : <rect x={s.rect[0]} y={s.rect[1]} width={s.rect[2]} height={s.rect[3]} rx={s.rect[4] ?? 6} {...props} />;
function Marker({ n, x, y }) { return <g className="art-marker" transform={`translate(${x} ${y})`}><circle r="8" /><text y="3.2" textAnchor="middle">{n}</text></g>; }
/** Metric value that opens its history. */
function MetricLink({ id, onOpen, label, children, className = '' }) {
  return <button type="button" className={`metric-link ${className}`} onClick={e => { e.stopPropagation(); onOpen(id); }} aria-label={`${label}: view history`} title={`${label} · view 1 h / 24 h / 7 d history`}>{children}</button>;
}
/** A side readout. Hover previews the part; a click anywhere on it opens the full detail. */
function Callout({ spot, side, active, onHover, onDetails, register, children }) {
  return <div className={`callout ${active ? 'is-active' : ''}`} data-side={side} ref={register} onClick={() => onDetails(spot)}
    onPointerEnter={e => e.pointerType === 'mouse' && onHover(spot.key)} onPointerLeave={e => e.pointerType === 'mouse' && onHover(null)}>
    <button type="button" className="callout-head" aria-haspopup="dialog" aria-label={`${spot.title}: ${spot.value}. Open details`}
      onClick={e => { e.stopPropagation(); onDetails(spot); }} onFocus={() => onHover(spot.key)} onBlur={() => onHover(null)}>
      <span className="callout-index">{spot.n}</span><span className="eyebrow">{spot.title}</span><span className="callout-more">Details<ChevronRight size={11} /></span>
    </button>{children}</div>;
}
function Overlay({ box, spots, active, open, popId, onHover, onOpen }) {
  const maskId = useId().replace(/:/g, ''), current = spots.find(s => s.key === active);
  return <g className="spot-layer">
    <defs><mask id={maskId}><rect width={box[0]} height={box[1]} fill="white" />{current?.glow.map((s, i) => <Shape key={i} s={s} fill="black" />)}</mask></defs>
    <rect className={`spot-dim ${current ? 'on' : ''}`} x="-40" y="-40" width={box[0] + 80} height={box[1] + 80} mask={`url(#${maskId})`} />
    {current?.glow.map((s, i) => <Shape key={i} s={s} className="spot-glow" />)}
    {spots.map(spot => <g key={spot.key} className={`hotspot ${active === spot.key ? 'is-active' : ''}`} data-spot={spot.key} role="button" tabIndex={0}
      aria-label={`${spot.n}. ${spot.title}: ${spot.value}. Show details`} aria-haspopup="dialog" aria-expanded={open === spot.key} aria-controls={open === spot.key ? popId : undefined}
      onPointerEnter={e => e.pointerType === 'mouse' && onHover(spot.key)} onPointerLeave={e => e.pointerType === 'mouse' && onHover(null)}
      onFocus={() => onHover(spot.key)} onBlur={() => onHover(null)}
      onClick={e => onOpen(spot.key, e.currentTarget)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(spot.key, e.currentTarget); } }}>
      {spot.hit.map((s, i) => <Shape key={i} s={s} className="hotspot-hit" />)}
      <circle cx={spot.anchor[0]} cy={spot.anchor[1]} r="15" className="hotspot-hit" />
      <Marker n={spot.n} x={spot.anchor[0]} y={spot.anchor[1]} />
    </g>)}
  </g>;
}
const focusables = el => [...el.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled);
const SpotPopover = React.forwardRef(function SpotPopover({ spot, id, style, close, openGroup }, ref) {
  const openMetric = metric => openGroup(spot.group, metric);
  const titleId = useId(), primary = spot.metrics[0], history = useMetric(primary?.id, '1h', Boolean(primary));
  return <div className="spot-pop" id={id} role="dialog" aria-modal="false" aria-labelledby={titleId} ref={ref} style={style}
    onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); }
      if (e.key !== 'Tab') return;
      const items = focusables(e.currentTarget); if (!items.length) return;
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
    }}>
    <div className="spot-pop-head"><span className="callout-index">{spot.n}</span><span className="eyebrow" id={titleId}>{spot.title}</span><button type="button" className="spot-pop-close" aria-label="Close" onClick={() => close(true)}><X size={14} /></button></div>
    <div className="spot-pop-value">{spot.value}</div>
    {spot.detail && <p>{spot.detail}</p>}
    {primary && <div className="spot-pop-trend"><span>{primary.label} · last hour</span><BandChart data={history.data} height={46} compact /></div>}
    {spot.metrics.length > 1 && <div className="spot-pop-metrics">{spot.metrics.map(m => <button type="button" key={m.id} onClick={() => openMetric(m.id)}><span>{m.label}</span><strong>{m.value}</strong><ChevronRight size={13} /></button>)}</div>}
    <button type="button" className="primary-button spot-pop-action" onClick={() => openMetric(primary?.id)}><History size={14} />Open details</button>
  </div>;
});

function Leaders({ lines, active, popLine }) {
  return <svg className="leaders" aria-hidden="true">
    {lines.map(l => <g key={l.key} className={active && active !== l.key ? 'dim' : active === l.key ? 'on' : ''}><path d={l.d} /><circle cx={l.px} cy={l.py} r="2" className="leader-end" /><circle cx={l.tx} cy={l.ty} r="7.5" className="leader-halo" /><circle cx={l.tx} cy={l.ty} r="3" className="leader-dot" /></g>)}
    {popLine && <g className="on pop-line"><path d={popLine.d} /><circle cx={popLine.tx} cy={popLine.ty} r="7.5" className="leader-halo" /><circle cx={popLine.tx} cy={popLine.ty} r="3" className="leader-dot" /></g>}
  </svg>;
}

/**
 * One illustration with Tesla-style callouts. Wide: leader lines to every callout.
 * Any width: hover/focus previews a part, tap/click/Enter opens a popover that
 * spotlights it; Esc, outside tap, or a second tap closes and returns focus.
 */
function Stage({ className, box, spots, art, left, right, openGroup }) {
  const stage = useRef(null), artRef = useRef(null), pop = useRef(null), trigger = useRef(null), callouts = useRef({});
  const popId = useId(), [hover, setHover] = useState(null), [open, setOpen] = useState(null), [pos, setPosState] = useState(null);
  const [lines, setLinesState] = useState([]), [popLine, setPopLineState] = useState(null);
  const active = open ?? hover, spotsRef = useRef(spots), wideRef = useRef(false);
  spotsRef.current = spots;
  // Layout effects run every render; only commit geometry that actually changed.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const setLines = next => setLinesState(prev => same(prev, next) ? prev : next);
  const setPos = next => setPosState(prev => same(prev, next) ? prev : next);
  const setPopLine = next => setPopLineState(prev => same(prev, next) ? prev : next);
  const measure = useCallback(() => {
    const spots = spotsRef.current, st = stage.current, a = artRef.current;
    if (!st || !a) return;
    const s = st.getBoundingClientRect(), r = a.getBoundingClientRect();
    const point = ([ax, ay]) => [r.left - s.left + ax / box[0] * r.width, r.top - s.top + ay / box[1] * r.height];
    const wide = getComputedStyle(st).getPropertyValue('--leaders').trim() === '1';
    wideRef.current = wide;
    setLines(wide ? spots.flatMap(spot => {
      const el = callouts.current[spot.key]; if (!el) return [];
      const c = el.getBoundingClientRect(), side = el.dataset.side, head = el.querySelector('.callout-head').getBoundingClientRect();
      const px = side === 'left' ? c.right - s.left + 6 : c.left - s.left - 6, py = head.top + head.height / 2 - s.top, [tx, ty] = point(spot.anchor);
      return [{ key: spot.key, d: `M${px.toFixed(1)},${py.toFixed(1)} H${(px + (side === 'left' ? 18 : -18)).toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}`, px, py, tx, ty }];
    }) : []);
    const spot = spots.find(x => x.key === open), p = pop.current;
    if (!spot || !p) { setPos(null); setPopLine(null); return; }
    const [tx, ty] = point(spot.anchor), w = Math.min(300, s.width - 16), h = p.offsetHeight;
    const panel = st.closest('.panel')?.getBoundingClientRect() || s, roomBelow = panel.bottom - r.bottom - 12;
    const below = roomBelow >= h + 10 || r.top - panel.top < h + 20;
    const leftPx = clamp(tx - w / 2, 8, s.width - w - 8), top = below ? r.bottom - s.top + 10 : r.top - s.top - h - 10;
    const ex = clamp(tx, leftPx + 18, leftPx + w - 18), ey = below ? top : top + h;
    setPos({ left: leftPx, top, width: w });
    setPopLine({ d: `M${ex.toFixed(1)},${ey.toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}`, tx, ty });
  }, [box, open]);
  useLayoutEffect(measure);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !stage.current) return;
    const observer = new ResizeObserver(() => measure()); observer.observe(stage.current);
    return () => observer.disconnect();
  }, [measure]);
  const close = useCallback(returnFocus => { setOpen(null); setHover(null); if (returnFocus) trigger.current?.focus({ preventScroll: true }); }, []);
  const details = useCallback(spot => { setOpen(null); openGroup(spot.group, spot.metrics[0]?.id); }, [openGroup]);
  // Wide layouts (readouts visible) open the full detail; compact layouts pop a summary first.
  const openSpot = useCallback((key, el) => { if (wideRef.current) { details(spotsRef.current.find(s => s.key === key)); return; } if (open === key) { close(true); return; } trigger.current = el; setOpen(key); }, [open, close, details]);
  useEffect(() => {
    if (!open) return;
    const outside = e => { if (pop.current?.contains(e.target) || e.target.closest?.(`[data-spot="${open}"]`)) return; close(false); };
    const escape = e => { if (e.key === 'Escape') close(true); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, close]);
  useEffect(() => { if (open && pos && pop.current && !pop.current.contains(document.activeElement)) focusables(pop.current)[0]?.focus({ preventScroll: true }); }, [open, pos]);
  const props = key => ({ spot: spots.find(s => s.key === key), active: active === key, onHover: setHover, onDetails: details, register: el => { callouts.current[key] = el; } });
  const overlay = <Overlay box={box} spots={spots} active={active} open={open} popId={popId} onHover={setHover} onOpen={openSpot} />;
  const spot = spots.find(s => s.key === open);
  return <div className={`compute-stage ${className} ${active ? 'has-active' : ''}`} ref={stage}>
    <div className="callout-column left">{left(props)}</div>
    <div className="stage-art">{art(artRef, overlay)}</div>
    <div className="callout-column right">{right(props)}</div>
    <Leaders lines={lines} active={active} popLine={popLine} />
    {spot && <SpotPopover ref={pop} id={popId} spot={spot} close={close} openGroup={(g, m) => { close(false); openGroup(g, m); }} style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { left: 8, top: 0, visibility: 'hidden' }} />}
  </div>;
}

/* ---------- fans ---------- */
function Blades({ count, r, className }) {
  return <g className={className}>{Array.from({ length: count }, (_, i) => <path key={i} transform={`rotate(${i * 360 / count})`} d={`M0,-${r * 0.24} C${r * 0.24},-${r * 0.36} ${r * 0.48},-${r * 0.66} ${r * 0.36},-${r * 0.96} C${r * 0.18},-${r * 0.92} ${r * 0.04},-${r * 0.62} -${r * 0.1},-${r * 0.25} Z`} className="gpu-blade" />)}</g>;
}
function GpuFan({ cx, cy, r, rps, enabled }) {
  const rotor = useRef(null);
  useSpin(rotor, rps, enabled);
  return <g transform={`translate(${cx} ${cy})`}>
    <circle r={r + 4} className="gpu-fan-ring" /><circle r={r} fill="url(#gpu-well)" />
    {[0.55, 0.8].map(f => <circle key={f} r={r * f} className="gpu-fan-grille" />)}
    <g ref={rotor} className="rotor">
      <circle r={r} fill="transparent" />
      <g transform="rotate(-10)"><Blades count={11} r={r - 3} className="fan-ghost" /></g>
      <g transform="rotate(-20)"><Blades count={11} r={r - 3} className="fan-ghost" /></g>
      <Blades count={11} r={r - 3} className="fan-crisp" />
      <circle r={r - 2} fill="url(#gpu-blur-disc)" className="fan-disc" />
      <circle r={r * 0.24} className="gpu-hub" /><circle r={r * 0.1} className="gpu-hub-cap" />
    </g>
  </g>;
}
/* ---------- GPU ---------- */
const GPU_BOX = [520, 236];
function GpuArt({ gpu, artRef, animate, overlay }) {
  const util = gpu?.utilization ?? 0, glow = tempColor(gpu?.temperature), rps = isNumber(gpu?.fan) ? gpu.fan / 100 * MAX_RPS : 0;
  return <svg ref={artRef} className="gpu-art" viewBox={`0 0 ${GPU_BOX[0]} ${GPU_BOX[1]}`} aria-label={`Illustration of the ${shortGpu(gpu?.name)}; fans at ${fmt(gpu?.fan, 0)}%, ${fmt(util, 0)}% load. Parts are buttons.`} role="group">
    <defs>
      <linearGradient id="gpu-metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f6f7f9" /><stop offset=".45" stopColor="#cdd0d7" /><stop offset="1" stopColor="#e5e7ec" /></linearGradient>
      <linearGradient id="gpu-plate" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#30333b" /><stop offset="1" stopColor="#15171b" /></linearGradient>
      <radialGradient id="gpu-well"><stop offset="0" stopColor="#24262c" /><stop offset="1" stopColor="#0d0e11" /></radialGradient>
      <radialGradient id="gpu-blur-disc"><stop offset=".22" stopColor="#2c2f36" stopOpacity="0" /><stop offset=".27" stopColor="#3a3d45" stopOpacity=".92" /><stop offset=".6" stopColor="#3d4049" stopOpacity=".86" /><stop offset=".9" stopColor="#363941" stopOpacity=".7" /><stop offset="1" stopColor="#2a2c32" stopOpacity="0" /></radialGradient>
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
    <GpuFan cx={132} cy={116} r={70} rps={rps} enabled={animate} />
    <GpuFan cx={394} cy={116} r={70} rps={rps} enabled={animate} />
    {overlay}
  </svg>;
}

function gpuSpots(g) {
  const mem = g.memoryTotal > 0 ? g.memoryUsed / g.memoryTotal * 100 : null;
  const m = (id, label, value) => ({ id, label, value });
  return [
    { key: 'cooling', group: 'gpu.cooling', n: 2, title: 'Cooling', anchor: [132, 116], hit: [{ circle: [132, 116, 74] }, { circle: [394, 116, 74] }], glow: [{ circle: [132, 116, 75] }, { circle: [394, 116, 75] }],
      value: `${fmt(g.fan, 0)}% fan`, detail: g.fan === 0 ? 'Zero-RPM mode · fans stopped' : 'Fan duty target from the driver', metrics: [m('gpu.fan', 'Fan duty', formatValue(g.fan, '%'))] },
    { key: 'memory', group: 'gpu.memory', n: 1, title: 'Video memory', anchor: [228, 60], hit: [{ rect: [206, 26, 114, 64] }], glow: [{ rect: [206, 26, 114, 66, 4] }],
      value: `${fmt(gib(g.memoryUsed))} / ${fmt(gib(g.memoryTotal), 0)} GiB`, detail: `${fmt(g.memoryClock, 0)} MHz memory clock`, metrics: [m('gpu.memory', 'VRAM used', formatValue(mem, '%')), m('gpu.memoryClock', 'Memory clock', formatValue(g.memoryClock, 'MHz'))] },
    { key: 'core', group: 'gpu.core', n: 5, title: 'Core', anchor: [263, 132], hit: [{ rect: [214, 92, 98, 48] }], glow: [{ rect: [212, 92, 102, 48, 6] }],
      value: `${fmt(g.temperature, 0)}°C · ${fmt(g.utilization, 0)}% load`, detail: `${fmt(g.coreClock, 0)} MHz core clock`,
      metrics: [m('gpu.temperature', 'Temperature', formatValue(g.temperature, '°C')), m('gpu.utilization', 'Load', formatValue(g.utilization, '%')), m('gpu.coreClock', 'Core clock', formatValue(g.coreClock, 'MHz'))] },
    { key: 'video', group: 'gpu.video', n: 6, title: 'Video engines', anchor: [304, 190], hit: [{ rect: [206, 142, 114, 62] }], glow: [{ rect: [206, 140, 114, 64, 4] }],
      value: `${fmt(g.encoder, 0)}% enc · ${fmt(g.decoder, 0)}% dec`, detail: 'NVENC / NVDEC utilization', metrics: [m('gpu.encoder', 'Encoder', formatValue(g.encoder, '%')), m('gpu.decoder', 'Decoder', formatValue(g.decoder, '%'))] },
    { key: 'state', group: 'gpu.state', n: 3, title: 'State & link', anchor: [11, 172], hit: [{ rect: [0, 8, 24, 216] }, { rect: [66, 206, 198, 18] }], glow: [{ rect: [2, 10, 19, 212, 4] }, { rect: [68, 209, 194, 14, 3] }],
      value: `${g.pstate || '—'} · ${isNumber(g.pcieGen) ? `PCIe Gen ${fmt(g.pcieGen, 0)} ×${fmt(g.pcieWidth, 0)}` : 'link not reported'}`, detail: throttleText(g.throttle),
      metrics: [m('gpu.coreClock', 'Core clock', formatValue(g.coreClock, 'MHz')), m('gpu.memoryClock', 'Memory clock', formatValue(g.memoryClock, 'MHz'))] },
    { key: 'power', group: 'gpu.power', n: 4, title: 'Board power', anchor: [316, 13], hit: [{ rect: [290, 2, 52, 22] }], glow: [{ rect: [294, 5, 44, 18, 4] }, { rect: [172, 15, 182, 7, 3] }],
      value: `${fmt(g.powerDraw)} W of ${fmt(g.powerLimit, 0)} W`, detail: isNumber(g.powerLimit) && g.powerLimit > 0 ? `${fmt(g.powerDraw / g.powerLimit * 100, 0)}% of the power limit` : null, metrics: [m('gpu.power', 'Board power', formatValue(g.powerDraw, 'W'))] },
  ];
}

function GpuStage({ c, series, animate, openMetric, openGroup }) {
  const g = c.gpu;
  if (!g) return <Empty icon={Gpu} title="GPU readings unavailable" text={c.gpuError === 'unreadable' ? 'nvidia-smi answered in an unexpected format. No values are guessed.' : 'nvidia-smi did not answer on the host. The card may be passed through to a VM or its driver may be unloaded.'} />;
  const memoryPct = g.memoryTotal > 0 ? g.memoryUsed / g.memoryTotal * 100 : null, powerPct = g.powerLimit > 0 ? g.powerDraw / g.powerLimit * 100 : null;
  const spots = gpuSpots(g), go = openMetric;
  return <Stage className="gpu-stage" box={GPU_BOX} spots={spots} openGroup={openGroup}
    art={(ref, overlay) => <GpuArt gpu={g} artRef={ref} animate={animate} overlay={overlay} />}
    left={p => <>
      <Callout {...p('memory')} side="left"><MetricLink id="gpu.memory" label="Video memory used" onOpen={go} className="callout-value"><strong>{fmt(gib(g.memoryUsed))}</strong><small> / {fmt(gib(g.memoryTotal), 0)} GiB</small></MetricLink><Meter value={memoryPct} label="GPU memory used" /><p><MetricLink id="gpu.memoryClock" label="GPU memory clock" onOpen={go}>{fmt(g.memoryClock, 0)} MHz</MetricLink>{isNumber(g.memoryUtilization) ? ` · bus ${fmt(g.memoryUtilization, 0)}% busy` : ''}<br />{isNumber(g.memoryTemperature) ? `Memory ${fmt(g.memoryTemperature, 0)}°C` : 'Memory temperature not reported'}</p></Callout>
      <Callout {...p('cooling')} side="left"><MetricLink id="gpu.fan" label="GPU fan duty" onOpen={go} className="callout-value"><strong>{fmt(g.fan, 0)}</strong><small>% fan</small></MetricLink><p>{g.fan === 0 ? 'Zero-RPM mode · fans stopped' : 'Fan duty target from the driver'}<br />Hotspot not exposed by nvidia-smi</p></Callout>
      <Callout {...p('state')} side="left"><MetricLink id="gpu.coreClock" label="GPU core clock" onOpen={go} className="callout-value"><strong>{g.pstate || '—'}</strong><small> {g.pstate === 'P0' ? 'max performance' : g.pstate === 'P8' ? 'idle' : 'performance state'}</small></MetricLink><p>{isNumber(g.pcieGen) ? `PCIe Gen ${fmt(g.pcieGen, 0)} ×${fmt(g.pcieWidth, 0)} now` : 'PCIe link not reported'}<br />{throttleText(g.throttle) || 'Clock limiter not reported'}{g.driver ? ` · driver ${g.driver}` : ''}</p></Callout>
    </>}
    right={p => <>
      <Callout {...p('power')} side="right"><MetricLink id="gpu.power" label="GPU board power" onOpen={go} className="callout-value"><strong>{fmt(g.powerDraw)}</strong><small> W</small></MetricLink><Meter value={powerPct} tone={powerPct > 92 ? 'amber' : 'accent'} label="GPU power draw of limit" /><p>of {fmt(g.powerLimit, 0)} W limit{isNumber(powerPct) ? ` · ${fmt(powerPct, 0)}%` : ''}</p><Sparkline series={series} k="gpuPower" unit=" W" label="GPU power" /></Callout>
      <Callout {...p('core')} side="right"><div className="callout-pair"><MetricLink id="gpu.temperature" label="GPU temperature" onOpen={go} className="callout-value"><strong>{fmt(g.temperature, 0)}</strong><small>°C</small></MetricLink><MetricLink id="gpu.utilization" label="GPU load" onOpen={go} className="callout-value"><strong>{fmt(g.utilization, 0)}</strong><small>% load</small></MetricLink></div><p><MetricLink id="gpu.coreClock" label="GPU core clock" onOpen={go}>{fmt(g.coreClock, 0)} MHz</MetricLink>{isNumber(g.coreClockMax) ? ` of ${fmt(g.coreClockMax, 0)} max` : ''}</p><div className="spark-pair"><span>Temp</span><Sparkline series={series} k="gpuTemperature" unit="°C" label="GPU temperature" /><span>Load</span><Sparkline series={series} k="gpuUtilization" unit="%" max={100} label="GPU utilization" /></div></Callout>
      <Callout {...p('video')} side="right"><div className="callout-pair"><MetricLink id="gpu.encoder" label="NVENC encoder" onOpen={go} className="callout-value"><strong>{fmt(g.encoder, 0)}</strong><small>% enc</small></MetricLink><MetricLink id="gpu.decoder" label="NVDEC decoder" onOpen={go} className="callout-value"><strong>{fmt(g.decoder, 0)}</strong><small>% dec</small></MetricLink></div><p>NVENC / NVDEC utilization</p></Callout>
    </>} />;
}

/* ---------- CPU ---------- */
const CPU_BOX = [360, 300];
const CAPS = [[24, 58, 16, 52], [24, 194, 16, 52], [320, 58, 16, 52], [320, 194, 16, 52]];
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
      const w = (30 - (core.threads.length - 1)) / core.threads.length;
      return <g key={i}><title>{`${label} · core ${core.core} · ${core.threads.map(t => `CPU ${t.cpu} ${isNumber(t.load) ? `${fmt(t.load, 0)}%` : 'measuring'}`).join(' · ')}${isNumber(core.threads[0]?.mhz) ? ` · ${fmt(core.threads[0].mhz, 0)} MHz` : ''}`}</title>
        {core.threads.map((t, j) => <rect key={t.cpu} x={sx + j * (w + 1)} y={sy} width={w} height={h} rx="2.5" className="cpu-thread" style={{ fill: heat(t.load) }} />)}</g>;
    })}
  </g>;
}
function CpuArt({ cpu, board, artRef, overlay }) {
  const threads = cpu?.threads || [], ccds = [...new Set(threads.map(t => t.ccd))].filter(isNumber).sort((a, b) => a - b);
  const util = cpu?.utilization ?? 0, glow = tempColor(board?.tctl);
  return <svg ref={artRef} className="cpu-art" viewBox={`0 0 ${CPU_BOX[0]} ${CPU_BOX[1]}`} role="group" aria-label={`Diagram of the ${shortCpu(cpu?.model)} package with per-thread load. Parts are buttons.`}>
    <defs><filter id="cpu-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="18" /></filter>
      <pattern id="cpu-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="#4a4e58" strokeWidth="1.4" /></pattern></defs>
    <rect x="40" y="34" width="280" height="240" rx="30" filter="url(#cpu-blur)" className="art-glow" style={{ fill: glow, opacity: 0.08 + clamp(util, 0, 100) / 100 * 0.5 }} />
    <rect x="20" y="14" width="320" height="272" rx="12" className="cpu-substrate" />
    {CAPS.map(([cx, cy]) => Array.from({ length: 8 }, (_, i) => <rect key={`${cx}-${cy}-${i}`} x={cx + 2} y={cy + 2 + i * 6} width="12" height="3.6" rx="1" className="cpu-cap" />))}
    {[0, 1].map(i => <Ccd key={i} x={i ? 188 : 52} y={36} slots={ccds[i] !== undefined ? coreSlots(threads, ccds[i]) : []} label={`CCD ${i + 1}`} />)}
    <text x="112" y="183" textAnchor="middle" className="cpu-label">CCD 1</text><text x="248" y="183" textAnchor="middle" className="cpu-label">CCD 2</text>
    <rect x="96" y="194" width="168" height="72" rx="6" className="cpu-iod" />
    <text x="180" y="226" textAnchor="middle" className="cpu-die-text strong">I/O DIE</text>
    <text x="180" y="242" textAnchor="middle" className="cpu-die-text">DDR5 · PCIE · IGPU</text>
    {overlay}
  </svg>;
}

function CpuStage({ c, series, thermalLimit, openMetric, openGroup }) {
  const cpu = c.cpu || {}, b = c.board || {}, threads = cpu.threads || [];
  const ccdIds = [...new Set(threads.map(t => t.ccd))].filter(isNumber).sort((x, y) => x - y);
  const ccd = i => { const list = threads.filter(t => t.ccd === ccdIds[i]), loads = list.map(t => t.load).filter(isNumber), mhz = list.map(t => t.mhz).filter(isNumber); return { id: b.ccds?.[i]?.id ?? i + 1, cores: new Set(list.map(t => t.core)).size, load: loads.length ? loads.reduce((a, v) => a + v, 0) / loads.length : null, mhz: mhz.length ? mhz.reduce((a, v) => a + v, 0) / mhz.length : null, temperature: b.ccds?.[i]?.temperature ?? null }; };
  const temps = b.temperatures || [], byName = Object.fromEntries(temps.map(t => [t.name, t])), vrm = byName['VRM MOS'] || temps[0];
  const go = openMetric, m = (id, label, value) => ({ id, label, value });
  const ccdSpot = (i, key, n, x) => { const d = ccd(i); return { key, group: `cpu.ccd.${d.id}`, n, title: `CCD ${i + 1}`, anchor: [x + 60, 104], hit: [{ rect: [x, 36, 120, 128] }], glow: [{ rect: [x - 2, 34, 124, 132, 8] }],
    value: `${fmt(d.temperature)}°C`, detail: `${d.cores || '—'} cores · ${isNumber(d.load) ? `${fmt(d.load, 0)}% avg load` : 'measuring load'}`, metrics: [m(`cpu.ccd.${d.id}`, `CCD ${i + 1} temperature`, formatValue(d.temperature, '°C'))] }; };
  const spots = [
    { key: 'package', group: 'cpu.package', n: 2, title: 'Package · Tctl', anchor: [180, 181], hit: [{ rect: [20, 14, 320, 272, 12] }], glow: [{ rect: [20, 14, 320, 272, 12] }],
      value: `${fmt(b.tctl)}°C`, detail: [thermalLimit ? `${thermalLimit}°C rated limit` : null, isNumber(cpu.power) ? `${fmt(cpu.power, 0)} W package` : null].filter(Boolean).join(' · '),
      metrics: [m('cpu.tctl', 'Tctl', formatValue(b.tctl, '°C')), m('cpu.power', 'Package power', formatValue(cpu.power, 'W'))] },
    ccdSpot(0, 'ccd0', 1, 52), ccdSpot(1, 'ccd1', 5, 188),
    { key: 'clocks', group: 'cpu.clocks', n: 3, title: 'Clocks', anchor: [120, 228], hit: [{ rect: [96, 194, 168, 72] }], glow: [{ rect: [94, 192, 172, 76, 8] }],
      value: `${fmt(cpu.clockAverage, 0)} MHz avg`, detail: `Peak thread ${fmt(cpu.clockMax, 0)} MHz`, metrics: [m('cpu.clock', 'Average clock', formatValue(cpu.clockAverage, 'MHz'))] },
    { key: 'load', group: 'cpu.utilization', n: 4, title: 'Utilization', anchor: [296, 60], hit: [], glow: [{ rect: [50, 34, 124, 132, 8] }, { rect: [186, 34, 124, 132, 8] }],
      value: `${fmt(cpu.utilization, 0)}%`, detail: cpu.load ? `Load average ${cpu.load.map(v => fmt(v, 2)).join(' · ')}` : null, metrics: [m('cpu.utilization', 'Utilization', formatValue(cpu.utilization, '%'))] },
    { key: 'board', group: 'cpu.board', n: 6, title: 'Board', anchor: [334, 278], hit: [], glow: CAPS.map(([x, y, w, h]) => ({ rect: [x, y, w, h, 3] })),
      value: vrm ? `${fmt(vrm.value)}°C ${vrm.name === 'VRM MOS' ? 'VRM' : vrm.name}` : 'Not reported', detail: b.name || 'Motherboard sensors',
      metrics: temps.map(t => m(`board.temp.${t.id}`, t.name, formatValue(t.value, '°C'))) },
  ];
  const ccdCallout = (i, p, side) => { const d = ccd(i); return <Callout {...p(i ? 'ccd1' : 'ccd0')} side={side}><MetricLink id={`cpu.ccd.${d.id}`} label={`CCD ${i + 1} temperature`} onOpen={go} className="callout-value"><strong>{fmt(d.temperature)}</strong><small>°C</small></MetricLink><p>{d.cores ? `${d.cores} cores` : 'No cores reported'} · {isNumber(d.load) ? `${fmt(d.load, 0)}% avg load` : 'measuring load'}<br />{isNumber(d.mhz) ? `${fmt(d.mhz, 0)} MHz average` : 'Clock not reported'}</p></Callout>; };
  return <Stage className="cpu-stage" box={CPU_BOX} spots={spots} openGroup={openGroup}
    art={(ref, overlay) => <CpuArt cpu={cpu} board={b} artRef={ref} overlay={overlay} />}
    left={p => <>
      {ccdCallout(0, p, 'left')}
      <Callout {...p('package')} side="left"><MetricLink id="cpu.tctl" label="CPU package temperature" onOpen={go} className="callout-value"><strong>{fmt(b.tctl)}</strong><small>°C</small></MetricLink><p>{thermalLimit ? `${thermalLimit}°C rated limit · boost runs close to it` : 'Control temperature'}<br />{isNumber(cpu.power) ? <MetricLink id="cpu.power" label="CPU package power" onOpen={go}>{fmt(cpu.power, 0)} W package</MetricLink> : 'Package power measuring'}{isNumber(b.vcore) ? ` · ${fmt(b.vcore, 3)} V core` : ''}</p><Sparkline series={series} k="cpuTemperature" unit="°C" label="CPU package temperature" /></Callout>
      <Callout {...p('clocks')} side="left"><MetricLink id="cpu.clock" label="CPU average clock" onOpen={go} className="callout-value"><strong>{fmt(cpu.clockAverage, 0)}</strong><small> MHz avg</small></MetricLink><p>Peak thread {fmt(cpu.clockMax, 0)} MHz<br />{cpu.coreCount || '—'} cores · {cpu.threadCount || '—'} threads</p></Callout>
    </>}
    right={p => <>
      <Callout {...p('load')} side="right"><MetricLink id="cpu.utilization" label="CPU utilization" onOpen={go} className="callout-value"><strong>{fmt(cpu.utilization, 0)}</strong><small>%</small></MetricLink><p>Load average {cpu.load ? cpu.load.map(v => fmt(v, 2)).join(' · ') : '—'}<br /><span className="muted-inline">1 · 5 · 15 minutes</span></p><Sparkline series={series} k="cpuUtilization" unit="%" max={100} label="CPU utilization" /></Callout>
      {ccdCallout(1, p, 'right')}
      <Callout {...p('board')} side="right">{vrm ? <MetricLink id={`board.temp.${vrm.id}`} label={`${vrm.name} temperature`} onOpen={go} className="callout-value"><strong>{fmt(vrm.value)}</strong><small>°C {vrm.name === 'VRM MOS' ? 'VRM' : vrm.name}</small></MetricLink> : <div className="callout-value"><strong>—</strong></div>}<p>{temps.filter(t => t !== vrm).map((t, i) => <React.Fragment key={t.id}>{i ? ' · ' : ''}<MetricLink id={`board.temp.${t.id}`} label={`${t.name} temperature`} onOpen={go}>{t.name === 'PCH' ? 'Chipset' : t.name} {fmt(t.value, 0)}°C</MetricLink></React.Fragment>)}{temps.length < 2 && 'Board temperatures not reported'}<br /><span className="muted-inline">{b.name || 'Motherboard sensors'}</span></p></Callout>
    </>} />;
}

function Processes({ processes, onOpen }) {
  return <div className="gpu-processes"><span className="eyebrow"><Boxes size={12} /> Using the GPU</span>
    {processes.length ? processes.map(p => <button type="button" className="process-chip" key={p.pid} onClick={() => onOpen?.(p.container ? `gpu.vram.ct.${p.container}` : null)}><strong>{p.name}</strong><small>{p.container ? `CT ${p.container}${p.containerName ? ` · ${p.containerName}` : ''}` : 'host'} · {isNumber(p.memory) ? `${fmt(p.memory / 1024)} GiB` : 'memory n/a'}</small></button>)
      : <span className="process-none">No compute processes right now</span>}</div>;
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
  const source = snapshot.sources.find(s => s.id === 'compute'), openGroup = (group, metric) => group && open({ type: 'group', group, metric }), openMetric = id => openGroup(groupOf(id, c), id);
  return <div ref={root} className="showcase-wrap"><Panel id="showcase" title="GPU & CPU" icon={Microchip} className="showcase-panel"
    action={<div className="showcase-actions"><Badge tone={status.tone === 'green' ? 'success' : status.tone === 'amber' ? 'warning' : 'neutral'}><Dot tone={status.tone} />{status.label}</Badge><button className="text-button" onClick={() => open({ type: 'compute' })}>Details <ArrowUpRight size={14} /></button></div>}
    refresh={<RefreshButton sources={['compute']} label="Refresh GPU and CPU readings" />}>
    {!c ? <Empty icon={Gpu} title="GPU & CPU telemetry is not connected" text={source?.message || 'The bridge sends readings from the hypervisor once the compute collector is enabled.'} /> : <>
      <section className="showcase-section" aria-label="Graphics card">
        <div className="showcase-heading"><div><span className="eyebrow">Graphics · {c.processes?.[0]?.containerName ? `shared with ${c.processes[0].containerName}` : 'hypervisor host'}</span><h3>{shortGpu(c.gpu?.name)}</h3></div><span className="showcase-observed">Observed {age(c.observedAt)}{c.gpu?.driver ? ` · driver ${c.gpu.driver}` : ''}</span></div>
        <GpuStage c={c} series={series} animate={animate} openMetric={openMetric} openGroup={openGroup} />
        {c.gpu && <Processes processes={c.processes || []} onOpen={metric => openGroup("gpu.processes", metric)} />}
      </section>
      <section className="showcase-section" aria-label="Processor">
        <div className="showcase-heading"><div><span className="eyebrow">Processor · per-thread load</span><h3>{shortCpu(c.cpu?.model)}</h3></div><span className="heat-legend" aria-label="Thread load scale from 0 to 100 percent"><small>0%</small><i /><small>100%</small></span></div>
        <CpuStage c={c} series={series} thermalLimit={thermalLimit} openMetric={openMetric} openGroup={openGroup} />
      </section>
      <div className="panel-footnote"><span>{status.label === 'Live' ? 'Collecting every 3 s while this panel is visible' : 'Collected every 30 s in the background'}</span><span>Tap a part or a reading for its history</span></div>
    </>}
  </Panel></div>;
}

/** One part's live stage in a dialog, opened by clicking the GPU or the CPU in the 3D case view. */
export function PartShowcase({ snapshot, part, close, open, thermalLimit }) {
  const [live] = useComputeLive(true), now = useNow(1000);
  const c = live.compute || snapshot.compute, series = live.series || [], status = liveState(c, now), gpu = part === 'gpu';
  const from = `part:${part}`, openGroup = (group, metric) => group && open({ type: 'group', group, metric, from }), openMetric = id => openGroup(groupOf(id, c), id);
  return <Dialog title={gpu ? shortGpu(c?.gpu?.name) : shortCpu(c?.cpu?.model)} eyebrow={gpu ? 'HOMEBASE / GRAPHICS' : 'HOMEBASE / PROCESSOR'} className="part-dialog" close={close} actions={<RefreshButton sources={['compute']} label="Refresh GPU and CPU readings" showStatus />}>
    {!c ? <Empty icon={Gpu} title="GPU & CPU telemetry is not connected" /> : <>
      <div className="detail-subtitle"><Badge tone={status.tone === 'green' ? 'success' : status.tone === 'amber' ? 'warning' : 'neutral'}><Dot tone={status.tone} />{status.label}</Badge><span>Observed {age(c.observedAt)} · tap a part or a reading for its history</span><button className="text-button" onClick={() => open({ type: 'compute' })}>All readings <ArrowUpRight size={14} /></button></div>
      {gpu ? <><GpuStage c={c} series={series} animate={!c.stale} openMetric={openMetric} openGroup={openGroup} />{c.gpu && <Processes processes={c.processes || []} onOpen={metric => openGroup('gpu.processes', metric)} />}</>
        : <CpuStage c={c} series={series} thermalLimit={thermalLimit} openMetric={openMetric} openGroup={openGroup} />}
    </>}
  </Dialog>;
}

/** Details modal: every reading as text, larger trends, and the process list. */
export function ComputeDetail({ snapshot, close, thermalLimit, open }) {
  const [live] = useComputeLive(true); useNow(1000);
  const c = live.compute || snapshot.compute, series = live.series || [], g = c?.gpu, cpu = c?.cpu || {}, b = c?.board || {};
  const openMetric = id => open({ type: 'group', group: groupOf(id, c), metric: id, from: 'compute' });
  const row = (label, value, id) => <React.Fragment key={label}><span>{id ? <button type="button" className="metric-link spec-link" onClick={() => openMetric(id)}>{label}<History size={11} /></button> : label}</span><strong>{value}</strong></React.Fragment>;
  return <Dialog title="GPU & CPU" close={close} actions={<RefreshButton sources={['compute']} label="Refresh GPU and CPU readings" showStatus />}>
    {!c ? <Empty icon={Gpu} title="GPU & CPU telemetry is not connected" /> : <>
      <div className="detail-subtitle"><Badge tone={c.stale ? 'warning' : 'success'}>{c.stale ? 'Stale reading' : 'Current reading'}</Badge><span>Observed {age(c.observedAt)} · hypervisor host · select a reading for its history</span></div>
      <section className="detail-section"><div className="detail-section-heading"><Gpu size={16} /><h3>{shortGpu(g?.name)}</h3><span>nvidia-smi</span></div>
        {g ? <><div className="trend-grid">{[['gpuTemperature', 'Temperature', '°C', undefined, 'gpu.temperature'], ['gpuUtilization', 'Utilization', '%', 100, 'gpu.utilization'], ['gpuPower', 'Board power', ' W', undefined, 'gpu.power'], ['gpuMemory', 'Memory used', '%', 100, 'gpu.memory']].map(([k, label, unit, max, id]) => <button type="button" key={k} onClick={() => openMetric(id)}><span>{label}</span><Sparkline series={series} k={k} unit={unit} max={max} width={220} height={44} label={label} stretch /></button>)}</div>
          <div className="integration-spec">{[
            row('Temperature', `${fmt(g.temperature, 0)}°C · memory ${isNumber(g.memoryTemperature) ? `${fmt(g.memoryTemperature, 0)}°C` : 'not reported'}`, 'gpu.temperature'),
            row('Utilization', `${fmt(g.utilization, 0)}% core · ${fmt(g.memoryUtilization, 0)}% memory bus`, 'gpu.utilization'),
            row('Video memory', `${fmt(gib(g.memoryUsed))} of ${fmt(gib(g.memoryTotal))} GiB`, 'gpu.memory'),
            row('Power', `${fmt(g.powerDraw)} W of ${fmt(g.powerLimit, 0)} W limit${isNumber(g.powerMaxLimit) ? ` (max ${fmt(g.powerMaxLimit, 0)} W)` : ''}`, 'gpu.power'),
            row('Core clock', `${fmt(g.coreClock, 0)} MHz`, 'gpu.coreClock'),
            row('Memory clock', `${fmt(g.memoryClock, 0)} MHz`, 'gpu.memoryClock'),
            row('Fan', `${fmt(g.fan, 0)}%${g.fan === 0 ? ' · zero-RPM idle' : ''}`, 'gpu.fan'),
            row('Encoder', `${fmt(g.encoder, 0)}%`, 'gpu.encoder'),
            row('Decoder', `${fmt(g.decoder, 0)}%`, 'gpu.decoder'),
            row('State', `${g.pstate || '—'} · ${throttleText(g.throttle) || 'limiter not reported'}`),
            row('PCIe link', isNumber(g.pcieGen) ? `Gen ${fmt(g.pcieGen, 0)} ×${fmt(g.pcieWidth, 0)}` : 'Not reported'),
            row('Driver', g.driver || '—'),
          ]}</div>
          <Processes processes={c.processes || []} onOpen={metric => open({ type: "group", group: "gpu.processes", metric, from: "compute" })} /></> : <Empty title="GPU readings unavailable" />}
      </section>
      <section className="detail-section"><div className="detail-section-heading"><Microchip size={16} /><h3>{shortCpu(cpu.model)}</h3><span>/proc · hwmon</span></div>
        <div className="trend-grid">{[['cpuTemperature', 'Package Tctl', '°C', undefined, 'cpu.tctl'], ['cpuUtilization', 'Utilization', '%', 100, 'cpu.utilization']].map(([k, label, unit, max, id]) => <button type="button" key={k} onClick={() => openMetric(id)}><span>{label}</span><Sparkline series={series} k={k} unit={unit} max={max} width={220} height={44} label={label} stretch /></button>)}</div>
        <div className="integration-spec">{[
          row('Package', `${fmt(b.tctl)}°C Tctl${thermalLimit ? ` · ${thermalLimit}°C rated limit` : ''}`, 'cpu.tctl'),
          ...(b.ccds || []).map(x => row(`CCD ${x.id}`, `${fmt(x.temperature)}°C`, `cpu.ccd.${x.id}`)),
          row('Utilization', `${fmt(cpu.utilization)}% · load ${cpu.load ? cpu.load.map(v => fmt(v, 2)).join(' / ') : '—'}`, 'cpu.utilization'),
          row('Package power', isNumber(cpu.power) ? `${fmt(cpu.power)} W (RAPL energy counter)` : 'Measuring', 'cpu.power'),
          row('Core voltage', isNumber(b.vcore) ? `${fmt(b.vcore, 3)} V` : 'Not reported'),
          row('Clocks', `${fmt(cpu.clockAverage, 0)} MHz average · ${fmt(cpu.clockMax, 0)} MHz peak`, 'cpu.clock'),
          ...(b.temperatures || []).map(t => row(t.name, `${fmt(t.value)}°C`, `board.temp.${t.id}`)),
          ...(b.fans || []).map(f => row(f.name, `${fmt(f.rpm, 0)} RPM`, `board.fan.${f.id}`)),
        ]}</div>
        <div className="thread-table" role="table" aria-label="Per-thread load">{(cpu.threads || []).map(t => <div key={t.cpu} role="row" title={`CPU ${t.cpu} · core ${t.core} · CCD ${isNumber(t.ccd) ? t.ccd + 1 : '—'}`}><span role="cell">{t.cpu}</span><i role="cell" style={{ background: heat(t.load) }} /><strong role="cell">{isNumber(t.load) ? `${fmt(t.load, 0)}%` : '—'}</strong></div>)}</div>
        <p className="muted-note">Per-thread load and package power are differences between two consecutive readings. The first reading after a gap shows them as measuring rather than estimating.</p>
      </section>
    </>}
  </Dialog>;
}

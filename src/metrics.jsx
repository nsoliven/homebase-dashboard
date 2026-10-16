import React, { useEffect, useId, useState } from 'react';
import { Activity, ArrowLeft, TrendingUp } from 'lucide-react';
import { fmt, isNumber, request } from './api.js';
import { Badge, Dialog, Empty } from './components.jsx';
import { RangeTabs } from './explorers.jsx';
import { RefreshButton } from './refresh.jsx';

export const unitText = unit => !unit ? '' : ['°C', '%'].includes(unit) ? unit : ` ${unit}`;
export const digits = unit => ['RPM', 'MHz'].includes(unit) ? 0 : 1;
export const formatValue = (value, unit) => isNumber(value) ? `${fmt(value, digits(unit))}${unitText(unit)}` : '—';
const when = ts => ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

/** Loads one metric's range from the server (statistics are computed there). */
export function useMetric(id, range, enabled = true) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (!enabled || !id) return;
    let cancelled = false;
    const load = async first => {
      if (first) setState(s => ({ ...s, loading: true }));
      try { const data = await request(`/api/metrics/${encodeURIComponent(id)}?range=${range}`); if (!cancelled) setState({ loading: false, data, error: null }); }
      catch (e) { if (!cancelled) setState(s => ({ ...s, loading: false, error: e.status === 404 ? 'This metric is not recorded yet.' : e.message })); }
    };
    load(true);
    const timer = setInterval(() => { if (!document.hidden) load(false); }, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, range, enabled]);
  return state;
}

/** Min/max band with an average line; gaps stay gaps. */
export function BandChart({ data, height = 190, compact = false }) {
  const gradient = useId().replace(/:/g, ''), [hover, setHover] = useState(null);
  const points = data?.points || [], spec = data?.metric || {}, s = data?.statistics;
  if (points.length < 2) return <div className="chart-placeholder" style={{ minHeight: compact ? height : height + 30 }}><Activity size={16} /><span>Collecting history</span>{!compact && <small>Two samples are needed to draw a trend. Missing periods are never filled in.</small>}</div>;
  const width = 600, from = data.from, to = data.to, span = to - from || 1;
  const lo = Math.min(...points.map(p => p.min)), hi = Math.max(...points.map(p => p.max));
  // Minimum visible span per unit so sensor noise is not magnified into drama.
  const minSpan = { '°C': 6, '%': 10, W: 10, MHz: 200, RPM: 200 }[spec.unit] ?? 1;
  const pad = Math.max((hi - lo) * 0.12, (minSpan - (hi - lo)) / 2, 0.5);
  const bottom = spec.max ? 0 : Math.max(0, lo - pad), top = spec.max || hi + pad;
  const x = ts => (ts - from) / span * width, y = v => height - 6 - (v - bottom) / (top - bottom || 1) * (height - 12);
  const segments = []; let current = [];
  points.forEach((p, i) => { if (i && p.ts - points[i - 1].ts > data.step * 2.5) { segments.push(current); current = []; } current.push(p); });
  segments.push(current);
  const line = (seg, k) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const band = seg => `${line(seg, 'max')} ${[...seg].reverse().map(p => `L${x(p.ts).toFixed(1)},${y(p.min).toFixed(1)}`).join(' ')} Z`;
  const selected = hover !== null ? points[hover] : null;
  const timeLabel = ts => new Date(ts).toLocaleString(undefined, span > 43200_000 ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  const peak = s && isNumber(s.peakAt) && s.peakAt >= from ? { left: x(s.peakAt) / width * 100, top: y(s.max) / height * 100 } : null;
  return <div className={`chart band-chart ${compact ? 'compact' : ''}`}>
    <div className="chart-drawing" style={{ height }}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${spec.label}: average with minimum to maximum band, ${timeLabel(from)} to ${timeLabel(to)}`}
        onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(), t = from + (e.clientX - r.left) / r.width * span; let best = 0; for (let i = 1; i < points.length; i++) if (Math.abs(points[i].ts - t) < Math.abs(points[best].ts - t)) best = i; setHover(best); }}
        onPointerLeave={() => setHover(null)}>
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".2" /><stop offset="1" stopColor="currentColor" stopOpacity=".08" /></linearGradient></defs>
        {!compact && [.25, .5, .75].map(n => <line key={n} x1="0" x2={width} y1={height * n} y2={height * n} className="chart-grid" />)}
        {segments.map((seg, i) => <g key={i}>{seg.length > 1 ? <><path d={band(seg)} fill={`url(#${gradient})`} /><path d={line(seg, 'avg')} fill="none" stroke="currentColor" strokeWidth={compact ? 1.6 : 1.8} vectorEffect="non-scaling-stroke" /></> : <line x1={x(seg[0].ts)} x2={x(seg[0].ts)} y1={y(seg[0].max)} y2={y(seg[0].min) + .5} stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />}</g>)}
        {selected && <line x1={x(selected.ts)} x2={x(selected.ts)} y1="0" y2={height} className="chart-cursor" />}
      </svg>
      {peak && !compact && <span className="peak-marker" style={{ left: `${peak.left}%`, top: `${peak.top}%` }} title={`Peak ${formatValue(s.max, spec.unit)} at ${when(s.peakAt)}`}><i /><small>Peak</small></span>}
      {selected && <div className="chart-tooltip" style={{ left: `${Math.max(14, Math.min(86, x(selected.ts) / width * 100))}%` }}>{formatValue(selected.avg, spec.unit)}{selected.max !== selected.min && <span>{fmt(selected.min, digits(spec.unit))}–{formatValue(selected.max, spec.unit)}</span>}<span>{timeLabel(selected.ts)}</span></div>}
    </div>
    {!compact && <div className="chart-labels"><span>{timeLabel(from)}</span><span>{fmt(bottom, digits(spec.unit))}–{formatValue(top, spec.unit)}</span><span>{timeLabel(to)}</span></div>}
  </div>;
}

/** Detail view for one compute metric: range switch, band chart, server-side statistics. */
export function MetricHistory({ id, close, back }) {
  const [range, setRange] = useState('24h'), { data, loading, error } = useMetric(id, range);
  const spec = data?.metric, s = data?.statistics, unit = spec?.unit;
  const tiles = [['current', 'Current'], ['average', 'Average'], ['min', 'Min'], ['max', 'Max'], ['p95', 'P95'], ['p99', 'P99']];
  return <Dialog title={spec?.label || 'Metric history'} close={close} actions={<RefreshButton sources={['compute']} label="Refresh GPU and CPU readings" showStatus />}>
    <div className="detail-subtitle">{back && <button className="secondary-button back-button" onClick={back}><ArrowLeft size={14} />GPU &amp; CPU</button>}<Badge>{spec?.group || 'Compute'}</Badge><span>{data ? `${data.resolution} · statistics over every sample in range` : 'Loading…'}</span></div>
    <div className="explorer-toolbar"><RangeTabs range={range} setRange={setRange} /></div>
    <section className="metric-explorer metric-history">
      {error && !data ? <Empty title="History unavailable" text={error} /> : <>
        <div className="metric-tiles" aria-busy={loading || undefined}>{tiles.map(([k, label]) => <div key={k} className={k === 'current' ? 'is-current' : ''}><span title={k === 'p99' ? '99th percentile (nearest rank) of every sample in range' : k === 'p95' ? '95th percentile (nearest rank)' : undefined}>{label}</span><strong>{isNumber(s?.[k]) ? fmt(s[k], digits(unit)) : '—'}<small>{unitText(unit)}</small></strong></div>)}</div>
        <div className="peak-line"><TrendingUp size={14} /><span>{s ? <>Peak <strong>{formatValue(s.max, unit)}</strong> at {when(s.peakAt)} · low {formatValue(s.min, unit)} at {when(s.lowAt)}</> : 'No samples in this range yet'}</span></div>
        {loading && !data ? <div className="chart-placeholder" style={{ minHeight: 220 }}>Loading history…</div> : <BandChart data={data} />}
        <div className="chart-legend"><span><i className="legend-line" />Average</span><span><i className="legend-band" />Min – max</span></div>
        <div className="sample-note">{s ? `${s.count.toLocaleString()} samples · ${when(s.first)} onwards` : 'History begins when this metric is first recorded. Earlier periods are not estimated.'}<span>P95 / P99 are nearest-rank over the original samples</span></div>
      </>}
    </section>
  </Dialog>;
}

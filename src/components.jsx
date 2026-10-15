import React, { useEffect, useId, useRef, useState } from 'react';
import { Activity, X } from 'lucide-react';
import { fmt, isNumber } from './api.js';

export function Dot({ tone = 'green' }) { return <span className={`dot ${tone}`} aria-hidden="true" />; }
export function AppIcon({src,fallback:Fallback,size=20}) {
  const [failed,setFailed]=useState(null);
  return src&&failed!==src?<img className="service-logo" src={src} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(src)}/>:<Fallback size={size}/>;
}
export function Badge({ children, tone = 'neutral' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function IconButton({ icon: Icon, label, onClick, className = '', disabled }) { return <button className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon size={17} /></button>; }
export function Meter({ value, tone = 'accent', label }) { return <div className={`meter ${tone}`} {...(isNumber(value) ? { role: 'meter', 'aria-label': label, 'aria-valuenow': Math.round(value), 'aria-valuemin': 0, 'aria-valuemax': 100 } : {})}><span style={{ width: `${isNumber(value) ? value : 0}%` }} /></div>; }
export function Ticks({ value, count = 50, tone = 'accent' }) { return <div className={`ticks ${tone}`} aria-hidden="true">{Array.from({ length: count }, (_, i) => <i key={i} className={isNumber(value) && i / count * 100 < value ? 'filled' : ''} />)}</div>; }
export function Panel({ title, icon: Icon, logo, action, children, className = '', id }) { return <section className={`panel ${className}`} data-panel={id} aria-label={title}><div className="panel-heading"><div className="panel-heading-title">{Icon && <AppIcon src={logo} fallback={Icon} size={16}/>}<h2>{title}</h2></div>{action}</div>{children}</section>; }
export function Empty({ title = 'Waiting for measurements', text, icon: Icon = Activity, action }) { return <div className="empty-state"><Icon size={23} /><strong>{title}</strong>{text && <p>{text}</p>}{action}</div>; }
export function Dialog({ title, close, children }) {
  const ref = useRef(null);
  useEffect(() => { const d = ref.current; d.showModal(); return () => d.close(); }, []);
  return <dialog className="detail-dialog" ref={ref} aria-labelledby="dialog-title" onCancel={close} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } }}><div className="dialog-heading"><div><div className="eyebrow">HOMEBASE / DETAILS</div><h2 id="dialog-title">{title}</h2></div><IconButton icon={X} label="Close dialog" onClick={close} /></div>{children}</dialog>;
}

export function Chart({ statistics, points = [], metric, secondary, title, unit = '%', scale = 1, height = 116, max, loading }) {
  const id = useId().replace(/:/g, ''), [hover, setHover] = useState(null);
  const valid = points.filter(p => isNumber(p.values[metric]));
  if (loading) return <div className="chart-placeholder" style={{ minHeight: height + 30 }}>Loading history…</div>;
  if (valid.length < 2) return <div className="chart-placeholder" style={{ minHeight: height + 30 }}><Activity size={17} /><span>Collecting history</span><small>Two measurements are needed to draw a trend.</small></div>;
  const first = points[0].ts, last = points.at(-1).ts, span = last - first || 1;
  const values = points.flatMap(p => [p.values[metric], p.values[secondary]]).filter(isNumber).map(v => v / scale);
  const top = max || Math.max(1, Math.ceil(Math.max(...values) * 1.15)), width = 600, h = height;
  const x = p => (p.ts - first) / span * width, y = v => h - 9 - v / scale / top * (h - 18);
  const paths = key => {
    const paths = []; let current = [], prior;
    for (const point of points) {
      const value = point.values[key];
      if (point.rrdOnly && !isNumber(value)) continue;
      if (!isNumber(value) || prior && point.ts - prior > Math.max(span / 80, 600_000)) { if (current.length > 1) paths.push(current); current = []; }
      if (isNumber(value)) current.push([x(point), y(value)]);
      prior = point.ts;
    }
    if (current.length > 1) paths.push(current);
    return paths;
  };
  const lines = paths(metric), selected = hover !== null ? points[Math.min(hover, points.length - 1)] : null;
  const timeLabel = ts => new Date(ts).toLocaleString(undefined, span > 43200_000 ? { month:'short',day:'numeric',hour:'numeric',minute:'2-digit' } : { hour: '2-digit', minute: '2-digit' });
  return <div className="chart">{statistics?.[metric]&&<div className="metric-statistics compact">{[['average','Average'],['low','Low'],['high','Peak'],['p99','P99']].map(([key,label])=><div key={key}><span>{label}</span><strong>{fmt(statistics[metric][key]/scale)}<small>{unit}</small></strong></div>)}</div>}<div className="chart-drawing" style={{ height }}>
    <svg viewBox={`0 0 ${width} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${title}, from ${timeLabel(first)} to ${timeLabel(last)}`}
      onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(), timestamp = first + (e.clientX - r.left) / r.width * span; let index = 0; for (let i = 1; i < points.length; i++) if (Math.abs(points[i].ts - timestamp) < Math.abs(points[index].ts - timestamp)) index = i; setHover(index); }} onPointerLeave={() => setHover(null)}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.13" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      {[.25, .5, .75].map(n => <line key={n} x1="0" x2={width} y1={h * n} y2={h * n} className="chart-grid" />)}
      {lines.map((line, index) => { const d = line.map(([x,y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' '); return <g key={index}><path d={`${d} L${line.at(-1)[0]},${h} L${line[0][0]},${h} Z`} fill={`url(#${id})`} /><path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" /></g>; })}
      {secondary && paths(secondary).map((line, i) => <path key={i} d={line.map(([x,y], j) => `${j ? 'L' : 'M'}${x},${y}`).join(' ')} className="chart-secondary" fill="none" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />)}
      {selected && <line x1={x(selected)} x2={x(selected)} y1="0" y2={h} className="chart-cursor" />}
    </svg>
    {selected && <div className="chart-tooltip" style={{ left: `${Math.max(12, Math.min(85, x(selected) / width * 100))}%` }}>{fmt(isNumber(selected.values[metric]) ? selected.values[metric] / scale : null)}{unit}<span>{timeLabel(selected.ts)}</span></div>}
    </div><div className="chart-labels"><span>{timeLabel(first)}</span><span>Scale 0–{fmt(top, 0)}{unit}</span><span>{timeLabel(last)}</span></div></div>;
}

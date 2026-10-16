import React, { useEffect, useState } from 'react';
import { Activity, ArrowLeft, Clock3, Gauge, Zap } from 'lucide-react';
import { fmt, isNumber, request } from './api.js';
import { Dialog, Empty } from './components.jsx';
import { RangeTabs } from './explorers.jsx';
import { RefreshButton } from './refresh.jsx';
import { MetricPanel, formatValue } from './metrics.jsx';
import { GROUP_ID, duration } from '../server/compute-groups.mjs';

export const DEEP_LINK = /^#compute\/([a-zA-Z0-9.]{1,60})(?:\/([a-zA-Z0-9.]{1,60}))?$/;
/** `#compute/<group>/<metric>` → detail descriptor, or null. */
export function parseDeepLink(hash) {
  const m = DEEP_LINK.exec(hash || '');
  return m && GROUP_ID.test(m[1]) ? { type: 'group', group: m[1], metric: m[2] || null } : null;
}
const RANGE_WORDS = { '1h': 'last hour', '24h': 'last 24 hours', '7d': 'last 7 days' };
const heat = load => isNumber(load) ? `color-mix(in oklab, #6a85ff ${Math.round(Math.max(0, Math.min(100, load)))}%, #1c2232)` : 'var(--line)';

function useGroup(id, range) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try { const data = await request(`/api/compute/groups/${encodeURIComponent(id)}?range=${range}`); if (!cancelled) setState({ loading: false, data, error: null }); }
      catch (e) { if (!cancelled) setState(s => ({ ...s, loading: false, error: e.status === 404 ? 'This part is not reported right now.' : e.message })); }
    };
    setState(s => ({ ...s, loading: true })); load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, range]);
  return state;
}

const share = (ms, total) => total > 0 ? ms / total * 100 : 0;
function Derived({ d, range }) {
  if (!d) return null;
  const words = RANGE_WORDS[range];
  return <section className="group-section"><div className="group-section-heading"><Gauge size={15} /><h3>Over the {words}</h3><span>From stored 30-second samples</span></div>
    <div className="derived-grid">
      {d.energy && <div className="derived-card"><span><Zap size={13} />Energy used</span><strong>{d.energy.kwh < 1 ? fmt(d.energy.kwh * 1000, 0) : fmt(d.energy.kwh, 2)}<small>{d.energy.kwh < 1 ? ' Wh' : ' kWh'}</small></strong><p>{d.energy.samples ? `Integrated from ${d.energy.samples.toLocaleString()} samples covering ${duration(d.energy.coverageMs)} of ${duration(d.energy.rangeMs)}. Gaps are not filled in.` : 'No power samples in this range yet.'}</p></div>}
      {d.atLimit && <div className="derived-card"><span><Clock3 size={13} />At ≥ {fmt(d.atLimit.share * 100, 0)}% of the power limit</span><strong>{duration(d.atLimit.ms)}</strong><p>{d.atLimit.samples ? `${fmt(share(d.atLimit.ms, d.atLimit.samples * 30_000), 1)}% of the sampled time. Each sample is compared with the limit recorded at the same moment.` : 'No samples in this range yet.'}</p></div>}
    </div>
    {d.pstates?.length > 0 && <PstateBar pstates={d.pstates} />}
    {d.throttle?.totalMs > 0 && <div className="throttle-time"><h4>Clock limiters over time</h4>
      <div className="throttle-row none"><span>Nothing limiting clocks</span><i style={{ '--w': `${share(d.throttle.noneMs, d.throttle.totalMs)}%` }} /><strong>{duration(d.throttle.noneMs)}</strong></div>
      {d.throttle.reasons.map(r => <div className="throttle-row" key={r.key} title={r.detail}><span>{r.label}</span><i style={{ '--w': `${share(r.ms, d.throttle.totalMs)}%` }} /><strong>{duration(r.ms)}</strong></div>)}
      <p className="muted-note">Several limiters can be active at once, so times can add up to more than the range.</p></div>}
  </section>;
}
function PstateBar({ pstates }) {
  const total = pstates.reduce((a, p) => a + p.ms, 0), ramp = i => `color-mix(in oklab, #6a85ff ${Math.round(100 - i / Math.max(1, pstates.length - 1) * 75)}%, #1c2232)`;
  return <div className="pstate-time"><h4>Time in each performance state</h4>
    <div className="pstate-bar" role="img" aria-label={pstates.map(p => `${p.state} ${duration(p.ms)}`).join(', ')}>{pstates.map((p, i) => <i key={p.state} style={{ flexGrow: p.ms, background: ramp(i) }} title={`${p.state} · ${duration(p.ms)}`} />)}</div>
    <div className="pstate-legend">{pstates.map((p, i) => <span key={p.state}><i style={{ background: ramp(i) }} /><strong>{p.state}</strong>{duration(p.ms)} · {fmt(share(p.ms, total), 0)}%</span>)}</div>
    <p className="muted-note">P0 is maximum performance; higher numbers are deeper power-saving states.</p></div>;
}
function Limiters({ list }) {
  if (!list) return null;
  return <div className="limiters"><span className="eyebrow">Clock limiters now</span>{list.length ? list.map(r => <div key={r.key} className="limiter"><strong>{r.label}</strong><span>{r.detail}</span></div>) : <div className="limiter ok"><strong>Nothing is limiting clocks</strong><span>The GPU can boost freely right now.</span></div>}</div>;
}
function ThreadGrid({ cores, selected, select }) {
  return <section className="group-section"><div className="group-section-heading"><Activity size={15} /><h3>Per-thread load</h3><span>Select a thread for its history</span></div>
    <div className="thread-grid" role="group" aria-label="Threads by core">{cores.map(c => <div className="thread-core" key={c.core}><span>Core {c.core}</span><div>{c.threads.map(t => <button type="button" key={t.cpu} aria-pressed={selected === t.metric} className={selected === t.metric ? 'selected' : ''} style={{ '--heat': heat(t.load) }} onClick={() => select(t.metric)} aria-label={`CPU ${t.cpu}: ${isNumber(t.load) ? `${fmt(t.load, 0)}% load` : 'measuring'}, ${fmt(t.mhz, 0)} MHz. Show history`}><i /><strong>CPU {t.cpu}</strong><small>{isNumber(t.load) ? `${fmt(t.load, 0)}%` : '—'} · {fmt(t.mhz, 0)} MHz</small></button>)}</div></div>)}</div></section>;
}
function CoreTable({ cores }) {
  return <section className="group-section"><div className="group-section-heading"><Activity size={15} /><h3>Per-core clocks</h3><span>Now</span></div>
    <div className="sensor-table-wrap"><table className="sensor-table"><thead><tr><th>Core</th><th>CCD</th><th>Threads</th><th>MHz</th><th>Load</th></tr></thead><tbody>{cores.map(c => <tr key={`${c.ccd}-${c.core}`}><th>Core {c.core}</th><td>{c.ccd}</td><td>{c.cpus.join(', ')}</td><td>{fmt(c.mhz, 0)}</td><td>{fmt(c.load, 0)}%</td></tr>)}</tbody></table></div></section>;
}
function Processes({ list, selected, select }) {
  return <section className="group-section"><div className="group-section-heading"><Activity size={15} /><h3>Processes now</h3><span>nvidia-smi compute apps</span></div>
    {list.length ? <div className="process-list">{list.map((p, i) => <button type="button" key={i} disabled={!p.metric} className={selected === p.metric ? 'selected' : ''} onClick={() => p.metric && select(p.metric)}><strong>{p.name}</strong><span>{p.container ? `CT ${p.container}${p.containerName ? ` · ${p.containerName}` : ''}` : 'Host process'}</span><em>{isNumber(p.memoryGiB) ? `${fmt(p.memoryGiB, 2)} GiB` : '—'}</em></button>)}</div>
      : <p className="muted-note">No compute processes right now. Container history below shows earlier use.</p>}</section>;
}

/**
 * Rich detail for one part of the GPU or CPU: live header, a tab per metric with
 * 1 h / 24 h / 7 d history and statistics, derived figures, and every known fact.
 * A modal on desktop, a bottom sheet at phone widths. Deep link: #compute/<group>/<metric>.
 */
export function GroupSheet({ group, metric, close, back }) {
  const [range, setRange] = useState('24h'), [selected, setSelected] = useState(metric || null), { data, loading, error } = useGroup(group, range);
  const metrics = data?.metrics || [], known = [...metrics.map(m => m.id), ...(data?.threadMetrics || [])];
  const active = selected && (known.includes(selected) || !data) ? selected : metrics[0]?.id || null;
  useEffect(() => {
    if (!active) return;
    const hash = `#compute/${group}/${active}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }, [group, active]);
  useEffect(() => () => { if (location.hash.startsWith('#compute/')) history.replaceState(null, '', location.pathname + location.search); }, []);
  const extra = active && !metrics.some(m => m.id === active) ? active : null;
  return <Dialog className="group-sheet sheet" eyebrow={data ? `${data.eyebrow} · DETAILS` : 'DETAILS'} title={data?.title || 'Loading…'} close={close} actions={<RefreshButton sources={['compute']} label="Refresh GPU and CPU readings" showStatus />}>
    {back && <button className="secondary-button back-button" onClick={back}><ArrowLeft size={14} />GPU &amp; CPU</button>}
    {error && !data ? <Empty title="Details unavailable" text={error} /> : <>
      <div className="group-header" aria-live="polite">{(data?.header || []).map(h => <div key={h.label}><span>{h.label}</span><strong>{h.value}</strong></div>)}{loading && !data && <div><span>Loading</span><strong>—</strong></div>}</div>
      <div className="group-toolbar"><RangeTabs range={range} setRange={setRange} /></div>
      {(metrics.length > 1 || extra) && <div className="metric-chips" role="tablist" aria-label="Metrics">{metrics.map(m => <button type="button" role="tab" key={m.id} aria-selected={active === m.id} className={active === m.id ? 'selected' : ''} onClick={() => setSelected(m.id)}><span>{m.label}</span><strong>{formatValue(m.current, m.unit)}</strong></button>)}{extra && <button type="button" role="tab" aria-selected="true" className="selected"><span>{extra.startsWith('cpu.thread.') ? `CPU ${extra.split('.').pop()}` : extra}</span><strong>thread load</strong></button>}</div>}
      {active && <MetricPanel key={active} id={active} range={range} title={metrics.find(m => m.id === active)?.label || "Thread load"} live={metrics.find(m => m.id === active)?.current ?? data?.cores?.flatMap(c => c.threads).find(t => t.metric === active)?.load} />}
      <Limiters list={data?.limiters} />
      <Derived d={data?.derived} range={range} />
      {data?.cores && <ThreadGrid cores={data.cores} selected={active} select={setSelected} />}
      {data?.coreClocks && <CoreTable cores={data.coreClocks} />}
      {data?.processes && <Processes list={data.processes} selected={active} select={setSelected} />}
      {data?.facts?.length > 0 && <section className="group-section"><div className="group-section-heading"><Activity size={15} /><h3>Everything we know</h3><span>Read-only telemetry</span></div>
        <dl className="fact-list">{data.facts.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}{f.note && <small>{f.note}</small>}</dd></div>)}</dl></section>}
    </>}
  </Dialog>;
}

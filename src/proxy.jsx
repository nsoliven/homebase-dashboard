import React, { useMemo, useState } from 'react';
import { CircleCheck, ExternalLink, Hourglass, KeyRound, Lock, RotateCw, Route, Sparkles, TriangleAlert } from 'lucide-react';
import { age, duration, fmt, isNumber } from './api.js';
import { Badge, Dot, Empty, Panel } from './components.jsx';
import { RefreshButton, useRefreshOnOpen } from './refresh.jsx';
import { appLink } from './static-demo.js';
import { quotaReading } from '../server/quota.mjs';
import './proxy.css';

const ROUTING = { DRAINING: ['In use', 'success'], NEXT: ['Next up', 'neutral'], COOLING: ['Cooling down', 'warning'], HOLD: ['Held back', 'neutral'], FLOOR: ['At its reserve', 'warning'], OVERFLOW: ['Overflow only', 'neutral'] };
const SCENARIO = { plan: { label: 'Follow the plan', tone: 'plan' }, normal: { label: 'Normal habits', tone: 'normal' }, recent: { label: 'Like the last 6 h', tone: 'recent' } };
const HEALTH = { ok: ['Signed in', 'success', 'green'], limited: ['Signed in · rate limited', 'warning', 'amber'], 'signed-out': ['Needs sign-in', 'warning', 'red'], error: ['Error', 'warning', 'red'], disabled: ['Disabled', 'neutral', 'gray'] };
const CREDIT = { full: ['Full reset', '↻'], weekly: ['Weekly reset', 'W'], model: ['Model-only reset', 'M'], session: ['5-hour reset', '5h'], unknown: ['Reset credit', '?'] };
const short = name => (name || '').split('@')[0] || name;
const when = ts => isNumber(ts) ? new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const day = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const pct = v => isNumber(v) ? `${fmt(v, 0)}%` : '—';

function outcome(s) {
  if (s.runOut) return `runs out ${when(s.runOut)}`;
  if (s.wasted >= 1) return `${fmt(s.wasted, 0)}% expires unused`;
  return 'never runs out';
}

function PaceChart({ timeline, accounts }) {
  const [hover, setHover] = useState(null);
  const model = useMemo(() => {
    if (!timeline?.past?.length) return null;
    const { now, end, stepMs } = timeline, start = timeline.past[0][0];
    const series = timeline.scenarios.map(s => ({ ...s, line: s.points.map((v, i) => [now + i * stepMs, v]).filter(([t, v]) => isNumber(v) && t <= end) }));
    const top = Math.max(100, ...timeline.past.map(p => p[1]), ...series.flatMap(s => s.line.map(p => p[1])));
    const step = [25, 50, 100, 200, 500].find(s => s * 4 >= top * 1.08) || 1000, max = step * 4;
    const days = [];
    for (let d = new Date(start); d.getTime() <= end; d.setDate(d.getDate() + 1)) { d.setHours(0, 0, 0, 0); if (d.getTime() > start) days.push(d.getTime()); }
    const pins = timeline.events.filter(e => e.at >= start && e.at <= end);
    return { start, end, now, max, series, days, pins };
  }, [timeline]);
  if (!model) return <Empty title="No pace history yet" text="CLI Proxy draws this once it has a few hours of readings." />;
  const W = 1000, H = 260, { start, end, now, max } = model;
  const x = t => (t - start) / (end - start) * W, y = v => H - Math.max(0, v) / max * H;
  const path = pts => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const past = timeline.past, nowLeft = past.at(-1)[1];
  const ticks = Array.from({ length: 5 }, (_, i) => max / 4 * i);
  const nearest = (pts, t) => pts.reduce((best, p) => !best || Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best, null);
  const at = hover === null ? null : start + hover * (end - start);
  const rows = at === null ? [] : at <= now ? [['What you had', nearest(past, at)?.[1], 'past']] : model.series.map(s => [SCENARIO[s.key].label, nearest(s.line, at)?.[1], SCENARIO[s.key].tone]);
  return <div className="pace-chart">
    <div className="pace-legend">{model.series.map(s => <span key={s.key} className={`pace-key ${SCENARIO[s.key].tone}`}><i /><strong>{SCENARIO[s.key].label}</strong><small>{outcome(s)}</small></span>)}</div>
    <div className="pace-plot">
      <div className="pace-axis">{ticks.map(t => <span key={t} style={{ bottom: `${t / max * 100}%` }}>{fmt(t, 0)}%</span>)}</div>
      <div className="pace-drawing" onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); }} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Claude quota left: ${pct(nowLeft)} of one account now, with forecasts to ${when(end)}`}>
          <defs><linearGradient id="pace-past" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".16" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
          {ticks.slice(1).map(t => <line key={t} x1="0" x2={W} y1={y(t)} y2={y(t)} className="chart-grid" />)}
          {model.days.map(d => <line key={d} x1={x(d)} x2={x(d)} y1="0" y2={H} className="pace-day" />)}
          <path d={`${path(past)} L${x(past.at(-1)[0])},${H} L${x(past[0][0])},${H} Z`} className="pace-past-fill" />
          <path d={path(past)} className="pace-line past" />
          {model.series.map(s => s.line.length > 1 && <path key={s.key} d={path(s.line)} className={`pace-line ${SCENARIO[s.key].tone}`} />)}
          {model.pins.map(p => <line key={p.kind + p.at + p.account} x1={x(p.at)} x2={x(p.at)} y1="0" y2={H} className={`pace-pin ${p.kind}`} />)}
          <line x1={x(now)} x2={x(now)} y1="0" y2={H} className="pace-now" />
          {at !== null && <line x1={x(at)} x2={x(at)} y1="0" y2={H} className="chart-cursor" />}
        </svg>
        {model.pins.map(p => <span key={p.kind + p.at + p.account} className={`pace-pin-label ${p.kind}`} style={{ left: `${x(p.at) / W * 100}%` }} title={`${p.kind === 'reset' ? `${p.account} refills` : p.kind === 'run_out' ? 'Out of Claude at normal habits' : 'A reset credit expires'} · ${when(p.at)}`}>{p.kind === 'reset' ? <RotateCw size={10} /> : p.kind === 'run_out' ? '!' : '★'}</span>)}
        <span className="pace-now-label" style={{ left: `${x(now) / W * 100}%` }}>now · {pct(nowLeft)}</span>
        {at !== null && <div className="chart-tooltip pace-tooltip" style={{ left: `${Math.max(10, Math.min(88, hover * 100))}%` }}><span>{when(at)}</span>{rows.map(([label, v, tone]) => <span key={label} className={`pace-tip ${tone}`}><i />{label} <strong>{pct(v)}</strong></span>)}</div>}
      </div>
    </div>
    <div className="pace-days">{model.days.map(d => <span key={d} className={x(d) / W > .95 ? 'edge' : ''} style={{ left: `${x(d) / W * 100}%` }}>{new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</span>)}</div>
    <p className="muted-note">100% is one account's full week. The solid line is what you actually had; from now on each line is a forecast. {accounts > 1 ? `Your ${accounts} accounts add up, so the total can go past 100%.` : ''}</p>
  </div>;
}

function AccountCard({ account, credits }) {
  const weekly = account.windows.find(w => w.id === 'weekly'), five = account.windows.find(w => w.id === 'five-hour');
  const wr = weekly && quotaReading(account, weekly), fr = five && quotaReading(account, five);
  const shown = r => r?.state === 'current' ? r.currentRemaining : r?.state === 'stale' ? r.remaining : null;
  const [label, tone] = ROUTING[account.status] || [account.status.toLowerCase(), 'neutral'];
  const unused = credits.filter(c => c.left > 0).length, reserve = account.reservePercent;
  const resetIn = weekly?.resetsAt ? weekly.resetsAt * 1000 - Date.now() : null;
  return <section className={`pace-account ${wr?.state === 'current' ? '' : 'quota-outdated'}`}>
    <div className="pace-account-head"><strong title={account.name}>{short(account.name)}</strong><Badge tone={tone}>{label}</Badge></div>
    <div className="pace-account-reading"><strong>{pct(shown(wr))}</strong><span>{wr?.state === 'current' ? 'of the week left' : wr?.state === 'stale' ? `last reported ${age(account.observedAt)}` : 'awaiting a reading'}</span></div>
    <div className="reserve-meter" role="img" aria-label={`${pct(shown(wr))} weekly left, ${reserve ? `${pct(reserve)} kept in reserve` : 'no reserve'}`}>
      <span className="reserve-fill" style={{ width: `${shown(wr) ?? 0}%` }} />
      {reserve > 0 && <span className="reserve-floor" style={{ width: `${Math.min(100, reserve)}%` }} />}
    </div>
    <div className="pace-account-facts">
      <span><Lock size={12} />{reserve > 0 ? <>Keeps <strong>{pct(reserve)}</strong> back</> : 'No weekly reserve'}</span>
      <span><RotateCw size={12} />{isNumber(resetIn) && resetIn > 0 ? <>Refills <strong>{when(weekly.resetsAt * 1000)}</strong> · in {duration(resetIn / 1000)}</> : 'Refill time unknown'}</span>
      <span><Hourglass size={12} />{fr?.state === 'unknown-reset' && fr.remaining === 100 ? '5-hour window not started' : <>5-hour window <strong>{pct(shown(fr))}</strong> left</>}</span>
      <span><Sparkles size={12} />{unused ? <><strong>{unused}</strong> unused reset credit{unused === 1 ? '' : 's'}</> : 'No reset credits'}</span>
    </div>
    {account.reason && <p className="pace-account-reason">{account.reason}</p>}
  </section>;
}

function QueueRow({ q }) {
  const text = {
    queued: ['Queued', `Spends only when ${short(q.account)} runs out of its weekly limit.`, 'neutral'],
    claiming: ['Spending now', `Claiming the credit for ${short(q.account)}.`, 'warning'],
    fired: ['Spent', `${when(q.firedAt)}: ${short(q.account)} ran out and the proxy refilled it.`, 'success'],
    failed: ['Didn’t go through', `${short(q.account)}: ${q.result || 'the provider refused the reset'}.`, 'warning'],
    unknown: ['Unconfirmed', `Check ${short(q.account)} before queueing again.`, 'warning'],
  }[q.state];
  return <div className={`queue-row ${q.state}`}><span className="queue-icon"><RotateCw size={15} /></span><div><strong>Queued reset · {text[0]}</strong><p>{text[1]}</p><small>{q.label}{q.queuedAt ? ` · queued ${when(q.queuedAt)}` : ''}</small></div></div>;
}

function Credits({ proxy }) {
  const byAccount = proxy.accounts.map(a => [a.name, proxy.credits.filter(c => c.account.toLowerCase() === a.name.toLowerCase())]).filter(([, list]) => list.length);
  const unused = proxy.credits.filter(c => c.left > 0).length;
  return <Panel id="credits" title="Reset credits" icon={RotateCw} className="pace-span-7" action={<Badge>{unused} unused</Badge>}>
    {proxy.queued.length > 0 && <div className="queue-list">{proxy.queued.map(q => <QueueRow key={q.account + q.queuedAt} q={q} />)}</div>}
    {byAccount.length ? byAccount.map(([name, list]) => <div className="credit-group" key={name}><span className="eyebrow">{short(name)}</span>{list.map((c, i) => { const [name, mark] = CREDIT[c.kind] || CREDIT.unknown; return <div className={`credit-row ${c.left > 0 ? '' : 'used'}`} key={i}><span className={`credit-type ${c.kind}`}>{mark}</span><div><strong>{name}</strong><small title={c.label}>{c.label}</small></div><div className="credit-when">{c.left > 0 ? <><small>Use by</small><strong>{c.expiresAt ? day(c.expiresAt) : '—'}</strong></> : <small>Used</small>}</div></div>; })}</div>)
      : <Empty title="No reset credits" text="Credits the provider grants show up here with their expiry." />}
    <div className="panel-footnote"><span>Queue a credit from CLI Proxy. Homebase only shows it.</span></div>
  </Panel>;
}

function SignIns({ credentials }) {
  if (!credentials) return <Panel id="signins" title="Sign-ins" icon={KeyRound} className="pace-span-5"><Empty title="Sign-in health unavailable" text="CLI Proxy did not return its credential list." /></Panel>;
  const bad = credentials.filter(c => !['ok', 'limited'].includes(c.health)).length;
  return <Panel id="signins" title="Sign-ins" icon={KeyRound} className="pace-span-5" action={<Badge tone={bad ? 'warning' : 'success'}>{bad ? `${bad} need${bad === 1 ? 's' : ''} you` : 'All good'}</Badge>}>
    <div className="signin-list">{credentials.map(c => { const [label, tone, dot] = HEALTH[c.health]; return <div className="signin-row" key={c.id}><Dot tone={dot} /><div><strong title={c.name}>{short(c.name)}</strong><small>{c.provider}{c.renewedAt ? ` · login renewed ${age(c.renewedAt)}` : c.awaitingRenewal ? ' · awaiting first renewal' : ''}</small>{c.message && <small className="signin-message">{c.message}</small>}</div><Badge tone={tone}>{label}</Badge></div>; })}</div>
    <div className="panel-footnote"><span>Rate-limited accounts are still signed in; they come back at their refill.</span></div>
  </Panel>;
}

export function ProxyPage({ proxy, launchId }) {
  useRefreshOnOpen(['proxy']);
  if (proxy.status === 'unavailable') return <div className="dashboard-grid"><Panel id="pace" title="CLI Proxy" icon={Route} className="pace-span-12" refresh={<RefreshButton sources={['proxy']} label="Refresh CLI Proxy" showStatus />}><Empty title="CLI Proxy readings unavailable" text="The private proxy connector will retry automatically." /></Panel></div>;
  const pace = proxy.pace, tl = pace?.timeline, nowLeft = tl?.past.at(-1)?.[1];
  const nextReset = tl?.events.filter(e => e.kind === 'reset' && e.at > Date.now()).sort((a, b) => a.at - b.at)[0];
  const okSignIns = proxy.credentials?.filter(c => ['ok', 'limited'].includes(c.health)).length;
  const failMax = Math.max(1, ...proxy.failovers.map(f => f.count));
  return <div className="dashboard-grid proxy-page">
    <Panel id="pace" title="Claude pace" icon={Route} className="pace-span-12 pace-summary" refresh={<RefreshButton sources={['proxy']} label="Poll every account now" showStatus />} action={<span className="pace-updated">{proxy.status === 'stale' ? <Badge tone="warning">Stale</Badge> : <Badge tone="success"><Dot />Router live</Badge>}<span>Updated {age(proxy.observedAt)}</span>{launchId && <a className="text-button" {...appLink(launchId)}>Open CLI Proxy <ExternalLink size={12} /></a>}</span>}>
      <h3 className="pace-headline">{pace?.headline || 'Waiting for a pace reading'}</h3>
      <div className="pace-stats">
        <div><span>Left across accounts</span><strong>{pct(nowLeft)}</strong><small>of one account's week</small></div>
        <div><span>Low point ahead</span><strong>{pct(pace?.low)}</strong><small>{pace?.runOut ? `runs out ${when(pace.runOut)}` : pace?.until ? `through ${when(pace.until)}` : 'on the current plan'}</small></div>
        <div><span>Next refill</span><strong>{nextReset ? when(nextReset.at) : '—'}</strong><small>{nextReset ? short(nextReset.account) : 'no refill in view'}</small></div>
        <div><span>Pace, last 6 h</span><strong>{isNumber(pace?.paceMultiple) ? `${fmt(pace.paceMultiple, 1)}×` : '—'}</strong><small>{isNumber(pace?.targetMultiple) ? `target ${fmt(pace.targetMultiple, 1)}× your usual` : 'of your usual'}</small></div>
        <div><span>Sign-ins</span><strong>{proxy.credentials ? `${okSignIns}/${proxy.credentials.length}` : '—'}</strong><small>{proxy.credentials ? okSignIns === proxy.credentials.length ? 'all signed in' : 'some need you' : 'unavailable'}</small></div>
      </div>
      <div className="pace-router">
        <span><Route size={13} />{proxy.router ? `Auto-route ${proxy.router.autoRoute ? 'on' : 'off'}${isNumber(proxy.router.changes24h) ? ` · ${proxy.router.changes24h} order changes in 24 h` : ''}` : 'Routing state unavailable'}</span>
        <span><Lock size={13} />{proxy.reserve ? proxy.reserve.enabled ? `Weekly reserve enforced${proxy.reserve.releaseHours ? ` · released ${proxy.reserve.releaseHours} h before refill` : ''}` : 'Weekly reserve saved but not enforced' : 'Weekly reserve unavailable'}</span>
        {proxy.failovers.length > 0 && <span className="failover-bars" title="Requests moved to another account after a rate limit, per day"><TriangleAlert size={13} />Rate-limit failovers<span>{proxy.failovers.map(f => <i key={f.day} style={{ height: `${Math.max(8, f.count / failMax * 100)}%` }} title={`${f.day}: ${f.count}`} />)}</span><strong>{proxy.failovers.at(-1).count}</strong> on {new Date(`${proxy.failovers.at(-1).day}T12:00`).toLocaleDateString(undefined, { weekday: 'short' })}</span>}
      </div>
    </Panel>
    <Panel id="pace-chart" title="Your Claude quota, past and ahead" icon={Sparkles} className="pace-span-12"><PaceChart timeline={tl} accounts={proxy.accounts.length} /></Panel>
    <Panel id="pace-accounts" title="Accounts" icon={CircleCheck} className="pace-span-12" action={<Badge>{proxy.accounts.length} routed</Badge>}>
      <div className="pace-accounts">{proxy.accounts.map(a => <AccountCard key={a.id} account={a} credits={proxy.credits.filter(c => c.account.toLowerCase() === a.name.toLowerCase())} />)}</div>
    </Panel>
    <Credits proxy={proxy} />
    <SignIns credentials={proxy.credentials} />
  </div>;
}

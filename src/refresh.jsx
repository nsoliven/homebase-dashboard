import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Check, Clock3, RefreshCw } from 'lucide-react';
import { refreshSource } from './api.js';

const RefreshContext = createContext({ capabilities: {}, state: {}, run: async () => {} });
const labels = { proxmox: 'Proxmox', host: 'host telemetry', router: 'router', agents: 'T3 sessions', quotas: 'Codex quota', proxy: 'CLI Proxy', compute: 'GPU & CPU', nas: 'TrueNAS', 'claude-statusline': 'Claude status line' };
export const sourceLabel = id => labels[id] || (id.startsWith('guest:') ? `guest ${id.slice(6)} telemetry` : id);

/** One refresh state for the whole app, so a card and its modal share a spinner. */
export function RefreshProvider({ session, capabilities, apply, expire, children }) {
  const [state, setState] = useState({});
  const run = useCallback(async ids => {
    setState(s => ({ ...s, ...Object.fromEntries(ids.map(id => [id, { ...s[id], running: true }])) }));
    await Promise.all(ids.map(async id => {
      let result;
      try { result = await refreshSource(id, session.csrf); apply(result); }
      catch (e) { if (e.status === 401) expire(); result = { source: id, status: 'failed', reason: e.message }; }
      setState(s => ({ ...s, [id]: { running: false, result, at: Date.now() } }));
    }));
  }, [session, apply, expire]);
  return <RefreshContext.Provider value={{ capabilities: capabilities || {}, state, run }}>{children}</RefreshContext.Provider>;
}

function summary(results) {
  if (!results.length) return null;
  const by = status => results.filter(r => r.status === status);
  if (by('throttled').length) return { tone: 'muted', text: by('throttled')[0].reason };
  if (by('failed').length) return { tone: 'warning', text: by('failed')[0].reason };
  if (by('pending').length) return { tone: 'muted', text: 'Requested · waiting for the collector' };
  if (by('unavailable').length) return { tone: 'muted', text: by('unavailable')[0].reason };
  return { tone: 'success', text: 'Updated just now' };
}

/**
 * Force-refresh control. `sources` are refresh IDs; sources that cannot be
 * refreshed are explained in the tooltip, and the control is disabled only
 * when none of them can be.
 */
export function RefreshButton({ sources, label = 'Refresh now', showStatus = false, className = '' }) {
  const { capabilities, state, run } = useContext(RefreshContext);
  const describedBy = useId(), [flash, setFlash] = useState(null), lastAt = useRef(null);
  const ready = sources.filter(id => capabilities[id]?.available), blocked = sources.filter(id => !capabilities[id]?.available);
  const running = sources.some(id => state[id]?.running);
  const finished = sources.map(id => state[id]).filter(s => s?.result && !s.running);
  const latest = Math.max(0, ...finished.map(s => s.at));
  useEffect(() => {
    if (!latest || latest === lastAt.current || running) return;
    lastAt.current = latest;
    setFlash(summary(finished.filter(s => s.at >= latest - 30_000).map(s => s.result)));
    const timer = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(timer);
  }, [latest, running]);
  const why = ready.length
    ? [`${label}: ${ready.map(sourceLabel).join(', ')}.`, ...blocked.map(id => `${sourceLabel(id)} cannot be refreshed: ${capabilities[id]?.reason || 'not available.'}`)].join(' ')
    : blocked.map(id => capabilities[id]?.reason || `${sourceLabel(id)} cannot be refreshed.`).filter((v, i, a) => a.indexOf(v) === i).join(' ');
  const disabled = !ready.length;
  const Icon = flash?.tone === 'success' && !running ? Check : running ? RefreshCw : flash?.tone === 'muted' ? Clock3 : RefreshCw;
  return <span className={`refresh-control ${className}`}>
    {showStatus && (running || flash) && <span className={`refresh-status ${running ? '' : flash.tone}`} role="status">{running ? 'Refreshing…' : flash.text}</span>}
    <button type="button" className={`icon-button refresh-button ${running ? 'is-running' : ''} ${flash?.tone === 'success' && !running ? 'is-done' : ''}`}
      aria-label={running ? `${label} — refreshing` : label} aria-describedby={describedBy} aria-disabled={disabled || undefined} aria-busy={running || undefined}
      title={why} onClick={e => { e.stopPropagation(); if (!disabled && !running) run(ready); }}>
      <Icon size={15} className={running ? 'spin' : ''} />
    </button>
    <span id={describedBy} className="visually-hidden">{why}</span>
    {!showStatus && <span className="visually-hidden" role="status">{running ? 'Refreshing' : flash?.text || ''}</span>}
  </span>;
}

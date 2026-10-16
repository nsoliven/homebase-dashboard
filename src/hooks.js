import { useCallback, useEffect, useState } from 'react';
import { request } from './api.js';

export function useSession() {
  const [session, setSession] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  const load = useCallback(async () => { setLoading(true); try { setSession(await request('/api/session')); setError(null); } catch (e) { setError(e.message); } finally { setLoading(false); } }, []);
  useEffect(() => { load(); }, [load]);
  return { session, setSession, loading, error, reload: load };
}
export function useSnapshot(session, expire) {
  const [data, setData] = useState(null), [error, setError] = useState(null), [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (manual = false) => {
    if (!session?.user) return;
    if (manual) setRefreshing(true);
    try { setData(await request(manual ? '/api/refresh' : '/api/snapshot', manual ? { method: 'POST', headers: { 'X-Homebase-CSRF': session.csrf } } : {})); setError(null); }
    catch (e) { if (e.status === 401) expire(); setError(e.message); }
    finally { setRefreshing(false); }
  }, [session, expire]);
  useEffect(() => { if (!session?.user) { setData(null); return; } load(); const timer = setInterval(() => { if (!document.hidden) load(); }, 10000); const visible = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', visible); return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); }; }, [load, session]);
  const acknowledge = useCallback(async id => { await request('/api/acknowledge', { method: 'POST', headers: { 'X-Homebase-CSRF': session.csrf }, body: JSON.stringify({ id }) }); await load(); }, [session, load]);
  return { data, error, refreshing, refresh: () => load(true), acknowledge, replace: setData };
}
/** Re-renders on an interval so relative times ("Observed 4s ago") stay honest. */
export function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, interval); return () => clearInterval(timer); }, [interval]);
  return now;
}
/** Live GPU/CPU readings while the panel is on screen; the server shortens the
 * collector interval only while these requests keep arriving. */
export function useComputeLive(enabled) {
  const [state, setState] = useState({ compute: null, series: [], loaded: false, error: null });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false, timer;
    const load = async () => {
      if (!document.hidden) {
        try { const next = await request('/api/compute?live=1'); if (!cancelled) setState({ ...next, loaded: true, error: null }); }
        catch (e) { if (!cancelled) setState(s => ({ ...s, loaded: true, error: e.message })); }
      }
      if (!cancelled) timer = setTimeout(load, 3000);
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled]);
  return [state, setState];
}
export function useHistory(range, guest, enabled = true) {
  const [state, setState] = useState({ points: [], loading: true, error: null });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async (initial = false) => {
      if (initial) setState({ points: [], loading: true, error: null });
      try { const data = await request(`/api/history?range=${range}${guest ? `&guest=${guest}` : ''}`); if (!cancelled) setState({ ...data, loading: false, error: null }); }
      catch (e) { if (!cancelled) setState(s => ({ ...s, loading: false, error: e.message })); }
    };
    load(true); const timer = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [range, guest, enabled]);
  return state;
}

export function useIntegrations(enabled) {
  const [data,setData]=useState({applications:[],branding:{},proxy:{status:'unavailable',accounts:[]}});
  useEffect(()=>{if(!enabled)return;let cancelled=false; const controller=new AbortController();
    const load=async()=>{try{const next=await request('/api/integrations',{signal:controller.signal});if(!cancelled)setData(next);}catch{}};
    load();const timer=setInterval(()=>{if(!document.hidden)load();},30000);
    return()=>{cancelled=true;controller.abort();clearInterval(timer);};
  },[enabled]);return {...data,replace:setData};
}

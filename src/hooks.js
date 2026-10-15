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
  return { data, error, refreshing, refresh: () => load(true), acknowledge };
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
  },[enabled]);return data;
}

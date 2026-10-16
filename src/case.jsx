import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Fan } from 'lucide-react';
import { Panel } from './components.jsx';

// The 3D case view is a static page under /case/; the panel frames it and sizes the frame to the page's reported height.
export function CasePanel() {
  const frame = useRef(null);
  const [height, setHeight] = useState(820);
  useEffect(() => {
    const onMessage = e => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      const h = e.data?.type === 'homebase-case-height' ? Number(e.data.height) : NaN;
      if (Number.isFinite(h) && h > 200 && h < 4000) setHeight(h);
    };
    // the frame cannot see the dashboard's viewport, so tell it how tall the window is
    const viewport = () => frame.current?.contentWindow?.postMessage({ type: 'homebase-viewport', height: innerHeight }, location.origin);
    const loaded = frame.current; loaded?.addEventListener('load', viewport);
    addEventListener('message', onMessage); addEventListener('resize', viewport); viewport();
    return () => { removeEventListener('message', onMessage); removeEventListener('resize', viewport); loaded?.removeEventListener('load', viewport); };
  }, []);
  const action = <div className="case-actions"><span className="case-note" title="Fan readings are modeled from 2026-10-15 values. Fan control is not connected yet, and nothing here changes the real fans.">Modeled</span><a className="case-full" href="/case/" target="_blank" rel="noopener">Full screen <ArrowUpRight size={13}/></a></div>;
  return <Panel id="case" title="prox · The Tower 500" icon={Fan} action={action} className="case-panel">
    <iframe ref={frame} className="case-frame" src="/case/?embed" title="3D model of prox's case with fans, airflow and fan curves" style={{ height }} loading="eager"/>
  </Panel>;
}

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Fan } from 'lucide-react';
import { Panel } from './components.jsx';

// The 3D case view is a static page under /case/; the panel frames it and sizes the frame to the page's reported height.
export function CasePanel({ full = false }) {
  const frame = useRef(null);
  const [height, setHeight] = useState(820);
  useEffect(() => {
    const onMessage = e => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      const h = e.data?.type === 'homebase-case-height' ? Number(e.data.height) : NaN;
      if (Number.isFinite(h) && h > 200 && h < 4000) setHeight(h);
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);
  const action = <div className="case-actions"><span className="case-note">Modeled readings · fan control not connected yet</span><a className="text-button" href="/case/" target="_blank" rel="noopener">Full screen <ArrowUpRight size={14}/></a></div>;
  return <Panel id="case" title="prox · The Tower 500" icon={Fan} action={action} className={`case-panel ${full ? 'case-full' : ''}`}>
    <iframe ref={frame} className="case-frame" src="/case/?embed" title="3D model of prox's case with fans, airflow and fan curves" style={{ height }} loading="eager"/>
  </Panel>;
}

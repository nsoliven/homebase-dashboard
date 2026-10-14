import { readFileSync } from 'node:fs';

export function safeApplications(input) {
  return (Array.isArray(input) ? input : []).slice(0,200).flatMap(a => {
    try {
      const url=new URL(a.url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || !/^[a-z0-9-]{1,80}$/.test(a.id)) return [];
      return [{id:a.id,name:String(a.name).slice(0,100),url:url.href,category:String(a.category||'Applications').slice(0,50),description:String(a.description||'').slice(0,180)}];
    } catch { return []; }
  });
}
const seconds=value=>{const n=Date.parse(value);return Number.isFinite(n)?n/1000:null;};
const pct=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
export function proxyReport(raw) {
  return {status:raw.stale?'stale':'connected',observedAt:Date.parse(raw.generated_at)||null,
    accounts:(Array.isArray(raw.accounts)?raw.accounts:[]).slice(0,50).map((a,i)=>({
      id:`account-${i+1}`,name:String(a.name||`Account ${i+1}`).slice(0,120),status:String(a.status||'unknown').slice(0,30),
      observedAt:Date.parse(a.last_sample_at)||null,windows:[
        {id:'five-hour',label:'5-hour window',usedPercent:pct(a.used_5h),resetsAt:seconds(a.resets_5h)},
        {id:'weekly',label:'Weekly window',usedPercent:pct(typeof a.left==='number'?100-a.left:null),resetsAt:seconds(a.resets)},
      ].filter(w=>w.usedPercent!==null),
    }))};
}
export class Integrations {
  constructor(config) { this.config=config;this.cached=null;this.pending=null; }
  applications() { try { return safeApplications(JSON.parse(readFileSync(this.config.applicationsFile,'utf8'))); } catch { return []; } }
  async readProxy() {
    const p=this.config.proxy;
    if (!p) return {status:'unavailable',accounts:[]};
    try {
      const url=new URL(p.endpoint);
      if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Loopback endpoint required');
      const line=readFileSync(p.keyFile,'utf8').split('\n').find(s=>s.startsWith(`${p.keyVariable}=`));
      const key=line?.slice(line.indexOf('=')+1).trim().replace(/^(['"])(.*)\1$/,'$2');
      if (!key) throw new Error('Unavailable key');
      const r=await fetch(url,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(8000),redirect:'error'});
      if (!r.ok) throw new Error('Proxy unavailable');
      const raw=await r.text();if(raw.length>2_000_000)throw new Error('Response too large');
      return proxyReport(JSON.parse(raw));
    } catch { return {status:'unavailable',accounts:[]}; }
  }
  async snapshot() {
    if (this.cached&&Date.now()-this.cached.at<15_000) return this.cached.data;
    if (!this.pending) this.pending=this.readProxy().then(proxy=>{
      const data={applications:this.applications(),proxy};this.cached={at:Date.now(),data};return data;
    }).finally(()=>{this.pending=null;});
    return this.pending;
  }
}

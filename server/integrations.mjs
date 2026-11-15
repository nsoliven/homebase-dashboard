import { readFileSync } from 'node:fs';
import { readPrivateIcon } from './icons.mjs';
import { proxyReport } from './proxy.mjs';

export function safeApplications(input) {
  return (Array.isArray(input) ? input : []).slice(0,200).flatMap(a => {
    try {
      const url=new URL(a.url);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || !/^[a-z0-9-]{1,80}$/.test(a.id)) return [];
      return [{id:a.id,name:String(a.name).slice(0,100),url:url.href,category:String(a.category||'Applications').slice(0,50),description:String(a.description||'').slice(0,180),...(/^[a-z0-9][a-z0-9-]{0,79}\.(png|ico|webp)$/.test(a.iconFile||'')?{iconFile:a.iconFile}:{})}];
    } catch { return []; }
  });
}
export class Integrations {
  constructor(config) { this.config=config;this.cached=null;this.pending=null; }
  applications() { try { return safeApplications(JSON.parse(readFileSync(this.config.applicationsFile,'utf8'))); } catch { return []; } }
  icon(kind,id) {
    const filename=kind==='apps'?this.applications().find(a=>a.id===id)?.iconFile:this.config.branding?.[id];
    return readPrivateIcon(this.config.iconsDirectory,filename);
  }
  // refresh=true uses the quota fork's fixed sibling route (POST .../refresh), which
  // polls each account's usage now and returns the same report. The reserve and
  // credential reads are fixed siblings of the same management API. Loopback only.
  async readProxy(refresh=false) {
    const p=this.config.proxy;
    if (!p) return {status:'unavailable',accounts:[]};
    try {
      const url=new URL(p.endpoint);
      if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Loopback endpoint required');
      const line=readFileSync(p.keyFile,'utf8').split('\n').find(s=>s.startsWith(`${p.keyVariable}=`));
      const key=line?.slice(line.indexOf('=')+1).trim().replace(/^(['"])(.*)\1$/,'$2');
      if (!key) throw new Error('Unavailable key');
      const read=async(path,method='GET',timeout=8000)=>{
        const target=new URL(url);target.pathname=path;
        const r=await fetch(target,{method,headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(timeout),redirect:'error'});
        if (!r.ok) throw new Error('Proxy unavailable');
        const raw=await r.text();if(raw.length>4_000_000)throw new Error('Response too large');
        return JSON.parse(raw);
      };
      const report=url.pathname.replace(/\/+$/,''), base=report.endsWith('/routing/quota')?report.slice(0,-'/routing/quota'.length):null;
      const optional=path=>base?read(`${base}${path}`).catch(()=>null):Promise.resolve(null);
      const [raw,reserve,credentials]=await Promise.all([refresh?read(`${report}/refresh`,'POST',20000):read(report),optional('/routing/quota/reserve'),optional('/credentials')]);
      return proxyReport(raw,{reserve,credentials});
    } catch { return {status:'unavailable',accounts:[]}; }
  }
  async refreshProxy() {
    const proxy=await this.readProxy(true);
    if (proxy.status==='connected') { await this.pending?.catch(()=>{}); this.cached=null; await this.snapshot(); }
    return proxy;
  }
  async snapshot() {
    if (this.cached&&Date.now()-this.cached.at<15_000) return this.cached.data;
    if (!this.pending) this.pending=this.readProxy().then(proxy=>{
      const applications=this.applications().map(({iconFile,...a})=>({...a,iconUrl:iconFile?`/api/apps/${a.id}/icon`:null}));
      const branding=Object.fromEntries(['proxmox','nas','router','agents','quotas','codex','claude'].filter(id=>typeof this.config.branding?.[id]==='string').map(id=>[id,`/api/branding/${id}/icon`]));
      const data={applications,branding,proxy};this.cached={at:Date.now(),data};return data;
    }).finally(()=>{this.pending=null;});
    return this.pending;
  }
}

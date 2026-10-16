// Isolated screenshot/demo server. Never loads production config or credentials.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { summarize } from '../server/statistics.mjs';
import { coolingStatus } from '../server/cooling.mjs';
import * as demoCompute from './demo-compute.mjs';
import { setScenario } from './demo-compute.mjs';
import { Store } from '../server/store.mjs';
import { METRIC_ID, RANGES, metricHistory, metricSpec } from '../server/metrics.mjs';
import { GROUP_ID, groupDetail } from '../server/compute-groups.mjs';

// In-memory only; synthetic samples through the production metric tiers.
const metricStore = new Store(':memory:');
demoCompute.seedHistory(metricStore);

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const GiB = 1024 ** 3;
const now = Date.now();
const temperatures = [
  ['cpu-package', 'CPU', 'CPU package', 'k10temp / Tctl', 68.4],
  ['cpu-1', 'CPU', 'CPU chiplet 1', 'k10temp / Tccd1', 64.2],
  ['cpu-2', 'CPU', 'CPU chiplet 2', 'k10temp / Tccd2', 61.8],
  ['gpu', 'GPU', 'GPU edge', 'amdgpu / edge', 43.1],
  ['memory-1', 'Memory', 'Memory module 1', 'spd5118 / temp1', 46.5],
  ['memory-2', 'Memory', 'Memory module 2', 'spd5118 / temp1', 45.8],
  ['drive', 'Storage', 'Drive composite', 'nvme / Composite', 39.7],
  ['network', 'Network', 'Network controller', 'controller / temp1', 38.6],
].map(([id, group, name, label, value]) => ({id, group, name, label, value}));
const pressure = {cpu:{some:1.2,full:0},memory:{some:0.1,full:0},io:{some:0.4,full:0.1}};
const fanReadings=[{id:'sample-fan',name:'Radiator fan',label:'Sample fan channel',rpm:1480},{id:'sample-pump',name:'AIO pump',label:'Sample pump channel',rpm:3200},{id:'sample-case',name:'Case fan',label:'Sample case channel',rpm:1050},{id:'sample-unused',name:'Unassigned channel',label:'Sample unused channel',rpm:0}];
const cooling={...coolingStatus(fanReadings,{description:'Synthetic cooling profile. Actual sound varies with the case and listening position.',channels:[{id:'sample-fan',role:'fan',confirmed:true,maxRpm:2450},{id:'sample-case',role:'fan',confirmed:true,maxRpm:2000},{id:'sample-pump',role:'pump',confirmed:true,maxRpm:3200}]}),observedAt:now};
const host = {
  name:'Compute host', cpuModel:'AMD Ryzen 9 · 12-core processor', threads:24,
  cpu:32.8, cpuTemperature:68.4, temperatures, cooling, load:[4.12,3.68,3.21],
  uptime:734400, memoryUsed:42*GiB, memoryTotal:96*GiB, memoryAvailable:54*GiB,
  swapUsed:0, pressure, zfsHealth:'ONLINE', backupAt:now-7200000,
  diskReadRate:18e6, diskWriteRate:6e6,
  storage:[{name:'Fast storage',type:'ZFS',status:'available',used:680*GiB,total:2048*GiB}],
};
const vms = ['Workspace','Gateway','Web services','Build runner','Sandbox'].map((name,i) => ({
  id:200+i, name, node:'Compute host', type:i===2?'lxc':'qemu',
  status:i===4?'stopped':'running', uptime:120000, cpu:i===4?null:7+i*4,
  cores:4, memoryUsed:(3+i)*GiB, memoryTotal:16*GiB, diskTotal:128*GiB,
  os:'Debian Linux', guest:i===4?null:{total:16*GiB,available:(13-i)*GiB,swapUsed:0,pressure},
  guestStale:i===4, guestUpdatedAt:now, memoryScope:'guest',
}));
const agents = [
  ['Refine the metrics view','codex','working'],
  ['Review network health','claude','review'],
  ['Prepare release notes','codex','idle'],
].map(([name,provider,status],i)=>({id:`demo-session-${i}`,name,provider,status,project:'Homebase',branch:'main',source:'T3 Code',updatedAt:now}));
const windows = (fiveHour,weekly) => [
  {id:'five-hour',label:'5-hour window',usedPercent:fiveHour,resetsAt:Math.floor(now/1000)+10800,durationMins:300},
  {id:'weekly',label:'Weekly window',usedPercent:weekly,resetsAt:Math.floor(now/1000)+345600,durationMins:10080},
];
const applications = [
  ['cli-proxy','CLI Proxy','Tools','Account routing and usage'],
  ['t3','T3 Code','Tools','Your coding workspace'],
  ['hypervisor','Hypervisor','Infrastructure','Machines and resources'],
  ['network','Network console','Infrastructure','Connectivity and devices'],
  ['storage','Storage console','Infrastructure','Pools, capacity, and health'],
  ['documents','Documents','Applications','A place for your files'],
  ['photos','Photo library','Applications','Browse your collection'],
  ['monitoring','Monitoring','Applications','Signals across the lab'],
].map(([id,name,category,description])=>({id,name,category,description,iconUrl:`/api/apps/${id}/icon`}));
const integrations = {applications,branding:{nas:'/api/branding/nas/icon',proxmox:'/api/branding/proxmox/icon',router:'/api/branding/router/icon'},proxy:{status:'connected',observedAt:now,accounts:[
  {id:'sample-a',name:'Personal account',status:'DRAINING',observedAt:now,source:'header',windows:windows(3,1)},
  {id:'sample-b',name:'Work account',status:'NEXT',observedAt:now-55*60_000,source:'usage',windows:windows(7,2)},
]}};
const snapshot = {
  observedAt:now,host,vms,agents,alerts:[],nas:null,
  quotas:{codex:{observedAt:now,windows:windows(18,26)},claude:null},
  router:{model:'Network gateway',firmware:'Stable release',uptime:734400,clients:24,
    interface:'wan0',downMbps:42.8,upMbps:8.2,latency:12,packetLoss:0},
  sources:['proxmox','host','nas','router','agents','quotas','compute'].map(id=>({
    id,label:{proxmox:'Proxmox',host:'Host telemetry',nas:'TrueNAS',router:'Network',agents:'T3 sessions',quotas:'AI usage',compute:'GPU & CPU'}[id],
    status:id==='nas'?'unavailable':'connected',observedAt:id==='nas'?null:now,
    message:id==='nas'?'Configure a dedicated read-only connection.':'Sample readings for this demo.',
  })),
};
const lastRefresh={};
function refreshCapabilities(){
  const ids=['proxmox','host','router','agents','quotas','proxy','compute',...vms.filter(v=>v.guest).map(v=>`guest:${v.id}`)];
  return {...Object.fromEntries(ids.map(id=>[id,{id,available:true,minIntervalMs:10000,lastRequestedAt:lastRefresh[id]||null,reason:'Sample refresh for this demo.'}])),
    nas:{id:'nas',available:false,reason:'TrueNAS is not connected, so there is nothing to re-collect.'},
    'claude-statusline':{id:'claude-statusline',available:false,reason:'Claude status-line readings arrive only when Claude Code renders its status line after a real response. They cannot be requested.'}};
}
const demoSnapshot=()=>({...snapshot,compute:demoCompute.view(),refresh:refreshCapabilities()});
function history(range) {
  const span = {'1h':3600000,'24h':86400000,'7d':604800000}[range]||86400000;
  const points = Array.from({length:241},(_,i)=>{
    const wave=Math.sin(i/14), burst=Math.max(0,Math.sin(i/9))*Math.max(0,Math.sin(i/31));
    const values={'host.cpu':25+wave*8+burst*35,'host.memory':43+Math.sin(i/40)*3,
      'host.temperature':62+wave*3+burst*14,'host.diskRead':(14+burst*25)*1e6,
      'host.diskWrite':(5+burst*9)*1e6,'router.down':28+burst*45,'router.up':6+burst*12,
      'router.latency':12+wave*2,'router.packetLoss':0};
    for(const t of temperatures)values[`temperature.${t.id}`]=t.id==='cpu-package'?values['host.temperature']:t.value+wave*2+burst*3;
    for(const f of fanReadings)values[`fan.${f.id}`]=f.rpm===0?0:f.rpm+(f.id==='sample-pump'?wave*15:wave*80+burst*350);
    for(const v of vms){values[`vm.${v.id}.cpu`]=v.cpu===null?null:v.cpu+wave*3;values[`vm.${v.id}.memory`]=v.status==='running'?25+wave*2:null;values[`vm.${v.id}.pressure`]=v.status==='running'?0.1:null;}
    return {ts:now-span+i*span/240,values};
  });
  const statistics=Object.fromEntries(Object.keys(points[0].values).map(key=>{
    const valid=points.filter(p=>Number.isFinite(p.values[key]));
    return [key,valid.length?{...summarize(valid.map(p=>p.values[key])),from:valid[0].ts,to:valid.at(-1).ts}:null];
  }));
  return {points,statistics};
}
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  let data;
  if(/^\/api\/(apps|branding)\/[a-z0-9-]+\/icon$/.test(url.pathname)){
    res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end(await readFile(resolve(root,'favicon.svg')));return;
  }
  const scenarioRoute=url.pathname.match(/^\/demo\/scenario\/(idle|load)$/);
  if(scenarioRoute){setScenario(scenarioRoute[1]);res.writeHead(302,{Location:'/'});res.end();return;}
  const refreshRoute=url.pathname.match(/^\/api\/refresh\/([^/]+)$/);
  if(refreshRoute&&req.method==='POST'){
    // Synthetic delay so the in-progress state is visible in screenshots.
    const id=decodeURIComponent(refreshRoute[1]),cap=refreshCapabilities()[id];
    if(!cap?.available){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({source:id,status:'unavailable',reason:cap?.reason||'Unknown source.',snapshot:demoSnapshot()}));return;}
    await new Promise(r=>setTimeout(r,Number(process.env.DEMO_REFRESH_MS||2200)));
    const at=Date.now();
    if(id==='proxy')for(const a of integrations.proxy.accounts)a.observedAt=at;
    else{const s=snapshot.sources.find(s=>s.id===id||id.startsWith('guest:')&&s.id==='host');if(s)s.observedAt=at;if(id==='proxmox')snapshot.observedAt=at;}
    lastRefresh[id]=at;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({source:id,status:'updated',observedAt:at,snapshot:demoSnapshot(),...(id==='proxy'?{integrations}:{}),...(id==='compute'?{live:demoCompute.live()}:{})}));return;
  }
  const metricRoute=url.pathname.match(/^\/api\/metrics\/([a-zA-Z0-9.]{1,60})$/);
  if(metricRoute){
    const range=url.searchParams.get('range')||'24h',spec=METRIC_ID.test(metricRoute[1])&&Object.hasOwn(RANGES,range)?metricSpec(metricRoute[1],demoCompute.view(),name=>metricStore.hasMetric(name)):null;
    res.writeHead(spec?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(spec?metricHistory(metricStore,spec,range):{error:'Unknown metric.'}));return;
  }
  const groupRoute=url.pathname.match(/^\/api\/compute\/groups\/([a-zA-Z0-9.]{1,60})$/);
  if(groupRoute){
    const range=url.searchParams.get('range')||'24h',result=GROUP_ID.test(groupRoute[1])&&Object.hasOwn(RANGES,range)?groupDetail(metricStore,demoCompute.view(),groupRoute[1],range,{thermalLimit:95}):null;
    res.writeHead(result?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(result||{error:'Unknown group.'}));return;
  }
  if(url.pathname==='/api/session')data={user:{name:'Demo operator'},csrf:'sample-only',configured:true};
  else if(['/api/snapshot','/api/refresh'].includes(url.pathname))data=demoSnapshot();
  else if(url.pathname==='/api/compute')data=demoCompute.live();
  else if(url.pathname==='/api/integrations')data=integrations;
  else if(url.pathname==='/api/history')data=history(url.searchParams.get('range'));
  else if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/')){res.writeHead(404);res.end('Demo links are disabled.');return;}
  if(data){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));return;}
  try{
    const filename=resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));
    if(!filename.startsWith(root+sep)&&filename!==resolve(root,'index.html'))throw new Error('Invalid path');
    let body=await readFile(filename);
    if(filename===resolve(root,'index.html'))body=Buffer.from(body.toString().replace('</body>','<div style="position:fixed;bottom:8px;right:14px;padding:5px 9px;border:1px solid #dedee5;border-radius:6px;background:white;color:#666;font:11px system-ui;z-index:9999">Sample data · screenshot demo</div></body>'));
    res.writeHead(200,{'Content-Type':types[extname(filename)]||'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(4320,'127.0.0.1',()=>console.log('Sample-data preview: http://127.0.0.1:4320'));

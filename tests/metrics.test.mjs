import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { summarize } from '../server/statistics.mjs';
import { proxyReport,safeApplications } from '../server/integrations.mjs';
import { chartValues,sanitizeFeed } from '../server/model.mjs';

test('summaries retain true peaks and nearest-rank P99 before chart downsampling',()=>{
  const store=new Store(':memory:');const now=1_000_000_000;
  for(let i=1;i<=100;i++)store.history({'host.temperature':i},now-2000+i);
  const result=store.series('24h',now);
  assert.deepEqual(Object.fromEntries(Object.entries(result.statistics['host.temperature']).filter(([k])=>!['from','to'].includes(k))),{count:100,average:50.5,low:1,high:100,p99:99});
  assert.equal(result.points.length,1);assert.equal(result.points[0].values['host.temperature'],50.5);
  store.close();
});
test('sensor coverage starts at its actual first sample, not another metric',()=>{
  const store=new Store(':memory:');const now=1_000_000_000;
  store.history({'host.cpu':20},now-3_000_000);
  store.history({'temperature.sensor-a':50},now-60_000);
  store.history({'temperature.sensor-a':null},now-30_000);
  const r=store.series('1h',now);
  assert.equal(r.statistics['temperature.sensor-a'].from,now-60_000);
  assert.equal(r.statistics['temperature.sensor-a'].count,1);
  assert.equal(r.statistics['temperature.sensor-a'].high,50);store.close();
});
test('non-finite readings never enter summary statistics',()=>{
  assert.equal(summarize([null,undefined,NaN,Infinity]),null);
  assert.deepEqual(summarize([40,null,60,NaN]),{count:2,average:50,low:40,high:60,p99:60});
});
test('private application catalogue rejects unsafe or credential-bearing destinations',()=>{
  const credentialUrl=new URL('https://app.example/');credentialUrl.username='synthetic-user';credentialUrl.password='synthetic-password';
  const result=safeApplications([{id:'sample',name:'Sample application',url:'https://app.example/'},{id:'bad',name:'Bad',url:'javascript:alert(1)'},{id:'credentials',name:'Credentials',url:credentialUrl.href},{id:'query',name:'Query',url:'https://app.example/?token=secret'}]);
  assert.equal(result.length,1);assert.equal(result[0].id,'sample');
});
test('proxy exposes quota fields without raw credential material',()=>{
  const r=proxyReport({generated_at:'2026-01-01T00:00:00Z',stale:false,secret:'NEVER_EXPORT',accounts:[{name:'Sample account',left:.25,used_5h:.2,resets:'2026-01-02T00:00:00Z',access_token:'NEVER_EXPORT',last_sample_at:'2026-01-01T00:00:00Z'}]});
  assert.equal(r.accounts[0].windows.find(w=>w.id==='weekly').usedPercent,75);
  assert.equal(r.accounts[0].windows.find(w=>w.id==='five-hour').usedPercent,20);
  assert.ok(!JSON.stringify(r).includes('NEVER_EXPORT'));
});
test('sensor identity and T3 thread metadata pass only through their explicit allowlists',()=>{
  const host=sanitizeFeed('host',{temperatures:[{id:'sensor-a',name:'CPU package',group:'CPU',label:'sensor / source',value:60,secret:'NEVER_EXPORT'}]});
  const agent=sanitizeFeed('agents',{agents:[{id:'thread-a',threadId:'thread-a',name:'Sample task',provider:'codex',status:'working',transcript:'NEVER_EXPORT'}]});
  assert.equal(host.temperatures[0].id,'sensor-a');assert.equal(agent.agents[0].threadId,'thread-a');
  assert.ok(!JSON.stringify({host,agent}).includes('NEVER_EXPORT'));
  const values=chartValues({host:{temperatures:host.temperatures},sources:[],vms:[]});
  assert.equal(values['temperature.sensor-a'],60);
});

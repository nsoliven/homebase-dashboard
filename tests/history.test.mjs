import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Monitor } from '../server/monitor.mjs';
test('unrelated RRD points are distinguishable from genuine missing sensor samples',async()=>{
  const store=new Store(':memory:');const now=Date.now();
  store.history({'host.temperature':70},now-60_000);
  store.history({'host.temperature':72},now-30_000);
  const api=async()=>[{time:(now-45_000)/1000,cpu:.5,memused:5,memtotal:10},{time:(now+600_000)/1000,cpu:.5}];
  const m=new Monitor({proxmox:{node:'test'}},store,api);
  const history=await m.history('1h');
  assert.ok(history.points.some(p=>p.rrdOnly&&p.values['host.temperature']===undefined));
  assert.ok(history.points.some(p=>!p.rrdOnly&&p.values['host.temperature']===70));
  assert.ok(history.points.every(p=>p.ts<=history.to));
  assert.equal(history.statistics['host.temperature'].high,72);store.close();
});

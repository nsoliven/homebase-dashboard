import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyReport} from '../server/integrations.mjs';
import {quotaReading,quotaSummary,QUOTA_FRESH_MS} from '../server/quota.mjs';

const now=Date.parse('2026-10-14T20:00:00Z');
const fixture=(extra={})=>({generated_at:new Date(now).toISOString(),stale:false,accounts:[{
  name:'Sample account',left:.99,used_5h:.03,kappa:1,
  resets:'2026-10-20T20:00:00Z',resets_5h:'2026-10-14T23:00:00Z',
  last_sample_at:new Date(now-60_000).toISOString(),...extra,
}]});
test('fractional provider fields display 97% session and 99% weekly remaining',()=>{
  const a=proxyReport(fixture()).accounts[0];
  assert.equal(quotaReading(a,a.windows[0],now).currentRemaining,97);
  assert.equal(quotaReading(a,a.windows[1],now).currentRemaining,99);
});
test('weekly account-weeks are normalized by account capacity',()=>{
  const a=proxyReport(fixture({left:1.8,kappa:2,used_5h:1})).accounts[0];
  assert.equal(a.windows[1].usedPercent,10);assert.equal(a.windows[0].usedPercent,100);
  const b=proxyReport(fixture({left:0,used_5h:0})).accounts[0];
  assert.equal(b.windows[1].usedPercent,100);assert.equal(b.windows[0].usedPercent,0);
});
test('invalid and percentage-shaped inputs are rejected, not silently interpreted',()=>{
  for(const v of [null,'0.03',NaN,Infinity,-.1,3]){
    const a=proxyReport(fixture({left:v,used_5h:v})).accounts[0];assert.equal(a.windows.length,0);
  }
  assert.equal(proxyReport(fixture({kappa:0})).accounts[0].windows.length,1);
});
test('a fresh generated report cannot freshen a stale or missing account observation',()=>{
  const a=proxyReport(fixture({last_sample_at:new Date(now-55*60_000).toISOString()})).accounts[0];
  assert.equal(quotaReading(a,a.windows[1],now).state,'stale');
  assert.equal(quotaReading(a,a.windows[1],now).currentRemaining,null);
  assert.equal(quotaReading(a,a.windows[1],now).remaining,99);
  assert.deepEqual(quotaSummary([a],now),{current:0,outdated:1});
  const missing=proxyReport(fixture({last_sample_at:null})).accounts[0];
  assert.equal(quotaReading(missing,missing.windows[0],now).state,'unavailable');
});
test('expired and rolled-forward projections never become current 100% readings',()=>{
  const a=proxyReport(fixture({used_5h:0,resets_5h:'2026-10-14T19:59:00Z'})).accounts[0];
  assert.equal(quotaReading(a,a.windows[0],now).state,'expired');
  const rolled=proxyReport(fixture({last_sample_at:'2026-10-13T20:00:00Z',resets:'2026-10-21T19:00:00Z'})).accounts[0];
  assert.equal(quotaReading(rolled,rolled.windows[1],now).state,'expired');
  const justRolled=proxyReport(fixture({left:1,last_sample_at:'2026-10-14T19:59:30Z',resets:'2026-10-21T19:59:50Z'})).accounts[0];
  assert.equal(quotaReading(justRolled,justRolled.windows[1],now).state,'expired');
  const unknown=proxyReport(fixture({resets_5h:null})).accounts[0];
  assert.equal(quotaReading(unknown,unknown.windows[0],now).state,'unknown-reset');
});
test('freshness expires at the boundary and honors upstream staleness and future timestamps',()=>{
  const a=proxyReport(fixture({last_sample_at:new Date(now-QUOTA_FRESH_MS).toISOString()})).accounts[0];
  assert.equal(quotaReading(a,a.windows[0],now).state,'stale');
  assert.equal(quotaReading({...a,observedAt:now,reportStale:true},a.windows[0],now).state,'stale');
  assert.equal(quotaReading({...a,observedAt:now+120_000},a.windows[0],now).state,'unavailable');
});

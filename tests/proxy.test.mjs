import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyReport,credentialHealth} from '../server/proxy.mjs';

const now=Date.parse('2026-10-14T20:00:00Z'), iso=offset=>new Date(now+offset).toISOString();
const report=(extra={})=>({generated_at:iso(0),stale:false,state:'on_pace',lines:['On pace · low point 60% of an account'],low:.6,
  accounts:[{name:'Sample@Example.test',left:.5,used_5h:.1,kappa:1,resets:iso(86400_000),last_sample_at:iso(-60_000),status:'ACTIVE',configured_reserve:.05}],
  timeline:{now:iso(0),end:iso(3600_000),step_minutes:30,past:[{at:iso(-1800_000),left:.6},{at:iso(0),left:.5}],
    scenarios:[{key:'plan',points:[.5,.45,.4],run_out:null,dry_hours:0,wasted:0},{key:'internal-only',points:[1]}],
    events:[{at:iso(1800_000),kind:'reset',account:'Sample@Example.test'},{at:iso(1800_000),kind:'until'}]},
  ...extra});

test('credentials expose health only, never tokens, paths, or IDs',()=>{
  const out=credentialHealth({files:[{id:'secret-id',path:'/private/auth.json',access_token:'tok',refresh_token:'tok2',auth_index:'idx',email:'a@example.test',provider:'claude',status:'active'}]});
  assert.deepEqual(Object.keys(out[0]).sort(),['awaitingRenewal','health','id','message','name','provider','renewedAt']);
  assert.equal(out[0].health,'ok');assert.doesNotMatch(JSON.stringify(out),/tok|private|secret-id|idx/);
});
test('a rate-limited account reads as limited, not as a broken sign-in',()=>{
  const [limited,signedOut,broken]=credentialHealth({files:[
    {email:'a',status:'error',unavailable:true,quota_blocked:true,status_message:'rate_limit_error'},
    {email:'b',status:'active',requires_sign_in:true},
    {email:'c',status:'error',unavailable:true,status_message:'invalid_grant'}]});
  assert.equal(limited.health,'limited');assert.equal(limited.message,'');
  assert.equal(signedOut.health,'signed-out');
  assert.equal(broken.health,'error');assert.equal(broken.message,'invalid_grant');
});
test('the saved reserve wins and matches accounts regardless of case',()=>{
  assert.equal(proxyReport(report()).accounts[0].reservePercent,5);
  const a=proxyReport(report(),{reserve:{enabled:true,reserve_release_h:2,reserve:{'sample@example.test':.15}}});
  assert.equal(a.accounts[0].reservePercent,15);assert.deepEqual(a.reserve,{enabled:true,releaseHours:2});
  assert.equal(proxyReport(report(),{reserve:{enabled:true,reserve_release_h:0,reserve:{'sample@example.test':15}}}).accounts[0].reservePercent,0);
});
test('what a credit clears decides its kind, not the provider type',()=>{
  const kinds=proxyReport(report({banks:[
    {account:'a',type:'full',clears:['five_hour','seven_day','seven_day_overage_included']},
    {account:'a',type:'weekly',clears:['five_hour','seven_day']},
    {account:'a',type:'full',clears:['seven_day_overage_included']},
    {account:'a',type:'full',clears:[],gives_back_weekly:false}]})).credits.map(c=>c.kind);
  assert.deepEqual(kinds,['full','weekly','model','unknown']);
});
test('queued resets keep known states only',()=>{
  const out=proxyReport(report({queued_resets:[
    {account:'Sample@Example.test',label:'One full reset',state:'fired',queued_at:iso(-7200_000),fired_at:iso(-60_000),result:'reset',request_id:'req'},
    {account:'x',state:'mystery'}]})).queued;
  assert.equal(out.length,1);assert.equal(out[0].firedAt,now-60_000);assert.equal(out[0].request_id,undefined);
});
test('the pace timeline is in percent of one account and drops unknown series',()=>{
  const t=proxyReport(report()).pace.timeline;
  assert.deepEqual(t.past,[[now-1800_000,60],[now,50]]);
  assert.deepEqual(t.scenarios.map(s=>s.key),['plan']);assert.deepEqual(t.scenarios[0].points,[50,45,40]);
  assert.deepEqual(t.events.map(e=>e.kind),['reset']);
  assert.equal(proxyReport(report({timeline:{now:'bad'}})).pace.timeline,null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {coolingStatus,thermalState} from '../server/cooling.mjs';
import {sanitizeFeed,chartValues,deriveAlerts} from '../server/model.mjs';
import {Store} from '../server/store.mjs';

test('fan readings reject malformed RPM and never accept collector role or secret fields',()=>{
  const feed=sanitizeFeed('host',{fans:[{id:'a',rpm:0,name:'Unused',role:'pump',secret:'NEVER_EXPORT'},{id:'b',rpm:1500},{id:'c',rpm:-1},{id:'d',rpm:Infinity},{id:'e',rpm:'1500'},{id:'f',rpm:20001}]});
  assert.equal(feed.fans.length,2);assert.equal(feed.fans[0].rpm,0);
  assert.ok(!JSON.stringify(feed).includes('NEVER_EXPORT'));assert.equal(feed.fans[0].role,undefined);
});
test('a fast pump cannot inflate the airflow estimate; unassigned and missing readings stay unknown',()=>{
  const channels=[{id:'fan',role:'fan',maxRpm:2500},{id:'pump',role:'pump',maxRpm:3200}];
  const result=coolingStatus([{id:'fan',name:'Fan',rpm:1000},{id:'pump',name:'Pump',rpm:3200}],{channels});
  assert.equal(result.noise.level,2);assert.equal(result.noise.rpm,1000);assert.equal(result.noise.confirmed,false);
  assert.equal(coolingStatus([{id:'pump',rpm:3200}],{channels}).noise.level,null);
  assert.equal(coolingStatus([{id:'unassigned',rpm:1800}]).noise.level,null);
  assert.equal(coolingStatus([{id:'fan',rpm:0}],{channels}).noise.level,null);
});
test('fan history records original peaks and zero readings with independent coverage',()=>{
  const store=new Store(':memory:');const now=1_000_000_000;
  for(const [i,rpm] of [0,800,1600].entries()){
    const values=chartValues({host:{cooling:{fans:[{id:'fan',rpm}]}},sources:[],vms:[]});store.history(values,now-3000+i*1000);
  }
  const stat=store.series('1h',now).statistics['fan.fan'];assert.equal(stat.high,1600);assert.equal(stat.low,0);assert.equal(stat.average,800);assert.equal(stat.count,3);store.close();
});
test('7900X boost temperature is contextual; high temperature at idle still requests a check',()=>{
  const host={cpuModel:'AMD Ryzen 9 7900X 12-Core Processor',cpuTemperature:95.8,cpu:65};
  assert.equal(thermalState(host).alert,false);assert.equal(thermalState(host).limit,95);
  assert.equal(thermalState({...host,cpu:3}).alert,true);
  assert.equal(thermalState({...host,cpuTemperature:98}).alert,true);
  assert.equal(thermalState({...host,cpuModel:'AMD Ryzen 9 7900X3D'}).limit,null);
  const snapshot={host,sources:[{id:'proxmox',status:'connected'}],vms:[],nas:null};
  assert.ok(!deriveAlerts(snapshot).some(a=>a.id==='host:temperature'));
});

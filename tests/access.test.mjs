import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/index.mjs';
test('integrations and catalogue redirects require a real session and cannot redirect arbitrarily',async()=>{
  const root=mkdtempSync(join(tmpdir(),'homebase-test-'));
  writeFileSync(join(root,'apps.json'),JSON.stringify([{id:'sample',name:'Sample application',url:'https://app.example/'}]));
  const store=new Store(':memory:');const app=createApp({publicUrl:'https://dashboard.example',applicationsFile:join(root,'apps.json')},store,{snapshot:()=>({})},{});
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const path of ['/api/integrations','/api/apps/sample/open'])assert.equal((await fetch(base+path,{redirect:'manual'})).status,401);
    const session=store.session({id:'test',name:'Test user'});const headers={Cookie:`__Host-homebase=${session.token}`};
    const r=await fetch(base+'/api/apps/sample/open?destination=https://evil.example',{headers,redirect:'manual'});
    assert.equal(r.status,302);assert.equal(r.headers.get('Location'),'https://app.example/');
    assert.equal((await fetch(base+'/api/apps/unknown/open',{headers,redirect:'manual'})).status,404);
    assert.equal((await fetch(base+'/api/integrations',{headers})).status,200);
  } finally {await new Promise(resolve=>server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});}
});

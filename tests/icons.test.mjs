import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createApp} from '../server/index.mjs';
import {readPrivateIcon} from '../server/icons.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=','base64');
test('private icons reject traversal, symlink escapes, active formats, and mismatched content',()=>{
  const root=mkdtempSync(join(tmpdir(),'homebase-icon-'));const icons=join(root,'icons');mkdirSync(icons);
  try {
    writeFileSync(join(icons,'sample.png'),png);writeFileSync(join(root,'outside.png'),png);
    symlinkSync(join(root,'outside.png'),join(icons,'escape.png'));
    writeFileSync(join(icons,'fake.png'),'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    writeFileSync(join(icons,'large.png'),Buffer.alloc(512*1024+1));
    assert.equal(readPrivateIcon(icons,'sample.png').type,'image/png');
    for(const name of ['../outside.png','escape.png','fake.png','large.png','sample.svg','https://example.test/icon.png'])assert.equal(readPrivateIcon(icons,name),null);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('icons require authentication and resolve configured IDs without exposing private filenames',async()=>{
  const root=mkdtempSync(join(tmpdir(),'homebase-icon-access-'));const icons=join(root,'icons');mkdirSync(icons);
  writeFileSync(join(icons,'sample.png'),png);
  writeFileSync(join(root,'apps.json'),JSON.stringify([{id:'sample',name:'Sample app',url:'https://app.example/',iconFile:'sample.png'}]));
  const store=new Store(':memory:');const app=createApp({publicUrl:'https://dashboard.example',applicationsFile:join(root,'apps.json'),iconsDirectory:icons,branding:{nas:'sample.png'}},store,{},{});
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const p of ['/api/apps/sample/icon','/api/branding/nas/icon'])assert.equal((await fetch(base+p)).status,401);
    const session=store.session({id:'test',name:'Test user'});const headers={Cookie:`__Host-homebase=${session.token}`};
    for(const p of ['/api/apps/sample/icon?filename=../outside.png','/api/branding/nas/icon']){
      const r=await fetch(base+p,{headers});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.match(r.headers.get('cache-control'),/private/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
    }
    assert.equal((await fetch(base+'/api/apps/unknown/icon',{headers})).status,404);
    const data=await fetch(base+'/api/integrations',{headers}).then(r=>r.json());
    assert.equal(data.applications[0].iconUrl,'/api/apps/sample/icon');assert.equal(data.applications[0].iconFile,undefined);
    assert.equal(data.branding.nas,'/api/branding/nas/icon');assert.ok(!JSON.stringify(data).includes(icons));
  }finally{await new Promise(resolve=>server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});}
});

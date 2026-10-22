import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createApp} from '../src/server.mjs';
// start:aigc.
import {Quotes} from '../src/quotes.mjs';
// end:aigc.

test('new admin is isolated, authenticated, versioned and persistent',async()=>{
  // start:aigc.
  const dir=mkdtempSync(join(tmpdir(),'lcjy-test-'));const quotes=new Quotes(); // 注入聚合层实例：不构建真实适配器、不连网
  // end:aigc.
  let app=await createApp({dataDir:dir,quotes});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  let base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const call=async(path,data,headers={})=>{const res=await fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...headers},body:data?JSON.stringify(data):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};};
  try{
    assert.equal((await call('/api/admin/config')).status,401);
    assert.equal((await call('/api/admin/session')).data.needsSetup,true);
    assert.equal((await call('/api/admin/setup',{password:'StrongPassword12!',setupToken:'wrong'})).status,403);
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setup=await call('/api/admin/setup',{password:'StrongPassword12!',setupToken:token});assert.equal(setup.status,200);csrf=setup.data.csrf;
    assert.equal((await call('/api/admin/setup',{password:'OtherPassword12!',setupToken:token})).status,409);
    const initial=(await call('/api/admin/config')).data;
    const config=structuredClone(initial.config);config.rows[0].sellFormula='【#黄金#销售价】+4';
    const noCsrf=await call('/api/admin/config',{config,expectedVersion:initial.version},{'x-csrf-token':''});assert.equal(noCsrf.status,403);
    assert.equal((await call('/api/admin/config',{config,expectedVersion:initial.version},{origin:'https://evil.example'})).status,403);
    assert.equal((await call('/api/admin/preview',{config})).status,200);
    assert.equal((await call('/api/admin/config')).data.version,initial.version);
    const save=await call('/api/admin/config',{config,expectedVersion:initial.version});assert.equal(save.status,200);
    assert.equal((await call('/api/admin/config',{config,expectedVersion:initial.version})).status,409);
    config.rows[0].sellFormula='process.exit()';
    assert.equal((await call('/api/admin/config',{config,expectedVersion:save.data.version})).status,400);
    assert.equal((await call('/api/admin/config')).data.config.rows[0].sellFormula,'【#黄金#销售价】+4');
    assert.equal((await call('/api/admin/audit')).data.entries.length,1);
    // start:aigc.
    await app.close(); app=await createApp({dataDir:dir,quotes});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;
    // end:aigc.
    cookie='';csrf=''; const login=await call('/api/admin/login',{password:'StrongPassword12!'});assert.equal(login.status,200);csrf=login.data.csrf;
    assert.equal((await call('/api/admin/config')).data.config.rows[0].sellFormula,'【#黄金#销售价】+4');
    assert.equal((await call('/api/admin/password',{oldPassword:'wrong',newPassword:'ReplacementPass12!'})).status,403);
    const current=(await call('/api/admin/config')).data;
    const pending=request(base+'/api/admin/config',{method:'POST',headers:{origin:base,cookie,'x-csrf-token':csrf,'content-type':'application/json'} });
    const pendingResult=new Promise((resolve,reject)=>{pending.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});pending.on('error',reject);});
    pending.flushHeaders();pending.write('{"config":');
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await call('/api/admin/logout',{})).status,200);
    pending.end(JSON.stringify(current.config)+',"expectedVersion":'+current.version+'}');
    assert.equal(await pendingResult,401,'logout must revoke a partially sent mutation');
    assert.equal((await call('/api/admin/config')).status,401);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

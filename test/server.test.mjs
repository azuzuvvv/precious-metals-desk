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
    // start:aigc. 预览改收目录草稿（R02 统一配置源）
    assert.equal((await call('/api/admin/preview',{categories:(await call('/api/admin/catalog')).data.categories})).status,200);
    // end:aigc.
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

// start:aigc.
test('admin 可读取来源状态、切换日志并保存三元目录',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lcjy-admin-'));const quotes=new Quotes();
  const app=await createApp({dataDir:dir,quotes});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const call=async(path,data)=>{const res=await fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})},body:data?JSON.stringify(data):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};};
  try{
    // 未登录全部 401
    assert.equal((await call('/api/admin/sources')).status,401);
    assert.equal((await call('/api/admin/catalog')).status,401);
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setup=await call('/api/admin/setup',{password:'StrongPassword12!',setupToken:token});csrf=setup.data.csrf;
    // 来源状态：含 rtj/sina，带 hasSecret 标志
    const sources=(await call('/api/admin/sources')).data.sources;
    assert.ok(sources.some((s)=>s.id==='rtj'));
    assert.ok(sources.some((s)=>s.id==='sina'));
    assert.ok(sources.every((s)=>typeof s.hasSecret==='boolean'));
    // 切换日志：空数组结构
    assert.deepEqual((await call('/api/admin/switch-logs')).data.entries,[]);
    // 三元目录读取：品类含黄金与港金（港金为换算公式）
    const catalog=(await call('/api/admin/catalog')).data;
    assert.ok(catalog.categories.some((c)=>c.name==='黄金'));
    const hk=catalog.categories.find((c)=>c.name==='港金');
    assert.ok(hk.sellFormula.includes('37.429'));
    assert.ok(catalog.baseQuotes.some((b)=>b.symbol==='美元指数'));
    // 保存品类：改黄金销售公式后读回生效（带版本乐观锁）
    const edited=structuredClone(catalog);
    edited.categories.find((c)=>c.name==='黄金').sellFormula='【#黄金#销售价】+4';
    const save=await call('/api/admin/catalog',{...edited,expectedVersion:catalog.version});
    assert.equal(save.status,200);
    assert.equal(save.data.version,catalog.version+1);
    assert.equal((await call('/api/admin/catalog')).data.categories.find((c)=>c.name==='黄金').sellFormula,'【#黄金#销售价】+4');
    // 旧版本号再保存：409 冲突
    assert.equal((await call('/api/admin/catalog',{...edited,expectedVersion:catalog.version})).status,409);
    // 非法目录 400：精度越界
    const bad=structuredClone(catalog);
    bad.categories.find((c)=>c.name==='黄金').decimals=9;
    assert.equal((await call('/api/admin/catalog',{...bad,expectedVersion:save.data.version})).status,400);
    // start:aigc.
    // 新增品类（R10）：硬缺口品种自配场景，保存后目录与公开报价均出现
    const withGap=structuredClone((await call('/api/admin/catalog')).data);
    withGap.categories.push({id:'gap-4411',name:'公斤条',visible:true,buyFormula:'【#黄金#回购价】*12.5',sellFormula:'【#黄金#销售价】*12.5',highFormula:'',lowFormula:'',decimals:2,rounding:'half-up'});
    assert.equal((await call('/api/admin/catalog',{...withGap,expectedVersion:withGap.version})).status,200);
    assert.ok((await call('/api/admin/catalog')).data.categories.some((c)=>c.name==='公斤条'));
    // 删除品类（R10）：保存后目录与公开报价均移除
    const removed=structuredClone((await call('/api/admin/catalog')).data);
    removed.categories=removed.categories.filter((c)=>c.name!=='公斤条');
    assert.equal((await call('/api/admin/catalog',{...removed,expectedVersion:removed.version})).status,200);
    assert.ok(!(await call('/api/admin/catalog')).data.categories.some((c)=>c.name==='公斤条'));
    // 排序（R10）：黄金移到末尾后读回顺序一致
    const reordered=structuredClone((await call('/api/admin/catalog')).data);
    const goldCat=reordered.categories.find((c)=>c.name==='黄金');
    reordered.categories=reordered.categories.filter((c)=>c!==goldCat).concat([goldCat]);
    assert.equal((await call('/api/admin/catalog',{...reordered,expectedVersion:reordered.version})).status,200);
    assert.equal((await call('/api/admin/catalog')).data.categories.at(-1).name,'黄金');
    // 基础行情增删（R10）
    const withBq=structuredClone((await call('/api/admin/catalog')).data);
    withBq.baseQuotes.push({symbol:'probe-x',name:'探针行情',unit:'',decimals:2,enabled:false,sources:[{sourceId:'rtj',priority:1,kind:'plain',code:'XAU'}]});
    assert.equal((await call('/api/admin/catalog',{...withBq,expectedVersion:withBq.version})).status,200);
    assert.ok((await call('/api/admin/catalog')).data.baseQuotes.some((b)=>b.symbol==='probe-x'));
    // end:aigc.
    // start:aigc.
    // 保存目录必须实际影响公开报价（R02 验收：不止配置读回）
    const quotesApp=app;
    const q=quotesApp.quotes;
    q.selector.configure(app.store.baseQuotes()); // 注入的聚合层未按目录建连：先注册候选来源（等价生产 start()），否则 ingest 会被 Selector 拒绝
    q.ingestTest('rtj','黄金',{buy:100,sell:101,high:110,low:95,time:Date.now()});
    q.publish();
    const edited2=structuredClone((await call('/api/admin/catalog')).data);
    edited2.categories.find((c)=>c.name==='黄金').sellFormula='【#黄金#销售价】+5';
    const ver=(await call('/api/admin/catalog')).data.version;
    assert.equal((await call('/api/admin/catalog',{...edited2,expectedVersion:ver})).status,200);
    const quotes=await (await fetch(base+'/api/quotes')).json();
    const goldRow=quotes.rows.find((r)=>r.name==='黄金');
    assert.equal(goldRow.buy,'100.00');
    assert.equal(goldRow.sell,'106.00','目录保存后公开报价必须按新基差计算');
    // end:aigc.
    // 目录保存写入审计
    assert.ok((await call('/api/admin/audit')).data.entries.some((e)=>e.summary==='更新行情目录'));
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
// end:aigc.

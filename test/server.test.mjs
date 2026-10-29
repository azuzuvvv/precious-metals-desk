import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createApp,buildRtjMap} from '../src/server.mjs';
// start:aigc.
import {Quotes} from '../src/quotes.mjs';
// end:aigc.
// start:aigc.
// MySQL 改造适配：src/server.mjs 的 createApp 不支持注入 store/db 参数，内部 Store.create 走默认
// env 配置（DB_*）。为隔离，采用最小侵入方案：每个用例前自建独立测试库，通过 DB_* 环境变量
// 注入（含 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD，保证连接用户与建库用户一致），用例结束恢复
// 原环境变量并 DROP 库。注意不能用"先 createTestStore 再改 DB_NAME"方式——createApp 会另建池。
import {beforeEach,afterEach} from 'node:test';
import {createTestDatabase,dropTestDatabase,testDbEnv,scanDelPrefix,randomTestPrefix,waitRedisReady} from './helpers.mjs';
import Redis from 'ioredis';
let testDbName,prevEnv;
// start:aigc. 审查 R2/R2残留：server.test 的 createApp 注入独立 Redis 库 + 随机测试命名空间，
// admin 会话/限流键全部落在 lcjy:test:* 下，清理只删本次随机前缀（生产前缀与真实会话不触碰）
const REDIS_TEST_DB = 13;
const TEST_PREFIX = randomTestPrefix();
const CLEAN_PATTERN = `${TEST_PREFIX}*`;
async function flushTestRedis(){
  const r=new Redis({host:process.env.REDIS_HOST||'127.0.0.1',port:Number(process.env.REDIS_PORT||6379),db:REDIS_TEST_DB,enableOfflineQueue:false,maxRetriesPerRequest:1});
  r.on('error',()=>{});
  await waitRedisReady(r);
  await scanDelPrefix(r,CLEAN_PATTERN);
  await r.quit();
}
beforeEach(async()=>{
  prevEnv=['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME'].map((k)=>[k,process.env[k]]);
  testDbName=await createTestDatabase();
  for(const [k,v] of Object.entries(testDbEnv(testDbName)))process.env[k]=v;
  await flushTestRedis();
});
afterEach(async()=>{
  for(const [k,v] of prevEnv){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await dropTestDatabase(testDbName);
});
// end:aigc.

test('new admin is isolated, authenticated, versioned and persistent',async()=>{
  // start:aigc.
  const dir=mkdtempSync(join(tmpdir(),'lcjy-test-'));const quotes=new Quotes(); // 注入聚合层实例：不构建真实适配器、不连网
  // end:aigc.
  let app=await createApp({dataDir:dir,quotes,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
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
    const preview=await call('/api/admin/preview',{categories:(await call('/api/admin/catalog')).data.categories});
    assert.equal(preview.status,200);
    // 2026-10-29 回归：预览必须与公开行情同口径传 baseQuotes——沪金主力/沪银主力既是基础 symbol 又是品类名，
    // 无行情时不能误报"品类间引用暂不支持"（应提示暂无数据源或不标异常）
    for(const name of ['沪金主力','沪银主力']){
      const row=preview.data.rows.find((r)=>r.name===name);
      assert.ok(row,`预览应包含 ${name}`);
      assert.ok(!String(row.reason||'').includes('品类间引用'),`${name} 不得误报品类引用，实际：${row.reason}`);
    }
    // end:aigc.
    assert.equal((await call('/api/admin/config')).data.version,initial.version);
    const save=await call('/api/admin/config',{config,expectedVersion:initial.version});assert.equal(save.status,200);
    assert.equal((await call('/api/admin/config',{config,expectedVersion:initial.version})).status,409);
    config.rows[0].sellFormula='process.exit()';
    assert.equal((await call('/api/admin/config',{config,expectedVersion:save.data.version})).status,400);
    assert.equal((await call('/api/admin/config')).data.config.rows[0].sellFormula,'【#黄金#销售价】+4');
    assert.equal((await call('/api/admin/audit')).data.entries.length,1);
    // start:aigc.
    await app.close(); app=await createApp({dataDir:dir,quotes,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}`;
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
  const app=await createApp({dataDir:dir,quotes,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const call=async(path,data)=>{const res=await fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})},body:data?JSON.stringify(data):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};};
  try{
    // 未登录全部 401
    assert.equal((await call('/api/admin/sources')).status,401);
    assert.equal((await call('/api/admin/catalog')).status,401);
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setup=await call('/api/admin/setup',{password:'StrongPassword12!',setupToken:token});csrf=setup.data.csrf;
    // 来源状态（第四批退役后）：仅 rtj/wscn/itick，带 hasSecret 标志
    const sources=(await call('/api/admin/sources')).data.sources;
    assert.ok(sources.some((s)=>s.id==='rtj'));
    // start:aigc. 2026-10-29 第四批退役：sina/tencent/yahoo/frankfurter 不再出现在来源列表
    for(const gone of ['sina','tencent','yahoo','frankfurter'])
      assert.ok(!sources.some((s)=>s.id===gone),`退役源 ${gone} 不得出现在来源状态`);
    // end:aigc.
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
    // start:aigc. baseQuotes 已异步化（MySQL 改造），直接调用 app.store 需加 await
    q.selector.configure(await app.store.baseQuotes()); // 注入的聚合层未按目录建连：先注册候选来源（等价生产 start()），否则 ingest 会被 Selector 拒绝
    // end:aigc.
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
    // start:aigc. 导出含实际生效目录（R11）：改目录后导出必须反映当前品类与基础行情
    const exported=(await call('/api/admin/export')).data;
    assert.ok(Array.isArray(exported.categories)&&exported.categories.length>0);
    assert.ok(exported.categories.some((c)=>c.name==='黄金'));
    assert.ok(exported.baseQuotes.some((b)=>b.symbol==='probe-x'),'导出需反映目录新增的基础行情');
    // end:aigc.
    // start:aigc. 数据源红绿灯（设计文档"数据源管理"）：runStatus 口径——已登记但未 attach 的源=idle
    // （注入聚合层时全部如此），并带 hasSecret 标志。2026-10-29 第四批退役：yahoo 已不在列表
    //（retired 与 enabled 区分，§9.2），改以 wscn 验证 idle 口径
    const withRun=(await call('/api/admin/sources')).data.sources;
    assert.equal(withRun.find((s)=>s.id==='wscn').runStatus,'idle','已登记未 attach 的源显示 idle');
    assert.ok(withRun.every((s)=>typeof s.runStatus==='string'&&typeof s.lastSuccessAt!=='undefined'));
    // iTick Token 后台配置：写入→hasSecret 翻转→清除；全程不回明文。
    // F04（四查）：credentialSource 区分当前实际凭据来源（db/env/null）
    const prevItickEnv=process.env.ITICK_TOKEN;delete process.env.ITICK_TOKEN;   // 排除环境兜底干扰断言
    const secretPayload='test-itick-token-abc123';
    assert.equal((await call('/api/admin/source-secret',{sourceId:'itick',secret:secretPayload})).status,200);
    let afterSet=(await call('/api/admin/sources')).data.sources.find((s)=>s.id==='itick');
    assert.equal(afterSet.hasSecret,true,'保存后密钥已配置标志必须翻转');
    assert.equal(afterSet.credentialSource,'db','库中有密钥时凭据来源为后台');
    assert.ok(!JSON.stringify(afterSet).includes(secretPayload),'任何接口都不得回显密钥明文');
    assert.equal(await app.store.getSourceSecret('itick'),secretPayload,'密文可解密回原文（供适配器装配）');
    assert.equal((await call('/api/admin/source-secret',{sourceId:'nope',secret:'x'})).status,400,'未登记数据源必须 400');
    assert.equal((await call('/api/admin/source-secret',{sourceId:'itick',secret:'bad token'})).status,400,'含空白密钥必须 400');
    assert.equal((await call('/api/admin/source-secret',{sourceId:'itick'})).status,400,'缺失 secret 字段必须 400（不得静默转清除）');
    assert.equal((await call('/api/admin/source-secret',{sourceId:'itick',secret:123})).status,400,'非字符串 secret 必须 400');
    assert.equal((await call('/api/admin/source-secret',{sourceId:'itick',secret:''})).status,200,'空串=清除密钥');
    afterSet=(await call('/api/admin/sources')).data.sources.find((s)=>s.id==='itick');
    assert.equal(afterSet.hasSecret,false,'清除后密钥已配置标志必须回落');
    assert.equal(afterSet.credentialSource,null,'清除且无环境变量时凭据来源为空');
    assert.equal(await app.store.getSourceSecret('itick'),null);
    if(prevItickEnv!==undefined)process.env.ITICK_TOKEN=prevItickEnv;
    // V5-03（五查）：登出（或改密）后的会话不得再写密钥——异步核验回归
    await call('/api/admin/logout',{});
    assert.equal((await call('/api/admin/source-secret',{sourceId:'itick',secret:'x'})).status,401,'登出后密钥写入必须 401');
    // end:aigc.
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
// end:aigc.

// start:aigc.
// R07（2026-10-28 三查）：rtj 订阅表必须同步单品种/映射停用——停用行不进订阅、
// 无 code 不生成占位（堵 resolveCatalog 补码通路）、全停用时返回空数组（零连接）
test('R07：buildRtjMap 过滤基础行情停用与映射停用，空订阅零连接',()=>{
  const mk=(symbol,bEnabled,sEnabled,code)=>({symbol,enabled:bEnabled,sources:[{sourceId:'rtj',priority:1,kind:'plain',code,enabled:sEnabled}]});
  // 正常行 + 映射停用行 + 基础行情停用行 + 无 rtj 映射行情 → 只有正常行进订阅
  const map=buildRtjMap([mk('黄金',true,true,'JZJ_au'),mk('白银',true,false,'JZJ_ag'),mk('铂金',false,true,'JZJ_pt'),{symbol:'美元指数',enabled:true,sources:[{sourceId:'wscn',priority:1,code:'DXY.OTC',enabled:true}]}]);
  assert.deepEqual(map,[{symbol:'黄金',code:'JZJ_au',kind:'plain'}]);
  // 唯一 rtj 映射停用（全局源仍启用）→ 空订阅，调用方据此不 attach（零握手/订阅/重连）
  assert.deepEqual(buildRtjMap([mk('黄金',true,false,'JZJ_au')]),[]);
  // 唯一基础行情停用 → 空订阅
  assert.deepEqual(buildRtjMap([mk('黄金',false,true,'JZJ_au')]),[]);
  // code 缺失/占位：不生成 code:null 占位（R05 补码通路），__NONE__ 同样排除
  assert.deepEqual(buildRtjMap([mk('港金',true,true,null)]),[]);
  assert.deepEqual(buildRtjMap([mk('港金',true,true,'__NONE__')]),[]);
});
// end:aigc.

// start:aigc.
// 第四批退役验收（§9/§12）：旧导入/目录保存再引用退役源必须明确拒绝；导出与来源状态无四源；
// 保留源与品类公式不受影响；重启（迁移已登记）不复活
test('第四批退役：旧导入拒绝、导出干净、品类不动、重启不复活',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lcjy-retire-'));const quotes=new Quotes();
  let app=await createApp({dataDir:dir,quotes,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const call=async(path,data)=>{const res=await fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})},body:data?JSON.stringify(data):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};};
  try{
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setup=await call('/api/admin/setup',{password:'RetireCheck12!x',setupToken:token});csrf=setup.data.csrf;
    const catalog=await call('/api/admin/catalog');
    // 旧导入再启用退役源：保存含 sina 映射的目录 → 400 明确错误（§9.3）
    const bad=structuredClone(catalog.data);
    bad.baseQuotes.push({symbol:'retired-x',name:'退役占位',unit:'',decimals:2,enabled:true,sources:[{sourceId:'sina',priority:1,kind:'sina',code:'hf_GC'}]});
    const rejected=await call('/api/admin/catalog',{...bad,expectedVersion:catalog.data.version});
    assert.equal(rejected.status,400,'退役源不得再被目录保存启用');
    assert.ok(String(rejected.data.error).includes('未在数据源中登记'),`错误信息明确（实际：${rejected.data.error}）`);
    // 导出与来源状态不含四源（§9.2 不当作可用源返回）
    const exported=await call('/api/admin/export');
    assert.ok(exported.data.sources.every((s)=>!['sina','tencent','yahoo','frankfurter'].includes(s.id)),'导出无退役源');
    // start:aigc. 2026-10-29 iTick 内盘期货接入：沪金/沪银主力由退役删除改为 itick 单源恢复
    for(const sym of ['沪金主力','沪银主力']){
      const b=exported.data.baseQuotes.find((x)=>x.symbol===sym);
      assert.ok(b,`导出应含 ${sym}（iTick 内盘期货已接入）`);
      assert.deepEqual(b.sources.map((s)=>s.sourceId),['itick'],`${sym} 仅 itick 单源`);
    }
    // end:aigc.
    // 保留源与品类公式不受影响（§9.4）
    assert.ok(exported.data.sources.some((s)=>s.id==='rtj')&&exported.data.sources.some((s)=>s.id==='wscn'));
    assert.ok(exported.data.categories.some((c)=>c.name==='港金'&&c.sellFormula.includes('37.429')),'港金公式不动');
    assert.ok(exported.data.baseQuotes.some((b)=>b.symbol==='美元指数'&&b.sources.length===2),'美元指数双源保留');
    // 重启不复活（§12）
    await app.close();
    app=await createApp({dataDir:dir,quotes:new Quotes(),redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const base2=`http://127.0.0.1:${app.server.address().port}`;
    const reSources=await (await fetch(base2+'/api/admin/sources',{headers:{cookie}})).json();
    assert.ok(reSources.sources.every((s)=>!['sina','tencent','yahoo','frankfurter'].includes(s.id)),'重启后退役源不复活');
    const reCatalog=await (await fetch(base2+'/api/admin/catalog',{headers:{cookie}})).json();
    assert.ok(['沪金主力','沪银主力'].every((sym)=>reCatalog.baseQuotes.some((b)=>b.symbol===sym)),'重启后 iTick 内盘品种保持（迁移幂等，不重复/不丢失）');
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
// end:aigc.

// start:aigc.
// 审查二轮 R6：改密并发下旧密码登录不得签发带新 epoch 的存活会话。
// 构造最坏交错——登录读取凭据快照后挂起，期间另一会话完成改密（epoch 前进），
// 再放行登录：旧密码按旧快照验证虽通过（200），但签发的会话带旧 epoch，必须立即 401
test('R6：挂起登录期间并发改密，旧密码会话必须立即失效',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lcjy-r6-'));const quotes=new Quotes();
  const app=await createApp({dataDir:dir,quotes,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
    // 会话 B：初始化后用于并发改密
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setupRes=await fetch(base+'/api/admin/setup',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'OldPassword12!x',setupToken:token})});
    assert.equal(setupRes.status,200);
    const cookieB=setupRes.headers.get('set-cookie').split(';')[0];
    const csrfB=(await setupRes.json()).csrf;
    // 挂起登录的凭据读取：快照 SELECT 完成后保持，等待改密提交再放行（复现 R6 窗口的最坏交错）
    const origGetCredential=app.store.getCredential.bind(app.store);
    let release,entered=false;const hold=new Promise(r=>release=r);
    app.store.getCredential=async()=>{const c=await origGetCredential();entered=true;await hold;return c;};
    const loginP=fetch(base+'/api/admin/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:'OldPassword12!x'})});
    // 轮询确认登录已取得旧快照并挂起（固定 sleep 在全量并行负载下不可靠）
    const until=Date.now()+5000;while(!entered&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
    assert.equal(entered,true,'登录凭据读取已挂起');
    const change=await fetch(base+'/api/admin/password',{method:'POST',headers:{origin:base,'content-type':'application/json',cookie:cookieB,'x-csrf-token':csrfB},body:JSON.stringify({oldPassword:'OldPassword12!x',newPassword:'NewPassword12!x'})});
    assert.equal(change.status,200,'会话 B 改密成功（epoch 0→1）');
    release();
    const loginRes=await loginP;
    assert.equal(loginRes.status,200,'旧密码按旧快照验证通过（窗口内签发，符合实现）');
    const cookieA=loginRes.headers.get('set-cookie').split(';')[0];
    const cfg=await fetch(base+'/api/admin/config',{headers:{cookie:cookieA}});
    assert.equal(cfg.status,401,'改密使 epoch 前进——旧密码签发的会话（旧 epoch）必须立即失效（R6）');
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
// end:aigc.

// start:aigc.
// 第二批访问管理（§3/§10）：访客行情请求计入实时统计；管理 API 需管理员会话；
// 管理查询本身不增加访客行情计数（§12 验收）；observe 下无会话放行但计数"会被拒"维度
test('访问管理：实时计数入列、管理 API 鉴权、页面查询不污染统计',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lcjy-access-'));const quotes=new Quotes();
  const app=await createApp({dataDir:dir,quotes,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const call=async(path,data)=>{const res=await fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})},body:data?JSON.stringify(data):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};};
  try{
    // 未登录：访问管理 API 必须 401
    assert.equal((await fetch(base+'/api/admin/access/ips')).status,401,'匿名不得访问访问管理');
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setup=await call('/api/admin/setup',{password:'AccessStats12!x',setupToken:token});csrf=setup.data.csrf;
    // 访客流量：observe 默认模式，无 Cookie 放行但计 noSess 维度
    for(let i=0;i<3;i++)assert.equal((await fetch(base+'/api/quotes')).status,200);
    await new Promise(r=>setTimeout(r,400)); // fire-and-forget 统计落 Redis
    const list=await call('/api/admin/access/ips');
    assert.equal(list.status,200);
    const row=list.data.rows.find((r)=>r.ip==='127.0.0.1');
    assert.ok(row,'本机 IP 出现在最近访问列表');
    assert.ok(row.cur.req>=3,'行情请求计入实时统计');
    assert.ok(row.cur.noSess>=1,'observe 无会话计入维度');
    assert.equal(list.data.mode,'observe');
    assert.ok(list.data.summary&&typeof list.data.summary.minuteUtc==='number','顶部健康摘要存在');
    // 管理查询不增加访客行情计数（§12：页面刷新不能增加访客行情计数）；跨分钟边界时跳过相等断言
    const beforeMin=list.data.summary.minuteUtc,beforeReq=row.cur.req;
    const again=await call('/api/admin/access/ips');
    if(again.data.summary.minuteUtc===beforeMin)
      assert.equal(again.data.rows.find((r)=>r.ip==='127.0.0.1').cur.req,beforeReq,'管理查询不污染统计');
    // 单 IP 趋势
    const trend=await call('/api/admin/access/ip?ip=127.0.0.1');
    assert.equal(trend.status,200);
    assert.ok(trend.data.rows.length>=1&&trend.data.rows[0].fields.req>0,'分钟趋势有数据');
    assert.equal((await call('/api/admin/access/ip')).status,400,'缺 ip 参数必须 400');
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
// end:aigc.

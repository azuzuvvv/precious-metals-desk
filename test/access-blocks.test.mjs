// start:aigc.
// 手动封禁集成测试（方案 §5，第三批，真实 MySQL+Redis）：observe 模式拦截、403+IP_BLOCKED+Retry-After、
// 回环/参数拒绝、expectedVersion 冲突、重启从 MySQL 恢复、列表红灯合并、blocked 计数入统计、解封即时恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach} from 'node:test';
import {createApp} from '../src/server.mjs';
import {Quotes} from '../src/quotes.mjs';
import {createTestDatabase,dropTestDatabase,testDbEnv,scanDelPrefix,randomTestPrefix,waitRedisReady,createTestStore,destroyTestStore} from './helpers.mjs';
import {createAccessBlocks,normalizeBlockIp} from '../src/access-blocks.mjs';
import {canonicalIp} from '../src/rate-limit.mjs';
import Redis from 'ioredis';

let testDbName,prevEnv;
const REDIS_TEST_DB=11;
const TEST_PREFIX=randomTestPrefix();
const CLEAN=`${TEST_PREFIX}*`;
async function flushTestRedis(){
  const r=new Redis({host:process.env.REDIS_HOST||'127.0.0.1',port:Number(process.env.REDIS_PORT||6379),db:REDIS_TEST_DB,enableOfflineQueue:false,maxRetriesPerRequest:1});
  r.on('error',()=>{});
  await waitRedisReady(r);
  await scanDelPrefix(r,CLEAN);
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
const settle=()=>new Promise((r)=>setTimeout(r,300));

test('封禁全链路：observe 也拦截、403+Retry-After、解封即时恢复、重启从 MySQL 加载',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lcjy-block-'));
  // trustProxy+专用头模拟外部 IP（本机回环被拒绝封禁，正好作为反例）
  const protect={mode:'observe',trustProxy:true,ipHeader:'x-real-ip'};
  let app=await createApp({dataDir:dir,quotes:new Quotes(),protect,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});
  await new Promise((r)=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const call=async(path,data,headers={})=>{const res=await fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...headers},body:data?JSON.stringify(data):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return res;};
  const q=(ip)=>fetch(base+'/api/quotes',{headers:ip?{'x-real-ip':ip}:{}});

  try{
    // 参数校验（§5）：回环拒绝、无效 IP、无原因、时长越界
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setup=await call('/api/admin/setup',{password:'BlockAdmin12!x',setupToken:token});csrf=(await setup.json()).csrf;
    assert.equal((await call('/api/admin/access/block',{ip:'127.0.0.1',minutes:60,reason:'误封测试'})).status,400,'回环必须拒绝');
    assert.equal((await call('/api/admin/access/block',{ip:'not-an-ip',minutes:60,reason:'x'})).status,400);
    assert.equal((await call('/api/admin/access/block',{ip:'203.0.113.7',minutes:60})).status,400,'原因必填');
    assert.equal((await call('/api/admin/access/block',{ip:'203.0.113.7',minutes:0,reason:'x'})).status,400);
    assert.equal((await call('/api/admin/access/block',{ip:'203.0.113.7',minutes:10081,reason:'x'})).status,400,'最长 7 天');

    // 封禁前：目标 IP 可看盘（observe 无会话放行）
    assert.equal((await q('203.0.113.7')).status,200);
    // 封禁（observe 模式同样生效 §5）
    const b=await call('/api/admin/access/block',{ip:'203.0.113.7',minutes:60,reason:'测试封禁'});
    assert.equal(b.status,200);
    const bJson=await b.json();
    assert.ok(bJson.untilMs>Date.now(),'返回到期时间');
    // 被封 IP：行情 403 + 稳定业务码 + Retry-After；会话发放同样拦截
    const denied=await q('203.0.113.7');
    assert.equal(denied.status,403);
    assert.equal((await denied.json()).error,'IP_BLOCKED');
    assert.equal(denied.headers.get('retry-after'),'30','B-02：封禁 403 统一 30 秒探测间隔，非剩余时长');
    const sessDenied=await fetch(base+'/api/viewer/session',{method:'POST',headers:{origin:base,'content-type':'application/json','x-real-ip':'203.0.113.7'},body:'{}'});
    assert.equal(sessDenied.status,403,'会话发放同样拦截');
    assert.equal(sessDenied.headers.get('retry-after'),'30','B-02：初始化封禁也按 30 秒探测，提前解封后快速恢复');
    // 其他 IP 不受影响；后台管理接口不受封禁影响（§5 范围仅公开行情与会话）
    assert.equal((await q('198.51.100.9')).status,200);
    assert.equal((await call('/api/admin/access/ips')).status,200);
    // 列表红灯合并：blockedCount、红灯行、行版本（解封用）
    const list=await (await call('/api/admin/access/ips')).json();
    assert.equal(list.summary.blockedCount,1);
    const red=list.rows.find((r)=>r.ip==='203.0.113.7');
    assert.ok(red&&red.status==='red'&&red.blocked===true,'封禁行红灯');
    assert.ok(Number.isInteger(red.blockedRowVersion));
    // blocked 拒绝计入统计（§6）
    await settle();
    const denied2=await q('203.0.113.7');await denied2.json();
    await settle();
    const trend=await (await call('/api/admin/access/ip?ip=203.0.113.7')).json();
    assert.ok(trend.rows.some((r)=>r.fields.blocked>=1),'封禁拒绝计入分钟统计');

    // expectedVersion 冲突：用旧版本解封 → 409（§5 防互相覆盖）
    assert.equal((await call('/api/admin/access/unblock',{ip:'203.0.113.7',reason:'过期的版本',expectedVersion:red.blockedRowVersion+5})).status,409);
    // 正确版本解封 → 立即恢复（无需重启 §5）
    assert.equal((await call('/api/admin/access/unblock',{ip:'203.0.113.7',reason:'测试完成',expectedVersion:red.blockedRowVersion})).status,200);
    assert.equal((await q('203.0.113.7')).status,200,'解封后立即恢复');

    // 重启恢复：重新封禁 → close → 重新 createApp（同库同目录）→ 封禁仍生效（MySQL 事实来源）
    const again=await call('/api/admin/access/block',{ip:'203.0.113.7',minutes:60,reason:'重启前封禁'});
    assert.equal(again.status,200);
    await app.close();
    app=await createApp({dataDir:dir,quotes:new Quotes(),protect,redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});
    await new Promise((r)=>app.server.listen(0,'127.0.0.1',r));
    const base2=`http://127.0.0.1:${app.server.address().port}`;
    const after=await fetch(base2+'/api/quotes',{headers:{'x-real-ip':'203.0.113.7'}});
    assert.equal(after.status,403,'重启后从 MySQL 加载封禁仍生效');
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('B-05：统计与封禁独立分页——真实访问行不丢失、无访问封禁在 blocks 列表、当前页置红',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lcjy-b5-'));
  const app=await createApp({dataDir:dir,quotes:new Quotes(),protect:{mode:'observe',trustProxy:true},redisOptions:{db:REDIS_TEST_DB},keyPrefix:TEST_PREFIX});
  await new Promise((r)=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const call=async(path,data)=>{const res=await fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})},body:data?JSON.stringify(data):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return res;};
  try{
    const token=readFileSync(join(dir,'setup-token.txt'),'utf8').trim();
    const setup=await call('/api/admin/setup',{password:'PagingAdmin12!x',setupToken:token});csrf=(await setup.json()).csrf;
    // 两个有访问的 IP + 一个有访问的封禁 + 一个无访问的封禁
    await fetch(base+'/api/quotes',{headers:{'x-real-ip':'203.0.113.8'}});
    await fetch(base+'/api/quotes',{headers:{'x-real-ip':'203.0.113.9'}});
    assert.equal((await call('/api/admin/access/block',{ip:'203.0.113.8',minutes:60,reason:'有访问'})).status,200);
    assert.equal((await call('/api/admin/access/block',{ip:'198.51.100.99',minutes:60,reason:'无访问'})).status,200);
    await settle();
    // /ips（size=1 分页）：纯统计分页——两页分别恰好 1 行真实访问，不插入封禁零行；被访封禁行置红
    const p1=await (await call('/api/admin/access/ips?page=1&size=1')).json();
    assert.equal(p1.rows.length,1,'每页恰好 1 行（B-05a：不再插零挤占）');
    const p2=await (await call('/api/admin/access/ips?page=2&size=1')).json();
    assert.equal(p2.rows.length,1,'第二页仍有真实访问行，不因封禁插入丢失');
    const ips=[...p1.rows,...p2.rows].map((r)=>r.ip).sort();
    assert.deepEqual(ips,['203.0.113.8','203.0.113.9'],'两条访问记录各出现一次，无重复无丢失');
    assert.equal(p1.total,2,'total 只含统计 IP，不含封禁合成行');
    const blockedRow=[...p1.rows,...p2.rows].find((r)=>r.ip==='203.0.113.8');
    assert.equal(blockedRow.status,'red','有访问且被封的行置红');
    // /blocks 独立分页：含无访问封禁（lastSeen=0）与有访问封禁（lastSeen>0）
    const bl=await (await call('/api/admin/access/blocks?page=1&size=10')).json();
    assert.equal(bl.total,2);
    const noVisit=bl.rows.find((r)=>r.ip==='198.51.100.99');
    assert.ok(noVisit,'无访问封禁出现在独立封禁列表');
    assert.equal(noVisit.lastSeen,0);
    const withVisit=bl.rows.find((r)=>r.ip==='203.0.113.8');
    assert.ok(withVisit&&withVisit.lastSeen>0,'有访问封禁带最近访问时间');
    assert.ok(Number.isInteger(withVisit.blockedRowVersion),'携带行版本供解封');
    assert.equal(bl.rows.length,2);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('B-01/B-03（模块级）：交错响应不删新封禁、容量原子、到期清扫与重封',async()=>{
  // 门控假 Store：SQL 语义按版本推演，可挂起解封响应复现交错（内存同步逻辑为测点）
  let relGate=Promise.resolve();
  const fakeStore={
    async loadActiveBlocks(){return [];},
    async saveBlock({ip,expectedVersion}){
      const v=expectedVersion>0?expectedVersion+1:1;
      return {ok:true,version:v};
    },
    async releaseBlock({ip,expectedVersion}){await relGate;return {ok:true,version:expectedVersion+1};},
  };
  // B-01：解封响应挂起期间重新封禁成功 → 放行旧解封不得删掉新封禁
  const blk=createAccessBlocks({store:fakeStore,now:Date.now});
  await blk.load();
  assert.equal((await blk.block({ip:'203.0.113.10',minutes:60,reason:'初始'})).version,1);
  let releaseRel;
  relGate=new Promise((r)=>releaseRel=r);
  const p1=blk.unblock({ip:'203.0.113.10',reason:'交错解封',expectedVersion:1}); // SQL 提交（v2）后响应挂起
  const p2=blk.block({ip:'203.0.113.10',minutes:60,reason:'重新封禁',expectedVersion:0}); // 排队；行已 released → v3
  await new Promise((r)=>setTimeout(r,50));
  releaseRel(); // 放行旧解封响应（其内存删除带版本条件，不得删 v3）
  await Promise.all([p1,p2]);
  assert.ok(blk.check('203.0.113.10'),'旧解封响应不得删除后来的有效封禁（B-01）');
  // B-01：容量原子——串行临界区内第二个不同 IP 被拒
  const cap=createAccessBlocks({store:fakeStore,now:Date.now,maxBlocks:1});
  await cap.load();
  assert.equal((await cap.block({ip:'203.0.113.11',minutes:60,reason:'A'})).ok,true);
  assert.equal((await cap.block({ip:'203.0.113.12',minutes:60,reason:'B'})).code,'CAPACITY','并发容量判定原子化');
  // B-03：到期清扫（size/activeList 不占容量、不显红灯）+ 已到期未解封行允许 expectedVersion=0 重封
  let t=Date.now();
  const expStore={
    rows:[],
    async loadActiveBlocks(){return this.rows;},
    async saveBlock({ip,untilMs,reason,expectedVersion}){
      const row=this.rows.find((r)=>r.ip===ip);
      const expired=row&&Number(row.until_ms)<=t; // 与注入时钟同口径（产品代码用真实 Date.now 与生成基准一致）
      if(row&&row.version!==expectedVersion&&!(expectedVersion===0&&(row.released===1||expired)))return {ok:false,code:'VERSION'};
      if(row){row.until_ms=untilMs;row.reason=reason;row.version++;}
      else this.rows.push({ip,until_ms:untilMs,reason,version:1});
      return {ok:true,version:row?row.version:1};
    },
    async releaseBlock({ip,expectedVersion}){const row=this.rows.find((r)=>r.ip===ip);if(!row||row.version!==expectedVersion)return {ok:false,code:'VERSION'};row.released=1;row.version++;return {ok:true,version:row.version};},
  };
  const life=createAccessBlocks({store:expStore,now:()=>t,maxBlocks:1});
  await life.load();
  assert.equal((await life.block({ip:'203.0.113.13',minutes:5,reason:'将到期'})).ok,true);
  t+=6*60000; // 越过到期
  assert.equal(life.size,0,'到期后不占容量（B-03）');
  assert.equal(life.activeList().size,0,'到期后列表不再红灯');
  assert.ok(life.check('203.0.113.13')===null,'到期即失效');
  // 重封已到期未解封的行：expectedVersion=0 放行（此前会 VERSION 拒绝）
  const re=await life.block({ip:'203.0.113.13',minutes:5,reason:'到期重封'});
  assert.equal(re.ok,true,'已到期未解封的行允许免版本重封（B-03）');
  assert.ok(life.check('203.0.113.13'),'重封后恢复拦截');
});

test('B-04（单元）：canonicalIp 等价归一与封禁输入校验',()=>{
  // 等价 IPv6 写法 → 同一键
  assert.equal(canonicalIp('2001:0db8:0000:0000:0000:0000:0000:0001'),'2001:db8::1');
  assert.equal(canonicalIp('2001:db8:0:0:0:0:0:1'),'2001:db8::1');
  assert.equal(canonicalIp('2001:DB8::1'),'2001:db8::1');
  // IPv4-mapped → IPv4 文本（与限流/统计键同一空间）
  assert.equal(canonicalIp('::ffff:203.0.113.7'),'203.0.113.7');
  assert.equal(canonicalIp('::FFFF:203.0.113.7'),'203.0.113.7');
  // 回环/未指定：任意等价写法都能识别并拒绝
  assert.equal(canonicalIp('::'),'::');
  assert.equal(canonicalIp('0:0:0:0:0:0:0:1'),'::1');
  const loop4=normalizeBlockIp('::ffff:127.0.0.1');
  assert.equal(loop4.ok,false,'mapped 回环拒绝');
  assert.equal(normalizeBlockIp('::').ok,false,'未指定地址拒绝');
  assert.equal(normalizeBlockIp('0:0:0:0:0:0:0:1').ok,false,'完整展开回环拒绝');
  // 等价写法封禁后可拦实际请求键
  const n=normalizeBlockIp('2001:0db8:0000:0000:0000:0000:0000:0001');
  assert.equal(n.ok,true);
  assert.equal(n.ip,'2001:db8::1','封禁键与请求键一致（B-04）');
  assert.equal(canonicalIp('not-an-ip'),null);
});
// end:aigc.
// start:aigc.
// 访问保护 HTTP 集成测试（方案 §9/§15.5 验收证据）：三态模式（off/observe/enforce）、
// 访客会话发放与幂等、会话/IP/发放三类限流命中 429、快照缓存去重。依赖本地 MySQL 测试库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach} from 'node:test';
import {createApp} from '../src/server.mjs';
import {Quotes} from '../src/quotes.mjs';
import {createTestDatabase,dropTestDatabase,testDbEnv,scanDelPrefix,randomTestPrefix,waitRedisReady} from './helpers.mjs';
import Redis from 'ioredis';

let testDbName,prevEnv;
beforeEach(async()=>{
  prevEnv=['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME'].map((k)=>[k,process.env[k]]);
  testDbName=await createTestDatabase();
  for(const [k,v] of Object.entries(testDbEnv(testDbName)))process.env[k]=v;
});
afterEach(async()=>{
  for(const [k,v] of prevEnv){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await dropTestDatabase(testDbName);
});

// Redis 隔离测试库 + 随机测试命名空间（审查 R2 残留）：清理只删本次随机前缀（生产前缀不触碰），
// ready 等待带超时，避免连接失败时挂起
const REDIS_TEST_DB = 14;
const TEST_PREFIX = randomTestPrefix();
const CLEAN_PATTERN = `${TEST_PREFIX}*`;
async function flushTestRedis(){
  const r = new Redis({host:process.env.REDIS_HOST||'127.0.0.1',port:Number(process.env.REDIS_PORT||6379),db:REDIS_TEST_DB,enableOfflineQueue:false,maxRetriesPerRequest:1});
  r.on('error', () => {});
  await waitRedisReady(r);
  await scanDelPrefix(r, CLEAN_PATTERN);
  await r.quit();
}
// 启动一个隔离 app（内存聚合层不连网），返回 base 与便捷请求助手。
// redisOptions 可覆盖端口指向不可达地址，模拟真实 Redis 故障（§17.1 降级验收）
async function startApp(protect,redisOptions){
  const dir=mkdtempSync(join(tmpdir(),'lcjy-protect-'));
  await flushTestRedis();
  const app=await createApp({dataDir:dir,quotes:new Quotes(),protect,redisOptions:{db:REDIS_TEST_DB,...(redisOptions||{})},keyPrefix:TEST_PREFIX});
  await new Promise((r)=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const cleanup=async()=>{await app.close();rmSync(dir,{recursive:true,force:true});};
  return {app,base,cleanup};
}
// 等待连接失败触发降级（事件驱动建降级，ioredis 重试耗尽发 'end'）
async function untilDegraded(gate,timeoutMs=6000){
  const start=Date.now();
  while(!gate.degraded&&Date.now()-start<timeoutMs)await new Promise((r)=>setTimeout(r,50));
  assert.equal(gate.degraded,true,'Redis 故障应触发降级');
}
// 请求助手：GET/POST，跟踪并自动回传 Set-Cookie（访客会话）
async function viewerPost(base,cookie){
  const headers={'content-type':'application/json',origin:base}; // POST 需同源 Origin（server 全局同站校验）
  if(cookie)headers.cookie=cookie;
  const res=await fetch(base+'/api/viewer/session',{method:'POST',headers,body:'{}'});
  const sc=res.headers.get('set-cookie');
  return {status:res.status,body:await res.json(),cookie:sc?sc.split(';')[0]:null};
}
async function quoteGet(base,cookie){
  const headers={};
  if(cookie)headers.cookie=cookie;
  const res=await fetch(base+'/api/quotes',{headers});
  return {status:res.status,body:await res.json().catch(()=>null)};
}

test('off 模式：无会话也可读行情，不计数会被拒',async()=>{
  const {app,base,cleanup}=await startApp({mode:'off'});
  try{
    const r=await quoteGet(base,null);
    assert.equal(r.status,200);
    assert.equal(app.protect.counters.noSessionWouldDeny,0);
    assert.equal(app.protect.counters.noSessionDenied,0);
  }finally{await cleanup();}
});

test('observe 模式：无会话放行但计数"会被拒"',async()=>{
  const {app,base,cleanup}=await startApp({mode:'observe'});
  try{
    const r=await quoteGet(base,null);
    assert.equal(r.status,200);
    assert.equal(app.protect.counters.noSessionWouldDeny,1);
    assert.equal(app.protect.counters.noSessionDenied,0);
  }finally{await cleanup();}
});

test('enforce 模式：无会话 401，发会话后 200',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce'});
  try{
    assert.equal((await quoteGet(base,null)).status,401);
    assert.equal(app.protect.counters.noSessionDenied,1);
    const issued=await viewerPost(base,null);
    assert.equal(issued.status,200);
    assert.match(issued.cookie,/^lcjy_viewer=[0-9a-f]{64}$/);
    assert.equal((await quoteGet(base,issued.cookie)).status,200);
  }finally{await cleanup();}
});

test('访客会话幂等：带有效 Cookie 重复发放复用不生成新会话',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce'});
  try{
    const first=await viewerPost(base,null);
    assert.equal(first.body.reused,false);
    const second=await viewerPost(base,first.cookie);
    assert.equal(second.status,200);
    assert.equal(second.body.reused,true);
    assert.equal(await app.protect.viewerSessions.count(),1,'重复发放必须复用同一会话');
  }finally{await cleanup();}
});

test('会话限流：burst 耗尽后 429 并返回 Retry-After',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce',sessionQuote:{perMinute:120,burst:2},ipQuote:{perMinute:120000,burst:1000},sessionIssue:{perMinute:120000,burst:1000}});
  try{
    const issued=await viewerPost(base,null);
    assert.equal((await quoteGet(base,issued.cookie)).status,200);
    assert.equal((await quoteGet(base,issued.cookie)).status,200);
    const third=await quoteGet(base,issued.cookie);
    assert.equal(third.status,429);
    assert.ok(app.protect.counters.sessionLimitDenied>=1);
  }finally{await cleanup();}
});

test('IP 限流：会话额度宽松但 IP burst 耗尽后 429',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce',sessionQuote:{perMinute:120000,burst:1000},ipQuote:{perMinute:120,burst:2},sessionIssue:{perMinute:120000,burst:1000}});
  try{
    const issued=await viewerPost(base,null);
    assert.equal((await quoteGet(base,issued.cookie)).status,200);
    assert.equal((await quoteGet(base,issued.cookie)).status,200);
    assert.equal((await quoteGet(base,issued.cookie)).status,429);
    assert.ok(app.protect.counters.ipLimitDenied>=1);
  }finally{await cleanup();}
});

test('发放限流：新 IP 反复新建会话 burst 耗尽后 429',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce',sessionQuote:{perMinute:120000,burst:1000},ipQuote:{perMinute:120000,burst:1000},sessionIssue:{perMinute:120,burst:2}});
  try{
    // 前 2 次新建消耗突发（无 Cookie 每次都是新会话）
    assert.equal((await viewerPost(base,null)).status,200);
    assert.equal((await viewerPost(base,null)).status,200);
    const third=await viewerPost(base,null);
    assert.equal(third.status,429);
    assert.ok(app.protect.counters.issueDenied>=1);
  }finally{await cleanup();}
});

test('快照缓存：TTL 内多次请求只重建一次',async()=>{
  const {app,base,cleanup}=await startApp({mode:'off',cacheTtlMs:60000}); // 大 TTL 保证命中
  try{
    await quoteGet(base,null);
    await quoteGet(base,null);
    await quoteGet(base,null);
    assert.equal(app.protect.snapshotCache.stats.rebuilds,1,'TTL 内并发/连续请求共享缓存，只重建一次');
    assert.ok(app.protect.snapshotCache.stats.hits>=2);
  }finally{await cleanup();}
});

test('匿名访客会话不能访问后台接口',async()=>{
  const {base,cleanup}=await startApp({mode:'enforce'});
  try{
    const issued=await viewerPost(base,null);
    const res=await fetch(base+'/api/admin/config',{headers:{cookie:issued.cookie}});
    assert.equal(res.status,401,'访客 Cookie 不得进入 /api/admin/*');
  }finally{await cleanup();}
});

// start:aigc. 第 17 节降级验收：Redis 故障时看盘继续、session 返回 degraded、管理接口保持拒绝。
// 用不可达端口（6399 无服务）模拟真实故障——连接失败重试耗尽发 'end' 事件建立降级，
// 而非用 disconnect()（本地 Redis 仍在，probe 会立即重连恢复，无法复现持续降级）。
test('enforce 模式 Redis 故障：看盘进入降级继续返回行情',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce'},{port:6399});
  try{
    await untilDegraded(app.protect.accessGate);
    const r=await quoteGet(base,null);
    assert.equal(r.status,200,'§17.1 降级后看盘继续返回最新行情');
  }finally{await cleanup();}
});

test('Redis 故障：session 返回 degraded（前端启动可用）',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce'},{port:6399});
  try{
    await untilDegraded(app.protect.accessGate);
    const r=await viewerPost(base,null);
    assert.equal(r.status,200);
    assert.equal(r.body.ok,true);
    assert.equal(r.body.degraded,true,'§17.1.4 降级返回 {ok:true,degraded:true}');
  }finally{await cleanup();}
});

test('Redis 故障：管理接口不因降级开放',async()=>{
  const {app,base,cleanup}=await startApp({mode:'enforce'},{port:6399});
  try{
    await untilDegraded(app.protect.accessGate);
    const res=await fetch(base+'/api/admin/config',{headers:{cookie:'lcjy_session=deadbeef'}});
    assert.equal(res.status,401,'§17.1.6 降级期间不授予新管理权限');
  }finally{await cleanup();}
});
// end:aigc.

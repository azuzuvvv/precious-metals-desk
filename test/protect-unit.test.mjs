// start:aigc.
// 访问保护纯单元测试（无数据库、无网络）：可信 IP 提取、配置校验、快照缓存单航次/代次保护/失败语义。
// 令牌桶与访客会话已迁 Redis（方案 §14.1），其语义测试见 redis.test.mjs（真实 Redis 集成）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {clientIp,loadProtectConfig} from '../src/rate-limit.mjs';
import {createSnapshotCache} from '../src/snapshot-cache.mjs';

test('clientIp：仅回环连接 + 信任开关才采信专用头，伪造 XFF 一律无效',()=>{
  const req=(remote,headers={})=>({socket:{remoteAddress:remote},headers});
  // 未启用信任：任何头都不改判（外部伪造无效）
  assert.equal(clientIp(req('127.0.0.1',{'x-real-ip':'1.2.3.4'})),'127.0.0.1');
  assert.equal(clientIp(req('8.8.8.8',{'x-real-ip':'1.2.3.4','x-forwarded-for':'9.9.9.9'})),'8.8.8.8');
  // 启用信任：回环连接采信合法头；非回环连接不采信；非法头回落
  const trust={trustProxy:true};
  assert.equal(clientIp(req('127.0.0.1',{'x-real-ip':'1.2.3.4'}),trust),'1.2.3.4');
  assert.equal(clientIp(req('::ffff:127.0.0.1',{'x-real-ip':'1.2.3.4'}),trust),'1.2.3.4');
  assert.equal(clientIp(req('::ffff:8.8.8.8',{'x-real-ip':'1.2.3.4'}),trust),'8.8.8.8');
  assert.equal(clientIp(req('127.0.0.1',{'x-real-ip':'not-an-ip'}),trust),'127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1',{}),trust),'127.0.0.1');
});

test('loadProtectConfig：默认值、合法覆盖与非法值启动即报错',()=>{
  const def=loadProtectConfig({});
  assert.equal(def.mode,'observe');
  assert.equal(def.trustProxy,false);
  assert.equal(def.sessionQuote.perMinute,240);
  assert.equal(def.ipQuote.perMinute,600);
  assert.equal(def.sessionIssue.perMinute,30);
  assert.equal(def.cacheTtlMs,1000);
  const custom=loadProtectConfig({PROTECT_MODE:'enforce',TRUST_PROXY:'1',QUOTE_IP_RATE_PER_MIN:'2400'});
  assert.equal(custom.mode,'enforce');
  assert.equal(custom.trustProxy,true);
  assert.equal(custom.ipQuote.perMinute,2400);
  assert.throws(()=>loadProtectConfig({PROTECT_MODE:'strict'}));
  assert.throws(()=>loadProtectConfig({QUOTE_SESSION_RATE_PER_MIN:'0'}));
  assert.throws(()=>loadProtectConfig({SNAPSHOT_CACHE_TTL_MS:'100'}));
  // AP-04 边界：零突发容量会让令牌桶永远无法积攒令牌，全部拒绝，必须在配置装载期拒绝
  assert.throws(()=>loadProtectConfig({QUOTE_SESSION_BURST:'0'}));
  assert.throws(()=>loadProtectConfig({QUOTE_IP_BURST:'0'}));
  assert.throws(()=>loadProtectConfig({SESSION_ISSUE_BURST:'0'}));
});

test('快照缓存：TTL 复用、单航次重建、并发共享同一 Promise',async()=>{
  let t=0,builds=0;
  const cache=createSnapshotCache({ttlMs:1000,now:()=>t,build:async()=>{builds++;return Buffer.from(`v${builds}`);}});
  const [x,y]=await Promise.all([cache.get(),cache.get()]); // 并发到来只有一次 build
  assert.equal(builds,1);
  assert.equal(x.toString(),y.toString());
  t+=500;
  await cache.get(); // TTL 内直接命中
  assert.equal(builds,1);
  t+=600; // 越过 TTL
  await cache.get();
  assert.equal(builds,2);
});

test('快照缓存：代次保护——重建在途时失效，旧结果可用但不回填缓存',async()=>{
  let t=0,builds=0,resolveBuild;
  const cache=createSnapshotCache({ttlMs:1000,now:()=>t,build:()=>{
    builds++;
    if(builds===1)return new Promise((r)=>{resolveBuild=r;}); // 首次 build 挂起，供测试注入失效时序
    return Promise.resolve(Buffer.from('new')); // 后续 build 立即返回
  }});
  const first=cache.get();
  await Promise.resolve(); // 等 build 实际启动
  cache.invalidate(); // 重建在途时发生配置保存
  resolveBuild(Buffer.from('old'));
  assert.equal((await first).toString(),'old'); // 已等待的请求拿到值
  assert.equal(builds,1);
  const second=await cache.get(); // 失效后必须重建，旧结果未回填
  assert.equal(builds,2);
  assert.equal(second.toString(),'new');
});

test('AP-03：失效后新请求不共享旧代次在途结果，等旧任务结束再重建',async()=>{
  let t=0,builds=0,resolveBuild;
  const cache=createSnapshotCache({ttlMs:1000,now:()=>t,build:()=>{
    builds++;
    if(builds===1)return new Promise((r)=>{resolveBuild=r;}); // 首次 build 挂起（旧代次在途）
    return Promise.resolve(Buffer.from('new'));
  }});
  const first=cache.get(); // 失效前发起，进入旧代次在途
  await Promise.resolve(); // 等 build 实际启动
  cache.invalidate(); // 失效（generation +1）
  const second=cache.get(); // 失效后新请求：此刻旧任务仍在途，不得共享旧结果
  resolveBuild(Buffer.from('old')); // 放行旧任务
  assert.equal((await first).toString(),'old','失效前已等待者拿到旧值');
  assert.equal((await second).toString(),'new','失效后新等待者必须拿到新代次重建结果');
  assert.equal(builds,2);
});

test('快照缓存：重建失败上抛且不回填旧值，下次 get 重试',async()=>{
  let t=0,fail=true,builds=0;
  const cache=createSnapshotCache({ttlMs:1000,now:()=>t,build:async()=>{builds++;if(fail)throw new Error('db down');return Buffer.from('ok');}});
  await assert.rejects(()=>cache.get());
  fail=false;
  assert.equal((await cache.get()).toString(),'ok'); // 失败后可恢复，不卡死
  assert.equal(builds,2);
});
// end:aigc.

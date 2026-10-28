// start:aigc.
// 访问保护纯单元测试（无数据库、无网络）：令牌桶语义、可信 IP 提取、配置校验、
// 快照缓存单航次/代次保护/失败语义、访客会话生命周期（方案 §15.5 验收证据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTokenBucketLimiter,clientIp,loadProtectConfig} from '../src/rate-limit.mjs';
import {createViewerSessions} from '../src/viewer-session.mjs';
import {createSnapshotCache} from '../src/snapshot-cache.mjs';

test('令牌桶：持续速率 + 突发余量，超限返回退避秒数',()=>{
  let t=0;
  const limiter=createTokenBucketLimiter({perMinute:60000,burst:2,now:()=>t}); // 1/ms 便于测试
  assert.deepEqual(limiter.check('a'),{ok:true,retryAfterSec:0});
  assert.deepEqual(limiter.check('a'),{ok:true,retryAfterSec:0});
  const denied=limiter.check('a');
  assert.equal(denied.ok,false);
  assert.ok(denied.retryAfterSec>=1);
  // 回填：前进 2ms 后可再次消费
  t+=2;
  assert.equal(limiter.check('a').ok,true);
  // 不同 key 独立满桶
  assert.equal(limiter.check('b').ok,true);
});

test('AP-04：容量满时对未记录 key 返回可重试拒绝并计数，不放行也不驱逐已有桶',()=>{
  let t=0;
  const limiter=createTokenBucketLimiter({perMinute:1,burst:1,maxKeys:1,now:()=>t}); // 容量只有 1 个 key
  assert.equal(limiter.check('a').ok,true); // 填入唯一桶
  // 未记录 key b：容量满且 a 未过期（清扫不释放），必须拒绝而非无限放行
  const denied=limiter.check('b');
  assert.equal(denied.ok,false);
  assert.ok(denied.retryAfterSec>=1);
  assert.equal(limiter.overflow,1);
  // 已有 key a 的独立判定不受影响（AP-04 要求保留已存在桶）
  assert.equal(limiter.check('a').ok,false); // a 桶已空，正常限流（不是溢出）
  // 容量上限有界：不会因拒绝而无限增长
  assert.equal(limiter.size,1);
});

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

test('访客会话：空闲过期与容量上限',()=>{
  let t=1000000;
  const sessions=createViewerSessions({idleMs:1000,maxSessions:2,now:()=>t});
  const a=sessions.issue(),b=sessions.issue();
  assert.equal(typeof a,'string','64 位 hex 会话标识');
  // 容量满：先清扫过期仍满则拒绝发放（不驱逐活跃会话）
  assert.equal(sessions.issue(),null);
  // 空闲过期：b 在中途刷新存活，a 超时失效并释放容量
  t+=501;sessions.touch(sessions.get(b));
  t+=501; // a 已 1002ms 未活动
  assert.equal(sessions.get(a),null);
  assert.ok(sessions.issue(),'过期清扫释放容量后可再次发放');
});

test('访客会话：Cookie 剩余不足一天时 touch 触发续写',()=>{
  let t=0;
  const sessions=createViewerSessions({idleMs:10_000_000,cookieMaxAgeSec:90000,now:()=>t}); // Cookie 寿命 25 小时
  const id=sessions.issue();
  assert.equal(sessions.touch(sessions.get(id)),false); // 剩余 90000s > 1 天：不续写
  t+=4_000_000; // 前进约 66 分钟，剩余约 86000s < 1 天
  assert.equal(sessions.touch(sessions.get(id)),true); // 触发续写并顺延到期
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

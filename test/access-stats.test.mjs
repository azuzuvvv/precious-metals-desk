// start:aigc.
// 访问统计集成测试（方案 §6/§7，第二批）：真实 Redis（独立 DB + 随机命名空间）+ 真实 MySQL 隔离库。
// 覆盖：Lua 原子计数口径（结果互斥/维度交叉/发放独立）、IP 容量上限转"其他"桶、会话去重截断、
// 黄灯分类、落库绝对值幂等（GREATEST 防回退 + LEAST 缺口保持）、水位事务推进。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRedisClient,createScriptRunner,createBatchRunner,loadRedisConfig} from '../src/redis-client.mjs';
import {createAccessStats,loadAccessStatsConfig,classifyStatus} from '../src/access-stats.mjs';
import {createAccessFlusher} from '../src/access-flush.mjs';
import {createTestStore,destroyTestStore,scanDelPrefix,randomTestPrefix,waitRedisReady} from './helpers.mjs';

const TEST_DB=12;
const TEST_PREFIX=randomTestPrefix();
const CLEAN=`${TEST_PREFIX}*`;
let redis,run,batch,store;
test.before(async()=>{
  redis=createRedisClient({...loadRedisConfig(),db:TEST_DB,connectTimeoutMs:3000,commandTimeoutMs:3000});
  redis.on('error',()=>{});
  await waitRedisReady(redis);
  run=createScriptRunner(redis);
  batch=createBatchRunner(redis,{batchLimit:64}); // 小分片验证分批路径
  store=await createTestStore();
});
test.after(async()=>{redis.disconnect();await destroyTestStore(store);});
test.beforeEach(async()=>{await scanDelPrefix(redis,CLEAN);});
// fire-and-forget 统计写入的等待（脚本经命令队列真实落 Redis）
const settle=()=>new Promise((r)=>setTimeout(r,250));

test('行情/发放计数：结果互斥、维度交叉、wAny 并集口径、发放独立、全局与索引、TTL',async()=>{
  const t0=Date.now(); // 注入固定时钟：记录与断言读同一分钟桶，避免跨分钟边界抖动
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  s.recordQuote('1.2.3.4',{ok:1,noSess:true,session:'a'.repeat(64)});
  s.recordQuote('1.2.3.4',{ok:1,wIp:true,wAny:true});
  s.recordQuote('1.2.3.4',{dIp:true,wAny:true});
  s.recordIssue('1.2.3.4',{issue:1});
  await settle();
  const m=s.minuteOf(t0);
  const f=await s.minuteHash(m,'1.2.3.4');
  assert.equal(f.req,'3','req=允许+拒绝的行情请求总数');
  assert.equal(f.ok,'2');
  assert.equal(f.noSess,'1','维度与结果可交叉');
  assert.equal(f.wIp,'1');
  assert.equal(f.wAny,'2','每请求 0/1 的应限流并集（S2-06：不叠维度）');
  assert.equal(f.dIp,'1');
  assert.equal(f.e429,'1','实际拒绝计入互斥结果 e429');
  assert.equal(f.issue,'1','发放单独计数');
  const all=await s.minuteHash(m,'__all__');
  assert.equal(all.req,'3');assert.equal(all.issue,'1','全局桶同步累计');
  assert.notEqual(await redis.zscore(s.ipsKey,'1.2.3.4'),null,'最近 IP 索引已登记');
  assert.ok((await redis.zcard(s.miKey(m)))>=2,'分钟 IP 索引含本 IP 与 __all__');
  assert.ok(await redis.pttl(s.minuteHashKey(m,'1.2.3.4'))>0,'分钟桶必须有 TTL（§6 48h）');
});

test('容量上限：超出 maxIps 的新 IP 计入"其他"聚合，不建独立记录',async()=>{
  const t0=Date.now(); // 固定时钟消除跨分钟抖动
  const s=createAccessStats({redis,run,keyPrefix:TEST_PREFIX,cfg:{...loadAccessStatsConfig({}),maxIps:2},now:()=>t0});
  s.recordQuote('9.9.9.1',{ok:1});s.recordQuote('9.9.9.2',{ok:1});s.recordQuote('9.9.9.3',{ok:1});
  await settle();
  assert.equal(await redis.zcard(s.ipsKey),2,'最近 IP 索引不超上限');
  const m=s.minuteOf(t0);
  const other=await s.minuteHash(m,'__other__');
  assert.equal(other.req,'1','第三个 IP 的请求进入其他桶');
  assert.notEqual(await redis.zscore(s.miKey(m),'__other__'),null,'其他桶进分钟索引可落库');
});

test('S2-05：会话去重——已存在成员刷新、窗口计数、截断标记',async()=>{
  const t0=Date.now();let t=t0;
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:{...loadAccessStatsConfig({}),sessionDedupMax:2},now:()=>t});
  const sid=(c)=>c.repeat(64);
  s.recordQuote('8.8.8.8',{ok:1,session:sid('a')}); // a
  s.recordQuote('8.8.8.8',{ok:1,session:sid('b')}); // b → 容量 2 满
  t=t0+60000;
  s.recordQuote('8.8.8.8',{ok:1,session:sid('a')}); // 已存在：无条件刷新 score（S2-05）
  t=t0+120000;
  s.recordQuote('8.8.8.8',{ok:1,session:sid('c')}); // 新成员超容量 → 丢弃 + 截断标记
  s.recordQuote('8.8.8.8',{ok:1,session:sid('a')}); // a 刚刷新过仍存在
  await settle();
  const list=await s.listIps({ip:'8.8.8.8'});
  const row=list.rows[0];
  assert.equal(row.sessions10m,2,'10 分钟窗口内计数（a 刷新存活 + b），非全量 ZCARD');
  assert.equal(row.sessionsTruncated,true,'丢弃过新会话 → 显式截断标记（不由数量推测）');
});

test('黄灯分类（§4 + S2-06）：wAny 并集口径，e401 不进超限阈值',()=>{
  const cfg=loadAccessStatsConfig({});
  assert.equal(classifyStatus({},{},cfg).status,'green');
  assert.equal(classifyStatus({wSess:3,wIp:3},{},cfg).status,'green','维度叠加不再作为口径：wAny=0 不判黄');
  assert.equal(classifyStatus({wAny:4},{},cfg).status,'green','wAny 4<5 不判黄');
  assert.equal(classifyStatus({wAny:5},{},cfg).status,'yellow','wAny≥5 判黄');
  assert.equal(classifyStatus({e401:6},{},cfg).status,'green','无会话 401 不进超限阈值（走独立规则）');
  assert.equal(classifyStatus({},{req:50,noSess:40},cfg).status,'yellow','10 分钟 50 次且 80% 无会话');
  assert.equal(classifyStatus({},{req:50,noSess:30},cfg).status,'green','占比不足不判黄');
  assert.equal(classifyStatus({},{req:49,noSess:49},cfg).status,'green','量不足不判黄');
  assert.equal(classifyStatus({issue:20},{},cfg).status,'yellow','1 分钟新建会话≥20');
});

test('S2-04：lastSeen 分页只取当前页（不构建深分页全量命令）',async()=>{
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({})});
  for(let i=1;i<=25;i++)s.recordQuote(`10.0.0.${i}`,{ok:1});
  await settle();
  const p1=await s.listIps({page:1,size:10});
  assert.equal(p1.rows.length,10,'第一页 10 行');
  const p3=await s.listIps({page:3,size:10});
  assert.equal(p3.rows.length,5,'第三页恰好剩余 5 行（只取当前页）');
  assert.equal(p3.total,25);
  const p9=await s.listIps({page:9,size:10});
  assert.equal(p9.rows.length,0,'超出页为空');
});

test('落库：绝对值幂等（GREATEST/LEAST）、水位推进、缺口分钟 complete=0',async()=>{
  const t0=Date.now();
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000}); // 两分钟后：t0 所在分钟已结束
  s.recordQuote('7.7.7.7',{ok:1,noSess:true});
  s.recordQuote('7.7.7.7',{dIp:1});
  s.markLoss(); // 制造统计缺口 → 该分钟 complete=0（§8 不伪造完整）
  await settle();
  assert.equal(await f.flushOnce(),true);
  const m=s.minuteOf(t0);
  assert.equal(await store.getAccessWatermark(),m,'水位推进到已结束分钟');
  const [rows]=await store.pool.execute('SELECT * FROM access_ip_minute WHERE minute_utc=? ORDER BY ip',[m]);
  const mine=rows.find((r)=>r.ip==='7.7.7.7');
  assert.equal(mine.req,2);assert.equal(mine.ok,1);assert.equal(mine.no_sess,1);assert.equal(mine.d_ip,1);
  assert.equal(mine.e429,1);assert.equal(mine.complete,0,'缺口分钟标不完整');
  assert.ok(rows.some((r)=>r.ip==='__all__'&&r.req===2),'全局桶同分钟落库');
  // 幂等保护：重放较小快照不得回退绝对值，complete=1 不得翻掉缺口标记
  await store.upsertAccessMinute(m,[{minute:m,ip:'7.7.7.7',fields:{req:1},complete:1}]);
  const [[again]]=await store.pool.execute('SELECT req,complete FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'7.7.7.7']);
  assert.equal(again.req,2,'GREATEST 防回退');
  assert.equal(again.complete,0,'LEAST 保持缺口标记');
  // 再次落库：无待交付分钟，水位不动（Redis 桶保留至 TTL）
  assert.equal(await f.flushOnce(),true);
  assert.equal(await store.getAccessWatermark(),m);
  assert.equal(await redis.zcard(s.dirtyKey),0,'版本确认后待交付索引清空');
});

test('S2-02：迟到统计经待交付队列重扫补传（绝对值合并）',async()=>{
  const t0=Date.now()+180000; // 时钟前移 3 分钟：确保本用例分钟严格大于此前用例已推的水位
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('6.6.6.6',{ok:1});
  await settle();
  assert.equal(await f.flushOnce(),true);
  const m=s.minuteOf(t0);
  assert.equal(await store.getAccessWatermark(),m);
  // 迟到写：无条件登记待交付（不再依赖客户端水位，S2-02 三轮）
  s.recordQuote('6.6.6.6',{ok:1});
  await settle();
  assert.notEqual(await redis.zscore(s.dirtyKey,String(m)),null,'迟到分钟已登记待交付');
  assert.equal(await f.flushOnce(),true);
  const [[row]]=await store.pool.execute('SELECT req FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'6.6.6.6']);
  assert.equal(row.req,2,'迟到值经绝对值合并补传，不丢不翻倍');
  assert.equal(await store.getAccessWatermark(),m,'补传不回退水位');
  assert.equal(await redis.zcard(s.dirtyKey),0,'待交付处理完即清');
});

test('S2-03：pipeline 子命令错误整轮失败、不推水位、修复后可重试',async()=>{
  const t0=Date.now()+300000; // 5 分钟偏移：与上一用例（+3min）的分钟错开，必须大于既有水位才进 pending
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('3.3.3.3',{ok:1});
  await settle();
  const m=s.minuteOf(t0);
  const wmBefore=await store.getAccessWatermark();
  // 破坏：把该分钟 __all__ 桶占位成 STRING → hgetall 产生 WRONGTYPE 子命令错误
  await redis.set(s.minuteHashKey(m,'__all__'),'not-a-hash');
  assert.equal(await f.flushOnce(),false,'任一子命令错误必须整轮失败');
  assert.equal(await store.getAccessWatermark(),wmBefore,'失败绝不推进水位');
  assert.ok(f.state.lastError,'错误信息可供页面标注汇总延迟');
  // 移除占位（真实桶仍在）→ 下一轮从原水位重试成功
  await redis.del(s.minuteHashKey(m,'__all__'));
  assert.equal(await f.flushOnce(),true);
  const [[row]]=await store.pool.execute('SELECT req FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'3.3.3.3']);
  assert.equal(row.req,1,'重试按绝对值落库');
});

test('S2-02残留-窗口1：正常落库提交期间的并发写入经版本 CAS 转 dirty 补传',async()=>{
  const t0=Date.now()+420000; // 7 分钟偏移：与前面用例的分钟错开
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('4.4.4.4',{ok:1});
  await settle();
  const m=s.minuteOf(t0);
  // 挂钩 MySQL 提交：提交期间到达的写入仍携带旧水位（-1），不会自登记 dirty（codex 复现的交错窗口）
  const orig=store.upsertAccessMinute.bind(store);
  let injected=false;
  store.upsertAccessMinute=async(minute,rows)=>{
    if(minute===m&&!injected){injected=true;s.recordQuote('4.4.4.4',{ok:1});await new Promise((r)=>setTimeout(r,200));} // 等写入真实落 Redis（INCR 版本）
    return orig(minute,rows);
  };
  try{
    assert.equal(await f.flushOnce(),true);
    assert.equal(injected,true,'写入确实发生在提交期间');
    assert.notEqual(await redis.zscore(s.dirtyKey,String(m)),null,'版本前进必须保留 dirty（原实现会丢）');
    assert.equal(await f.flushOnce(),true); // 下轮重扫合并
    assert.equal(await redis.zcard(s.dirtyKey),0,'补传完成清 dirty');
  }finally{store.upsertAccessMinute=orig;}
  const [[row]]=await store.pool.execute('SELECT req FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'4.4.4.4']);
  assert.equal(row.req,2,'提交期间的写入不丢失');
});

test('S2-02残留-窗口2：dirty 重扫提交期间的写入不被确认抹掉',async()=>{
  const t0=Date.now()+540000; // 9 分钟偏移
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('5.5.5.5',{ok:1});
  await settle();
  assert.equal(await f.flushOnce(),true);
  const m=s.minuteOf(t0);
  s.recordQuote('5.5.5.5',{ok:1}); // 常规迟到 → 自登记待交付
  await settle();
  // 挂钩：重扫的提交期间又来一笔（会再次 ZADD 待交付 + INCR 版本；原实现提交后无条件 ZREM 会抹掉新标记）
  const orig=store.upsertAccessMinute.bind(store);
  let injected=false;
  store.upsertAccessMinute=async(minute,rows)=>{
    if(minute===m&&!injected){injected=true;s.recordQuote('5.5.5.5',{ok:1});await new Promise((r)=>setTimeout(r,200));}
    return orig(minute,rows);
  };
  try{
    assert.equal(await f.flushOnce(),true); // 处理待交付（此轮提交期间又 +1）
    assert.notEqual(await redis.zscore(s.dirtyKey,String(m)),null,'重扫期间的写入标记不被 ZREM 抹掉');
    assert.equal(await f.flushOnce(),true); // 再扫一轮收尾
  }finally{store.upsertAccessMinute=orig;}
  const [[row]]=await store.pool.execute('SELECT req FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'5.5.5.5']);
  assert.equal(row.req,3,'三笔全部落库，无丢写');
});

test('S2-02残留-窗口3：CAS 确认之后到达的写入仍被待交付队列兜住',async()=>{
  const t0=Date.now()+780000; // 13 分钟偏移：与前面用例分钟错开
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('1.1.1.1',{ok:1});
  await settle();
  const m=s.minuteOf(t0);
  // 挂钩：upsert（MySQL 事务）返回后 80ms 注入写入——此刻版本 CAS 已执行完毕，
  // 而旧实现此时既无 dirty 自登记（客户端水位未同步）也无重扫（复现 codex 第三轮窗口）
  const orig=store.upsertAccessMinute.bind(store);
  let injected=false;
  store.upsertAccessMinute=async(minute,rows)=>{
    const p=orig(minute,rows);
    if(minute===m&&!injected){injected=true;setTimeout(()=>{s.recordQuote('1.1.1.1',{ok:1});},80);}
    return p;
  };
  try{
    assert.equal(await f.flushOnce(),true);
    await settle(); // 等注入写入真实落 Redis
    assert.equal(injected,true,'写入发生在 CAS 确认之后');
    assert.notEqual(await redis.zscore(s.dirtyKey,String(m)),null,'无条件登记：确认后的写入重回待交付队列');
    assert.equal(await f.flushOnce(),true); // 下轮重扫合并
  }finally{store.upsertAccessMinute=orig;}
  const [[row]]=await store.pool.execute('SELECT req FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'1.1.1.1']);
  assert.equal(row.req,2,'确认后的写入不丢失');
});

test('S2-03残留：缺口补写原子协议——失败保留兜底重试、synced 标记不翻倍且为缺口证据',async()=>{
  const t0=Date.now();
  const m=Math.floor(t0/60000);
  // 最小替身：直接路径（hincrby/expire）+ LOSS_SYNC 原子脚本语义（evalsha 按 KEYS/ARGV 模拟四步）。
  // redisUp=总开关；attemptFail=恢复后首次脚本失败（复现"补写成功一半不再重试"的旧窗口）
  const state={};const pending=new Set();
  let redisUp=false,attemptFail=false,syncCalls=0;
  const fakeRedis={
    hincrby:async(k,f,v)=>{if(!redisUp)throw new Error('down');state[f]=String((Number(state[f])||0)+Number(v));return Number(v);},
    expire:async()=>{if(!redisUp)throw new Error('down');return 1;},
    hgetall:async()=>({...state}),
    // evalsha 按 KEYS/ARGV 数量区分脚本：2 参=LOSS_MARK（minute,ret），3 参=LOSS_SYNC（minute,count,ret）
    evalsha:async(sha,numKeys,...rest)=>{
      if(!redisUp||attemptFail){attemptFail=false;throw new Error('down');}
      const args=rest.slice(numKeys);
      if(args.length===2){pending.add(args[0]);return 1;} // LOSS_MARK：计数走 hincrby 语义可省，仅验证登记
      const [minute,count]=args; // LOSS_SYNC
      syncCalls++;
      pending.add(minute);
      const mk=`synced:${minute}`;
      if(!(mk in state)){state[mk]=String(count);state[minute]=String((Number(state[minute])||0)+Number(count));}
      return 1;
    },
    script:async()=>'ok',
  };
  const fakeRun=createScriptRunner(fakeRedis);
  const s=createAccessStats({redis:fakeRedis,run:fakeRun,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  s.markLoss();s.markLoss(); // 故障期间两次缺口 → 进程兜底累计 2
  await new Promise((r)=>setTimeout(r,100));
  let mins=await s.lossMinutes(); // Redis 仍不可用：原子脚本失败、兜底保留
  assert.deepEqual(mins,[m],'故障期间缺口保留在进程兜底中，不返回空冒充完整');
  redisUp=true;attemptFail=true; // 恢复但首次补写失败（旧实现此后不再重试）
  mins=await s.lossMinutes();
  assert.deepEqual(mins,[m],'首次补写失败后兜底仍在，可重试');
  mins=await s.lossMinutes(); // 本次成功
  assert.deepEqual(mins,[m]);
  assert.equal(state[m],'2','兜底累计正确补写');
  assert.ok(pending.has(String(m)),'待交付登记成功（已落库分钟可降级 complete=0）');
  mins=await s.lossMinutes(); // 再读：synced 标记挡住重复累加
  assert.equal(state[m],'2','synced 幂等标记：重复补写不翻倍');
  assert.deepEqual(mins,[m]);
  // synced 标记本身即缺口证据：即使计数字段丢失（异常清除），该分钟仍被列出并可降级
  delete state[String(m)];
  mins=await s.lossMinutes();
  assert.deepEqual(mins,[m],'计数丢失时 synced 标记仍证明缺口存在');
});

test('S2-03残留：mi 有成员但 Hash 缺失，不得当完整零值落库',async()=>{
  const t0=Date.now()+660000; // 11 分钟偏移
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('2.2.2.2',{ok:1});
  await settle();
  const m=s.minuteOf(t0);
  await redis.del(s.minuteHashKey(m,'2.2.2.2')); // 模拟该成员桶丢失（TTL 异常/被清除），保留 mi 索引成员
  assert.equal(await f.flushOnce(),true);
  const [[row]]=await store.pool.execute('SELECT req,complete FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'2.2.2.2']);
  assert.equal(row.req,0);
  assert.equal(row.complete,0,'缺失桶标不完整，不伪装完整零值');
});

test('第四版-时序A：版本读取后、缺口读取前新增缺口 → 本次即 complete=0 且 CAS 保留待交付',async()=>{
  const t0=Date.now()+900000; // 15 分钟偏移
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('11.0.0.1',{ok:1});
  await settle();
  const m=s.minuteOf(t0);
  // 挂钩版本读取：返回 ver0 后立即注入缺口（复现"lossSet 快照后、collect 版本读取前"交错——
  // 缺口写入会 INCR 版本（第四版修复），随后 collect 的缺口读取能看到它）
  const origGet=redis.get.bind(redis);
  let armed=true;
  redis.get=async(key)=>{
    const v=await origGet(key);
    if(armed&&key===s.verKey(m)){armed=false;s.markLoss();await new Promise((r)=>setTimeout(r,200));}
    return v;
  };
  try{
    assert.equal(await f.flushOnce(),true);
  }finally{redis.get=origGet;}
  const [[rowA]]=await store.pool.execute('SELECT complete FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'11.0.0.1']);
  assert.equal(rowA.complete,0,'缺口在版本后读取，本次落库即不完整');
  // 缺口推了版本 → CAS 失配 → 待交付保留（不因版本未变而清掉缺口证据）
  assert.notEqual(await redis.zscore(s.dirtyKey,String(m)),null,'版本失配保留待交付');
  assert.equal(await f.flushOnce(),true);
  const [[rowB]]=await store.pool.execute('SELECT complete FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'11.0.0.1']);
  assert.equal(rowB.complete,0,'重扫后仍为不完整');
  assert.equal(await redis.zcard(s.dirtyKey),0,'重扫确认后清待交付');
});

test('第四版-时序B：快照后、MySQL 提交期间新增缺口 → 下轮重扫降级 complete=0',async()=>{
  const t0=Date.now()+1020000; // 17 分钟偏移
  const s=createAccessStats({redis,run,batch,keyPrefix:TEST_PREFIX,cfg:loadAccessStatsConfig({}),now:()=>t0});
  const f=createAccessFlusher({stats:s,store,redis,batch,run,now:()=>t0+120000});
  s.recordQuote('11.0.0.2',{ok:1});
  await settle();
  const m=s.minuteOf(t0);
  // 挂钩 MySQL 提交：快照已读（无缺口）→ 提交期间新增缺口（LOSS_MARK 推版本+登记待交付，
  // 修复前版本不变会被 CAS 当无变化清掉，complete=1 永不纠正——codex 第四版复现场景）
  const orig=store.upsertAccessMinute.bind(store);
  let injected=false;
  store.upsertAccessMinute=async(minute,rows)=>{
    if(minute===m&&!injected){injected=true;s.markLoss();await new Promise((r)=>setTimeout(r,200));}
    return orig(minute,rows);
  };
  try{
    assert.equal(await f.flushOnce(),true); // 本轮快照无缺口 → complete=1，但 CAS 失配保留待交付
    assert.equal(injected,true);
    const [[rowA]]=await store.pool.execute('SELECT complete FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'11.0.0.2']);
    assert.equal(rowA.complete,1,'本轮快照确实未含缺口');
    assert.notEqual(await redis.zscore(s.dirtyKey,String(m)),null,'缺口推版本 → CAS 不清待交付（修复点）');
    assert.equal(await f.flushOnce(),true); // 下轮重扫：缺口可见 → LEAST 降级
  }finally{store.upsertAccessMinute=orig;}
  const [[rowB]]=await store.pool.execute('SELECT complete FROM access_ip_minute WHERE minute_utc=? AND ip=?',[m,'11.0.0.2']);
  assert.equal(rowB.complete,0,'提交期间的缺口最终把 complete 降为 0');
  assert.equal(await redis.zcard(s.dirtyKey),0);
});
// end:aigc.
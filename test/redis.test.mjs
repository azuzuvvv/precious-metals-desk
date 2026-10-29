// start:aigc.
// Redis 访问状态集成测试（真实 Redis，方案 §12/§14.5/§15.5/§16.2 验收证据）：
// 令牌桶原子语义、访客会话生命周期、EVALSHA NOSCRIPT 重载、有界熔断降级/恢复。
// 本机验证用 2.8.9（4.x 命令子集，代码只用 4 兼容能力）；上线前在服务器 4.0.11 复测。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import Redis from 'ioredis';
import {createRedisClient,createScriptRunner,createRedisGate,createBoundedAccessor,createConnectionSupervisor,loadRedisConfig,digest} from '../src/redis-client.mjs';
import {createRedisLimiter} from '../src/rate-limit.mjs';
import {createViewerSessions} from '../src/viewer-session.mjs';
import {scanDelPrefix,randomTestPrefix,waitRedisReady} from './helpers.mjs';

// 独立测试库（15）+ 随机测试命名空间（审查 R2 残留）：不再触碰生产前缀 lcjy:quote:access:v1:，
// 清理只删本次随机前缀（scanDelPrefix 强校验）；ready 等待带超时，连接失败快速报错而非挂起
const TEST_DB = 15;
const TEST_PREFIX = randomTestPrefix();
const CLEAN_PATTERN = `${TEST_PREFIX}*`;
let redis, run;

test.before(async () => {
  redis = createRedisClient({...loadRedisConfig(), db: TEST_DB, connectTimeoutMs: 3000, commandTimeoutMs: 3000});
  redis.on('error', () => {}); // 测试期忽略连接错误（避免未捕获异常），由 gate 语义测试覆盖降级
  await waitRedisReady(redis);
  run = createScriptRunner(redis);
  await scanDelPrefix(redis, CLEAN_PATTERN);
});
test.after(async () => { redis.disconnect(); });
test.beforeEach(async () => { await scanDelPrefix(redis, CLEAN_PATTERN); });

test('令牌桶：burst 耗尽后拒绝，回填后可再次消费，不同 key 独立', async () => {
  let t = 1000000;
  const limiter = createRedisLimiter({redis, run, bucket: 't', keyPrefix: TEST_PREFIX, perMinute: 60000, burst: 2, now: () => t}); // 1 令牌/ms
  assert.equal((await limiter.check('a')).ok, true);
  assert.equal((await limiter.check('a')).ok, true);
  const denied = await limiter.check('a');
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1, '超限必须返回退避秒数');
  t += 2; // 前进 2ms，回填 2 令牌
  assert.equal((await limiter.check('a')).ok, true);
  assert.equal((await limiter.check('b')).ok, true, '不同逻辑 key 独立满桶');
});

test('令牌桶：key 存摘要，不在 Redis 可见明文标识', async () => {
  const limiter = createRedisLimiter({redis, run, bucket: 's', keyPrefix: TEST_PREFIX, perMinute: 60000, burst: 5});
  await limiter.check('8.8.8.8');
  // 排除桶索引 ZSET（lim:s:index），只断言桶键本身；桶键为 digest，不存明文 IP
  const keys = (await redis.keys(`${TEST_PREFIX}lim:s:*`)).filter((k) => !k.endsWith(':index'));
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes('8.8.8.8'), '限流键不存明文 IP');
});

test('访客会话：issue/touch/容量上限/过期清扫', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 用真实时间 + 短空闲期：会话 key 的 TTL 由 Redis 真实计时，注入假时间无法验证过期
  const sessions = createViewerSessions({redis, run, keyPrefix: TEST_PREFIX, idleMs: 150, maxSessions: 2});
  const a = await sessions.issue(), b = await sessions.issue();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await sessions.count(), 2);
  assert.equal(await sessions.issue(), null, '容量满拒绝发放，不驱逐活跃会话');
  assert.equal((await sessions.touch(a)).valid, true);
  assert.equal((await sessions.touch('x'.repeat(64))).valid, false, '未知会话 touch 无效');
  await sleep(150);
  await sessions.touch(b); // b 刷新存活
  await sleep(150); // 距上次 touch(a) 已约 300ms > idleMs(150)，a 的 key TTL 到期
  assert.equal((await sessions.touch(a)).valid, false, '超时会话 touch 无效');
  await sessions.sweep();
  assert.ok(await sessions.issue(), '清扫过期后释放容量可再次发放');
});

test('访客会话：Cookie 剩余不足一天时 touch 触发续写', async () => {
  let t = 0;
  const sessions = createViewerSessions({redis, run, keyPrefix: TEST_PREFIX, idleMs: 10_000_000, maxSessions: 100, cookieMaxAgeSec: 90000, now: () => t}); // Cookie 寿命 25 小时
  const id = await sessions.issue();
  assert.equal((await sessions.touch(id)).renew, false, '剩余 90000s > 1 天不续写');
  t += 4_000_000; // 剩余约 86000s < 1 天
  assert.equal((await sessions.touch(id)).renew, true, '剩余不足一天触发续写');
  // 审查「Cookie 续写边界」：续写后 cookieExpiresAtMs 元数据已更新，后续 touch 不再重复 renew
  assert.equal((await sessions.touch(id)).renew, false, '续写后元数据推进，不再持续触发 renew');
});

test('ScriptRunner：NOSCRIPT 自动重载并成功（fake redis，避开实例级 SCRIPT FLUSH）', async () => {
  // 审查 R2：SCRIPT FLUSH 是实例级操作，会清空整个 Redis 实例的脚本缓存，不能用于共享实例。
  // 改用 fake redis 模拟「脚本缓存被外部清除」：首次 evalsha 抛 NOSCRIPT，验证 run 自动 SCRIPT LOAD 后重试
  let evalshaCalls = 0, loads = 0;
  const fake = {
    async evalsha() {
      evalshaCalls++;
      if (evalshaCalls === 1) { const e = new Error('NOSCRIPT No matching script. Please use EVAL.'); throw e; }
      return [1];
    },
    async script() { loads++; return 'ok'; },
  };
  const fakeRun = createScriptRunner(fake);
  const r = await fakeRun('return 1');
  assert.equal(Number(r[0]), 1);
  assert.equal(evalshaCalls, 2, '首次 NOSCRIPT 后重载并重试一次');
  assert.equal(loads, 1, '执行过一次 SCRIPT LOAD');
});

test('令牌桶：maxKeys 桶数上限，超限新桶返回 capacityFull 不驱逐已有桶', async () => {
  // 审查 R3：桶数受控（§14.2）。maxKeys=1 下第一个 key 建桶，第二个 key 因容量满被拒且不建桶
  const limiter = createRedisLimiter({redis, run, bucket: 'mk', keyPrefix: TEST_PREFIX, perMinute: 60000, burst: 2, maxKeys: 1});
  assert.equal((await limiter.check('a')).ok, true);
  const denied = await limiter.check('b');
  assert.equal(denied.ok, false);
  assert.equal(denied.capacityFull, true, '容量满标记');
  assert.equal((await limiter.check('a')).ok, true, '已有桶 a 的判定不受容量满影响');
});

test('RedisGate：guard 成功自动恢复，fail 标记降级，probe 探测恢复', async () => {
  const gate = createRedisGate(redis, {probeMs: 0});
  gate.fail();
  assert.equal(gate.degraded, true);
  assert.equal(gate.downSince, gate.downSince, '记录降级起点');
  assert.equal(await gate.guard(async () => 'ok'), 'ok');
  assert.equal(gate.degraded, false, 'guard 成功自动恢复');
  gate.fail();
  assert.equal(await gate.probe(), true);
  assert.equal(gate.degraded, false, 'probe 探测成功后恢复');
});

test('RedisGate：guard 失败上抛且进入降级', async () => {
  const gate = createRedisGate(redis, {probeMs: 0});
  await assert.rejects(() => gate.guard(async () => { throw new Error('boom'); }));
  assert.equal(gate.degraded, true, '命令失败进入降级');
});

test('R7：续写后会话键必须保留 TTL，停止访问后实际过期', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 真实时间 + 短空闲期 + 1 秒 Cookie 寿命（< 1 天阈值，首次 touch 即续写）
  const prefix = randomTestPrefix();
  const sessions = createViewerSessions({redis, run, keyPrefix: prefix, idleMs: 150, maxSessions: 10, cookieMaxAgeSec: 1});
  const id = await sessions.issue();
  const t1 = await sessions.touch(id);
  assert.equal(t1.renew, true, 'Cookie 寿命 1s < 1 天阈值，首次 touch 即续写');
  const pttl = await redis.pttl(`${prefix}viewer:${digest(id)}`);
  assert.ok(pttl > 0 && pttl <= 150, `续写后必须保留空闲 TTL（R7：裸 SET 清 TTL 回归，实际 PTTL=${pttl}）`);
  await sleep(250); // 超过 idleMs(150) 不再访问
  assert.equal((await sessions.touch(id)).valid, false, '停止访问超过空闲期后会话键实际过期');
});

test('R3残留：活跃桶跨 TTL 窗口后索引不误删，新桶仍容量拒绝', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 注入 1 秒短 TTL（测试专用覆盖）：a 持续活跃跨越原创建时间的 TTL 窗口，
  // 索引 score 随访问推进，b 仍应被 maxKeys=1 拒绝——修复前索引会误删活跃的 a 导致突破上限
  const limiter = createRedisLimiter({redis, run, bucket: 'r3', keyPrefix: TEST_PREFIX, perMinute: 60000, burst: 2, maxKeys: 1, ttlSecondsOverride: 1});
  assert.ok((await limiter.check('a')).ok);
  await sleep(600); // 未超 TTL
  assert.ok((await limiter.check('a')).ok, 'a 再次访问：刷新桶 TTL 并推进索引 score');
  await sleep(600); // 距 a 上次访问 0.6s < 1s，a 仍活跃；距创建已 1.2s > 1s（修复前索引会把 a 当过期清扫）
  const denied = await limiter.check('b');
  assert.equal(denied.capacityFull, true, '活跃桶不应被索引清扫误删，新桶必须仍被容量上限拒绝');
});

test('R5：脚本执行故障时探测不得宣布恢复（SET 可用而 EVALSHA 失败）', async () => {
  // fake redis：普通 SET/GET/DEL 全部可用，但 EVALSHA 抛错——probe 走脚本验证时必须保持降级
  const fake = {
    status: 'ready',
    set: async () => 'OK',
    get: async () => '1',
    del: async () => 1,
    evalsha: async () => { throw new Error('ERR script runtime error'); },
    script: async () => { throw new Error('unexpected'); },
  };
  const fakeRun = createScriptRunner(fake);
  const gate = createRedisGate(fake, {probeMs: 0, runScript: fakeRun});
  gate.fail();
  assert.equal(await gate.probe(), false, 'EVALSHA 故障时探测失败');
  assert.equal(gate.degraded, true, '不得宣布恢复（R5）');
});

test('P2内存边界：命令超时主动断开，ioredis 内部命令队列不随超时累积', async () => {
  // 半哑服务：正确应答 ioredis 6 握手（HELLO 回错误触发 RESP2 回退、SETINFO 回 +OK、readyCheck 的
  // info 回 bulk——握手命令同样受 commandTimeout，不答就永远到不了 ready），业务 get 一律不回——
  // 精确复现"连接不断开、却一直不回包"，业务命令逐条超时
  const silent = net.createServer((sock) => {
    sock.on('data', (buf) => {
      let replies = '';
      for (const m of buf.toString('binary').matchAll(/\$([0-9]+)\r\n([^\r\n]+)\r\n/g)) {
        const word = m[2];
        if (word === 'hello') replies += `-ERR unknown command 'hello'\r\n`;
        else if (word === 'SETINFO') replies += '+OK\r\n';
        else if (word === 'info') { const info = '# Server\r\nredis_version:4.0.11\r\n'; replies += `$${Buffer.byteLength(info)}\r\n${info}\r\n`; }
        // get 及其余参数：不回——制造命令超时
      }
      if (replies) sock.write(replies);
    });
  });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const port = silent.address().port;
  // 直连 ioredis（镜像 createRedisClient 关键项：离线队列禁用 + 命令级超时 + 不自动重连）
  const redis = new Redis({host: '127.0.0.1', port, connectTimeout: 1000, commandTimeout: 300,
    enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => null});
  redis.on('error', () => {});
  try {
    await waitRedisReady(redis);
    const supervisor = createConnectionSupervisor(redis, {minTeardownIntervalMs: 50});
    const accessor = createBoundedAccessor(redis, {maxConcurrent: 1, supervisor});
    const fire = async () => { try { await accessor.get('k'); } catch { /* 逐条失败符合预期 */ } };
    // 等 teardown 的 close/end 异步落定（disconnect 立即生效但状态经事件循环推进）
    const settle = async () => { const until = Date.now() + 500; while (redis.status !== 'end' && Date.now() < until) await new Promise((r) => setTimeout(r, 20)); };
    // 第一轮：顺序 4 次（每次超时释放预算后才放下一次）——修复前内部队列会累积到 4 条
    for (let i = 0; i < 4; i++) await fire();
    await settle();
    assert.equal(redis.status, 'end', '首个命令超时必须主动断开（连接进入 end，清空内部队列）');
    assert.equal(redis.commandQueue?.length ?? 0, 0, '超时清理后内部命令队列必须为空');
    // 第二轮：重连后再来一轮同样的故障——队列仍不持续增长（故障恢复后重复故障均有界）
    await redis.connect().catch(() => {});
    await waitRedisReady(redis);
    for (let i = 0; i < 4; i++) await fire();
    await settle();
    assert.equal(redis.commandQueue?.length ?? 0, 0, '重连后再次故障，内部队列仍不累积');
  } finally {
    redis.disconnect();
    await new Promise((r) => silent.close(r));
  }
});
// end:aigc.
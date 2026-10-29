// start:aigc.
// Redis 访问客户端封装（方案 §2/§6/§14/§17）：ioredis 连接工厂 + EVALSHA 封装 + 有界熔断健康探测。
// 兼容 Redis 4（含本机 2.8.9 子集）：只用 Hash/Sorted Set/TTL/EVAL/EVALSHA/SCAN(无 TYPE)，
// 不使用 Streams、Redis Functions、ACL、ZADD NX/XX/CH/INCR、SCAN TYPE 等新版本能力（§2 末段）。
// 客户端禁用无限离线队列、命令级有限重试、短超时——故障时快速失败，由上层降级处理（§14.3/§17.1）。

import Redis from 'ioredis';
import {createHash} from 'node:crypto';

// 项目专属键前缀（§2）：命名隔离，非权限隔离；所有本模块产出的键都带此前缀
export const ACCESS_PREFIX = 'lcjy:quote:access:v1:';

// 整数 env 校验：非法值启动即报错，与 loadProtectConfig 的口径一致
const int = (env, key, def, min, max) => {
  if (env[key] === undefined || env[key] === '') return def;
  const v = Number(env[key]);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} 必须是 ${min}-${max} 的整数（当前：${env[key]}）`);
  return v;
};

// Redis 连接配置装载（§10）：env 优先，密码不落源码/文档/日志，db 参数供测试注入隔离库
export function loadRedisConfig(env = process.env, db = undefined) {
  const password = env.REDIS_PASSWORD === undefined || env.REDIS_PASSWORD === '' ? undefined : env.REDIS_PASSWORD;
  const cfg = {
    host: env.REDIS_HOST || '127.0.0.1',
    port: int(env, 'REDIS_PORT', 6379, 1, 65535),
    password,
    db: db ?? int(env, 'REDIS_DB', 0, 0, 15),
    connectTimeoutMs: int(env, 'REDIS_CONNECT_TIMEOUT_MS', 2000, 100, 60000),
    commandTimeoutMs: int(env, 'REDIS_COMMAND_TIMEOUT_MS', 1000, 100, 60000),
  };
  return cfg;
}

// ioredis 实例构造：enableOfflineQueue=false 禁用无限离线队列，maxRetriesPerRequest=1 命令级只重试一次，
// retryStrategy 有限次退避后停止重连（不再无限重试，恢复交给健康探测），超时取配置值（§14.3 有界）
export function createRedisClient({ host, port, password, db, connectTimeoutMs, commandTimeoutMs }) {
  const redis = new Redis({
    host, port, password, db,
    connectTimeout: connectTimeoutMs,
    commandTimeout: commandTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times < 3 ? Math.min(200 * times, 1000) : null),
    lazyConnect: false,
    showFriendlyErrorStack: false,
  });
  return redis;
}

// 会话/计数键使用标识摘要，不存明文 Cookie（§14.1）：统一 sha256 hex
export function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// EVALSHA 脚本运行器：缓存 SHA1，NOSCRIPT（实例重启丢脚本）时 SCRIPT LOAD 重载后重试一次（§6）。
// 返回可直接调用的 run(script, keys, args) 函数（闭包持有 SHAS 缓存），调用方统一以函数形式使用。
// maxConcurrent 设在途脚本并发上限（§14.3 审查 R4）：enableOfflineQueue:false 只防离线积压，
// 不防"连接慢"时命令堆积，此处兜底限制脚本在途数量，超限抛可重试错误由上层降级/拒绝处理。
// supervisor（审查 P2 内存边界）：命令超时说明连接"活着但不回包"，ioredis 的 commandTimeout 只让
// 调用方 Promise 拒绝、内部 commandQueue 的 Command 仍累积；超时交给 supervisor 主动断开清队。
export function createScriptRunner(redis, { maxConcurrent = 1000, supervisor = null } = {}) {
  const shas = new Map(); // script 源码 -> sha1
  let inflight = 0; // 在途脚本调用计数（有界）
  const isNoScript = (e) => /NOSCRIPT/i.test(e?.message || '');
  async function evalsha(sha, keys, args) {
    return redis.evalsha(sha, keys.length, ...keys.map(String), ...args.map(String));
  }
  return async function run(script, keys = [], args = []) {
    if (inflight >= maxConcurrent) { const e = new Error('REDIS_INFLIGHT_LIMIT'); e.code = 'REDIS_INFLIGHT_LIMIT'; throw e; }
    inflight++;
    try {
      let sha = shas.get(script);
      if (!sha) { sha = createHash('sha1').update(script).digest('hex'); shas.set(script, sha); }
      try {
        return await evalsha(sha, keys, args);
      } catch (e) {
        if (!isNoScript(e)) throw e;
        // 实例重启（AOF/RDB 未持久化脚本）导致脚本丢失：重载并重试一次
        await redis.script('load', script);
        return await evalsha(sha, keys, args);
      }
    } catch (e) {
      if (supervisor?.isTimeoutError(e)) supervisor.onTimeout();
      throw e;
    } finally {
      inflight--;
    }
  };
}

// 有界熔断健康探测（§17.1.3/§14.4）：命令失败进入降级，降级期间按 probeMs 间隔探测恢复，
// 不让每个访客反复等待 Redis 超时。恢复验证走与关键路径一致的能力（审查 R5）：优先经 runScript
// 执行短 Lua（EVALSHA + 写 + 读 + TTL + 删），覆盖脚本缓存/执行/写权限故障——SET 可用而 EVALSHA
// 失败时不得宣布恢复；无 runScript 时退化为 SET PX + GET + DEL 普通命令链。
export function createRedisGate(redis, { probeMs = 1000, now = Date.now, probeKey = `${ACCESS_PREFIX}probe`, runScript = null } = {}) {
  let downAt = null, lastProbe = 0, probing = false; // probing：单笔探测在途，慢探测超过间隔也不重叠
  const recovered = () => { downAt = null; lastProbe = 0; };
  // 探测脚本：与业务同路径（EVALSHA 命中 NOSCRIPT 时由 run 统一重载），写→读→删验证完整读写链
  const PROBE_SCRIPT = `redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
local v = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
return v`;
  return {
    get degraded() { return downAt !== null; },
    get downSince() { return downAt; },
    // 在 guard 内执行 Redis 操作：成功自动恢复；失败记录降级起点并上抛由调用方决定降级分支
    async guard(op) {
      try { const v = await op(); recovered(); return v; }
      catch (e) { downAt = downAt ?? now(); throw e; }
    },
    fail() { downAt = downAt ?? now(); },
    // 降级期间按间隔探测；连接已断开时先重连，验证通过才恢复
    async probe() {
      if (downAt === null) return true;
      const t = now();
      if (t - lastProbe < probeMs || probing) return false;
      lastProbe = t; probing = true;
      try {
        if (redis.status !== 'ready') await redis.connect();
        if (runScript) {
          await runScript(PROBE_SCRIPT, [probeKey], ['1', '1000']);
        } else {
          await redis.set(probeKey, '1', 'PX', 1000);
          await redis.get(probeKey);
          await redis.del(probeKey);
        }
        recovered();
        return true;
      } catch { return false; }
      finally { probing = false; }
    },
  };
}

// start:aigc. 连接健康监管（审查 P2 内存边界）：连接不断开但停止回包（网络黑洞/实例假死）时，
// ioredis 的 commandTimeout 只让调用方 Promise 超时拒绝，内部 commandQueue 中已发送待回包的
// Command 对象仍会随请求速率无限累积。超时即主动 disconnect()：立即销毁连接并清空内部队列，
// 状态转 end（离线队列已禁用，新命令快速失败而非排队）；重连交给既有 gate.probe 的有限探测，
// 不在此处自动重连。限频窗口内只拆一次，避免并发超时把连接反复重建。
export function createConnectionSupervisor(redis, { minTeardownIntervalMs = 5000, now = Date.now } = {}) {
  let lastTeardown = 0;
  return {
    // 超时类错误识别（ioredis commandTimeout 报错含 timed out；排除自定义在途上限错误）
    isTimeoutError(e) {
      if (!e || e.code === 'REDIS_INFLIGHT_LIMIT') return false;
      return /timed?\s*out|timeout/i.test(String(e.message || ''));
    },
    // 主动断开清理：返回是否执行了 teardown
    onTimeout() {
      const t = now();
      if (t - lastTeardown < minTeardownIntervalMs) return false;
      lastTeardown = t;
      try { redis.disconnect(); } catch { /* 已断开时忽略 */ }
      return true;
    },
  };
}

// start:aigc. 非脚本命令的共享在途预算（审查二轮 R4 部分）：管理员会话 get/set/del、访客索引
// zcard/zremrangebyscore 等直连命令与脚本运行器一样有界；超限抛 code=REDIS_INFLIGHT_LIMIT
// 的可重试错误，由上层既有 catch 走降级/401 路径。与脚本预算各自独立计数（两者均有界即可）。
// 超时错误同样上报 supervisor 主动清队（审查 P2 内存边界）。
// 二批审查 S2-04：统计读取路径（hgetall/zrange/zcount 等）同样纳入预算，不绕过连接保护。
export function createBoundedAccessor(redis, { maxConcurrent = 2000, supervisor = null } = {}) {
  let inflight = 0;
  const limit = (name) => async (...args) => {
    if (inflight >= maxConcurrent) { const e = new Error(`Redis 在途命令上限(${name})`); e.code = 'REDIS_INFLIGHT_LIMIT'; throw e; }
    inflight++;
    try { return await redis[name](...args); }
    catch (e) { if (supervisor?.isTimeoutError(e)) supervisor.onTimeout(); throw e; }
    finally { inflight--; }
  };
  return { get: limit('get'), set: limit('set'), del: limit('del'), zcard: limit('zcard'), zremrangebyscore: limit('zremrangebyscore'), ping: limit('ping'),
    hgetall: limit('hgetall'), hmget: limit('hmget'), hincrby: limit('hincrby'), hdel: limit('hdel'), expire: limit('expire'), zrange: limit('zrange'), zrevrangebyscore: limit('zrevrangebyscore'), zscore: limit('zscore'), zcount: limit('zcount'), zrem: limit('zrem'), zadd: limit('zadd') };
}
// end:aigc.

// start:aigc. 有界批量执行（审查 S2-04/S2-03）：pipeline 按 batchLimit 分片提交，避免一次构造
// 十万级命令；逐项校验子命令错误——任一 [Error,null] 都整体上抛，绝不把失败当完整零值；
// 连接/超时错误上报 supervisor 主动断开清队；单 runner 并发有界（maxConcurrent）。
// commands 为 [命令名, ...参数] 数组，返回按序结果数组（只含值，错误走异常）。
export function createBatchRunner(redis, { batchLimit = 512, maxConcurrent = 2, supervisor = null } = {}) {
  let inflight = 0;
  return async function batch(commands) {
    if (inflight >= maxConcurrent) { const e = new Error('Redis 批量读取并发上限'); e.code = 'REDIS_INFLIGHT_LIMIT'; throw e; }
    inflight++;
    try {
      const out = [];
      for (let i = 0; i < commands.length; i += batchLimit) {
        const pl = redis.pipeline();
        for (const cmd of commands.slice(i, i + batchLimit)) pl[cmd[0]](...cmd.slice(1));
        const res = await pl.exec();
        for (const item of res) if (item[0]) throw item[0]; // S2-03：子命令失败=整批失败，不推水位/不伪绿
        for (const item of res) out.push(item[1]);
      }
      return out;
    } catch (e) {
      if (supervisor?.isTimeoutError(e)) supervisor.onTimeout();
      throw e;
    } finally { inflight--; }
  };
}
// end:aigc.
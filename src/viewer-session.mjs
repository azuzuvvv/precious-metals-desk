// start:aigc.
// 匿名访客会话存储（Redis 版，方案 §14.1/§15.7/§16.3）：会话与滑动续期、总量索引统一迁入 Redis，
// 不使用 Node 内存全量副本。会话/索引/容量判定在单个 Lua 脚本内原子完成，避免"判过期但索引没清"、
// "刷新不断向索引追加重复成员"的竞态（§15.7）。key 只存会话标识摘要，不存明文 Cookie（§14.1）。

import {randomBytes} from 'node:crypto';
import {ACCESS_PREFIX, digest} from './redis-client.mjs';

// 会话 touch（验证 + 滑动续期 + 索引一致性 + 续写判定）原子脚本：
//   KEYS[1]=会话键  KEYS[2]=索引 ZSET
//   ARGV[1]=digest(成员)  ARGV[2]=now(ms)  ARGV[3]=idleMs  ARGV[4]=renewThresholdMs  ARGV[5]=newCookieExpiresAtMs
//  返回 {valid, renew, cookieExpiresAtMs}；renew 时同步更新 cookieExpiresAtMs 元数据，
//  否则进入剩余 < 阈值窗口后每次 touch 都返回 renew=true 持续重发 Set-Cookie（审查「Cookie 续写边界」）
const TOUCH_SCRIPT = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return {0, 0, 0}
end
local cookieExp = tonumber(redis.call('GET', KEYS[1]))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
local renew = 0
if (cookieExp - tonumber(ARGV[2])) < tonumber(ARGV[4]) then
  renew = 1
  cookieExp = tonumber(ARGV[5])
  -- 审查 R7：裸 SET 会移除键的 TTL（Redis SET 默认清除过期），必须带 PX 保留空闲过期；
  -- Redis 4 无 KEEPTTL，且顺序上本 SET 已在 PEXPIRE 之后，只能显式重设
  redis.call('SET', KEYS[1], cookieExp, 'PX', ARGV[3])
end
return {1, renew, cookieExp}
`;

// 会话 issue（容量判断 + 新建 + 索引登记）原子脚本：
//   KEYS[1]=会话键  KEYS[2]=索引 ZSET
//   ARGV[1]=digest  ARGV[2]=now(ms)  ARGV[3]=idleMs  ARGV[4]=cookieExpiresAtMs  ARGV[5]=maxSessions
//  先清扫过期成员（score < now-idleMs）再判容量；仍满返回 0（不驱逐活跃会话）
const ISSUE_SCRIPT = `
local cutoff = tonumber(ARGV[2]) - tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
redis.call('SET', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`;

export function createViewerSessions({redis, run, idleMs = 30 * 60000, maxSessions = 10000, cookieMaxAgeSec = 7 * 86400, now = Date.now, keyPrefix = ACCESS_PREFIX} = {}) {
  const sessionKey = (d) => `${keyPrefix}viewer:${d}`;
  const indexKey = `${keyPrefix}viewer:index`;
  const renewThresholdMs = 86400000; // Cookie 剩余不足一天触发续写（与原内存版一致）

  return {
    // 验证并续期：invalid 时返回 {valid:false}；有效时原子刷新 TTL/索引并给出是否续写 Cookie
    async touch(id) {
      if (typeof id !== 'string' || id.length !== 64) return { valid: false, renew: false };
      const d = digest(id);
      const t = now();
      const r = await run(TOUCH_SCRIPT, [sessionKey(d), indexKey], [d, t, idleMs, renewThresholdMs, t + cookieMaxAgeSec * 1000]);
      return { valid: Number(r[0]) === 1, renew: Number(r[1]) === 1, cookieExpiresAtMs: Number(r[2]) };
    },
    // 新建会话：容量满先清扫过期仍满则返回 null（路由转可重试 503，不驱逐正常看盘会话）
    async issue() {
      const id = randomBytes(32).toString('hex');
      const d = digest(id);
      const t = now();
      const ok = await run(ISSUE_SCRIPT, [sessionKey(d), indexKey], [d, t, idleMs, t + cookieMaxAgeSec * 1000, maxSessions]);
      return Number(ok) === 1 ? id : null;
    },
    // 清扫过期索引成员（会话键由 TTL 自动过期；索引 ZSET 需显式清理，批次即"过期区间"有界）
    async sweep() {
      await redis.zremrangebyscore(indexKey, '-inf', now() - idleMs);
    },
    // 当前会话总数（索引 ZCARD，供聚合日志）
    async count() {
      return redis.zcard(indexKey);
    },
  };
}
// end:aigc.
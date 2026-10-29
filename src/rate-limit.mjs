// start:aigc.
// 行情接口访问保护（方案 §5/§13.2/§15.2-15.3/§14.1）：令牌桶限流（Redis 原子）、可信代理客户端 IP 提取、保护配置装载。
// 独立模块（方案 §8）：server.mjs 只做路由装配，不在此文件之外混入限流状态。
// 限流桶迁入 Redis（§14.1）：令牌补入/消费在单个 Lua 脚本内原子完成，无 Node 内存镜像（§14.3）。

import {isIP} from 'node:net';
import {ACCESS_PREFIX, digest} from './redis-client.mjs';

// 令牌桶限流 Lua（原子补令牌 + 消费 + 桶数上限）：KEYS[1]=桶键 KEYS[2]=桶索引 ZSET；
// ARGV[1]=容量 ARGV[2]=每毫秒回填(perMinute/60000) ARGV[3]=now(ms) ARGV[4]=cost ARGV[5]=TTL秒 ARGV[6]=maxKeys。
// 返回 {allowed, retryAfterSec, capacityFull}：新桶创建前先清扫过期索引成员再判容量上限，超限不建桶（§14.2 记录数量受控）
const LIMIT_SCRIPT = `
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'lastMs')
local tokens = tonumber(bucket[1])
local lastMs = tonumber(bucket[2])
local now = tonumber(ARGV[3])
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[4])
local ttlSec = tonumber(ARGV[5])
local maxKeys = tonumber(ARGV[6])
if tokens == nil then
  local cutoff = now - ttlSec * 1000
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
  if redis.call('ZCARD', KEYS[2]) >= maxKeys then
    return {0, 5, 1}
  end
  tokens = capacity
  lastMs = now
else
  tokens = math.min(capacity, tokens + (now - lastMs) * refillPerMs)
end
lastMs = now
local allowed = 0
local retryAfter = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retryAfter = math.max(1, math.ceil((cost - tokens) / refillPerMs / 1000))
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'lastMs', lastMs)
redis.call('EXPIRE', KEYS[1], ttlSec)
-- 审查 R3 残留：索引 score 每次访问都推进为最后活动时间（与桶 EXPIRE 续期对齐）。
-- 若只在创建时 ZADD，持续活跃的旧桶会在超过 TTL 窗口后被清扫误删，ZCARD 低估实际桶数、突破 maxKeys
redis.call('ZADD', KEYS[2], now, KEYS[1])
return {allowed, retryAfter, 0}
`;

// Redis 令牌桶限流器（§14.1/§15.7）：key 采用逻辑标识摘要（IP/会话均不存明文），
// 桶状态 {tokens,lastMs} 存 Hash，TTL 至少覆盖令牌回满时间，避免低速大桶被提前重置额度（§14.2）。
// 桶数上限 maxKeys：索引 ZSET 维护"近 TTL 窗口内活跃桶"，超限对新桶返回 capacityFull（可重试，不驱逐已有桶）。
// 每次 check 无条件消费令牌并返回是否允许；observe/enforce 的"只计数/拒绝"由 server 按模式决定（§16.3）。
export function createRedisLimiter({redis, run, keyPrefix = ACCESS_PREFIX, bucket, perMinute, burst, maxKeys = 20000, ttlSecondsOverride = null, now = Date.now} = {}) {
  const capacity = Math.max(0, burst);
  const refillPerMs = perMinute / 60000;
  // TTL 覆盖令牌回满时间并设 120s 下限（§14.2）；ttlSecondsOverride 仅供测试注入短窗口验证索引语义
  const ttlSeconds = ttlSecondsOverride ?? Math.max(120, Math.ceil(burst * 60 / perMinute) + 1);
  const indexKey = `${keyPrefix}lim:${bucket}:index`;
  return {
    async check(logicalKey, cost = 1) {
      const key = `${keyPrefix}lim:${bucket}:${digest(logicalKey)}`;
      const r = await run(LIMIT_SCRIPT, [key, indexKey], [capacity, refillPerMs, now(), cost, ttlSeconds, maxKeys]);
      return { ok: Number(r[0]) === 1, retryAfterSec: Number(r[1]), capacityFull: Number(r[2]) === 1 };
    },
  };
}

// 可信代理客户端 IP（方案 §5 末段 + §15.2.3）：仅当连接来自本机回环且启用代理信任时，
// 才采用专用客户端 IP 头（默认 x-real-ip，由 Nginx 覆写）。绝不读取 X-Forwarded-For 首项——
// 外部伪造的 XFF/X-Real-IP 在未启用信任或非回环连接时一律无效（验收 §15.5：伪造头不能换桶）。
// start:aigc. IP 规范化（第三批 B-04）：管理输入、代理输出、统计与限流共用同一 canonicalIp，
// 消除等价 IPv6 文本（压缩/前导零/大小写/IPv4-mapped）造成的"封禁键对不上"。
export function canonicalIp(input){
  let ip=String(input??'').trim().toLowerCase();
  if(!ip)return null;
  if(/^\d+\.\d+\.\d+\.\d+$/.test(ip)){const p=ip.split('.').map(Number);return p.every((x)=>x>=0&&x<=255)?ip:null;}
  // IPv6：尾段可为 IPv4 点分（::ffff:1.2.3.4）→ 转成两组十六进制（hi:lo 各两字节）
  const lastColon=ip.lastIndexOf(':');
  if(lastColon>=0&&ip.slice(lastColon+1).includes('.')){
    const p=ip.slice(lastColon+1).split('.').map(Number);
    if(p.length!==4||p.some((x)=>!Number.isInteger(x)||x<0||x>255))return null;
    const hi=(p[0]<<8|p[1]).toString(16),lo=(p[2]<<8|p[3]).toString(16);
    ip=ip.slice(0,lastColon+1)+hi+':'+lo;
  }
  const halves=ip.split('::');
  if(halves.length>2)return null;
  const head=halves[0]?halves[0].split(':'):[];
  const tail=halves.length===2&&halves[1]?halves[1].split(':'):[];
  if(halves.length===1&&head.length!==8)return null;
  const missing=8-head.length-tail.length;
  if(missing<0||(halves.length===1&&head.some((g)=>!/^[0-9a-f]{1,4}$/.test(g))))return null;
  const groups=[...head,...(halves.length===2?Array(Math.max(0,missing)).fill('0'):[]),...tail];
  if(groups.length!==8||groups.some((g)=>!/^[0-9a-f]{1,4}$/.test(g)))return null;
  const vals=groups.map((g)=>parseInt(g,16));
  // IPv4-mapped（::ffff:a.b.c.d）→ 输出 IPv4 文本，与既有去前缀行为保持同一键空间
  if(vals[0]===0&&vals[1]===0&&vals[2]===0&&vals[3]===0&&vals[4]===0&&vals[5]===0xffff)
    return `${vals[6]>>8}.${vals[6]&255}.${vals[7]>>8}.${vals[7]&255}`;
  // 压缩最长连续零段（≥2 组）为 '::'
  let bestStart=-1,bestLen=0,cur=0,curStart=0;
  vals.forEach((v,i)=>{if(v===0){if(cur===0)curStart=i;cur++;if(cur>bestLen){bestLen=cur;bestStart=curStart;}}else cur=0;});
  const hex=vals.map((v)=>v.toString(16));
  if(bestLen>=2)return hex.slice(0,bestStart).join(':')+'::'+hex.slice(bestStart+bestLen).join(':');
  return hex.join(':');
}
const LOOPBACK_IP=(ip)=>ip==='::1'||ip.startsWith('127.')||ip==='::'; // :: 为未指定，同样不采信
export function clientIp(req,{trustProxy=false,ipHeader='x-real-ip'}={}){
  const remote=canonicalIp(req.socket.remoteAddress||'')||'';
  if(trustProxy&&LOOPBACK_IP(remote)&&remote!=='::'){
    const v=canonicalIp(req.headers[ipHeader]||'');
    if(v)return v;
  }
  return remote;
}
// end:aigc.

// 保护配置装载（方案 §15.3：所有数量、时长、模式可配置并有合法范围校验；非法值启动即报错）
const int=(env,key,def,min,max)=>{
  if(env[key]===undefined||env[key]==='')return def;
  const v=Number(env[key]);
  if(!Number.isInteger(v)||v<min||v>max)throw new Error(`${key} 必须是 ${min}-${max} 的整数（当前：${env[key]}）`);
  return v;
};
export function loadProtectConfig(env=process.env){
  const mode=env.PROTECT_MODE===undefined||env.PROTECT_MODE===''?'observe':env.PROTECT_MODE;
  if(!['off','observe','enforce'].includes(mode))throw new Error(`PROTECT_MODE 必须是 off/observe/enforce（当前：${mode}）`);
  const trustProxy=env.TRUST_PROXY==='1';
  return {
    mode,trustProxy,
    ipHeader:String(env.CLIENT_IP_HEADER||'x-real-ip').toLowerCase(),
    sessionQuote:{perMinute:int(env,'QUOTE_SESSION_RATE_PER_MIN',240,1,100000),burst:int(env,'QUOTE_SESSION_BURST',30,1,100000)},
    ipQuote:{perMinute:int(env,'QUOTE_IP_RATE_PER_MIN',600,1,100000),burst:int(env,'QUOTE_IP_BURST',120,1,100000)},
    sessionIssue:{perMinute:int(env,'SESSION_ISSUE_RATE_PER_MIN',30,1,100000),burst:int(env,'SESSION_ISSUE_BURST',10,1,100000)},
    viewer:{
      idleMinutes:int(env,'VIEWER_IDLE_MINUTES',30,1,1440),
      cookieMaxAgeDays:int(env,'VIEWER_COOKIE_MAX_AGE_DAYS',7,1,365),
      maxSessions:int(env,'VIEWER_MAX_SESSIONS',10000,1,1000000),
    },
    cacheTtlMs:int(env,'SNAPSHOT_CACHE_TTL_MS',1000,250,10000),
  };
}
// end:aigc.
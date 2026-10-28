// start:aigc.
// 行情接口访问保护（方案 §5/§13.2/§15.2-15.3）：令牌桶限流、可信代理客户端 IP 提取、保护配置装载。
// 独立模块（方案 §8）：server.mjs 只做路由装配，不在此文件之外混入限流状态。

import {isIP} from 'node:net';

// 令牌桶：桶容量 = 突发余量 burst，按每毫秒 perMinute/60000 匀速回填。
// 语义即"持续速率 perMinute/分钟 + 突发 burst 次"：新 key 满桶起步，可持续以 perMinute 速率消费。
// key 桶总量有界（maxKeys + 空闲清扫），防止限流器自身内存膨胀（方案 §4.2/§15.2.4）。
export function createTokenBucketLimiter({perMinute,burst,maxKeys=20000,now=Date.now}){
  const capacity=Math.max(0,burst),refillPerMs=perMinute/60000,idleMs=120000;
  const buckets=new Map(); // key -> {tokens,lastMs}
  let overflow=0; // AP-04：容量饱和拒绝计数（用于观测"本应受限但因容量满被拒"的访问）
  // 空闲清扫：超过 idleMs 未活动的桶令牌已回满，可直接移除（再访问会满桶重建，语义不变）
  const sweep=(t)=>{for(const [k,b]of buckets)if(t-b.lastMs>idleMs)buckets.delete(k);};
  return {
    check(key,cost=1){
      const t=now();
      let b=buckets.get(key);
      if(!b){
        // AP-04：容量满且清扫无法释放时，对未记录 key 返回可重试拒绝并计数，不无限放行（§4.2 容量不足返回可重试错误）
        if(buckets.size>=maxKeys){sweep(t);if(buckets.size>=maxKeys){overflow++;return {ok:false,retryAfterSec:5};}}
        b={tokens:capacity,lastMs:t};buckets.set(key,b);
      }else{
        b.tokens=Math.min(capacity,b.tokens+(t-b.lastMs)*refillPerMs);b.lastMs=t;
      }
      if(b.tokens>=cost){b.tokens-=cost;return {ok:true,retryAfterSec:0};}
      return {ok:false,retryAfterSec:Math.max(1,Math.ceil((cost-b.tokens)/refillPerMs/1000))};
    },
    get size(){return buckets.size;},
    get overflow(){return overflow;},
  };
}

// 可信代理客户端 IP（方案 §5 末段 + §15.2.3）：仅当连接来自本机回环且启用代理信任时，
// 才采用专用客户端 IP 头（默认 x-real-ip，由 Nginx 覆写）。绝不读取 X-Forwarded-For 首项——
// 外部伪造的 XFF/X-Real-IP 在未启用信任或非回环连接时一律无效（验收 §15.5：伪造头不能换桶）。
const LOOPBACK=/^(127\.|::1$|::ffff:127\.|::ffff:0:0)/;
const normalizeIp=(ip)=>ip.startsWith('::ffff:')?ip.slice(7):ip;
export function clientIp(req,{trustProxy=false,ipHeader='x-real-ip'}={}){
  const remote=normalizeIp(req.socket.remoteAddress||'');
  if(trustProxy&&LOOPBACK.test(remote)){
    const v=String(req.headers[ipHeader]||'').trim();
    if(isIP(v)>0)return normalizeIp(v);
  }
  return remote;
}

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

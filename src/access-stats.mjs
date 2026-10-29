// start:aigc.
// 访问实时统计（方案 §3/§4/§6/§7）：/api/quotes 与 /api/viewer/session 的每分钟计数迁 Redis，
// 单请求最多一次短小原子脚本（计数 + TTL + IP 索引 + 会话去重 + 容量判定 + 迟到脏分钟登记），
// 失败只记统计缺口、不影响鉴权与行情（§8/§17.1.2）。MySQL 汇总由 access-flush.mjs 按绝对值落库（§7）。
// Redis 4 兼容：仅用 HINCRBY/EXPIRE/ZADD/ZSCORE/ZCARD/ZCOUNT/ZREMRANGEBYSCORE 等 2.8+ 命令。
// 二批审查修订：S2-02 迟到写登记 dirty；S2-03 缺口分钟持久化 Redis 且批量读取逐项校验；
// S2-04 读取经有界 batch runner、lastSeen 只取当前页；S2-05 去重刷新+窗口计数+截断标记；
// S2-06 wAny=每请求 0/1 的"应限流"口径（维度不叠加、e401 不混入）。

import {ACCESS_PREFIX, digest} from './redis-client.mjs';

// 统计字段口径（§3/§7）：req=行情请求总数（含拒绝）；ok/e401/e429=互斥结果分类；
// noSess/wSess/wIp=判定维度（可与结果交叉）；wAny=该请求是否"应限流"（0/1，黄灯阈值唯一口径 S2-06）；
// dSess/dIp=实际拒绝；issue*=会话发放单独计数
export const STAT_FIELDS=['req','ok','e401','e429','e5xx','blocked','noSess','wSess','wIp','wAny','dSess','dIp','issue','issueDeny','issueFull'];

// 容量与阈值配置（§6 上限 + §4 黄色初值，全可配置，非法值启动即报错）
const int=(env,key,def,min,max)=>{
  if(env[key]===undefined||env[key]==='')return def;
  const v=Number(env[key]);
  if(!Number.isInteger(v)||v<min||v>max)throw new Error(`${key} 必须是 ${min}-${max} 的整数（当前：${env[key]}）`);
  return v;
};
export function loadAccessStatsConfig(env=process.env){
  return {
    maxIps:int(env,'ACCESS_STATS_MAX_IPS',10000,100,100000),            // 最近 24h 跟踪 IP 上限（§6）
    retentionHours:int(env,'ACCESS_STATS_RETENTION_HOURS',48,1,168),     // 分钟桶 Redis 保留（迟到补传用）
    sessionDedupMax:int(env,'ACCESS_SESSION_DEDUP_MAX',100,10,1000),     // 单 IP 会话去重上限（§6 100+/分钟截断）
    sessionWindowMs:600000,                                              // 去重窗口 10 分钟（§3 口径）
    yellow:{                                                             // 黄灯阈值（§4，observe 阶段只标黄不拦截）
      wDenyPerMin:int(env,'ACCESS_YELLOW_WDENY_PERMIN',5,1,10000),
      req10m:int(env,'ACCESS_YELLOW_REQ_10M',50,1,1000000),
      noSessPct:int(env,'ACCESS_YELLOW_NOSESS_PCT',80,1,99),
      issuePerMin:int(env,'ACCESS_YELLOW_ISSUE_PERMIN',20,1,10000),
    },
  };
}

// 分钟桶 Hash 键等 key 构造（ipDigest 编码进键，不拼原始头部内容 §6）
const minuteKey=(p,m,d)=>`${p}stat:m:${m}:${d}`;
const OTHER=()=>digest('__other__'); // 超容量聚合桶（§6 "其他访问"总量）
const ALL=()=>digest('__all__');     // 全局分钟桶（顶部"过去一分钟请求数"）

// 共用 Lua 片段：target 选择（新 IP 超 maxIps 转 other 桶）+ 最近 IP 索引 + 分钟 IP 索引
// + 分钟写版本（CAS 确认依据）+ 无条件登记"待交付分钟"（S2-02 三轮：写入侧完全不依赖客户端水位——
// 任何写入（无论多迟）都会把所属分钟放回交付队列，确认后到达的写入由下轮重扫兜住，无水位新鲜度窗口）
// KEYS: 1=本IP分钟桶 2=other桶 3=all桶 4=最近IP索引 5=分钟IP索引 6=会话去重ZSET
//       7=（保留位，不再使用）8=会话截断标记键 9=待交付分钟索引 10=分钟写版本键
// ARGV: 1=now(ms) 2=minute 3=ip 4=ipDigest 5=maxIps 6=ttlSec ...
const SHARED=()=>`
local now = tonumber(ARGV[1]); local minute = tonumber(ARGV[2]); local ip = ARGV[3]
local maxIps = tonumber(ARGV[5]); local ttl = tonumber(ARGV[6])
-- 每次写入递增该分钟版本：flusher 快照读 ver0、提交后 CAS 确认，版本前进=有并发写入
redis.call('INCR', KEYS[10])
redis.call('EXPIRE', KEYS[10], ttl)
local member = ip
local target = KEYS[1]
if redis.call('ZSCORE', KEYS[4], ip) then
  redis.call('ZADD', KEYS[4], now, ip)
else
  -- 先清扫 24h 外的最近 IP 再判容量（§6 索引同步清扫）；仍满则该 IP 计入 other，不建独立记录
  redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now - 86400000)
  if redis.call('ZCARD', KEYS[4]) >= maxIps then target = KEYS[2]; member = '__other__'
  else redis.call('ZADD', KEYS[4], now, ip) end
end
redis.call('ZADD', KEYS[5], minute, member)
redis.call('ZADD', KEYS[5], minute, '__all__')
redis.call('EXPIRE', KEYS[5], ttl)
-- 无条件登记待交付：flusher 只扫此索引，CAS 确认版本未变才移除；确认后的新写入自动重回队列
redis.call('ZADD', KEYS[9], minute, minute)
`;

// 行情请求计数：ARGV[7..16]=ok,noSess,e401,wSess,wIp,dSess,dIp,e5xx,wAny,blocked（0/1）；e429=dSess+dIp；
// ARGV[17]=会话摘要（空=无）18=去重窗口毫秒 19=去重上限
const QUOTE_SCRIPT = SHARED() + `
local deltas = {{'ok',tonumber(ARGV[7])},{'noSess',tonumber(ARGV[8])},{'e401',tonumber(ARGV[9])},{'wSess',tonumber(ARGV[10])},{'wIp',tonumber(ARGV[11])},{'dSess',tonumber(ARGV[12])},{'dIp',tonumber(ARGV[13])},{'e5xx',tonumber(ARGV[14])},{'wAny',tonumber(ARGV[15])},{'blocked',tonumber(ARGV[16])}}
local e429 = tonumber(ARGV[12]) + tonumber(ARGV[13])
for _,k in ipairs({target, KEYS[3]}) do
  redis.call('HINCRBY', k, 'req', 1)
  if e429 > 0 then redis.call('HINCRBY', k, 'e429', e429) end
  for _,d in ipairs(deltas) do if d[2] > 0 then redis.call('HINCRBY', k, d[1], d[2]) end end
  redis.call('EXPIRE', k, ttl)
end
-- 会话去重（S2-05）：已存在成员无条件刷新 score（持续访问不被旧时间清掉）；
-- 新成员先窗口清扫再判容量，超限丢弃并置截断标记（PX=窗口，查询显示"已截断"）
local sessD = ARGV[17]
if sessD ~= '' and target == KEYS[1] then
  local w = tonumber(ARGV[18]); local cap = tonumber(ARGV[19])
  if redis.call('ZSCORE', KEYS[6], sessD) then
    redis.call('ZADD', KEYS[6], now, sessD)
  else
    redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', now - w)
    if redis.call('ZCARD', KEYS[6]) < cap then redis.call('ZADD', KEYS[6], now, sessD)
    else redis.call('SET', KEYS[8], '1', 'PX', w) end
  end
  redis.call('EXPIRE', KEYS[6], ttl)
end
return 1
`;

// 会话发放计数：ARGV[7..9]=issue,issueDeny,issueFull（0/1）。不计入行情 req（§3 发放单独统计）
const ISSUE_SCRIPT = SHARED() + `
local issue = tonumber(ARGV[7]); local deny = tonumber(ARGV[8]); local full = tonumber(ARGV[9])
for _,k in ipairs({target, KEYS[3]}) do
  if issue > 0 then redis.call('HINCRBY', k, 'issue', issue) end
  if deny > 0 then redis.call('HINCRBY', k, 'issueDeny', deny) end
  if full > 0 then redis.call('HINCRBY', k, 'issueFull', full) end
  redis.call('EXPIRE', k, ttl)
end
return 1
`;

// 缺口标记原子脚本（直接路径）：计数 + 保留期 + 待交付登记 + 分钟版本推进。
// 版本推进是关键（第四版复核）：缺口改变分钟完整性，必须与普通写入一样参与版本协议——
// 否则 flusher 提交期间新增的缺口会被 CAS 当"版本未变"清掉待交付登记，complete=1 永不降级。
// KEYS: 1=缺口哈希 2=待交付分钟索引 3=分钟写版本；ARGV: 1=minute 2=保留期秒
const LOSS_MARK_SCRIPT=`
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1])
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[2]))
return 1`;

// 缺口补写原子脚本（S2-03 三轮，兜底恢复路径）：KEYS[1]=缺口哈希 KEYS[2]=待交付分钟索引
// KEYS[3]=分钟写版本；ARGV[1]=minute ARGV[2]=兜底累计次数 ARGV[3]=保留期秒。
// ① 待交付登记（幂等，可安全重放）② synced 幂等标记（提交点，值为次数——标记存在即缺口证据，
// 即便 ③ 失败该分钟仍会被 lossMinutes 列出并降级 complete=0）③ 计数累加（仅首次）④ 保留期
// ⑤ 分钟版本推进（与 LOSS_MARK 同理：完整性变化必须让 CAS 失配，重试多推一次只会引发幂等重扫）。
const LOSS_SYNC_SCRIPT=`
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1])
if redis.call('HSETNX', KEYS[1], 'synced:'..ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[1], ARGV[1], tonumber(ARGV[2]))
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[3]))
return 1`;

// 灯色分类（§4，S2-06 修订）：第 1 条阈值只看 wAny（每请求 0/1 的"应限流"并集，不叠维度、不含 401）；
// 无会话走独立的第 2 条（量+占比联合判定）。红灯留给第三批手动封禁；输入为完整分钟聚合。
export function classifyStatus(m1,m10,cfg){
  const reasons=[];
  const w1=m1.wAny||0;
  if(w1>=cfg.yellow.wDenyPerMin)reasons.push(`最近完整1分钟应限流请求 ${w1} 次（阈值 ${cfg.yellow.wDenyPerMin}）`);
  const req10=(m10.req||0),noSess10=(m10.noSess||0);
  if(req10>=cfg.yellow.req10m&&noSess10*100>=req10*cfg.yellow.noSessPct)
    reasons.push(`10分钟 ${req10} 次请求中 ${Math.round(noSess10*100/Math.max(1,req10))}% 无有效会话，可能为旧页面或脚本`);
  const iss1=(m1.issue||0);
  if(iss1>=cfg.yellow.issuePerMin)reasons.push(`最近完整1分钟新建会话 ${iss1} 个（阈值 ${cfg.yellow.issuePerMin}）`);
  return {status:reasons.length?'yellow':'green',reasons};
}

const emptyFields=()=>Object.fromEntries(STAT_FIELDS.map((f)=>[f,0]));
const toFields=(raw)=>{const o=emptyFields();for(const f of STAT_FIELDS)o[f]=Number(raw?.[f]||0);return o;};
const sumFields=(list)=>{const o=emptyFields();for(const f of STAT_FIELDS)for(const r of list)o[f]+=r[f]||0;return o;};

export function createAccessStats({redis,run,batch,keyPrefix=ACCESS_PREFIX,cfg=loadAccessStatsConfig(),now=Date.now}={}){
  const ipsKey=`${keyPrefix}stat:ips`;
  const dirtyKey=`${keyPrefix}stat:dirty`; // 待交付分钟索引（S2-02 三轮：唯一交付队列，写入无条件登记）
  const lossKey=`${keyPrefix}stat:loss`;
  const miKey=(m)=>`${keyPrefix}stat:mi:${m}`;
  const sessKey=(d)=>`${keyPrefix}stat:sess:${d}`;
  const sessFullKey=(d)=>`${keyPrefix}stat:sessfull:${d}`;
  const verKey=(m)=>`${keyPrefix}stat:ver:${m}`;
  const minuteOf=(t)=>Math.floor(t/60000);
  // 统计缺口（§8 + S2-03 三轮）：直接路径经 LOSS_MARK 原子脚本（计数+登记待交付）；
  // 脚本失败（Redis 不可用）才落有界进程级兜底（分钟→次数，上限 2880 条=48h 保留期维度），
  // 恢复后由 lossMinutes 经 LOSS_SYNC 原子脚本补写回填（synced 幂等标记防翻倍）。
  const health={lastOkAt:0};
  const lossFallback=new Map();
  const markLoss=(t=now())=>{
    const m=minuteOf(t);
    // 原子脚本失败（Redis 不可用）才落进程兜底；回复丢失的极端重试可能使计数偏大，
    // 但 synced 幂等标记保证不重复翻倍、缺口证据与交付登记始终成立
    Promise.resolve(run(LOSS_MARK_SCRIPT,[lossKey,dirtyKey,verKey(m)],[String(m),String(cfg.retentionHours*3600)])).catch(()=>{
      lossFallback.set(m,(lossFallback.get(m)||0)+1);
      if(lossFallback.size>2880)lossFallback.delete([...lossFallback.keys()].sort((a,b)=>a-b)[0]);
    });
  };
  const fire=(script,keys,args)=>{const t=now();Promise.resolve(run(script,keys,args)).then(()=>{health.lastOkAt=t;}).catch(()=>markLoss(t));};
  // keysFor：KEYS[7] 为保留位（旧分钟全局索引已并入待交付索引），保持位置稳定避免脚本下标漂移
  const keysFor=(t,ip)=>{const m=minuteOf(t);return{m,keys:[minuteKey(keyPrefix,m,digest(ip)),minuteKey(keyPrefix,m,OTHER()),minuteKey(keyPrefix,m,ALL()),ipsKey,miKey(m),sessKey(digest(ip)),'unused',sessFullKey(digest(ip)),dirtyKey,verKey(m)]};};

  // 单成员聚合命令组（listIps/ipTrend 共用口径）：11 个分钟桶 + 窗口会话计数 + 截断标记 + 最近访问
  const memberCmds=(d,t)=>{
    const cur=minuteOf(t);const cmds=[];
    for(let k=10;k>=0;k--)cmds.push(['hgetall',minuteKey(keyPrefix,cur-k,d)]);
    cmds.push(['zcount',sessKey(d),String(t-cfg.sessionWindowMs),'+inf']);
    cmds.push(['exists',sessFullKey(d)]);
    return cmds;
  };

  return {
    health,markLoss,dirtyKey,ipsKey,miKey,sessKey,sessFullKey,verKey,minuteOf,OTHER,ALL,lossKey,
    minuteHashKey:(m,ip)=>minuteKey(keyPrefix,m,digest(ip)),
    async minuteHash(m,ip){return redis.hgetall(minuteKey(keyPrefix,m,digest(ip)));},
    // 缺口补写原子脚本（S2-03 三轮）：待交付登记（幂等可重放）+ synced 幂等标记（提交点，值=次数）
    // + 计数 HINCRBY + 保留期，四步单脚本原子完成；回复丢失重试时标记已存在 → 不重复累加。
    // synced:m 标记本身就是缺口证据：即使计数命令丢失，lossMinutes 仍列出该分钟，落库降级 complete=0 不受影响。
    async lossMinutes(){
      const h=await redis.hgetall(lossKey).catch(()=>({}));
      const recovered=[]; // 本次补写成功的分钟（h 快照读于补写前，需并入结果保证可见）
      if(lossFallback.size){
        for(const [m,c] of [...lossFallback]){
          try{
            await run(LOSS_SYNC_SCRIPT,[lossKey,dirtyKey,verKey(m)],[String(m),String(c),String(cfg.retentionHours*3600)]);
            recovered.push(m);
            lossFallback.delete(m); // 原子脚本整体确认成功才删兜底：登记/标记/计数任一失败都会抛错保留重试
          }catch{break;} // Redis 仍不可用：保留兜底，下次再补（synced 标记保证重试不翻倍）
        }
      }
      const minutes=new Set(recovered);
      for(const k of Object.keys(h)){
        const m=k.startsWith('synced:')?Number(k.slice(7)):Number(k); // synced 标记也计入缺口分钟（见脚本注释）
        if(Number.isFinite(m))minutes.add(m);
      }
      for(const m of lossFallback.keys())minutes.add(m);
      return [...minutes].sort((a,b)=>a-b);
    },
    // 单分钟缺口状态（第四版复核：flusher 必须在读取版本之后、读取桶数据之前调用——
    // 此时读到的缺口状态与 ver0 严格对应，ver0 之后的缺口写入会推版本使 CAS 失配触发重扫）。
    // 计数字段或 synced 标记任一存在即缺口（synced 本身即证据）。
    async minuteLoss(m){
      const v=await redis.hmget(lossKey,String(m),`synced:${m}`);
      return v[0]!=null||v[1]!=null;
    },

    // 行情请求：flags={ok,noSess,e401,wSess,wIp,wAny,dSess,dIp,e5xx,blocked,session?}；opts.skip=true 只记缺口
    recordQuote(ip,flags={},opts={}){
      if(opts.skip)return markLoss();
      const t=now();const{m,keys}=keysFor(t,ip);
      fire(QUOTE_SCRIPT,keys,[t,m,ip,digest(ip),cfg.maxIps,cfg.retentionHours*3600,
        flags.ok?1:0,flags.noSess?1:0,flags.e401?1:0,flags.wSess?1:0,flags.wIp?1:0,flags.dSess?1:0,flags.dIp?1:0,flags.e5xx?1:0,flags.wAny?1:0,flags.blocked?1:0,
        flags.session?digest(flags.session):'',cfg.sessionWindowMs,cfg.sessionDedupMax]);
    },
    // 会话发放：flags={issue,issueDeny,issueFull}（互斥；503 容量满只计 issueFull，不算成功新建 S2-06）
    recordIssue(ip,flags={}){
      const t=now();const{m,keys}=keysFor(t,ip);
      fire(ISSUE_SCRIPT,keys,[t,m,ip,digest(ip),cfg.maxIps,cfg.retentionHours*3600,flags.issue?1:0,flags.issueDeny?1:0,flags.issueFull?1:0]);
    },

    // 访问管理列表（§3 + S2-04）：lastSeen 排序只取当前页（offset/size）再聚合，不构建深分页全量命令；
    // req10m 排序最多聚合 scanLimit 个最近 IP（有界，超出提示截断）。聚合经 batch runner 单执行层，
    // 任一子命令失败整体上抛（S2-03：绝不显示伪绿/零值）
    async listIps({page=1,size=50,ip=null,sort='lastSeen',scanLimit=500}={}){
      const t=now();const wStart=t-86400000;const cur=minuteOf(t);
      let members;
      if(ip){ // 精确筛选：IP 必须仍在最近访问索引中（members 统一为 IP 字符串）
        const score=await redis.zscore(ipsKey,ip);
        members=score?[ip]:[];
      }else if(sort==='req10m'){
        members=await redis.zrevrangebyscore(ipsKey,'+inf',wStart,'LIMIT',0,scanLimit);
      }else{
        members=await redis.zrevrangebyscore(ipsKey,'+inf',wStart,'LIMIT',(page-1)*size,size); // 只取当前页
      }
      const total=ip?members.length:await redis.zcount(ipsKey,wStart,'+inf');
      const truncated=!ip&&sort==='req10m'&&total>scanLimit;
      const agg={};
      if(members.length){
        const cmds=[];
        for(const one of members){cmds.push(...memberCmds(digest(one),t),['zscore',ipsKey,one]);}
        const res=await batch(cmds); // 逐项校验：任一失败上抛（S2-03）
        let i=0;
        for(const one of members){
          const buckets=res.slice(i,i+11).map(toFields);
          const sessions10m=Number(res[i+11])||0,truncatedFlag=Number(res[i+12])===1,lastSeen=Number(res[i+13])||0;
          i+=14;
          agg[one]={lastSeen,m1:buckets[9],m10:sumFields(buckets.slice(0,10)),cur:buckets[10],
            sessions10m,sessionsTruncated:truncatedFlag}; // 截断以显式标记为准（S2-05），不由数量推测
        }
      }
      let rows=members.map((one)=>({ip:one,...agg[one],...classifyStatus(agg[one].m1,agg[one].m10,cfg)}));
      if(sort==='req10m')rows.sort((a,b)=>b.m10.req-a.m10.req);
      // lastSeen/精确筛选：ZSET 已按 offset/size 取过当前页，不再二次切片；仅 req10m 需在候选内分页
      const start=(ip||sort==='lastSeen')?0:(page-1)*size;
      return {rows:rows.slice(start,start+size),total,truncated,page,size,generatedAt:t};
    },

    // 单 IP 分钟趋势（§10 /ip）：最近 N 个分钟桶 + 窗口会话数 + 截断标记
    async ipTrend(ip,{minutes=60}={}){
      const t=now();const cur=minuteOf(t);const d=digest(ip);
      const cmds=[];
      for(let k=minutes-1;k>=0;k--)cmds.push(['hgetall',minuteKey(keyPrefix,cur-k,d)]);
      cmds.push(['zcount',sessKey(d),String(t-cfg.sessionWindowMs),'+inf'],['exists',sessFullKey(d)],['zscore',ipsKey,ip]);
      const res=await batch(cmds);
      const rows=res.slice(0,minutes).map((raw,idx)=>({minuteUtc:cur-minutes+1+idx,fields:toFields(raw)})).filter((r)=>r.fields.req>0||r.fields.issue>0);
      return {ip,rows,sessions10m:Number(res[minutes])||0,sessionsTruncated:Number(res[minutes+1])===1,lastSeen:Number(res[minutes+2])||0,generatedAt:t};
    },
  };
}
// end:aigc.
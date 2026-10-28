import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve,extname} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store,passwordHash,passwordMatches,validPassword} from './store.mjs';
// start:aigc.
import {validateConfig,validateCatalog,snapshot} from './config.mjs';
import {createHealthSyncer} from './health-sync.mjs';
// end:aigc.
// start:aigc.
import {createSinaAdapter} from './sina.mjs';
import {createWscnAdapter} from './wscn.mjs';
import {createTencentAdapter} from './tencent.mjs';
import {createItickAdapter} from './itick.mjs';
import {Quotes} from './quotes.mjs';
import {createRtj} from './rtj.mjs';
// end:aigc.
// start:aigc.
// 访问保护（方案 §13-§17）：令牌桶限流/可信 IP/配置装载 + 访客会话 + 快照缓存独立模块（§8 模块划分）
import {createTokenBucketLimiter,clientIp,loadProtectConfig} from './rate-limit.mjs';
import {createViewerSessions} from './viewer-session.mjs';
import {createSnapshotCache} from './snapshot-cache.mjs';
// end:aigc.
// start:aigc.
// HTTP 源注册表（2026-10-28 重构）：新增一个 HTTP 源 = 新协议模块 + 此处加一项，
// 不再触碰 server 的 import 之外的启动/命名/关闭逻辑（适配器契约由 Quotes.attach 统一管理）。
// R01：注册项带来源 id，装配时按 sources 表 enabled/poll_ms/timeout_ms 生效
const HTTP_ADAPTERS=[
  ['sina',createSinaAdapter],['wscn',createWscnAdapter],['tencent',createTencentAdapter],['itick',createItickAdapter],
];
// end:aigc.

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// start:aigc.
// R07（2026-10-28 三查）：rtj 订阅表只保留"基础行情启用 + rtj 映射启用 + code 非空"的行——
// 单品种/映射停用后不再握手、订阅、重连；不为缺映射的行情生成 code:null 占位，
// 堵住 QuoteFeed.resolveCatalog 按源站 metadata 自动补码恢复订阅的通路（R05 同源问题）。
// 返回空数组时调用方直接跳过 attach（空订阅零连接）
export function buildRtjMap(baseQuotes){
  const out=[];
  for(const b of baseQuotes){
    if(b.enabled===false)continue;                    // 基础行情停用：不订阅
    const s=(b.sources||[]).find((x)=>x.sourceId==='rtj');
    if(s&&s.enabled!==false&&s.code&&s.code!=='__NONE__')out.push({symbol:b.symbol,code:s.code,kind:s.kind??'plain'});
  }
  return out;
}
// end:aigc.
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const error=(status,message)=>Object.assign(new Error(message),{status});
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256000)throw error(413,'请求内容过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error(400,'JSON格式无效');}}

export async function createApp({dataDir=join(project,'data'),quotes=null,publicOrigin=process.env.PUBLIC_ORIGIN||null,protect:protectOverride=null}={}){
  // start:aigc. MySQL 改造：Store.create() 异步建池建表（方案第 6.1 节启动顺序）
  const store=await Store.create(dataDir),sessions=new Map(),attempts=new Map();
  let closing=false;
  // 组装聚合层：默认按 SQLite 目录构建真实适配器（生产 main 调 start() 时才连网）；
  // 注入聚合层实例（测试）时不连网。来源切换写运行日志（switch_log 表）。
  // publish 由 1 秒定时器驱动，把选定 tick 刷成公式键与来源元数据。
  const baseQuotes=await store.baseQuotes();
  // start:aigc. R01/R05（2026-10-28 复查）：来源级配置先于聚合层装配——
  // sources 表 enabled=0 的源，其映射行从目录副本剔除，且该副本同时用于构造 Selector、
  // rtj 订阅与全部 HTTP 适配器（R05：修"过滤在 aggregator 构造之后，Selector 仍保留
  // 全局禁用来源 + rtj 无条件 attach + resolveCatalog 补码绕过停用"的组合漏洞）；
  // poll_ms/timeout_ms 传给运行器（运行器内钳制安全下限）。测试注入聚合层时不读库
  let sourceCfgById=new Map();
  if(!quotes)for(const s of await store.sources())sourceCfgById.set(s.id,s);
  const activeQuotes=baseQuotes.map((b)=>({...b,sources:(b.sources||[]).filter((s)=>sourceCfgById.get(s.sourceId)?.enabled!==0)}));
  // switch_log 异步写入 fire-and-forget：失败记日志不静默丢失（方案 6.2），不阻塞行情主流程
  const aggregator=quotes??new Quotes({baseQuotes:activeQuotes,categories:await store.categories(),onSwitch:(e)=>{store.appendSwitchLog({...e,reason:'来源切换'}).catch((err)=>console.error('[switch_log] 写入失败:',err.message));}});
  // end:aigc.
  let stopTimer=null,started=false;
  // start:aigc.
  // iTick Token 后台配置（设计文档"数据源管理"：凭据加密保存）：
  // 后台密钥(source_secrets 表)优先，环境变量 ITICK_TOKEN 兼容兜底，均未配置则适配器降级为空。
  // F04（四查）：凭据来源的展示（后台/环境变量）由 /api/admin/sources 按请求动态计算。
  // 解密失败（如 secret.key 丢失）不阻断启动：降级 env、记日志并保留原因进红绿灯 note
  let itickToken=null,itickNote=null;
  try{
    const secret=await store.getSourceSecret('itick');
    if(secret!=null)itickToken=secret;
  }catch(err){
    console.error('[itick] 后台密钥读取失败，回落环境变量:',err.message);
    itickNote=`后台密钥读取失败：${err.message}`;
  }
  if(itickToken==null&&process.env.ITICK_TOKEN)itickToken=process.env.ITICK_TOKEN;
  // end:aigc.
  // start:aigc.
  // 访问保护装配（方案 §15.2/§16.3）：配置可注入（测试）或从环境装载（含合法范围校验，非法启动即报错）。
  // 三态模式 off/observe/enforce（§15.2.8）：observe 用同一套判定逻辑只记"会被拒"指标不实际拒绝；
  // 快照缓存（§15.2.5-6）：请求触发 + TTL 复用 + 单航次重建 + 代次保护，鉴权/限流先于缓存命中。
  const protectCfg={...loadProtectConfig(),...(protectOverride||{})};
  const secure=publicOrigin?.startsWith('https://')?' Secure;':'';
  const viewerSessions=createViewerSessions({
    idleMs:protectCfg.viewer.idleMs??protectCfg.viewer.idleMinutes*60000, // idleMs 供测试注入更细粒度，env 侧只有分钟
    maxSessions:protectCfg.viewer.maxSessions,
    cookieMaxAgeSec:protectCfg.viewer.cookieMaxAgeDays*86400,
  });
  const limitSessionQuote=createTokenBucketLimiter(protectCfg.sessionQuote);
  const limitIpQuote=createTokenBucketLimiter(protectCfg.ipQuote);
  const limitIssue=createTokenBucketLimiter(protectCfg.sessionIssue);
  const snapshotCache=createSnapshotCache({
    ttlMs:protectCfg.cacheTtlMs,
    build:async()=>{
      const snap=await store.catalogSnapshot();
      return Buffer.from(JSON.stringify(snapshot({...snap.config,categories:snap.categories},aggregator)),'utf8');
    },
  });
  // 聚合计数（§13.6/§15.2.8）：只记数量与字节数，不记 Cookie/Token/请求头（§8 日志脱敏）
  const counters={quotes200:0,quoteBytes:0,quote503:0,noSessionWouldDeny:0,noSessionDenied:0,sessionLimitWouldDeny:0,sessionLimitDenied:0,ipLimitWouldDeny:0,ipLimitDenied:0,issueWouldDeny:0,issueDenied:0};
  // end:aigc.
  const start=()=>{
    if(started)return stopTimer;   // 幂等：重复 start 不重复建连，避免旧 WebSocket/轮询/定时器泄漏
    started=true;
    if(!quotes){
      // start:aigc. R05/R07：rtj 全局停用不 attach；订阅表只保留明确启用的 rtj 映射——
      // 不为无 rtj 映射的行情生成 code:null 占位，堵住 resolveCatalog 按源站 metadata
      // 自动补码恢复订阅、绕过全局停用的通路
      if(sourceCfgById.get('rtj')?.enabled!==0){
        const rtjMap=buildRtjMap(activeQuotes);
        if(rtjMap.length)aggregator.attach(createRtj({map:rtjMap}));
      }
      // end:aigc.
      // start:aigc. 2026-10-28 重构：全部 HTTP 源走注册表 + 统一适配器契约。
      // 来源名注册、失败通知(markFailure)、stop 清理由 Quotes.attach/stop 统一承担；
      // 目录无启用映射时适配器零轮询；itick 未配 Token 自动降级为空适配器；
      // R01：来源级 enabled=0 跳过装配，poll_ms/timeout_ms 传入运行器
      for(const [sourceId,create] of HTTP_ADAPTERS){
        const cfg=sourceCfgById.get(sourceId);
        if(cfg?.enabled===0)continue;   // 全局停用的源零启动
        const opts={pollMs:cfg?.poll_ms??null,timeoutMs:cfg?.timeout_ms??null};
        if(sourceId==='itick')opts.token=itickToken;   // 后台密钥优先，env 兜底（未配置则空适配器）
        aggregator.attach(create(activeQuotes,opts));
      }
      // end:aigc.
    }
    const timer=setInterval(()=>aggregator.publish(),1000);timer.unref();
    // start:aigc. 红绿灯持久化（仅生产装配）：health-sync 模块统一承担节流、失败重试与
    // 防重叠（F03）；null 不覆盖库中历史值由 store.updateSourceHealth 的 COALESCE 保证（F02）
    let healthSyncer=null;
    if(!quotes)healthSyncer=createHealthSyncer({store,sourceStatus:()=>aggregator.sourceStatus()});
    stopTimer=()=>{clearInterval(timer);healthSyncer?.stop();};return stopTimer;
  };
  // end:aigc.
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const cookie=(req)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lcjy_session='))?.slice(13);
  const session=(req)=>{const id=cookie(req),s=sessions.get(id);if(!s||s.expires<Date.now()){if(id)sessions.delete(id);return null;}return s;};
  // start:aigc.
  // 访客 Cookie 解析与回写串（与管理员 lcjy_session 分开命名，§4.1；HttpOnly/SameSite=Strict/Path=/，HTTPS 时加 Secure）
  const viewerCookie=(req)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lcjy_viewer='))?.slice(12);
  const viewerCookieStr=(id)=>`lcjy_viewer=${id}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${protectCfg.viewer.cookieMaxAgeDays*86400}`;
  // end:aigc.
  function login(res){const token=randomBytes(32).toString('hex'),s={csrf:randomBytes(24).toString('hex'),expires:Date.now()+8*3600000};sessions.set(token,s);res.setHeader('set-cookie',`lcjy_session=${token}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=28800`);return {authenticated:true,csrf:s.csrf};}
  // start:aigc.
  // 13.1 修复：admin 限流键改为可信代理客户端 IP（原 socket.remoteAddress 在 Nginx 反代后恒为 127.0.0.1，
  // 全站共享一个 12 次/分钟桶，刷登录即可锁死管理员登录）。访客与管理员计数器彼此独立（§15.2.3）
  function rateLimit(req){const ip=clientIp(req,protectCfg),now=Date.now();let a=attempts.get(ip);if(!a||now-a.start>60000){a={start:now,count:0};attempts.set(ip,a);}if(++a.count>12)throw error(429,'尝试过多，请一分钟后重试');}
  // end:aigc.
  // start:aigc.
  // 定时清理：admin 会话/尝试计数沿用原逻辑；追加访客会话空闲清扫（§4.2）。
  // 保护指标每分钟输出一条聚合日志（增量，§13.6）：只含模式/会话数/计数与字节数，无凭据无 IP 明细
  const cleanup=setInterval(()=>{const now=Date.now();for(const [k,v]of sessions)if(v.expires<now)sessions.delete(k);for(const [k,v]of attempts)if(now-v.start>60000)attempts.delete(k);viewerSessions.sweep();},60000);cleanup.unref();
  let protectPrev={};
  const protectLog=setInterval(()=>{
    const snap={...counters,...snapshotCache.stats};
    const delta={};for(const k of Object.keys(snap))delta[k]=snap[k]-(protectPrev[k]||0);
    protectPrev=snap;
    console.info('[protect]',JSON.stringify({mode:protectCfg.mode,sessions:viewerSessions.size,...delta}));
  },60000);protectLog.unref();
  // end:aigc.
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://www.jin10.com https://rili-d.jin10.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try{
      const host=req.headers.host||'',origin=publicOrigin||`http://${host}`;
      const hostname=host.split(':')[0];
      if(publicOrigin?host!==new URL(publicOrigin).host:!['127.0.0.1','localhost'].includes(hostname))throw error(403,'访问主机未配置，请设置PUBLIC_ORIGIN');
      const path=new URL(req.url,origin).pathname;
      if(req.method==='POST'){
        if(req.headers.origin!==origin)throw error(403,'只允许同站操作');
        if(!req.headers['content-type']?.startsWith('application/json'))throw error(415,'需要JSON请求');
      }
      // start:aigc.
      // 访客会话发放（§4.1/§4.2）：同源 POST（上方已有 Origin/JSON 全局校验）；
      // 有效 Cookie 幂等复用（不消耗发放额度）；Fetch Metadata 仅拒明显跨站，非真人证明
      if(path==='/api/viewer/session'&&req.method==='POST'){
        if(req.headers['sec-fetch-site']==='cross-site')throw error(403,'跨站请求被拒绝');
        const id=viewerCookie(req),existing=viewerSessions.get(id);
        const policy={idleMinutes:protectCfg.viewer.idleMinutes,cookieMaxAgeDays:protectCfg.viewer.cookieMaxAgeDays};
        if(existing){
          if(viewerSessions.touch(existing))res.setHeader('set-cookie',viewerCookieStr(id));
          json(res,200,{ok:true,reused:true,policy});return;
        }
        // 新会话：每 IP 发放限流（off 跳过；observe 计数放行；enforce 429 + Retry-After，不永久封禁）
        const issueIp=clientIp(req,protectCfg);
        const issueResult=protectCfg.mode==='off'?{ok:true}:limitIssue.check(issueIp);
        if(!issueResult.ok){
          if(protectCfg.mode==='enforce'){counters.issueDenied++;res.setHeader('retry-after',issueResult.retryAfterSec);throw error(429,'会话创建过于频繁，请稍后重试');}
          counters.issueWouldDeny++;
        }
        const newId=viewerSessions.issue();
        if(!newId){res.setHeader('retry-after',5);throw error(503,'服务繁忙，请稍后重试');} // 容量满：可重试错误，不驱逐正常看盘会话（§4.2）
        res.setHeader('set-cookie',viewerCookieStr(newId));
        json(res,200,{ok:true,reused:false,policy});return;
      }
      // 公开行情：鉴权与限流先于缓存命中（§14.4 规则4）；会话/IP 两层限流 + 无会话判定共用一套逻辑，
      // observe 只记"会被拒"指标、enforce 才实际拒绝（§15.2.8）；缓存重建失败转 503（§15.2.6）
      if(path==='/api/quotes'&&req.method==='GET'){
        let renewId=null;
        if(protectCfg.mode!=='off'){
          const vid=viewerCookie(req),vs=viewerSessions.get(vid),ip=clientIp(req,protectCfg);
          if(!vs){
            if(protectCfg.mode==='enforce'){counters.noSessionDenied++;throw error(401,'会话无效，请刷新页面');}
            counters.noSessionWouldDeny++;
          }
          if(vs){
            const v=limitSessionQuote.check(vid);
            if(!v.ok){
              if(protectCfg.mode==='enforce'){counters.sessionLimitDenied++;res.setHeader('retry-after',v.retryAfterSec);throw error(429,'请求过于频繁，请稍后重试');}
              counters.sessionLimitWouldDeny++;
            }
          }
          const vi=limitIpQuote.check(ip);
          if(!vi.ok){
            if(protectCfg.mode==='enforce'){counters.ipLimitDenied++;res.setHeader('retry-after',vi.retryAfterSec);throw error(429,'请求过于频繁，请稍后重试');}
            counters.ipLimitWouldDeny++;
          }
          if(vs&&viewerSessions.touch(vs))renewId=vid; // 成功访问刷新空闲期；Cookie 剩余不足一天续写
        }
        let body;
        try{body=await snapshotCache.get();}catch{counters.quote503++;res.setHeader('retry-after',1);throw error(503,'行情暂时不可用，请稍后重试');}
        counters.quotes200++;counters.quoteBytes+=body.length;
        res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...(renewId?{'set-cookie':viewerCookieStr(renewId)}:{})});
        res.end(body);return;
      }
      // end:aigc.
      if(path==='/api/admin/session'&&req.method==='GET'){const s=session(req);json(res,200,{authenticated:!!s,needsSetup:!(await store.hasAdmin()),csrf:s?.csrf||null});return;}
      if(path==='/api/admin/setup'&&req.method==='POST'){
        rateLimit(req);if(await store.hasAdmin())throw error(409,'管理员已经初始化');const data=await body(req);
        if(!store.checkSetup(data.setupToken))throw error(403,'初始化令牌错误');validPassword(data.password);
        // R2 修复：写入改为原子"仅插入"——两个并发初始化只有一个成功，另一个得到 409
        const hash=await passwordHash(data.password);if(!await store.setPasswordIfAbsent(hash))throw error(409,'管理员已经初始化');
        json(res,200,login(res));return;
      }
      if(path==='/api/admin/login'&&req.method==='POST'){
        rateLimit(req);const data=await body(req),hash=await store.getHash();if(!await passwordMatches(data.password,hash)||(await store.getHash())!==hash)throw error(401,'密码错误或管理员未初始化');json(res,200,login(res));return;
      }
      if(path.startsWith('/api/admin/')){
        const s=session(req);if(!s)throw error(401,'请先登录新盘后台');
        const stillAuthorized=()=>{if(session(req)!==s)throw error(401,'会话已失效，请重新登录');};
        if(req.method==='POST'&&!same(req.headers['x-csrf-token'],s.csrf))throw error(403,'页面凭据已过期，请重新登录');
        // start:aigc.
        if(path==='/api/admin/config'&&req.method==='GET'){const config=await store.config();json(res,200,{config,version:config.version});return;} // R02：旧页签退役，不再回传 sourceCatalog
        // end:aigc.
        // start:aigc. 预览走真实报价路径：品类用目录草稿（R02 统一配置源）
        if(path==='/api/admin/preview'&&req.method==='POST'){const data=await body(req);stillAuthorized();const checked=validateCatalog({sources:await store.sources(),baseQuotes:await store.baseQuotes(),categories:Array.isArray(data?.categories)?data.categories:[]});json(res,200,snapshot({...await store.config(),categories:checked.categories},aggregator,{all:true}));return;}
        // end:aigc.
        if(path==='/api/admin/config'&&req.method==='POST'){const data=await body(req);stillAuthorized();if(!Number.isInteger(data.expectedVersion))throw error(400,'缺少配置版本');const config=await store.save(validateConfig(data.config),data.expectedVersion);snapshotCache.invalidate();json(res,200,{config,version:config.version});return;} // 保存成功即失效公开快照缓存（§14.4 规则3）
        // start:aigc.
        // 三元目录与运行状态 admin API：品类保存即时生效（/api/quotes 每次请求读 categories 表），
        // 基础行情保存需重启后适配器按新目录建连。来源密钥只回是否已配置，永不回明文。
        // 红绿灯：实时值(sourceStatus 内存聚合)优先，库值(last_success_at/last_error)作重启后兜底
        if(path==='/api/admin/sources'&&req.method==='GET'){
          const run=aggregator.sourceStatus();
          json(res,200,{sources:await Promise.all((await store.sources()).map(async(s)=>{
            const r=run.get(s.id);
            const hasSecret=await store.hasSourceSecret(s.id);
            return {...s,hasSecret,
              // F04：凭据来源按请求动态计算——反映"下次启动将使用"的凭据（后台库行优先于
              // ITICK_TOKEN 环境变量），保存/清除后立即翻转，无需等重启
              credentialSource:s.id==='itick'?(hasSecret?'db':(process.env.ITICK_TOKEN?'env':null)):null,
              runStatus:s.enabled===0?'disabled':(r?.status??'idle'),
              runHealthy:r?.healthy??0,runTotal:r?.total??0,
              lastSuccessAt:r?.lastSuccessAt?.toISOString()??s.last_success_at??null,
              lastError:r?.lastError??s.last_error??null,
              note:r?.note??(s.id==='itick'?itickNote:null)??null};
          }))});return;
        }
        // 来源密钥写入（iTick Token 后台配置）：密文落库不回显；空串=清除。
        // 改动需重启服务生效（适配器在启动时装配并持有 token）
        if(path==='/api/admin/source-secret'&&req.method==='POST'){
          const data=await body(req);stillAuthorized();
          const sourceId=typeof data?.sourceId==='string'?data.sourceId.trim():'';
          // 严格类型校验：缺失/非字符串 secret 直接 400，不能静默转空串触发意外清除（四查边界建议）
          if(typeof data?.secret!=='string')throw error(400,'缺少密钥字段');
          const secret=data.secret.trim();
          if(!(await store.sources()).some((s)=>s.id===sourceId))throw error(400,'数据源不存在');
          // start:aigc. V5-03（五查）：存在性查询等待期间会话可能失效（登出/改密），
          // 敏感写操作必须在异步查询之后、写库之前重新核验（与 password 路由双重检查对齐）
          stillAuthorized();
          // end:aigc.
          if(secret===''){await store.deleteSourceSecret(sourceId);json(res,200,{ok:true,cleared:true});return;}
          if(secret.length>256||!/^[\x21-\x7e]+$/.test(secret))throw error(400,'密钥格式无效（仅限可见ASCII，长度1-256）');
          await store.setSourceSecret(sourceId,secret);
          json(res,200,{ok:true});return;
        }
        if(path==='/api/admin/switch-logs'&&req.method==='GET'){json(res,200,{entries:await store.switchLogs()});return;}
        if(path==='/api/admin/catalog'&&req.method==='GET'){
          // R4 修复：版本+目录改为单连接一致性快照读取，消除并发保存时的"旧版本号配新目录"
          const snap=await store.catalogSnapshot();
          json(res,200,{version:snap.config.version,sources:await Promise.all(snap.sources.map(async(s)=>({...s,hasSecret:await store.hasSourceSecret(s.id)}))),baseQuotes:snap.baseQuotes,categories:snap.categories});return;}
        if(path==='/api/admin/catalog'&&req.method==='POST'){
          const data=await body(req);stillAuthorized();
          if(!Number.isInteger(data.expectedVersion))throw error(400,'缺少目录版本');
          // start:aigc. 防御式补全 sources，防止前端漏传导致空 Set 触发外键校验失败
          validateCatalog({sources:await store.sources(),...data});
          // end:aigc.
          const version=await store.saveCatalog(data.baseQuotes,data.categories,data.expectedVersion);
          aggregator.updateRequirements(await store.categories()); // 品类公式变化后立即刷新字段需求
          snapshotCache.invalidate(); // 目录保存成功即失效公开快照缓存（§14.4 规则3；预览不经过缓存）
          json(res,200,{ok:true,version});return;
        }
        // end:aigc.
        if(path==='/api/admin/audit'&&req.method==='GET'){json(res,200,{entries:await store.audit()});return;}
        // start:aigc. 完整导出（R11）：品牌/营业 + 实际生效的行情目录（品类/基础行情/来源映射，不含密钥密文）
        if(path==='/api/admin/export'&&req.method==='GET'){res.setHeader('content-disposition','attachment; filename="lcjy-config.json"');
          const snap=await store.catalogSnapshot(); // R4 修复：导出同用一致性快照
          json(res,200,{...snap.config,categories:snap.categories,baseQuotes:snap.baseQuotes,sources:snap.sources});return;}
        // end:aigc.
        if(path==='/api/admin/logout'&&req.method==='POST'){sessions.delete(cookie(req));res.setHeader('set-cookie',`lcjy_session=; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=0`);json(res,200,{ok:true});return;}
        if(path==='/api/admin/password'&&req.method==='POST'){rateLimit(req);const data=await body(req);stillAuthorized();const oldHash=await store.getHash();if(!await passwordMatches(data.oldPassword,oldHash))throw error(403,'原密码错误');validPassword(data.newPassword);const newHash=await passwordHash(data.newPassword);stillAuthorized();
          // R3 修复：改密改为"带旧哈希条件"的原子更新——他人抢先改密则匹配 0 行，得到 409 而非覆盖
          if(!await store.replacePassword(oldHash,newHash))throw error(409,'密码已在其他会话中更新');
          sessions.clear();json(res,200,{ok:true});return;}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw error(404,'接口不存在');
      const target=path==='/'?'index.html':path==='/admin'||path==='/admin/'?'admin.html':path.replace(/^\//,'');
      const root=join(project,'public'),file=resolve(root,target);
      if(!file.startsWith(root+ '/')&&!file.startsWith(root+'\\'))throw error(404,'页面不存在');
      let content;try{if(!(await stat(file)).isFile())throw new Error();content=await readFile(file);}catch{throw error(404,'页面不存在');}
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ico':'image/x-icon'};
      res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){if(!res.headersSent)json(res,e.status||400,{error:e.message||'请求失败'});else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,quotes:aggregator,start,
    // start:aigc. 保护组件暴露：测试断言计数/失效钩子，运维只读观测（§15.5 验收证据）
    protect:{config:protectCfg,viewerSessions,snapshotCache,counters},
    // end:aigc.
    async close(){if(closing)return;closing=true;clearInterval(cleanup);clearInterval(protectLog);
    // start:aigc.
    aggregator.stop();stopTimer?.();
    // end:aigc.
    await new Promise(r=>{server.close(r);server.closeAllConnections();});await store.close();}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp();const port=Number(process.env.PORT||3188),host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,async()=>{console.log(`报价盘 http://${host}:${port}/\n独立后台 http://${host}:${port}/admin`);if(!await app.store.hasAdmin())console.log(`首次设置令牌位于 ${join(app.store.dir,'setup-token.txt')}，请在新后台设置密码。`);
  // start:aigc.
  app.start(); // 组装生产适配器（融通金+新浪）并启动 publish 定时器
  // end:aigc.
  });
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await app.close();process.exit(0);});
}

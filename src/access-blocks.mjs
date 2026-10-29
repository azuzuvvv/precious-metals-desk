// start:aigc.
// 手动封禁（方案 §5，第三批 + B 系列审查修订）：MySQL 为事实来源（数据+审计同事务、行级
// expectedVersion 乐观锁），本进程内存表执行判定（有界 ≤ maxBlocks，过期按绝对到期时间即时失效）。
// 范围仅 /api/quotes 与 POST /api/viewer/session，observe/off 模式同样生效，off 不自动取消（§5）。
// 说明：方案 §5 的 Redis 镜像本期未实现——单进程部署下执行判定以本机表为准即为权威，
// 不存在跨进程可见性需求；后续多实例化时再引入镜像与版本同步（文档 §5 亦声明本期不支持多进程共享执行）。
// B-01：管理操作全局串行（容量判定+SQL+内存同步作为一个完整临界区），杜绝并发容量突破；
//       内存同步带版本条件——迟到的旧响应不得覆盖/删除更新的封禁状态。
// B-03：到期记录在 size/activeList/容量判定/列表展示前统一 prune；重新封禁"已到期未解封"的行
//       允许 expectedVersion=0（无有效状态可覆盖，事务内以绝对到期时间判定）。
// B-04：IP 键统一走 rate-limit 的 canonicalIp（IPv6 压缩/前导零/大小写/IPv4-mapped 归一）。

import {canonicalIp} from './rate-limit.mjs';

// 管理输入规范化校验：canonical 后校验类别；拒回环/未指定/空地址（§5 不能误封 127.0.0.1）
export function normalizeBlockIp(input){
  const ip=canonicalIp(input);
  if(!ip)return {ok:false,reason:'IP 格式无效（仅支持 IPv4/IPv6 单地址，不支持网段）'};
  if(ip==='::1'||ip==='::'||ip.startsWith('127.'))
    return {ok:false,reason:'不能封禁回环或未指定地址（若为代理误报，请先修复可信代理配置）'};
  return {ok:true,ip};
}

const MAX_MINUTES=7*24*60; // §5：1 分钟至 7 天，无永久封禁
export function createAccessBlocks({store,now=Date.now,maxBlocks=10000}={}){
  // 本机执行表：ip -> {untilMs,reason,version}；启动从 MySQL 加载，操作后同步，Redis 故障不影响封禁
  const active=new Map();
  // B-03：到期清扫（懒式+主动）——size/activeList/容量判定/加载后调用，保证执行表只含有效封禁
  const prune=()=>{const t=now();for(const [ip,b] of active)if(b.untilMs<=t)active.delete(ip);};
  // B-01：管理操作串行队列——"容量判定 + SQL 事务 + 内存同步"作为完整临界区，
  // 并发封禁不同 IP 也不会同时通过容量检查突破 maxBlocks（管理操作低频，全局串行开销可忽略）
  let chain=Promise.resolve();
  const serialize=(op)=>{const p=chain.then(op,op);chain=p.catch(()=>{});return p;};

  return {
    active,
    // 启动加载有效封禁；失败上抛（§5：加载失败不允许静默当作没有封禁）
    async load(){
      const rows=await store.loadActiveBlocks(now());
      active.clear();
      for(const r of rows)active.set(r.ip,{untilMs:Number(r.until_ms),reason:r.reason,version:Number(r.version)});
      prune();
      return active.size;
    },
    // 请求路径判定：过期即时失效（绝对到期时间），返回 null 或封禁信息；纯内存无 IO
    check(ip){
      const b=active.get(ip);
      if(!b)return null;
      if(b.untilMs<=now()){active.delete(ip);return null;}
      return b;
    },
    get size(){prune();return active.size;},
    activeList(){prune();return new Map(active);},
    // 封禁/延长/重新封禁：串行临界区内 prune→容量→SQL→内存同步（版本条件写入）
    block(args){
      return serialize(async()=>{
        const norm=normalizeBlockIp(args.ip);
        if(!norm.ok)return {ok:false,code:'BAD_IP',reason:norm.reason};
        const minutes=Number(args.minutes);
        if(!Number.isInteger(minutes)||minutes<1||minutes>MAX_MINUTES)return {ok:false,code:'BAD_MINUTES'};
        const reason=typeof args.reason==='string'?args.reason.trim():'';
        if(!reason||reason.length>512)return {ok:false,code:'BAD_REASON'};
        const ip=norm.ip,expectedVersion=Number(args.expectedVersion)||0;
        prune();
        if(!active.has(ip)&&active.size>=maxBlocks)return {ok:false,code:'CAPACITY'};
        const untilMs=now()+minutes*60000;
        const r=await store.saveBlock({ip,untilMs,minutes,reason,expectedVersion});
        if(!r.ok)return r;
        // B-01：迟到的旧封禁响应不得覆盖更新的状态（解封后重封 v3 > 旧 v2 写回）
        const cur=active.get(ip);
        if(!cur||cur.version<=r.version)active.set(ip,{untilMs,reason,version:r.version});
        return {ok:true,version:r.version,untilMs};
      });
    },
    // 解封：必须显式操作并携带当前版本；内存删除同样带版本条件——旧解封响应不得删掉其后的新封禁
    unblock(args){
      return serialize(async()=>{
        const norm=normalizeBlockIp(args.ip);
        if(!norm.ok)return {ok:false,code:'BAD_IP',reason:norm.reason};
        const reason=typeof args.reason==='string'?args.reason.trim():'';
        if(!reason||reason.length>512)return {ok:false,code:'BAD_REASON'};
        const expectedVersion=Number(args.expectedVersion);
        if(!Number.isInteger(expectedVersion)||expectedVersion<1)return {ok:false,code:'VERSION'};
        const r=await store.releaseBlock({ip:norm.ip,reason,expectedVersion});
        if(!r.ok)return r;
        const cur=active.get(norm.ip);
        if(!cur||cur.version<=r.version)active.delete(norm.ip); // 重封后的版本更高则保留
        return {ok:true};
      });
    },
  };
}
// end:aigc.
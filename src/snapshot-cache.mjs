// start:aigc.
// 报价快照缓存（方案 §13.3/§14.4 规则 2/3/5/6/7 + §15.2.5-15.2.6）：
// - 请求触发 + TTL 内复用（无访客时不读数据库，沿用行情 publish 自身定时器）；
// - 单航次重建：TTL 到期时并发请求共享同一 Promise，至多一笔重建在途；
// - 代次保护：重建在途期间发生配置/目录保存（invalidate），旧结果只发给已等待的请求，不放回缓存；
// - 只缓存响应 body（Buffer），鉴权/限流/Set-Cookie 由路由按请求独立处理；
// - 重建失败不无限复用旧报价：过期缓存不服务，错误上抛由路由转 503。
// 说明：TTL 是"至多复用约 TTL 毫秒"的设计值，不构成精确时效承诺（§14.4 规则 7）。

export function createSnapshotCache({ttlMs=1000,build,now=Date.now}){
  let generation=0,buffer=null,expiresAtMs=0,inflight=null,inflightGen=0;
  const stats={hits:0,rebuilds:0};
  return {
    // 返回共享 Buffer；并发请求共享同一重建 Promise（单航次）
    async get(){
      // AP-03 修复：循环处理代次，失效后新请求不得共享旧代次在途结果
      while(true){
        const t=now();
        if(buffer&&t<expiresAtMs){stats.hits++;return buffer;}
        const g=generation;
        if(!inflight){
          stats.rebuilds++;
          inflightGen=g;
          inflight=Promise.resolve().then(build).then((b)=>{
            // 代次保护：重建期间发生过 invalidate 时，旧结果不放回缓存（§14.4 规则 3）
            if(g===generation){buffer=b;expiresAtMs=now()+ttlMs;}
            return b;
          }).finally(()=>{inflight=null;});
        }
        if(inflightGen===g){
          // 同代次在途：失效前/正常并发的等待者共享该结果
          return inflight;
        }
        // 旧代次在途（失效后新请求）：等旧任务结束，循环进入新代次重建，不拿旧值
        await inflight.catch(()=>{});
      }
    },
    // 配置/目录保存成功后失效：代次 +1 并清空当前缓存；在途重建的结果由代次判断弃用
    invalidate(){generation++;buffer=null;expiresAtMs=0;},
    get stats(){return {hits:stats.hits,rebuilds:stats.rebuilds};},
  };
}
// end:aigc.

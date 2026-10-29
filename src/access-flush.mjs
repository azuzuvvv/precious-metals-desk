// start:aigc.
// 访问分钟统计落库（方案 §7 + 二批审查 S2-02/S2-03）：每分钟将"已结束分钟桶"从 Redis 按绝对值
// upsert 进 MySQL，成功水位与数据写入同一事务推进（提交后前进，崩溃不留半程状态）；Redis 桶
// 保留至 TTL 过期，不读后即删（§7 故障补传）。重复落库按 GREATEST 绝对值覆盖保护，禁止增量累加。
// 迟到补传（S2-02）：fire-and-forget 记录可能在分钟落库之后才到达 Redis；统计脚本发现请求分钟
// ≤ 水位时登记 dirty 索引，flusher 每轮先重扫 dirty 分钟（GREATEST 合并，水位不回退）。
// 子命令失败（S2-03）：批量读取逐项校验，任一错误本轮失败、不推水位，下轮从原水位重试。
// 汇总失败不影响行情访问控制（§8）：状态上抛给访问管理页显示"汇总延迟"。

export function createAccessFlusher({stats,store,redis,batch,run,intervalMs=60000,retentionDays=7,minuteBatch=60,rowBatch=500,now=Date.now}={}){
  const minuteOf=(t)=>Math.floor(t/60000);
  const state={running:false,lastRunAt:0,lastError:null,lastFlushedMinute:0,pendingCount:0,dirtyCount:0,lastCleanupAt:0};
  let timer=null;
  const runBatch=batch||((cmds)=>{
    // 未注入 batch runner 时的兼容路径（测试/旧装配）：单 pipeline 一次提交并逐项校验
    const pl=redis.pipeline();for(const c of cmds)pl[c[0]](...c.slice(1));
    return pl.exec().then((res)=>{for(const it of res)if(it[0])throw it[0];return res.map((it)=>it[1]);});
  });

  // 分钟写版本 CAS 确认（S2-02 残留）：快照读取时记 ver0，MySQL 提交后原子核对——
  // 版本未变才清 dirty；版本前进=读取/提交期间有并发写入，dirty 必须保留待下轮重扫。
  // 不能在 Node 侧先比后删（仍是两个交错命令），必须单脚本原子完成。
  const CONFIRM_SCRIPT=`
local cur = redis.call('GET', KEYS[1])
if (not cur) or (cur == ARGV[2]) then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 1
end
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1])
return 0
`;
  async function confirmMinute(minute,ver0){
    try{
      await run(CONFIRM_SCRIPT,[stats.verKey(minute),stats.dirtyKey],[String(minute),String(ver0)]);
    }catch(e){
      // Redis 异常时保守重登记 dirty（宁可多扫一次幂等重放，不冒丢写风险）；仍失败只能下轮兜底
      try{await redis.zadd(stats.dirtyKey,minute,minute);}catch{/* 全断：统计写入自身也在失败记缺口 */}
    }
  }

  // 读单个分钟快照（第四版复核修订的读取顺序）：① 版本 ver0 ② 该分钟缺口状态 ③ 桶哈希。
  // 顺序保证：ver0 之后发生的缺口写入（LOSS_MARK/LOSS_SYNC）都会推版本 → CAS 失配 → 待交付保留重扫；
  // ver0 与缺口读取之间到达的缺口会被②读到（本次即 complete=0），版本同样失配触发幂等重扫。
  // 子命令错误上抛；mi 有成员但 Hash 缺失（过期/异常）标 complete=0，不当完整零值。
  async function collectMinute(minute){
    const ver0=await redis.get(stats.verKey(minute));
    const loss=await stats.minuteLoss(minute);
    const members=await redis.zrange(stats.miKey(minute),0,-1);
    const rows=[];
    for(let i=0;i<members.length;i+=rowBatch){
      const part=members.slice(i,i+rowBatch);
      const cmds=part.map((ip)=>['hgetall',stats.minuteHashKey(minute,ip)]);
      const res=await runBatch(cmds);
      part.forEach((ip,idx)=>{
        const raw=res[idx]||{};
        const missing=Object.keys(raw).length===0; // 正常桶必有 req/issue 字段；空=数据缺失
        rows.push({minute,ip,fields:raw,complete:(loss||missing)?0:1});
      });
    }
    return {rows,ver0:String(ver0??'')};
  }

  // 单轮（S2-02 三轮：统一"待交付分钟"协议）：只扫待交付索引（写入侧无条件登记，与客户端水位无关），
  // 逐分钟：记 ver0 → 快照 → MySQL 事务（数据+水位）→ 版本 CAS 确认（版本未变才移除；确认后的
  // 新写入会重新登记，下轮重扫）。任一步失败整轮失败，下轮原样重试（绝对值幂等不翻倍）。
  async function flushOnce(){
    if(state.running)return false; // §7 避免多任务重叠
    state.running=true;
    try{
      const t=now();const lastComplete=minuteOf(t)-1;
      // 待交付分钟（≤ 已结束分钟；当前分钟未完整不处理 §7）。迟到/并发写入与正常分钟共用此队列。
      // 缺口状态不再整轮预读（第四版复核）：collectMinute 在版本之后逐分钟读取，与 ver0 严格对应。
      const pending=(await redis.zrangebyscore(stats.dirtyKey,'-inf',lastComplete)).map(Number).sort((a,b)=>a-b).slice(0,minuteBatch);
      state.pendingCount=pending.length;state.dirtyCount=pending.length;
      for(const minute of pending){
        const {rows,ver0}=await collectMinute(minute);
        await store.upsertAccessMinute(minute,rows);
        state.lastFlushedMinute=Math.max(state.lastFlushedMinute,minute);
        // CAS：版本未变才从待交付队列移除；确认后到达的写入已重新登记，天然由下轮兜住（无水位同步窗口）
        await confirmMinute(minute,ver0);
      }
      state.lastRunAt=t;state.lastError=null;
      // 留存清理（§7 分钟统计保留 7 天，按批清理）+ 缺口分钟哈希过期字段清理：低频执行
      if(t-state.lastCleanupAt>6*3600000){
        state.lastCleanupAt=t;
        await store.cleanupAccessMinutes(retentionDays);
        const wm=await store.getAccessWatermark();
        const stale=(await stats.lossMinutes()).filter((m)=>m<wm-360);
        if(stale.length)await redis.hdel(stats.lossKey,...stale.map(String));
      }
      return true;
    }catch(e){
      state.lastError=e.message; // 保留 Redis 桶，下轮从待交付队列原样重试（幂等，绝对值不翻倍）
      return false;
    }finally{state.running=false;}
  }

  return {
    state,flushOnce,
    start(){if(timer)return;timer=setInterval(()=>{flushOnce();},intervalMs);timer.unref();flushOnce();},
    stop(){if(timer){clearInterval(timer);timer=null;}},
  };
}
// end:aigc.
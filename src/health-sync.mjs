// start:aigc.
// 数据源红绿灯持久化同步器（F03，四查）：把 Quotes.sourceStatus() 的最近成功/最近错误
// 周期写回 sources 表（由 store.updateSourceHealth 落库，null 不覆盖历史值——F02）。
// 约定：
// - 与上次"成功写库"的快照相同才跳过；写失败不标记快照，下一轮对相同状态重试
//   （持续断线时错误值长时间不变，数据库恢复后仍能补写，不会被静默吞掉）
// - 同源写未完成时不重复发起（防重叠：慢写入不会以旧状态乱序覆盖新状态）
// - 写失败记日志不抛出，不中断行情主流程
export function createHealthSyncer({ store, sourceStatus, intervalMs = 60000, onError = null }) {
  const synced = new Map();   // id -> {lastSuccessAt,lastError} 已成功落库的快照
  const pending = new Set();  // 在途写的源 id
  const report = onError ?? ((err) => console.error('[source-health] 写入失败:', err.message));
  function tick() {
    for (const [id, st] of sourceStatus()) {
      const lastSuccessAt = st.lastSuccessAt ? st.lastSuccessAt.toISOString() : null;
      const next = { lastSuccessAt, lastError: st.lastError };
      const prev = synced.get(id);
      if (prev && prev.lastSuccessAt === next.lastSuccessAt && prev.lastError === next.lastError) continue;
      if (pending.has(id)) continue;   // 在途写未完成：本轮让位，下一轮带最新状态重试
      pending.add(id);
      store.updateSourceHealth(id, lastSuccessAt, next.lastError)
        .then(() => { synced.set(id, next); })   // 成功才标记快照（F03 核心）
        .catch(report)
        .finally(() => { pending.delete(id); });
    }
  }
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return { tick, stop() { clearInterval(timer); } };
}
// end:aigc.

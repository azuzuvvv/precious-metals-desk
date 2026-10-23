// start:aigc.
// 数据源选择器：为每个基础行情维护各来源的 healthy/stale/disconnected 状态，
// 按 priority 升序挑选健康来源。主源失效立即切换；主源恢复后连续 becomeHealthyAfter 次
// 有效更新才切回。全部失效时回退到最后有效 tick（last-known）。来源切换通过 onSwitch 写运行日志。
export const HEALTHY = 'healthy', STALE = 'stale', DISCONNECTED = 'disconnected', DISABLED = 'disabled';

export class Selector {
  constructor({ staleMs = 45000, becomeHealthyAfter = 3, onSwitch = null } = {}) {
    this.staleMs = staleMs;
    this.becomeHealthyAfter = becomeHealthyAfter;
    this.onSwitch = onSwitch;
    this.config = new Map();   // symbol -> [{sourceId,priority,enabled}] 按 priority 升序
    this.entries = new Map();  // symbol -> Map(sourceId -> {status,tick,streak,err,everHealthy})
    this.selected = new Map(); // symbol -> {sourceId,mode}
  }
  configure(baseQuotes = []) {
    this.config.clear(); this.entries.clear(); this.selected.clear();
    for (const bq of baseQuotes) {
      // 停用的基础行情不参与选源（R07）：不注册候选来源，publish 侧清理残留键
      if (bq.enabled === false) { this.config.set(bq.symbol, []); this.entries.set(bq.symbol, new Map()); continue; }
      const list = (bq.sources || [])
        .filter((s) => s && s.sourceId)
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
      this.config.set(bq.symbol, list);
      this.entries.set(bq.symbol, new Map());
    }
  }
  _entry(symbol, sourceId) {
    const m = this.entries.get(symbol);
    if (!m) return null;
    if (!m.has(sourceId)) m.set(sourceId, { status: DISCONNECTED, tick: null, streak: 0, err: null, everHealthy: false });
    return m.get(sourceId);
  }
  _enabled(symbol, sourceId) {
    const src = this.config.get(symbol)?.find((s) => s.sourceId === sourceId);
    return !!(src && src.enabled !== false);
  }
  ingest(symbol, sourceId, tick, { now = Date.now() } = {}) {
    if (!this._enabled(symbol, sourceId)) return;
    const entry = this._entry(symbol, sourceId);
    if (!entry) return;
    entry.tick = tick; entry.err = null;
    if (entry.status !== HEALTHY) {
      entry.streak += 1;
      // 首次连接立即健康；失败后恢复需连续 becomeHealthyAfter 次有效更新
      if (!entry.everHealthy || entry.streak >= this.becomeHealthyAfter) {
        entry.status = HEALTHY; entry.everHealthy = true;
      }
    }
    this._reselect(symbol, now);
  }
  markFailure(symbol, sourceId, err, { now = Date.now() } = {}) {
    if (!this._enabled(symbol, sourceId)) return;
    const entry = this._entry(symbol, sourceId);
    if (!entry) return;
    entry.status = DISCONNECTED; entry.streak = 0; entry.err = err ?? '连接或请求失败';
    this._reselect(symbol, now);
  }
  refresh(now = Date.now()) {
    for (const [symbol] of this.entries) {
      const list = this.config.get(symbol) || [];
      let changed = false;
      for (const src of list) {
        const e = this.entries.get(symbol)?.get(src.sourceId);
        if (e && e.status === HEALTHY && e.tick && now - e.tick.time > this.staleMs) {
          e.status = STALE; e.streak = 0; e.err = '超时未更新'; changed = true;
        }
      }
      if (changed) this._reselect(symbol, now);
    }
  }
  _reselect(symbol, now) {
    const enabled = (this.config.get(symbol) || []).filter((s) => s.enabled !== false);
    const prevId = this.selected.get(symbol)?.sourceId ?? null;
    let next = null;
    // 1) 优先选择优先级最高的健康来源
    for (const src of enabled) {
      const e = this.entries.get(symbol)?.get(src.sourceId);
      if (e && e.status === HEALTHY) {
        next = { sourceId: src.sourceId, mode: src === enabled[0] ? 'primary' : 'failover' };
        break;
      }
    }
    // 2) 无健康来源时，回退到最后一次有效 tick 的来源
    if (!next) {
      let newest = null;
      for (const src of enabled) {
        const e = this.entries.get(symbol)?.get(src.sourceId);
        if (e?.tick && (!newest || e.tick.time > newest.tick.time)) newest = { sourceId: src.sourceId, tick: e.tick };
      }
      if (newest) next = { sourceId: newest.sourceId, mode: 'last-known' };
    }
    const result = next ?? { sourceId: null, mode: null };
    this.selected.set(symbol, result);
    // 仅当来源真正变更（且非首次选定）时触发切换日志
    if (prevId !== null && result.sourceId !== prevId && this.onSwitch) {
      this.onSwitch({ symbol, oldSource: prevId, newSource: result.sourceId, mode: result.mode, time: now });
    }
    return result;
  }
  getTick(symbol) {
    const sel = this.selected.get(symbol);
    if (!sel?.sourceId) return null;
    return this.entries.get(symbol)?.get(sel.sourceId)?.tick ?? null;
  }
  state(symbol, now = Date.now()) {
    const sel = this.selected.get(symbol) ?? { sourceId: null, mode: null };
    const entry = sel.sourceId ? this.entries.get(symbol)?.get(sel.sourceId) : null;
    return { sourceId: sel.sourceId, mode: sel.mode, status: entry?.status ?? DISCONNECTED, err: entry?.err ?? null };
  }
}
// end:aigc.
// start:aigc.
// 聚合层：接收适配器回调→喂给 Selector→publish() 把选定 tick 转成公式键与来源元数据。
// prices 键格式与旧 feed 一致（【#symbol#字段】），snapshot 无需改读法。
import { Selector } from './selector.mjs';
import { FIELD_LABELS } from './catalog.mjs';

export class Quotes {
  constructor({ baseQuotes = [], staleMs = 45000, onSwitch = null } = {}) {
    this.selector = new Selector({ staleMs, onSwitch });
    this.selector.configure(baseQuotes);
    this.prices = new Map();     // 【#symbol#字段】 -> {value:String, time}
    this.meta = new Map();       // symbol -> {sourceId, sourceName, mode, status, updatedAt}
    this.sourceName = new Map(); // sourceId -> name
    this.adapters = new Map();   // sourceId -> adapter 实例，stop() 时统一关闭
  }
  attach(adapter) {
    this.sourceName.set(adapter.id, adapter.name);
    this.adapters.set(adapter.id, adapter);
    const stop = adapter.start({
      onQuote: (tick) => this.selector.ingest(tick.symbol, adapter.id, tick),
      onFailure: (symbol, err) => this.selector.markFailure(symbol, adapter.id, err),
    });
    if (typeof stop === 'function') adapter._stop = stop;
    return adapter;
  }
  // 测试钩子：绕过适配器直接喂 Selector
  ingestTest(sourceId, symbol, tick, now) { this.selector.ingest(symbol, sourceId, tick, { now }); }
  failTest(sourceId, symbol, err) { this.selector.markFailure(symbol, sourceId, err); }
  publish(now = Date.now()) {
    this.selector.refresh(now);
    const active = new Set();
    for (const [symbol] of this.selector.entries) {
      const tick = this.selector.getTick(symbol); if (!tick) continue;
      active.add(symbol);
      const st = this.selector.state(symbol, now);
      // 原子替换字段集：本组 tick 没有的字段清除旧源残留，杜绝混合报价（R05 规则3/5）
      for (const [field, label] of Object.entries(FIELD_LABELS)) {
        const key = `【#${symbol}#${label}】`;
        if (tick[field] === undefined || tick[field] === null) { this.prices.delete(key); continue; }
        this.prices.set(key, { value: String(tick[field]), time: tick.time });
      }
      this.meta.set(symbol, {
        sourceId: st.sourceId, sourceName: this.sourceName.get(st.sourceId) ?? st.sourceId,
        mode: st.mode, status: st.status, updatedAt: new Date(tick.time).toISOString(),
      });
    }
    // 停用或无数据的基础行情：清理残留的价格键与来源元数据（R07）
    for (const key of this.prices.keys()) {
      const m = key.match(/^【#([^#]+)#/);
      if (m && !active.has(m[1])) this.prices.delete(key);
    }
    for (const s of this.meta.keys()) if (!active.has(s)) this.meta.delete(s);
  }
  // 优先用 start() 返回的清理函数（适配器可只返回清理函数不实现 stop 方法），回落到 stop()
  stop() { for (const a of this.adapters.values()) (a._stop ?? a.stop)?.(); this.adapters.clear(); }
}
// end:aigc.

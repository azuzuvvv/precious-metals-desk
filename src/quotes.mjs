// start:aigc.
// 聚合层：接收适配器回调→喂给 Selector→publish() 把选定 tick 转成公式键与来源元数据。
// prices 键格式与旧 feed 一致（【#symbol#字段】），snapshot 无需改读法。
import { Selector } from './selector.mjs';
import { FIELD_LABELS } from './catalog.mjs';
// start:aigc.
import { references } from './formula.mjs';
// end:aigc.

export class Quotes {
  constructor({ baseQuotes = [], categories = [], staleMs = 45000, onSwitch = null } = {}) {
    this.selector = new Selector({ staleMs, onSwitch });
    // start:aigc.
    // 从品类公式提取每个基础行情的必需字段并集（F01）：候选源必须覆盖全部必需字段才算完整。
    this.selector.configure(baseQuotes, computeRequired(baseQuotes, categories));
    // end:aigc.
    this.prices = new Map();     // 【#symbol#字段】 -> {value:String, time}
    this.meta = new Map();       // symbol -> {sourceId, sourceName, mode, status, updatedAt}
    this.sourceName = new Map(); // sourceId -> name
    this.adapters = new Map();   // sourceId -> adapter 实例，stop() 时统一关闭
    // start:aigc. 记录各适配器上报的源站状态文本（如 rtj 的"源站标记闭盘"），
    // 供 snapshot 在 last-known 时区分"收盘停更"与"连接中断"文案
    this.adapterStatus = new Map(); // sourceId -> 最近状态文本
    // end:aigc.
  }
  attach(adapter) {
    this.sourceName.set(adapter.id, adapter.name);
    this.adapters.set(adapter.id, adapter);
    const stop = adapter.start({
      onQuote: (tick) => this.selector.ingest(tick.symbol, adapter.id, tick),
      onFailure: (symbol, err) => this.selector.markFailure(symbol, adapter.id, err),
      // start:aigc. 透传源站状态文本（无此回调的适配器如 sina 自动忽略）
      onStatus: (text) => this.adapterStatus.set(adapter.id, text),
      // end:aigc.
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
  // start:aigc.
  // 目录保存后重算字段需求（公式引用可能变化），保留连接状态
  updateRequirements(categories) { this.selector.setRequired(computeRequired([...this.selector.config.keys()].map((symbol) => ({ symbol })), categories)); }
  // end:aigc.
  // 优先用 start() 返回的清理函数（适配器可只返回清理函数不实现 stop 方法），回落到 stop()
  stop() { for (const a of this.adapters.values()) (a._stop ?? a.stop)?.(); this.adapters.clear(); }
}
// end:aigc.

// start:aigc.
// 计算各基础行情的必需字段：遍历品类买卖公式的引用【#symbol#字段】，聚合每个 symbol 的字段并集。
// 高低价是辅助字段（规则5/F03）：高低公式的引用不计入必需集——缺失/停更只显示 --，不拖垮买卖报价。
// 软引用（未登记 symbol）与未识别字段标签忽略。
// end:aigc.
export function computeRequired(baseQuotes, categories) {
  const required = new Map(baseQuotes.map((b) => [b.symbol, new Set()]));
  const byLabel = new Map(Object.entries(FIELD_LABELS).map(([f, label]) => [label, f]));
  for (const c of categories || []) {
    for (const key of ['buyFormula', 'sellFormula']) {
      const expr = (c?.[key] ?? '').trim(); if (!expr) continue;
      for (const ref of references(expr)) {
        const last = ref.lastIndexOf('#');
        const field = byLabel.get(ref.slice(last + 1, -1));
        if (field) required.get(ref.slice(2, last))?.add(field);
      }
    }
  }
  return new Map([...required].map(([s, set]) => [s, set]));
}

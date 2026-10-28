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
    // start:aigc. V5-02（五查）：各源"最近一次错误事件"文本——失败回调即记录，恢复不清除。
    // 分钟级落库读这里而非 Selector entry.err（entry.err 恢复即被清空，采样间隔内
    // 失败又恢复的短暂故障会从历史中丢失）
    this.errorLog = new Map(); // sourceId -> 最近一次错误文本
    // end:aigc.
  }
  attach(adapter) {
    this.sourceName.set(adapter.id, adapter.name);
    this.adapters.set(adapter.id, adapter);
    const stop = adapter.start({
      onQuote: (tick) => this.selector.ingest(tick.symbol, adapter.id, tick),
      // start:aigc. V5-02：失败即记入错误事件（恢复不清除），再交给 Selector 处理选源
      onFailure: (symbol, err) => { this.errorLog.set(adapter.id, err?.message ?? String(err ?? '连接或请求失败')); this.selector.markFailure(symbol, adapter.id, err); },
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
  // 数据源红绿灯（设计文档"数据源管理"）：按源聚合 Selector 中各品种的连接状态。
  // F01（四查）：分母从有效配置（selector.config）枚举，而非已存在的 entry——entry 只在
  // 首次收到 tick/失败通知时建立，从未响应的品种不能从分母中删除（否则 A 有数据 B 无数据
  // 会误报 healthy 1/1 全绿）。无 entry 的已配置品种计为未响应（disconnected、无错误文本）。
  // status 口径：healthy=订阅品种全部健康；partial=部分健康；stale=无健康但有过期数据；
  // disconnected=全部断开/未响应；idle=已挂载但无任何启用映射（真正零订阅）。
  // lastSuccessAt 取该源全部品种 tick 时间的最大值；lastError 取任一断线品种的最近错误
  sourceStatus() {
    const out = new Map();
    for (const id of this.adapters.keys()) {
      let total = 0, healthy = 0, stale = 0, lastSuccessAtMs = null, lastErrRaw = null;
      for (const [symbol, list] of this.selector.config) {
        // 只统计该源启用映射的品种；停用基础行情在 Selector.configure 中为空列表，天然排除
        if (!list.some((s) => s.sourceId === id && s.enabled !== false)) continue;
        total += 1;
        const e = this.selector.entries.get(symbol)?.get(id);
        if (!e) continue;   // 已配置未响应：计入分母，由下方 unresponsive 归入 disconnected
        // 红绿灯按接口返回的数据流统计（2026-10-28 回退 V5-01）：healthy 只看连接与更新是否
        // 正常，不按品类公式必需字段降级——源站原生单边品种（如 Pt99.95 只推单侧）是常态，
        // 按字段完整性判定会让红绿灯常态黄灯，淹没真故障；字段缺失由前台 M01 单边提示呈现
        if (e.status === 'healthy') healthy += 1;
        else if (e.status === 'stale') stale += 1;
        if (e.tick?.time != null && (lastSuccessAtMs == null || e.tick.time > lastSuccessAtMs)) lastSuccessAtMs = e.tick.time;
        if (e.status !== 'healthy' && e.status !== 'stale' && e.err && lastErrRaw == null) lastErrRaw = e.err;
      }
      const unresponsive = total - healthy - stale;
      let status = 'idle';
      if (total > 0) {
        if (healthy === total) status = 'healthy';
        else if (healthy > 0) status = 'partial';
        else if (stale > 0 && unresponsive === 0) status = 'stale';
        else status = 'disconnected';
      }
      // start:aigc. V5-02（五查）：lastError 优先取错误事件（失败即记、恢复不清除，短暂故障
      // 不因采样间隔丢失）；errorLog 未覆盖路径（如测试钩子直接 failTest）回落当前断线 entry
      const errEvent = this.errorLog.get(id) ?? null;
      const errRaw = errEvent ?? lastErrRaw;
      // end:aigc.
      // Selector 存的 err 可能是 Error 对象（HTTP 源）或字符串（rtj），统一取 message 文本
      out.set(id, {
        status, healthy, total,
        lastSuccessAt: lastSuccessAtMs != null ? new Date(lastSuccessAtMs) : null,
        lastError: errRaw ? (errRaw.message ?? String(errRaw)) : null,
        note: this.adapterStatus.get(id) ?? null,
      });
    }
    return out;
  }
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

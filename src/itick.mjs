// start:aigc.
// iTick 协议模块：美元指数的最终备援（见闻挂掉时顶上）。
// 免费版约束：5 次/分钟 → 轮询 30s（2 次/分钟留余量）；强制 IP 白名单（ECS 公网 IP 需在
// itick.org 后台登记）；Token 优先走后台密钥配置（数据源页签，加密落库），环境变量
// ITICK_TOKEN 兼容兜底（/etc/lcjy-quote.env），两者皆无则不启动（设计文档"数据源管理"）。
// 口径注意：iTick DXY 与新浪/见闻存在 ~0.3 观测偏差（2026-10-27 实测），仅作最后备援。
import { createPollingAdapter } from './polling-adapter.mjs';
import { normalizeTick } from './adapter.mjs';

const BASE = 'https://api-free.itick.org';   // 免费版专用域名；api.itick.org 会报 Invalid API key
// start:aigc. iTick 按类型分端点：indices（指数）/forex（外汇），code 不能混端点批量 → 逐码请求
const ITICK_QMAP = {
  DXY: { type: 'indices' },
};
// end:aigc.

export function buildItickQuotes(baseQuotes) {
  // start:aigc. F01：基础行情或映射停用的不进订阅（零请求，不烧配额）
  const out = {};
  for (const bq of baseQuotes) {
    if (bq.enabled === false) continue;
    const s = (bq.sources || []).find((x) => x.sourceId === 'itick');
    if (s?.enabled !== false && s?.code && s.code !== '__NONE__') (out[s.code] ??= []).push({ symbol: bq.symbol });
  }
  return out;
  // end:aigc.
}

export function parseItickJson(json, quotes, now = Date.now()) {
  const ticks = [];
  const d = json?.data;
  const qs = d?.s ? quotes[d.s] : null;
  if (!qs?.length || json?.code !== 0) return ticks;
  const map = ITICK_QMAP[d.s]; if (!map) return ticks;
  // start:aigc. 时间守卫与 wscn 对齐：t 为毫秒时间戳，无效或超未来整条丢弃
  const time = Number(d.t);
  if (!Number.isFinite(time) || time <= 0 || time > now + 300000) return ticks;
  // end:aigc.
  const last = Number(d.ld);
  if (!Number.isFinite(last) || last <= 0) return ticks;
  const raw = { buy: last, sell: last, time };
  const high = Number(d.h), low = Number(d.l);
  if (Number.isFinite(high) && high > 0) raw.high = high;
  if (Number.isFinite(low) && low > 0) raw.low = low;
  for (const q of qs) {
    try { ticks.push(normalizeTick(q.symbol, raw)); } catch { /* 字段不足跳过 */ }
  }
  return ticks;
}

// start:aigc. 协议组装：逐码请求（端点按类型不同）；业务码非 0 视为失败（F04：鉴权/配额错误
// 不再被当空结果静默吞掉）。无 Token 优雅降级为空适配器，并通过 onStatus 上报原因——
// 红绿灯据此区分"缺凭据未启动"与"已配置但未响应"（四查观察项）
export function createItickAdapter(baseQuotes, { fetchImpl = fetch, token = process.env.ITICK_TOKEN, pollMs = null, timeoutMs = null } = {}) {
  if (!token) {
    console.error('[itick] 未配置 ITICK_TOKEN，备援未启动（请在后台数据源页签或环境文件中补齐）');
    return { id: 'itick', name: 'iTick',
      start(handlers = {}) { handlers.onStatus?.('未配置 Token（后台密钥与环境变量均无），备援未启动'); return () => {}; },
      stop() {} };
  }
  // start:aigc. R02：逐码请求必须带 symbols 归属——单码失败只判该品种，
  // 将来加第二码（如 XAUUSD）时互不牵连
  const reqFor = (code, quoteMap) => [{ url: `${BASE}/${ITICK_QMAP[code].type}/quote?region=GB&code=${code}`, headers: { token }, symbols: (quoteMap[code] ?? []).map((q) => q.symbol) }];
  return createPollingAdapter({
    id: 'itick', name: 'iTick', baseQuotes, fetchImpl,
    intervalMs: 30000,   // 免费版 5 次/分钟 → 2 次/分钟留余量
    // start:aigc. R06：供应商配额是协议红线，优先于全局配置钳制——poll_ms 覆盖值
    // 强制 ≥30s，防止数据库配置把轮询提到 12 次/分钟突破 5 次/分钟配额
    pollMs: pollMs != null ? Math.max(Math.floor(pollMs), 30000) : null,
    reqTimeoutMs: timeoutMs,
    buildQuotes: buildItickQuotes,
    requestsFor: (codes, quoteMap) => codes.filter((c) => ITICK_QMAP[c]).flatMap((c) => reqFor(c, quoteMap)),
    parseResponse: (text, quotes) => {
      const json = JSON.parse(text);
      if (json?.code !== 0) throw new Error(`业务码 ${json?.code}:${json?.msg ?? json?.message ?? ''}`);
      return parseItickJson(json, quotes);
    },
  });
}
// end:aigc.

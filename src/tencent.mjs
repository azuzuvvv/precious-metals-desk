// start:aigc.
// 腾讯行情协议模块：qt.gtimg.cn 阿里云可直连（实测 200），hf_ 外盘字段与新浪 hf_ 完全同构：
// [2]买 [3]卖 [4]高 [5]低 [6]时间(HH:mm:ss) [12]日期。用作美黄金/美白银的备援源。
// 刷新粒度 10~30 秒（准实时快照），日高日低与新浪精确一致（2026-10-27 实测 5 轮）。
import { createPollingAdapter } from './polling-adapter.mjs';
import { normalizeTick } from './adapter.mjs';

// start:aigc. 字段位表：与 SINA_QMAP 的 hf_ 系列一致（同构），只接入已实测校准的代码
const TX_QMAP = {
  hf_GC: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },   // 美黄金备援
  hf_SI: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },   // 美白银备援
};
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
// end:aigc.
const number = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };

export function buildTencentQuotes(baseQuotes) {
  // start:aigc. F01：基础行情或映射停用的不进订阅（零请求）
  const out = {};
  for (const bq of baseQuotes) {
    if (bq.enabled === false) continue;
    const s = (bq.sources || []).find((x) => x.sourceId === 'tencent');
    if (s?.enabled !== false && s?.code && s.code !== '__NONE__') (out[s.code] ??= []).push({ symbol: bq.symbol });
  }
  return out;
  // end:aigc.
}

export function parseTencentText(text, quotes, now = Date.now()) {
  const ticks = [];
  for (const m of text.matchAll(/v_(\w+)="([^"]*)"/g)) {
    const qs = quotes[m[1]]; if (!qs?.length) continue;
    const map = TX_QMAP[m[1]]; if (!map) continue;
    const f = m[2].split(',');
    const raw = {};
    if (map.buy != null) raw.buy = number(f[map.buy]);
    if (map.sell != null) raw.sell = number(f[map.sell]);
    if (map.high != null) raw.high = number(f[map.high]);
    if (map.low != null) raw.low = number(f[map.low]);
    // start:aigc. 时间按东八区显式解析（与 sina.mjs T02 同因：非 +08:00 服务器上避免时区错判）；
    // 解析失败整条丢弃不回退抓取时间，防休市旧价续命
    if (map.timeFields) {
      const parsed = Date.parse(`${f[map.timeFields[0]]}T${f[map.timeFields[1]]}+08:00`);
      if (!Number.isFinite(parsed) || parsed <= 0) continue;
      if (parsed > now + 300000) continue;   // 未来守卫
      raw.time = parsed;
    }
    // end:aigc.
    for (const q of qs) {
      try { ticks.push(normalizeTick(q.symbol, { ...raw })); } catch { /* 字段不足跳过 */ }
    }
  }
  return ticks;
}

// start:aigc. 协议组装：一个 URL 批量；文本协议无业务码，解析层已具备完整守卫
export function createTencentAdapter(baseQuotes, { fetchImpl = fetch, pollMs = null, timeoutMs = null } = {}) {
  return createPollingAdapter({
    id: 'tencent', name: '腾讯', baseQuotes, fetchImpl, pollMs, reqTimeoutMs: timeoutMs,
    buildQuotes: buildTencentQuotes,
    requestsFor: (codes) => [{ url: `https://qt.gtimg.cn/q=${codes.join(',')}`, headers: HEADERS }],
    parseResponse: (text, quotes) => parseTencentText(text, quotes),
  });
}
// end:aigc.

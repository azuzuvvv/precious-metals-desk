// start:aigc.
// 华尔街见闻协议模块：只描述协议差异，调度由 polling-adapter.mjs 统一承担。
// 阿里云可直连的免费源（新浪 hq 机房 403 后的替代主源），秒级实时。
// 口径与新浪 DINIW 同源（日高日低曾精确一致）：美元指数/港汇/离岸人民币/现货金银。
import { createPollingAdapter } from './polling-adapter.mjs';
import { normalizeTick } from './adapter.mjs';

// start:aigc. 返回的 fields 数组按请求动态变化（服务端自动追加 delisting_date），
// 必须按字段名定位索引，写死下标会因请求字段数变化而错位（验收实测踩坑）
const FKEYS = { last: 'last_px', high: 'high_px', low: 'low_px', time: 'update_time' };
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
const FIELDS_QS = Object.values(FKEYS).map((k) => `${k}${k === 'update_time' ? '' : ''}`).join(',');

export function buildWscnQuotes(baseQuotes) {
  // start:aigc. 与 buildSinaQuotes 同构 + F01：基础行情或映射停用的不进订阅（零请求）
  const out = {};
  for (const bq of baseQuotes) {
    if (bq.enabled === false) continue;
    const s = (bq.sources || []).find((x) => x.sourceId === 'wscn');
    if (s?.enabled !== false && s?.code && s.code !== '__NONE__') (out[s.code] ??= []).push({ symbol: bq.symbol });
  }
  return out;
}
// end:aigc.

export function parseWscnJson(json, quotes, now = Date.now()) {
  const ticks = [];
  const snapshot = json?.data?.snapshot ?? {};
  // start:aigc. 按返回的 fields 名定位各值下标；关键字段缺失（接口改版）整批跳过不产脏数据
  const fields = Array.isArray(json?.data?.fields) ? json.data.fields : [];
  const idx = {};
  for (const [k, fieldName] of Object.entries(FKEYS)) {
    const i = fields.indexOf(fieldName);
    if (i >= 0) idx[k] = i;
  }
  if (idx.last == null || idx.time == null) return ticks;
  // end:aigc.
  for (const [code, arr] of Object.entries(snapshot)) {
    const qs = quotes[code];
    if (!qs?.length) continue;   // 未映射代码（含占位）直接跳过
    // start:aigc. 时间守卫与 sina.mjs 对齐：源时间无效或明显晚于当前（+300s 容差）整条丢弃，
    // 不回退抓取时间，让旧值自然过期暴露 stale
    const tSec = Number(arr[idx.time]);
    if (!Number.isFinite(tSec) || tSec <= 0) continue;
    const time = tSec * 1000;
    if (time > now + 300000) continue;
    // end:aigc.
    const last = Number(arr[idx.last]);
    if (!Number.isFinite(last) || last <= 0) continue;
    // 见闻无买卖盘口：买卖同价，价差由品类公式基差体现（美元指数原口径 ±0.05 等）
    const raw = { buy: last, sell: last, time };
    if (idx.high != null) { const high = Number(arr[idx.high]); if (Number.isFinite(high) && high > 0) raw.high = high; }
    if (idx.low != null) { const low = Number(arr[idx.low]); if (Number.isFinite(low) && low > 0) raw.low = low; }
    for (const q of qs) {
      try { ticks.push(normalizeTick(q.symbol, raw)); } catch { /* 字段不足跳过 */ }
    }
  }
  return ticks;
}

// start:aigc. 协议组装：一次批量请求带全部代码；业务码非 20000 视为失败（F04：不给静默空结果）
export function createWscnAdapter(baseQuotes, { fetchImpl = fetch, pollMs = null, timeoutMs = null } = {}) {
  return createPollingAdapter({
    id: 'wscn', name: '华尔街见闻', baseQuotes, fetchImpl, pollMs, reqTimeoutMs: timeoutMs,
    buildQuotes: buildWscnQuotes,
    // R02：单批量请求覆盖全部品种，symbols 由运行器兜底（全源）
    requestsFor: (codes) => [{ url: `https://api-ddc-wscn.awtmt.com/market/real?fields=${FIELDS_QS}&prod_code=${codes.join(',')}`, headers: HEADERS }],
    parseResponse: (text, quotes) => {
      const json = JSON.parse(text);
      if (json?.code !== 20000) throw new Error(`业务码 ${json?.code}:${json?.message ?? ''}`);
      return parseWscnJson(json, quotes);
    },
  });
}
// end:aigc.

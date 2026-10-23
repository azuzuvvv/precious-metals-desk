// start:aigc.
// 新浪适配器：配置驱动（由目录的 sina 源 code 决定拉取哪些 symbol）。
// 字段映射集中在一个表，新增品种只需加表项。fx 外汇字段按 [1]=买 [2]=卖 [4]=高 [5]=低 假设，
// 港汇字段由 scripts/verify-live.mjs 探针在实盘校验。
import { normalizeTick } from './adapter.mjs';

const SINA_QMAP = {
  DINIW: { buy: 1, sell: 2, high: 6, low: 7 },             // 美元指数
  nf_AU0: { mid: [6, 7], sell: 7, high: 3, low: 4 },       // 沪金主力：回购=买卖中间价
  nf_AG0: { mid: [6, 7], sell: 7, high: 3, low: 4 },       // 沪银主力
  fx_susdhkd: { buy: 1, sell: 2, high: 4, low: 5 },        // 美元兑港元（字段以探针实测为准）
  // start:aigc. hf_ 外盘系列（R03 备援）：字段位经 scripts/probe-sina-hf.mjs 与融通金实测校准
  // [2]买 [3]卖 [4]高 [5]低 [12]日期+[6]时间（北京时间）。伦敦铂/钯以纽约系近似口径兜底。
  hf_XAU: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },
  hf_XAG: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },
  hf_GC: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },
  hf_SI: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },
  hf_XPT: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },
  hf_XPD: { buy: 2, sell: 3, high: 4, low: 5, timeFields: [12, 6] },
  // end:aigc.
};
const number = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };

export function buildSinaQuotes(baseQuotes) {
  const out = {};
  for (const bq of baseQuotes) {
    const s = (bq.sources || []).find((x) => x.sourceId === 'sina');
    if (s?.code && s.code !== '__NONE__') out[s.code] = { symbol: bq.symbol };
  }
  return out;
}

export function parseSinaText(text, quotes, now = Date.now()) {
  const ticks = [];
  for (const m of text.matchAll(/hq_str_(\w+)="([^"]*)"/g)) {
    const q = quotes[m[1]]; if (!q) continue;
    const map = SINA_QMAP[m[1]]; if (!map) continue;
    const f = m[2].split(',');
    const raw = {};
    if (map.buy != null) raw.buy = number(f[map.buy]);
    if (map.sell != null) raw.sell = number(f[map.sell]);
    if (map.mid) { const a = number(f[map.mid[0]]), b = number(f[map.mid[1]]); if (a != null && b != null) raw.buy = (a + b) / 2; }
    if (map.high != null) raw.high = number(f[map.high]);
    if (map.low != null) raw.low = number(f[map.low]);
    // start:aigc. hf_ 外盘自带源日期+时间（北京时间）时用源时间，缓解抓取时间冒充行情时间（R08 部分）
    let time = now;
    if (map.timeFields) {
      const parsed = Date.parse(`${f[map.timeFields[0]]}T${f[map.timeFields[1]]}`);
      if (Number.isFinite(parsed) && parsed > 0) time = parsed;
    }
    // end:aigc.
    try { ticks.push(normalizeTick(q.symbol, { ...raw, time })); } catch { /* 字段不足跳过 */ }
  }
  return ticks;
}

export function attachSina({ baseQuotes, onQuote, intervalMs = 15000 }) {
  const quotes = buildSinaQuotes(baseQuotes);
  const codes = Object.keys(quotes);
  if (!codes.length) return () => {};   // 无新浪品种可拉取时不开轮询
  const url = `https://hq.sinajs.cn/list=${codes.join(',')}`;
  async function poll() {
    try {
      const r = await fetch(url, { headers: { Referer: 'https://finance.sina.com.cn' }, signal: AbortSignal.timeout(8000) });
      // 新浪返回 GBK 编码，数字段均为 ASCII，latin1 解码即可
      const text = Buffer.from(await r.arrayBuffer()).toString('latin1');
      for (const t of parseSinaText(text, quotes)) onQuote(t);
    } catch { /* 拉取失败保留旧值，由超时机制标记 stale */ }
  }
  void poll();
  const timer = setInterval(poll, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
// end:aigc.
// start:aigc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSinaQuotes, parseSinaText } from '../src/sina.mjs';

test('parseSinaText 解析美元指数与沪金主力字段', () => {
  const quotes = buildSinaQuotes([
    { symbol: '美元指数', sources: [{ sourceId: 'sina', code: 'DINIW' }] },
    { symbol: '沪金主力', sources: [{ sourceId: 'sina', code: 'nf_AU0' }] },
  ]);
  const raw = 'hq_str_DINIW="15:00:00,103.5,103.55,103.4,103.6,103.2,103.5";\n'
    + 'hq_str_nf_AU0="沪金主力,15:00:00,4116.0,4120.0,4110.0,4112.0,887.0,888.0";';
  const ticks = parseSinaText(raw, quotes);
  const diniw = ticks.find((t) => t.symbol === '美元指数');
  assert.equal(diniw.buy, 103.5); assert.equal(diniw.sell, 103.55);
  const au = ticks.find((t) => t.symbol === '沪金主力');
  assert.equal(au.buy, 887.5); assert.equal(au.sell, 888.0); // mid(887,888)=887.5
});

test('港汇 fx_susdhkd 字段映射解析', () => {
  const quotes = buildSinaQuotes([{ symbol: '美元兑港元', sources: [{ sourceId: 'sina', code: 'fx_susdhkd' }] }]);
  // 字段布局取自 verify-live 港汇探针实盘报文（18 字段）
  const raw = 'hq_str_fx_susdhkd="11:11:21,7.841400,7.841900,7.835800,61,7.836100,7.841900,7.835800,7.841400,USDHKD,0.070000,0.005600,0.0007784,,7.849100,7.781500,,2026-10-23";';
  const [t] = parseSinaText(raw, quotes, 1792725082143);
  assert.equal(t.symbol, '美元兑港元');
  assert.equal(t.buy, 7.8414); assert.equal(t.sell, 7.8419);
  assert.equal(t.high, 7.8491, '日高取 [14]，不是持仓量位 [4]');
  assert.equal(t.low, 7.7815, '日低取 [15]');
  assert.equal(t.time, Date.parse('2026-10-23T11:11:21+08:00'), '源日期[17]+时间[0]按东八区组合解析');
});
// start:aigc.
test('hf_XAU 外盘字段映射与源时间解析', () => {
  const quotes = buildSinaQuotes([{ symbol: '伦敦金', sources: [{ sourceId: 'sina', code: 'hf_XAU' }] }]);
  const raw = 'hq_str_hf_XAU="4015.12,4024.260,4015.12,4015.47,4032.56,3986.78,10:17:00,4024.26,4025.41,0,0,0,2026-10-23,NAME";';
  const [t] = parseSinaText(raw, quotes, 1792721856000);
  assert.equal(t.symbol, '伦敦金');
  assert.equal(t.buy, 4015.12); // buy=[2]
  assert.equal(t.sell, 4015.47); // sell=[3]
  assert.equal(t.high, 4032.56);
  assert.equal(t.low, 3986.78);
  assert.equal(t.time, Date.parse('2026-10-23T10:17:00+08:00'), '源日期+时间按东八区组合解析，而非抓取时间');
});

// start:aigc.
test('T02：源时间明显晚于当前的异常报文整条丢弃', () => {
  const quotes = buildSinaQuotes([{ symbol: '伦敦金', sources: [{ sourceId: 'sina', code: 'hf_XAU' }] }]);
  // 报文源时间为当前 +1 小时（时钟错位/异常）：必须丢弃不产出 tick，避免未来时间恒不过期
  const now = Date.parse('2026-10-23T10:00:00+08:00');
  const raw = 'hq_str_hf_XAU="4015.12,4024.260,4015.12,4015.47,4032.56,3986.78,11:00:00,4024.26,4025.41,0,0,0,2026-10-23,NAME";';
  const ticks = parseSinaText(raw, quotes, now);
  assert.equal(ticks.length, 0, '未来时间的报文必须整条丢弃');
});

test('T01：无日期接口三天候选构造源时间（正常/休市缓存/跨零点）', () => {
  const quotes = buildSinaQuotes([{ symbol: '美元指数', sources: [{ sourceId: 'sina', code: 'DINIW' }] }]);
  const raw = (t) => `hq_str_DINIW="${t},103.5,103.55,103.4,103.6,103.2,103.5,103.6";`;
  // 正常时段：报文时间 3 分钟前 → time 取报文时间而非抓取时间
  const now = Date.parse('2026-10-23T10:00:00+08:00');
  let [t] = parseSinaText(raw('09:57:00'), quotes, now);
  assert.equal(t.time, Date.parse('2026-10-23T09:57:00+08:00'), '正常时段取报文时间');
  // 休市缓存：报文时间停在昨日下午收盘 → 构造出旧绝对时间，时差自然超 staleMs 暴露过期
  [t] = parseSinaText(raw('15:00:00'), quotes, now);
  assert.equal(t.time, Date.parse('2026-10-22T15:00:00+08:00'), '缓存报文得到最近的旧绝对时间（昨天候选）');
  // 跨零点：凌晨 00:05 收到昨日 23:59 报文 → 选前一天候选，不误拼成未来 24 小时
  const midnight = Date.parse('2026-10-23T00:05:00+08:00');
  [t] = parseSinaText(raw('23:59:00'), quotes, midnight);
  assert.equal(t.time, Date.parse('2026-10-22T23:59:00+08:00'), '跨零点选前一天候选');
});
// end:aigc.

test('共用 code 的报文同时服务多个基础行情（hf_XPT → 美铂金/伦敦铂）', () => {
  const quotes = buildSinaQuotes([
    { symbol: '伦敦铂', sources: [{ sourceId: 'sina', code: 'hf_XPT' }] },
    { symbol: '美铂金', sources: [{ sourceId: 'sina', code: 'hf_XPT' }] },
  ]);
  assert.equal(quotes.hf_XPT.length, 2, '共用 code 必须聚合为 symbol 数组，不能互相覆盖');
  const raw = 'hq_str_hf_XPT="1572.305,,1571.200,1571.700,1576.400,1556.500,10:15:24,1576.900,1572.500,0,1,1,2026-10-23,NAME,0";';
  const ticks = parseSinaText(raw, quotes, 1792721856000);
  assert.equal(ticks.length, 2, '一条报文必须产出两个品种的 tick');
  assert.ok(ticks.some((t) => t.symbol === '美铂金' && t.buy === 1571.2));
  assert.ok(ticks.some((t) => t.symbol === '伦敦铂' && t.buy === 1571.2));
});
// end:aigc.
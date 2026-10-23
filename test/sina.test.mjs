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
  const raw = 'hq_str_fx_susdhkd="17:59:59,7.8450,7.8460,7.8440,7.8480,7.8430,7.8460";';
  const [t] = parseSinaText(raw, quotes);
  assert.equal(t.symbol, '美元兑港元');
  assert.equal(t.buy, 7.8450); assert.equal(t.sell, 7.8460);
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
  assert.equal(t.time, Date.parse('2026-10-23T10:17:00'), '源日期+时间组合，而非抓取时间');
});

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
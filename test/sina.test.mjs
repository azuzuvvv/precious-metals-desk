// start:aigc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSinaQuotes, parseSinaText } from '../src/sina.mjs';

test('parseSinaText 解析美元指数与沪金主力字段（实盘报文格式）', () => {
  const quotes = buildSinaQuotes([
    { symbol: '美元指数', sources: [{ sourceId: 'sina', code: 'DINIW' }] },
    { symbol: '沪金主力', sources: [{ sourceId: 'sina', code: 'nf_AU0' }] },
  ]);
  // 报文取自 2026-10-23 收盘时段实盘探针：DINIW [10]=日期 [0]=HH:mm:ss；nf_AU0 [17]=日期 [1]=HHmmss 无冒号
  const raw = 'hq_str_DINIW="16:11:03,101.7436,101.7436,101.6219,3414,101.6241,101.8304,101.4890,101.7436,美元指数,2026-10-23";\n'
    + 'hq_str_nf_AU0="黄金连续,150000,880.000,881.000,858.080,864.360,864.160,864.360,864.360,869.200,886.380,1,1,198578.000,286554,沪,黄金,2026-10-23,1";';
  const now = Date.parse('2026-10-23T16:11:10+08:00');
  const ticks = parseSinaText(raw, quotes, now);
  const diniw = ticks.find((t) => t.symbol === '美元指数');
  assert.equal(diniw.buy, 101.7436); assert.equal(diniw.sell, 101.7436);
  assert.equal(diniw.time, Date.parse('2026-10-23T16:11:03+08:00'));
  const au = ticks.find((t) => t.symbol === '沪金主力');
  assert.equal(au.buy, 864.26); assert.equal(au.sell, 864.36); // mid(864.160,864.360)
  // T01 核心断言：收盘后报文时间停在收盘时刻（150000），tick.time 不再被轮询时间续命
  assert.equal(au.time, Date.parse('2026-10-23T15:00:00+08:00'), '收盘停更：源时间=收盘时刻而非抓取时间');
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

// start:aigc.
// T01 实盘修正：nf_/DINIW 报文自带真实日期（[17]/[10]），直接走 timeFields 精确路径，
// 无需三天候选兜底（原 timeOnly 方案基于"报文无日期"的错误假设，已随实盘探针修正移除）。
// end:aigc.
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
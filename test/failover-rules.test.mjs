// start:aigc.
// 备援切换验收（对应审查报告 R04/R05/R09/R07 与用户确认的 8 条规则）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quotes } from '../src/quotes.mjs';
import { snapshot } from '../src/config.mjs';
import { createRtj } from '../src/rtj.mjs';

const BQ = (symbol, sources) => ({ symbol, name: symbol, unit: '', decimals: 2, enabled: true, sources });
const SRC = (id, p) => ({ sourceId: id, priority: p, enabled: true });

test('单品类独立切换：X 切备源不影响 Y', () => {
  const q = new Quotes({ baseQuotes: [BQ('X', [SRC('a', 1), SRC('b', 2)]), BQ('Y', [SRC('a', 1), SRC('b', 2)])] });
  q.ingestTest('a', 'X', { buy: 1, sell: 2, time: 1000 }, 1000);
  q.ingestTest('a', 'Y', { buy: 3, sell: 4, time: 1000 }, 1000);
  q.failTest('a', 'X', '断线');
  q.ingestTest('b', 'X', { buy: 5, sell: 6, time: 1001 }, 1001);
  q.publish(1002);
  assert.equal(q.meta.get('X').sourceId, 'b');
  assert.equal(q.meta.get('Y').sourceId, 'a');
});

test('缺输入转下一来源：旧单侧源过期后由完整备源接管', () => {
  const q = new Quotes({ baseQuotes: [BQ('X', [SRC('a', 1), SRC('b', 2)])] });
  q.ingestTest('a', 'X', { buy: 100, time: 1000 }, 1000);           // a 只有买价
  q.ingestTest('b', 'X', { buy: 90, sell: 91, time: 46000 }, 46000); // b 双侧完整
  q.publish(46001);
  assert.equal(q.meta.get('X').sourceId, 'b');
  assert.equal(q.prices.get('【#X#销售价】').value, '91');
});

test('单基础价可派生双侧（规则2）', () => {
  const q = new Quotes({ baseQuotes: [BQ('X', [SRC('a', 1)])] });
  q.ingestTest('a', 'X', { buy: 100, time: 1000 }, 1000);
  q.publish(1000);
  const cfg = { version: 1, brand: {}, openMode: 'open', schedule: ['','','','','','',''],
    categories: [{ id: 'c1', name: '派生', visible: true, buyFormula: '【#X#回购价】*1+0', sellFormula: '【#X#回购价】*1+0', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up' }] };
  const row = snapshot(cfg, q, { now: 1000 }).rows[0];
  assert.equal(row.buy, '100.00'); assert.equal(row.sell, '100.00'); assert.equal(row.stale, false);
});

test('切源清除旧源字段：缺高低价显示空且不残留（规则5，R05）', () => {
  const q = new Quotes({ baseQuotes: [BQ('X', [SRC('a', 1), SRC('b', 2)])] });
  q.ingestTest('a', 'X', { buy: 100, sell: 101, high: 110, low: 95, time: 1000 }, 1000);
  q.publish(1000);
  assert.equal(q.prices.get('【#X#最高价】').value, '110');
  q.failTest('a', 'X', '断线');
  q.ingestTest('b', 'X', { buy: 90, sell: 91, time: 1001 }, 1001);
  q.publish(1002);
  assert.equal(q.prices.get('【#X#回购价】').value, '90');
  assert.equal(q.prices.get('【#X#最高价】'), undefined, '备源没有最高价时必须清掉旧源残留');
  assert.equal(q.prices.get('【#X#最低价】'), undefined);
});

test('全部失效保留最后一组完整报价并标过期（规则6，R09）', () => {
  const q = new Quotes({ baseQuotes: [BQ('X', [SRC('a', 1)])] });
  q.ingestTest('a', 'X', { buy: 100, sell: 101, time: 1000 }, 1000);
  q.failTest('a', 'X', '断线');
  q.publish(1001);
  const cfg = { version: 1, brand: {}, openMode: 'open', schedule: ['','','','','','',''],
    categories: [{ id: 'c1', name: 'X', visible: true, buyFormula: '【#X#回购价】', sellFormula: '【#X#销售价】', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up' }] };
  const row = snapshot(cfg, q, { now: 1001 }).rows[0];
  assert.equal(row.buy, '100.00'); assert.equal(row.sell, '101.00');
  assert.equal(row.stale, true, 'last-known 必须标过期');
  assert.equal(row.reason, '行情源中断，显示最后有效报价');
});

test('切源沿用用户基差（规则7）', () => {
  const q = new Quotes({ baseQuotes: [BQ('X', [SRC('a', 1), SRC('b', 2)])] });
  q.ingestTest('a', 'X', { buy: 100, sell: 101, time: 1000 }, 1000);
  q.failTest('a', 'X', '断线');
  q.ingestTest('b', 'X', { buy: 200, sell: 201, time: 1001 }, 1001);
  q.publish(1002);
  const cfg = { version: 1, brand: {}, openMode: 'open', schedule: ['','','','','','',''],
    categories: [{ id: 'c1', name: 'X', visible: true, buyFormula: '【#X#回购价】', sellFormula: '【#X#销售价】+3.5', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up' }] };
  const row = snapshot(cfg, q, { now: 1002 }).rows[0];
  assert.equal(row.sell, '204.50', '切源后仍按用户基差计算');
});

test('单侧停推不再把旧价标为新价（R04）', () => {
  const ticks = [];
  const rtj = createRtj({ map: [{ symbol: '黄金', code: 'JZJ_au', kind: 'split' }], onQuote: (t) => ticks.push(t) });
  rtj.ingestForTest({ code: 'JZJ_au_PB', quoteTime: 1000, rt: { last: 882 } });
  rtj.ingestForTest({ code: 'JZJ_au_PS', quoteTime: 1000, rt: { last: 885 } });
  rtj.ingestForTest({ code: 'JZJ_au_PB', quoteTime: 61000, rt: { last: 883 } }); // sell 停推，只来新买价
  const last = ticks[ticks.length - 1];
  assert.equal(last.buy, 883);
  assert.equal(last.sell, 885);
  assert.equal(last.time, 1000, '输出时间必须取两侧最旧，让旧侧可过期');
});

test('停用基础行情不产出报价并清理残留（R07）', () => {
  const q = new Quotes({ baseQuotes: [BQ('X', [SRC('a', 1)]), { ...BQ('Y', [SRC('a', 1)]), enabled: false }] });
  q.ingestTest('a', 'X', { buy: 1, sell: 2, time: 1000 }, 1000);
  q.ingestTest('a', 'Y', { buy: 3, sell: 4, time: 1000 }, 1000);
  q.publish(1000);
  assert.equal(q.prices.get('【#X#回购价】').value, '1');
  assert.equal(q.prices.get('【#Y#回购价】'), undefined, '停用的基础行情不得发布');
  assert.equal(q.meta.has('Y'), false);
});
// end:aigc.

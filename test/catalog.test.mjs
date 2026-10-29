import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, BASE_QUOTES, FIELD_LABELS, ITICK_STALE_MS } from '../src/catalog.mjs';

test('三元目录 seed 结构完整且交叉引用一致（第四批退役后）', () => {
  assert.deepEqual(FIELD_LABELS, { buy: '回购价', sell: '销售价', high: '最高价', low: '最低价' });
  const ids = SOURCES.map((s) => s.id);
  // 2026-10-29 第四批退役：仅保留 rtj/wscn/itick；sina/tencent/yahoo/frankfurter 不再登记（§9/§17.2）
  assert.deepEqual(ids, ['rtj', 'wscn', 'itick']);
  for (const bq of BASE_QUOTES) {
    assert.ok(bq.symbol && bq.name);
    assert.ok(Array.isArray(bq.sources) && bq.sources.length > 0);
    for (const s of bq.sources) {
      assert.ok(ids.includes(s.sourceId), `未知数据源 ${s.sourceId}`);
      assert.ok(Number.isInteger(s.priority));
    }
  }
  const baseSymbols = new Set(BASE_QUOTES.map((b) => b.symbol));
  assert.ok(baseSymbols.has('黄金') && baseSymbols.has('美元指数') && baseSymbols.has('美元兑港元') && baseSymbols.has('伦敦金'));
  // 退役影响清单固定为断言：美黄金/美白银/美元兑港元退化为单源
  for (const sym of ['美黄金', '美白银', '美元兑港元'])
    assert.equal(BASE_QUOTES.find((b) => b.symbol === sym).sources.length, 1, `${sym} 退役后单源`);
  assert.equal(BASE_QUOTES.find((b) => b.symbol === '美元指数').sources.length, 2, '美元指数仍 wscn+itick 双源');
  // 2026-10-29 沪金/沪银主力改由 iTick 内盘期货供给（sina 退役后实测可用），单源
  for (const sym of ['沪金主力', '沪银主力'])
    assert.deepEqual(BASE_QUOTES.find((b) => b.symbol === sym).sources.map((s) => s.sourceId), ['itick'], `${sym} 仅 itick 单源`);
  assert.equal(BASE_QUOTES.find((b) => b.symbol === '沪金主力').sources[0].code, 'AU', '沪金走 SHFE AU');
  assert.equal(BASE_QUOTES.find((b) => b.symbol === '沪银主力').sources[0].code, 'AG', '沪银走 SHFE AG');
  assert.ok(!baseSymbols.has('沪金次主力') && !baseSymbols.has('沪银次主力'), '次主力无源仍不登记');
  // start:aigc. 2026-10-29 P2：iTick 45 秒轮询 + 13 秒间隔下，过期阈值必须留余量（≥3 个周期）
  for (const sym of ['美元指数', '沪金主力', '沪银主力']) {
    const s = BASE_QUOTES.find((b) => b.symbol === sym).sources.find((x) => x.sourceId === 'itick');
    assert.equal(s.staleMs, ITICK_STALE_MS, `${sym} 的 iTick 映射须配放宽后的过期阈值`);
  }
  assert.ok(ITICK_STALE_MS >= 45000 * 3, '阈值须留 ≥3 个轮询周期的余量');
  // end:aigc.
});

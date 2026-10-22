import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, BASE_QUOTES, FIELD_LABELS } from '../src/catalog.mjs';

test('三元目录 seed 结构完整且交叉引用一致', () => {
  assert.deepEqual(FIELD_LABELS, { buy: '回购价', sell: '销售价', high: '最高价', low: '最低价' });
  const ids = SOURCES.map((s) => s.id);
  assert.ok(ids.includes('rtj') && ids.includes('sina') && ids.includes('yahoo') && ids.includes('frankfurter'));
  for (const bq of BASE_QUOTES) {
    assert.ok(bq.symbol && bq.name);
    assert.ok(Array.isArray(bq.sources) && bq.sources.length > 0);
    for (const s of bq.sources) {
      assert.ok(ids.includes(s.sourceId), `未知数据源 ${s.sourceId}`);
      assert.ok(Number.isInteger(s.priority));
    }
  }
  const baseSymbols = new Set(BASE_QUOTES.map((b) => b.symbol));
  assert.ok(baseSymbols.has('黄金') && baseSymbols.has('美元指数') && baseSymbols.has('美元兑港元')
    && baseSymbols.has('伦敦金') && baseSymbols.has('沪金主力'));
});
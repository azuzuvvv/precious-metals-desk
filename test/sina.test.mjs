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
// end:aigc.
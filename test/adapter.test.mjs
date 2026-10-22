import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTick } from '../src/adapter.mjs';

test('normalizeTick 保留有效数字字段并补充 symbol/time', () => {
  assert.deepEqual(normalizeTick('黄金', { buy: 882.73, sell: 885.73, time: 1700000000000 }),
    { symbol: '黄金', buy: 882.73, sell: 885.73, time: 1700000000000 });
});

test('normalizeTick 丢弃非有限数字与非法时间', () => {
  assert.deepEqual(normalizeTick('白银', { buy: 12.5, sell: NaN, high: Infinity, time: 1700000000000 }),
    { symbol: '白银', buy: 12.5, time: 1700000000000 });
  assert.throws(() => normalizeTick('', { buy: 1, time: 1700000000000 }), /行情键缺失/);
  assert.throws(() => normalizeTick('美元指数', { buy: 1, time: 0 }), /时间无效/);
  assert.throws(() => normalizeTick('美元指数', { high: 1, time: 1700000000000 }), /缺买卖价/);
  assert.throws(() => normalizeTick('白银', { buy: '12', sell: NaN, high: Infinity, time: 1700000000000 }), /缺买卖价/);
});
// start:aigc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, detectCycles } from '../src/config.mjs';

const cat = (id, name, buyFormula, extra = {}) => ({ id, name, visible: true, buyFormula, sellFormula: '', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up', ...extra });
const BASE = [{ symbol: '黄金', name: '黄金', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_au' }] }];

test('detectCycles 识别业务品类间循环引用', () => {
  const cats = [cat('a', 'A', '【#B#回购价】'), cat('b', 'B', '【#A#回购价】')];
  assert.throws(() => detectCycles(cats), /循环引用/);
});

test('detectCycles 对基础 symbol 引用不画边，直连透传不算自环', () => {
  // 品类「黄金」引用【#黄金#回购价】：目标是基础 symbol，优先于同名品类，不构成环
  const cats = [cat('c1', '黄金', '【#黄金#回购价】*1')];
  assert.doesNotThrow(() => detectCycles(cats, new Set(['黄金'])));
  assert.doesNotThrow(() => validateCatalog({ baseQuotes: BASE, categories: cats }));
});

test('validateCatalog 允许软引用（未知行情键不报错）', () => {
  // 铑金引用未登记的公斤条：软引用，运行时空值，校验放行
  assert.doesNotThrow(() => validateCatalog({ baseQuotes: BASE, categories: [cat('rh', '铑金', '', { sellFormula: '【#公斤条#回购价】*1' })] }));
});

test('validateCatalog 拒绝除零与非法语法', () => {
  assert.throws(() => validateCatalog({ baseQuotes: BASE, categories: [cat('c1', '港金', '【#黄金#回购价】/0', { decimals: 0 })] }), /除数不能为零/);
  assert.throws(() => validateCatalog({ baseQuotes: BASE, categories: [cat('c1', '港金', 'alert(1)')] }), /公式只允许|公式语法无效|公式不完整/);
});

test('validateCatalog 校验 id/name/decimals/rounding 结构', () => {
  assert.throws(() => validateCatalog({ baseQuotes: BASE, categories: [cat('c1', 'X', ''), cat('c1', 'Y', '')] }), /重复/);
  assert.throws(() => validateCatalog({ baseQuotes: BASE, categories: [cat('c1', 'X', '', { decimals: 9 })] }), /精度/);
  assert.throws(() => validateCatalog({ baseQuotes: BASE, categories: [cat('c1', 'X', '', { rounding: 'nope' })] }), /舍入/);
});
// end:aigc.

// start:aigc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, detectCycles } from '../src/config.mjs';

const cat = (id, name, buyFormula, extra = {}) => ({ id, name, visible: true, buyFormula, sellFormula: '', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up', ...extra });
// start:aigc. T08 外键校验后，BASE 的 sourceId 'rtj' 必须在 sources 中登记
const SRCS = [{ id: 'rtj', name: '融通金', type: 'websocket' }, { id: 'sina', name: '新浪', type: 'http' }];
const BASE = [{ symbol: '黄金', name: '黄金', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_au' }] }];
// end:aigc.

test('detectCycles 识别业务品类间循环引用', () => {
  const cats = [cat('a', 'A', '【#B#回购价】'), cat('b', 'B', '【#A#回购价】')];
  assert.throws(() => detectCycles(cats), /循环引用/);
  // 品类引用自身（非基础 symbol）构成自环
  assert.throws(() => detectCycles([cat('a', 'A', '【#A#回购价】')]), /循环引用/);
});

test('detectCycles 对基础 symbol 引用不画边，直连透传不算自环', () => {
  // 品类「黄金」引用【#黄金#回购价】：目标是基础 symbol，优先于同名品类，不构成环
  const cats = [cat('c1', '黄金', '【#黄金#回购价】*1')];
  assert.doesNotThrow(() => detectCycles(cats, new Set(['黄金'])));
  assert.doesNotThrow(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: cats }));
});

// start:aigc.
test('M06：品类引用品类放行保存，快照层提示取值为空（不阻塞软引用业务）', () => {
  // B 引用品类 A（非基础 symbol）：validateCatalog 放行——硬拒绝会误伤铑金引用公斤条
  // + 用户登记公斤条品类的合法组合（品类引用与软引用运行时同构）
  const chain = [cat('a', 'A', '【#黄金#回购价】'), cat('b', 'B', '【#A#回购价】')];
  assert.doesNotThrow(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: chain }));
  // 品类名与基础 symbol 同名：按基础行情解析，正常路径
  assert.doesNotThrow(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('c1', '黄金', '【#黄金#回购价】*1')] }));
});
// end:aigc.

test('validateCatalog 允许软引用（未知行情键不报错）', () => {
  // 铑金引用未登记的公斤条：软引用，运行时空值，校验放行
  assert.doesNotThrow(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('rh', '铑金', '', { sellFormula: '【#公斤条#回购价】*1' })] }));
});

test('validateCatalog 拒绝除零与非法语法', () => {
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('c1', '港金', '【#黄金#回购价】/0', { decimals: 0 })] }), /除数不能为零/);
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('c1', '港金', 'alert(1)')] }), /公式只允许|公式语法无效|公式不完整/);
});

test('validateCatalog 校验 id/name/decimals/rounding 结构', () => {
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('c1', 'X', ''), cat('c1', 'Y', '')] }), /重复/);
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('c1', 'X', '', { decimals: 9 })] }), /精度/);
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('c1', 'X', '', { rounding: 'nope' })] }), /舍入/);
  // name 是引用解析键，重复 name 也拒绝
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: BASE, categories: [cat('c1', 'X', ''), cat('c2', 'X', '')] }), /名称无效或重复/);
  // baseQuotes 元素缺 symbol 直接拒绝
  assert.throws(() => validateCatalog({ baseQuotes: [null], categories: [] }), /基础行情键无效/);
  // baseQuotes 名称/精度/来源结构对称校验
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: [{ symbol: 'X', name: '', decimals: 2 }], categories: [] }), /基础行情名称无效/);
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: [{ symbol: 'X', name: 'X', decimals: 9 }], categories: [] }), /基础行情精度无效/);
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: [{ symbol: 'X', name: 'X', decimals: 2, sources: [{ sourceId: 'rtj', priority: 'hi' }] }], categories: [] }), /优先级无效/);
});

// start:aigc.
test('validateCatalog T08：来源外键 / symbol 唯一 / 单行情内 sourceId 唯一', () => {
  // 拼写错误的 sourceId 必须在保存前拒绝（否则静默收不到数据）
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: [
    { symbol: 'X', name: 'X', decimals: 2, sources: [{ sourceId: 'typo', priority: 1 }] }], categories: [] }), /未在数据源中登记/);
  // 重复基础行情 symbol 拒绝（否则撞主键以 500 暴露）
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: [
    { symbol: 'X', name: 'X', decimals: 2 }, { symbol: 'X', name: 'X2', decimals: 2 }], categories: [] }), /重复/);
  // 单基础行情内重复 sourceId 拒绝
  assert.throws(() => validateCatalog({ sources: SRCS, baseQuotes: [
    { symbol: 'X', name: 'X', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1 }, { sourceId: 'rtj', priority: 2 }] }], categories: [] }), /重复/);
  // 合法映射不受影响
  assert.doesNotThrow(() => validateCatalog({ sources: SRCS, baseQuotes: [
    { symbol: 'X', name: 'X', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1 }, { sourceId: 'sina', priority: 2 }] }], categories: [] }));
});
// end:aigc.
// end:aigc.

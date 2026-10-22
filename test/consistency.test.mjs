// start:aigc.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

test('迁移后品类与升级前口径一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-migrate-'));
  try {
    const store = new Store(dir);
    const categories = store.categories();
    // 直连透传品类公式保持一致
    const gold = categories.find((c) => c.name === '黄金');
    assert.equal(gold.buyFormula, '【#黄金#回购价】');
    // 港金采用换算公式（买卖与高低全部换算，替换旧自引用透传）
    const hk = categories.find((c) => c.name === '港金');
    for (const f of ['buyFormula','sellFormula','highFormula','lowFormula']) assert.ok(hk[f].includes('37.429'), `${f} 应为换算公式`);
    // 铑金等复杂引用公式原样迁移（含对公斤条的软引用，运行时空值与线上等价）
    const rh = categories.find((c) => c.name === '铑金');
    assert.ok(rh && rh.sellFormula.includes('公斤条'));
    // 7 个硬缺口品类不迁入（后续由用户自行配置）
    for (const gap of ['公斤条','公斤铂','公斤钯','公斤银','沪金次主力','沪银次主力','美铑金']) {
      assert.equal(categories.filter((c) => c.name === gap).length, 0, `${gap} 不应迁入`);
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// end:aigc.

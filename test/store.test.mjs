import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// start:aigc.
// 来源密钥测试需确认 data/secret.key 已生成
import { existsSync } from 'node:fs';
// end:aigc.
import { Store } from '../src/store.mjs';

test('首次初始化迁移默认三元目录进 SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-catalog-'));
  try {
    const store = new Store(dir);
    const sources = store.sources();
    const baseQuotes = store.baseQuotes();
    const categories = store.categories();
    assert.ok(sources.some((s) => s.id === 'rtj'));
    assert.ok(sources.some((s) => s.id === 'sina'));
    assert.ok(baseQuotes.some((b) => b.symbol === '黄金'));
    // 业务品类来自 defaults.json rows
    assert.ok(categories.some((c) => c.name === '黄金'));
    assert.ok(categories.some((c) => c.name === '港金'));
    const hk = categories.find((c) => c.name === '港金');
    assert.ok(hk.buyFormula.includes('37.429'));
    // 港金高/低同样为换算公式（旧 defaults 的自引用透传在环检测中会判自环）
    assert.ok(hk.highFormula.includes('伦敦金'));
    assert.ok(hk.lowFormula.includes('美元兑港元'));
    // 铑金公式原样迁移（含对公斤条的软引用）
    const rh = categories.find((c) => c.name === '铑金');
    assert.ok(rh && rh.sellFormula.includes('公斤条'));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('港金公式再次打开后持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-persist-'));
  try {
    let store = new Store(dir);
    store.saveBaseQuotes(store.baseQuotes().map((b) => b.symbol === '美元兑港元' ? { ...b, decimals: 5 } : b));
    store.close();
    store = new Store(dir);
    assert.equal(store.baseQuotes().find((b) => b.symbol === '美元兑港元').decimals, 5);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// start:aigc.
test('来源密钥 AES-256-GCM 加密落库且可解密读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-crypto-'));
  try {
    const store = new Store(dir);
    store.setSourceSecret('rtj', 'my-secret-key');
    assert.equal(store.getSourceSecret('rtj'), 'my-secret-key');
    assert.equal(store.hasSourceSecret('rtj'), true);
    assert.equal(store.hasSourceSecret('sina'), false);
    const raw = store.db.prepare('SELECT secret_ciphertext FROM source_secrets WHERE source_id=?').get('rtj');
    assert.ok(raw && raw.secret_ciphertext !== 'my-secret-key');
    assert.ok(existsSync(join(dir, 'secret.key')));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// end:aigc.
// start:aigc.
test('升级迁移保留用户已有基差与自定义品类（R01）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-upgrade-'));
  try {
    let store = new Store(dir);
    // 模拟旧版本运营期修改：黄金加基差、隐藏白银、新增自定义品类
    const cfg = store.config();
    cfg.rows.find(r => r.name === '黄金').sellFormula = '【#黄金#销售价】+3.5';
    cfg.rows.find(r => r.name === '白银').visible = false;
    cfg.rows.push({ id: 'custom-9', name: '金条定制', visible: true, buyFormula: '【#黄金#回购价】*1.005', sellFormula: '【#黄金#销售价】*1.005', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up' });
    store.save(cfg, cfg.version);
    // 回到未迁移状态：清空目录三表 + sources（幂等守卫依据）
    store.db.exec('DELETE FROM categories; DELETE FROM base_quotes; DELETE FROM base_quote_sources; DELETE FROM sources;');
    store.close();
    // 重新打开触发迁移
    store = new Store(dir);
    const cats = store.categories();
    const gold = cats.find(c => c.name === '黄金');
    assert.equal(gold.sellFormula, '【#黄金#销售价】+3.5', '用户基差必须保留');
    assert.equal(cats.find(c => c.name === '白银').visible, false, '可见性必须保留');
    const custom = cats.find(c => c.name === '金条定制');
    assert.ok(custom, '自定义品类必须迁入');
    assert.equal(custom.buyFormula, '【#黄金#回购价】*1.005');
    const hk = cats.find(c => c.name === '港金');
    assert.ok(hk.sellFormula.includes('37.429'), '港金仍替换为换算公式');
    for (const gap of ['公斤条','公斤铂','公斤钯','公斤银','沪金次主力','沪银次主力','美铑金'])
      assert.equal(cats.filter(c => c.name === gap).length, 0, `${gap} 仍不迁入`);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// end:aigc.
// start:aigc.
test('已迁移库幂等补登记新浪外盘备援（R03）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-hf-up-'));
  try {
    let store = new Store(dir);
    // 模拟用户禁用伦敦金的新浪备援后重开：补登记不得覆盖 enabled=0
    store.db.prepare("UPDATE base_quote_sources SET enabled=0 WHERE symbol='伦敦金' AND source_id='sina'").run();
    store.close();
    store = new Store(dir);
    const rows = store.baseQuotes();
    // 时效红线 20s：仅美黄金/美白银保留备援（staleMs=20s），其余 hf_ 全部禁用
    const usGold = rows.find((b) => b.symbol === '美黄金');
    const usSina = usGold.sources.find((x) => x.sourceId === 'sina');
    assert.ok(usSina && usSina.code === 'hf_GC' && usSina.enabled === true);
    assert.equal(usSina.staleMs, 20000, '备援过期阈值应收紧至 20s');
    const usSilver = rows.find((b) => b.symbol === '美白银').sources.find((x) => x.sourceId === 'sina');
    assert.ok(usSilver && usSilver.code === 'hf_SI' && usSilver.enabled === true && usSilver.staleMs === 20000);
    for (const sym of ['伦敦金','伦敦银','美铂金','美钯金','伦敦铂','伦敦钯']) {
      const s = rows.find((r) => r.symbol === sym).sources.find((x) => x.sourceId === 'sina');
      assert.ok(!s || s.enabled === false, `${sym} 不得有启用的超时效备援`);
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// end:aigc.
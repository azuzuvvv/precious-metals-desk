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

// start:aigc.
test('一次性迁移登记后不再覆盖用户目录操作（T07）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-mig-'));
  try {
    let store = new Store(dir);   // 首次启动：migrateCatalog + sinaFailover 迁移执行并登记
    // 模拟用户后续操作：启用迁移中被禁用的伦敦金备援 + 删除美黄金的新浪备援
    store.db.prepare("INSERT OR IGNORE INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES ('伦敦金','sina',2,'sina','hf_XAU',1,20000)").run();
    store.db.prepare("UPDATE base_quote_sources SET enabled=1 WHERE symbol='伦敦金' AND source_id='sina'").run();
    store.db.prepare("DELETE FROM base_quote_sources WHERE symbol='美黄金' AND source_id='sina'").run();
    store.close();
    // 重启：迁移已登记必须跳过——启用不复活禁用、删除不复活行
    store = new Store(dir);
    const rows = store.baseQuotes();
    const hkSina = rows.find((b) => b.symbol === '伦敦金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(hkSina && hkSina.enabled === true, '用户手动启用的备援不得被重启强制禁回');
    const usSina = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(!usSina, '用户删除的映射不得在重启后复活');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// end:aigc.
// start:aigc.
test('M05：旧版三层库首次升级不重跑修正（含足迹全删的最坏场景）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-legacy-'));
  try {
    let store = new Store(dir);   // 建成三层库（模拟旧版创建的库）
    // 模拟旧版运营期的用户状态：删除美黄金备援、手动启用伦敦金 hf_XAU 备援
    store.db.prepare("DELETE FROM base_quote_sources WHERE symbol='美黄金' AND source_id='sina'").run();
    store.db.prepare("INSERT OR IGNORE INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES ('伦敦金','sina',2,'sina','hf_XAU',1,20000)").run();
    // 模拟"旧版库"：T07 之前的版本没有 migrations 表（同时覆盖足迹全删的歧义场景）
    store.db.exec('DROP TABLE migrations');
    store.close();
    // 升级启动：检测到 base_quote_sources 表存在而无 migrations 表 → 预置完成标记，不重跑修正
    store = new Store(dir);
    const rows = store.baseQuotes();
    const usSina = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(!usSina, '旧库升级：用户删除的映射不得复活（哪怕迁移足迹已全部消失）');
    const hkSina = rows.find((b) => b.symbol === '伦敦金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(hkSina && hkSina.enabled === true, '旧库升级：用户手动启用的备援不得被禁回');
    // 预置标记后，后续重启同样稳定跳过
    store.close();
    store = new Store(dir);
    assert.ok(!store.baseQuotes().find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina'));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// end:aigc.
// start:aigc.
test('F03：建表后迁移执行前中断的库重启必须真实执行迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-f03-'));
  try {
    let store = new Store(dir);   // 正常建库（表全部创建 + 迁移执行 + 登记）
    // 模拟"新版首次运行在 runMigration 前中断"：清掉迁移记录并回滚修正效果
    // （migrations 表存在但无 sinaFailover 记录；hf 映射删除模拟修正未执行）
    store.db.exec("DELETE FROM migrations");
    store.db.exec("DELETE FROM base_quote_sources WHERE source_id='sina' AND code IN ('hf_GC','hf_SI')");
    store.close();
    // 重启：migrations 表存在 → 不预置标记（修复前只查业务表会误预置）→ runMigration 真实执行
    store = new Store(dir);
    const rows = store.baseQuotes();
    const usGold = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(usGold && usGold.code === 'hf_GC' && usGold.enabled === true, '中断后重启：迁移必须真实执行并恢复美黄金备援映射');
    const usSilver = rows.find((b) => b.symbol === '美白银').sources.find((x) => x.sourceId === 'sina');
    assert.ok(usSilver && usSilver.code === 'hf_SI', '中断后重启：美白银备援映射同样恢复');
    // 且登记写回：再次重启不再重复执行（幂等）
    store.close();
    store = new Store(dir);
    assert.ok(store.db.prepare('SELECT name FROM migrations WHERE name=?').get('sinaFailover'), '迁移执行后必须登记，后续重启跳过');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// end:aigc.
// end:aigc.
// start:aigc.
// MySQL 改造适配说明：本文件已整体从 SQLite 适配到 MySQL——
// 1) new Store(dir) → await createTestStore()（独立测试库隔离，见 helpers.mjs），目录创建由 helper 接管；
// 2) "关掉重开" → await reopenTestStore(store)；测试结束 → await destroyTestStore(store)；
// 3) store.db.prepare().get()/.run() 与 db.exec() → store.pool.query()；INSERT OR IGNORE → ON DUPLICATE KEY UPDATE；
// 4) 各用例回调改 async、store 调用加 await。断言语义与测试意图保持不变。
import test from 'node:test';
import assert from 'node:assert/strict';
// 来源密钥测试需确认 data/secret.key 已生成
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTestStore, reopenTestStore, destroyTestStore } from './helpers.mjs';
// end:aigc.

test('首次初始化迁移默认三元目录进 MySQL', async () => {
  let store;
  try {
    store = await createTestStore();
    const sources = await store.sources();
    const baseQuotes = await store.baseQuotes();
    const categories = await store.categories();
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
  } finally { await destroyTestStore(store); }
});

test('港金公式再次打开后持久化', async () => {
  let store;
  try {
    store = await createTestStore();
    await store.saveBaseQuotes((await store.baseQuotes()).map((b) => b.symbol === '美元兑港元' ? { ...b, decimals: 5 } : b));
    store = await reopenTestStore(store);
    assert.equal((await store.baseQuotes()).find((b) => b.symbol === '美元兑港元').decimals, 5);
  } finally { await destroyTestStore(store); }
});

// start:aigc.
test('来源密钥 AES-256-GCM 加密落库且可解密读回', async () => {
  let store;
  try {
    store = await createTestStore();
    await store.setSourceSecret('rtj', 'my-secret-key');
    assert.equal(await store.getSourceSecret('rtj'), 'my-secret-key');
    assert.equal(await store.hasSourceSecret('rtj'), true);
    assert.equal(await store.hasSourceSecret('sina'), false);
    // 单行读取：pool.query 返回 [rows]，行在 rows[0]
    const [[raw]] = await store.pool.query('SELECT secret_ciphertext FROM source_secrets WHERE source_id=?', ['rtj']);
    assert.ok(raw && raw.secret_ciphertext !== 'my-secret-key');
    assert.ok(existsSync(join(store.dir, 'secret.key')));
  } finally { await destroyTestStore(store); }
});
// start:aigc.
// F02（四查）：红绿灯持久化的 null 语义——null=本进程无新事件（如重启后首轮无行情），
// 不得覆盖库中已有历史值；最近成功只前进，最近错误只在出现新错误时覆盖
test('F02：updateSourceHealth 的 null 不清除历史成功时间与历史错误', async () => {
  let store;
  try {
    store = await createTestStore();
    const read = async (id) => {
      const [[row]] = await store.pool.query('SELECT last_success_at,last_error FROM sources WHERE id=?', [id]);
      return row;
    };
    await store.updateSourceHealth('sina', '2026-10-28T01:00:00.000Z', 'HTTP 500');
    // 重启后首轮无行情：写 null 必须保留历史（页面承诺"重启后仍可追溯"）
    await store.updateSourceHealth('sina', null, null);
    let row = await read('sina');
    assert.equal(row.last_success_at, '2026-10-28T01:00:00.000Z', 'null 不得清空历史成功时间');
    assert.equal(row.last_error, 'HTTP 500', 'null 不得清空历史错误');
    // 有新事件时正常推进/覆盖
    await store.updateSourceHealth('sina', '2026-10-28T02:00:00.000Z', 'HTTP 401');
    row = await read('sina');
    assert.equal(row.last_success_at, '2026-10-28T02:00:00.000Z');
    assert.equal(row.last_error, 'HTTP 401');
  } finally { await destroyTestStore(store); }
});
// end:aigc.
// start:aigc.
test('升级迁移保留用户已有基差与自定义品类（R01）', async () => {
  let store;
  try {
    store = await createTestStore();
    // 模拟旧版本运营期修改：黄金加基差、隐藏白银、新增自定义品类
    const cfg = await store.config();
    cfg.rows.find(r => r.name === '黄金').sellFormula = '【#黄金#销售价】+3.5';
    cfg.rows.find(r => r.name === '白银').visible = false;
    cfg.rows.push({ id: 'custom-9', name: '金条定制', visible: true, buyFormula: '【#黄金#回购价】*1.005', sellFormula: '【#黄金#销售价】*1.005', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up' });
    await store.save(cfg, cfg.version);
    // 回到未迁移状态：清空目录三表 + sources（幂等守卫依据）；SQLite 多语句 exec 拆为逐条执行
    for (const sql of ['DELETE FROM categories', 'DELETE FROM base_quotes', 'DELETE FROM base_quote_sources', 'DELETE FROM sources']) {
      await store.pool.query(sql);
    }
    // 重新打开触发迁移
    store = await reopenTestStore(store);
    const cats = await store.categories();
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
  } finally { await destroyTestStore(store); }
});
// end:aigc.
// start:aigc.
test('已迁移库幂等补登记新浪外盘备援（R03）', async () => {
  let store;
  try {
    store = await createTestStore();
    // 模拟用户禁用伦敦金的新浪备援后重开：补登记不得覆盖 enabled=0
    await store.pool.query("UPDATE base_quote_sources SET enabled=0 WHERE symbol='伦敦金' AND source_id='sina'");
    store = await reopenTestStore(store);
    const rows = await store.baseQuotes();
    // 时效红线 20s：仅美黄金/美白银保留备援（staleMs=20s），其余 hf_ 全部禁用
    // start:aigc. 2026-10-28 换源后：sina 备援行仍被 sinaFailover 补登记（行存在、红线 20s），
    // 但随即被 wscnSources 禁用，实际生效备援为腾讯——两段断言分别验证
    const usGold = rows.find((b) => b.symbol === '美黄金');
    const usSina = usGold.sources.find((x) => x.sourceId === 'sina');
    assert.ok(usSina && usSina.code === 'hf_GC' && usSina.enabled === false, 'sina 美黄金备援应存在但已被换源迁移禁用');
    assert.equal(usSina.staleMs, 20000, '备援过期阈值应收紧至 20s');
    const usTx = usGold.sources.find((x) => x.sourceId === 'tencent');
    assert.ok(usTx && usTx.code === 'hf_GC' && usTx.enabled === true && usTx.staleMs === 20000, '生效备援应为腾讯 hf_GC（红线 20s）');
    const usSilver = rows.find((b) => b.symbol === '美白银').sources.find((x) => x.sourceId === 'sina');
    assert.ok(usSilver && usSilver.code === 'hf_SI' && usSilver.enabled === false && usSilver.staleMs === 20000);
    // end:aigc.
    for (const sym of ['伦敦金','伦敦银','美铂金','美钯金','伦敦铂','伦敦钯']) {
      const s = rows.find((r) => r.symbol === sym).sources.find((x) => x.sourceId === 'sina');
      assert.ok(!s || s.enabled === false, `${sym} 不得有启用的超时效备援`);
    }
  } finally { await destroyTestStore(store); }
});

// start:aigc.
test('一次性迁移登记后不再覆盖用户目录操作（T07）', async () => {
  let store;
  try {
    store = await createTestStore();   // 首次启动：migrateCatalog + sinaFailover 迁移执行并登记
    // 模拟用户后续操作：启用迁移中被禁用的伦敦金备援 + 删除美黄金的新浪备援
    // （INSERT OR IGNORE 的"键冲突跳过"语义用 ON DUPLICATE KEY UPDATE symbol=symbol 等价实现）
    await store.pool.query("INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES ('伦敦金','sina',2,'sina','hf_XAU',1,20000) ON DUPLICATE KEY UPDATE symbol=symbol");
    await store.pool.query("UPDATE base_quote_sources SET enabled=1 WHERE symbol='伦敦金' AND source_id='sina'");
    await store.pool.query("DELETE FROM base_quote_sources WHERE symbol='美黄金' AND source_id='sina'");
    // 重启：迁移已登记必须跳过——启用不复活禁用、删除不复活行
    store = await reopenTestStore(store);
    const rows = await store.baseQuotes();
    const hkSina = rows.find((b) => b.symbol === '伦敦金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(hkSina && hkSina.enabled === true, '用户手动启用的备援不得被重启强制禁回');
    const usSina = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(!usSina, '用户删除的映射不得在重启后复活');
  } finally { await destroyTestStore(store); }
});
// end:aigc.
// start:aigc.
test('M05：旧版三层库首次升级不重跑修正（含足迹全删的最坏场景）', async () => {
  let store;
  try {
    store = await createTestStore();   // 建成三层库（模拟旧版创建的库）
    // 模拟旧版运营期的用户状态：删除美黄金备援、手动启用伦敦金 hf_XAU 备援
    await store.pool.query("DELETE FROM base_quote_sources WHERE symbol='美黄金' AND source_id='sina'");
    await store.pool.query("INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES ('伦敦金','sina',2,'sina','hf_XAU',1,20000) ON DUPLICATE KEY UPDATE symbol=symbol");
    // 模拟"旧版库"：T07 之前的版本没有 migrations 表（同时覆盖足迹全删的歧义场景）
    await store.pool.query('DROP TABLE migrations');
    // 升级启动：检测到 base_quote_sources 表存在而无 migrations 表 → 预置完成标记，不重跑修正
    store = await reopenTestStore(store);
    const rows = await store.baseQuotes();
    const usSina = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(!usSina, '旧库升级：用户删除的映射不得复活（哪怕迁移足迹已全部消失）');
    const hkSina = rows.find((b) => b.symbol === '伦敦金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(hkSina && hkSina.enabled === true, '旧库升级：用户手动启用的备援不得被禁回');
    // 预置标记后，后续重启同样稳定跳过
    store = await reopenTestStore(store);
    assert.ok(!(await store.baseQuotes()).find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina'));
  } finally { await destroyTestStore(store); }
});
// end:aigc.
// start:aigc.
test('F03：建表后迁移执行前中断的库重启必须真实执行迁移', async () => {
  let store;
  try {
    store = await createTestStore();   // 正常建库（表全部创建 + 迁移执行 + 登记）
    // 模拟"新版首次运行在 runMigration 前中断"：清掉迁移记录并回滚修正效果
    // （migrations 表存在但无 sinaFailover 记录；hf 映射删除模拟修正未执行）
    await store.pool.query('DELETE FROM migrations');
    await store.pool.query("DELETE FROM base_quote_sources WHERE source_id='sina' AND code IN ('hf_GC','hf_SI')");
    // 重启：migrations 表存在 → 不预置标记（修复前只查业务表会误预置）→ runMigration 真实执行
    store = await reopenTestStore(store);
    const rows = await store.baseQuotes();
    // start:aigc. 2026-10-28 换源后终态变化：sinaFailover 先恢复 sina 行（行存在即证明迁移真实执行），
    // 随后 wscnSources 迁移禁用 sina 备援并启用腾讯备援——断言按新链路验证两个迁移都真实执行
    const usGold = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(usGold && usGold.code === 'hf_GC', '中断后重启：sinaFailover 迁移必须真实执行并恢复美黄金备援映射行');
    assert.ok(usGold.enabled === false, 'wscnSources 迁移必须随后执行并禁用 sina 美黄金备援');
    const txGold = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'tencent');
    assert.ok(txGold && txGold.code === 'hf_GC' && txGold.enabled === true, '美黄金备援已切换为腾讯 hf_GC');
    const usSilver = rows.find((b) => b.symbol === '美白银').sources.find((x) => x.sourceId === 'sina');
    assert.ok(usSilver && usSilver.code === 'hf_SI', '中断后重启：美白银备援映射同样恢复');
    const txSilver = rows.find((b) => b.symbol === '美白银').sources.find((x) => x.sourceId === 'tencent');
    assert.ok(txSilver && txSilver.code === 'hf_SI' && txSilver.enabled === true, '美白银备援已切换为腾讯 hf_SI');
    // 且登记写回：再次重启不再重复执行（幂等）；单行读取 rows[0] 不存在时为 undefined
    store = await reopenTestStore(store);
    const [[row]] = await store.pool.query('SELECT name FROM migrations WHERE name=?', ['sinaFailover']);
    assert.ok(row, '迁移执行后必须登记，后续重启跳过');
    const [[row2]] = await store.pool.query('SELECT name FROM migrations WHERE name=?', ['wscnSources']);
    assert.ok(row2, 'wscnSources 迁移执行后必须登记');
  } finally { await destroyTestStore(store); }
});
// end:aigc.
// end:aigc.

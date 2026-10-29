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
import { ITICK_STALE_MS } from '../src/catalog.mjs';
// end:aigc.

test('首次初始化迁移默认三元目录进 MySQL', async () => {
  let store;
  try {
    store = await createTestStore();
    const sources = await store.sources();
    const baseQuotes = await store.baseQuotes();
    const categories = await store.categories();
    assert.ok(sources.some((s) => s.id === 'rtj'));
    // start:aigc. 2026-10-29 第四批退役：四源不进 seed 也不得经 sources() 返回（§9.2）
    for(const gone of ['sina','tencent','yahoo','frankfurter'])
      assert.ok(!sources.some((s) => s.id === gone),`退役源 ${gone} 不得出现在 sources()`);
    // end:aigc.
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
    await store.updateSourceHealth('wscn', '2026-10-28T01:00:00.000Z', 'HTTP 500');
    // 重启后首轮无行情：写 null 必须保留历史（页面承诺"重启后仍可追溯"）
    await store.updateSourceHealth('wscn', null, null);
    let row = await read('wscn');
    assert.equal(row.last_success_at, '2026-10-28T01:00:00.000Z', 'null 不得清空历史成功时间');
    assert.equal(row.last_error, 'HTTP 500', 'null 不得清空历史错误');
    // 有新事件时正常推进/覆盖
    await store.updateSourceHealth('wscn', '2026-10-28T02:00:00.000Z', 'HTTP 401');
    row = await read('wscn');
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
test('已迁移库幂等补登记新浪外盘备援（R03）+ 第四批退役终态收敛', async () => {
  let store;
  try {
    store = await createTestStore();
    // 模拟用户禁用伦敦金的新浪备援后重开（历史中间态操作）
    await store.pool.query("UPDATE base_quote_sources SET enabled=0 WHERE symbol='伦敦金' AND source_id='sina'");
    store = await reopenTestStore(store);
    const rows = await store.baseQuotes();
    // start:aigc. 2026-10-29 第四批退役终态：retireSources 在迁移链最后执行——
    // sina/tencent/yahoo/frankfurter 的全部映射行（含 sinaFailover/wscnSources 曾插入/禁用的）
    // 一并删除；美黄金/美白银退化为 rtj 单源（§17.2 用户确认接受）
    for(const gone of ['sina','tencent'])
      for(const sym of ['美黄金','美白银','伦敦金'])
        assert.ok(!rows.find((b)=>b.symbol===sym)?.sources.some((x)=>x.sourceId===gone),`${sym} 不残留 ${gone} 映射（退役清理）`);
    assert.deepEqual(rows.find((b)=>b.symbol==='美黄金').sources.map((s)=>s.sourceId),['rtj'],'美黄金仅剩 rtj');
    assert.deepEqual(rows.find((b)=>b.symbol==='美白银').sources.map((s)=>s.sourceId),['rtj'],'美白银仅剩 rtj');
    assert.deepEqual(rows.find((b)=>b.symbol==='美元兑港元').sources.map((s)=>s.sourceId),['wscn'],'美元兑港元仅剩 wscn');
    // start:aigc. 2026-10-29 沪金/沪银主力改由 iTick 内盘期货供给：退役删除 → 恢复为 itick 单源
    for(const sym of ['沪金主力','沪银主力'])
      assert.deepEqual(rows.find((b)=>b.symbol===sym)?.sources.map((s)=>s.sourceId),['itick'],`${sym} 为 itick 单源`);
    // end:aigc.
    // end:aigc.
  } finally { await destroyTestStore(store); }
});

// start:aigc.
// 第四批复查整改验收：退役迁移不得误删用户定制内容——
// A 公式加过差价的品类保留（基础行情行因无有效源仍删）；
// B 配置了非退役源映射的品种：基础行情行 + 映射 + 默认透传品类全保留（无孤立映射）；
// C 默认透传且无任何有效源的品类仍随退役删除（原行为）；
// D 公式改为引用其他品类的保留
test('第四批复查：退役迁移不误删用户定制内容（公式改动/其他有效源映射）', async () => {
  let store;
  try {
    store = await createTestStore();
    const q = (sql, p) => store.pool.query(sql, p);
    // start:aigc. 新默认目录已登记 iTick 内盘品种，先清空以还原"退役前"形态（只有 sina 源）；
    // 只清 retireSources 记录随后的重跑，itickCnFutures 仍保持已执行（否则恢复会盖掉断言场景）
    for (const sym of ['沪金主力', '沪银主力']) {
      await q('DELETE FROM base_quote_sources WHERE symbol=?', [sym]);
      await q('DELETE FROM base_quotes WHERE symbol=?', [sym]);
    }
    await q("DELETE FROM categories WHERE name IN ('沪金主力','沪银主力','沪金次主力','沪银次主力')");
    // end:aigc.
    // 还原退役前形态：sina 可用 + 沪金/沪银主力基础行情（sina 映射）+ 四个品类
    await q("INSERT INTO sources (id,name,type,enabled,retired) VALUES ('sina','新浪','http',1,0) ON DUPLICATE KEY UPDATE retired=0,enabled=1");
    await q("INSERT INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES ('沪金主力','沪金主力','元/克',2,1) ON DUPLICATE KEY UPDATE enabled=1");
    await q("INSERT INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES ('沪银主力','沪银主力','元/千克',1,1) ON DUPLICATE KEY UPDATE enabled=1");
    await q("INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled) VALUES ('沪金主力','sina',1,'sina','nf_AU0',1) ON DUPLICATE KEY UPDATE symbol=symbol");
    await q("INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled) VALUES ('沪银主力','sina',1,'sina','nf_AG0',1) ON DUPLICATE KEY UPDATE symbol=symbol");
    // 场景B：用户为沪银主力配置了非退役源（wscn）映射
    await q("INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled) VALUES ('沪银主力','wscn',2,'wscn','AU0.SHFE',1) ON DUPLICATE KEY UPDATE symbol=symbol");
    const cat = (id, name, buy) => q(
      "INSERT INTO categories (id,name,visible,buy_formula,sell_formula,high_formula,low_formula,decimals,rounding,sort) VALUES (?,?,1,?,?,?,?,2,'half-up',0) ON DUPLICATE KEY UPDATE name=name",
      [id, name, buy, `【#${name}#销售价】`, `【#${name}#最高价】`, `【#${name}#最低价】`]);
    await cat('t1', '沪金主力', '【#沪金主力#回购价】+3.5');   // A：加差价（定制）
    await cat('t2', '沪银主力', '【#沪银主力#回购价】');         // B：默认透传但品种有有效源
    await cat('t3', '沪金次主力', '【#沪金次主力#回购价】');     // C：默认透传且无源
    await cat('t4', '沪银次主力', '【#黄金#回购价】*0.9');       // D：改引用其他品类（定制）
    // 删除迁移记录让 reopen 重跑 retireSources（等价线上升级首次执行）
    await q("DELETE FROM migrations WHERE name='retireSources'");
    store = await reopenTestStore(store);
    const bqs = await store.baseQuotes();
    const cats = await store.categories();
    // 基础行情：仅剩 sina 映射的沪金主力随退役删除；有 wscn 有效映射的沪银主力保留且仅剩 wscn（无孤立映射）
    assert.ok(!bqs.some((b) => b.symbol === '沪金主力'), '仅剩退役源映射的沪金主力基础行情应删除');
    const agRow = bqs.find((b) => b.symbol === '沪银主力');
    assert.ok(agRow, '配置了非退役源映射的沪银主力基础行情应保留');
    assert.deepEqual(agRow.sources.map((s) => s.sourceId), ['wscn'], 'sina 映射清理后仅剩 wscn');
    // 品类四场景逐一验收
    assert.ok(cats.some((c) => c.name === '沪金主力'), 'A：加过差价的沪金主力品类不得误删');
    assert.ok(cats.some((c) => c.name === '沪银主力'), 'B：品种仍有有效源的沪银主力品类不得误删');
    assert.ok(!cats.some((c) => c.name === '沪金次主力'), 'C：默认透传且无源的沪金次主力仍随退役删除');
    assert.ok(cats.some((c) => c.name === '沪银次主力'), 'D：改过公式的沪银次主力品类不得误删');
  } finally { await destroyTestStore(store); }
});
// end:aigc.

// start:aigc.
test('P2 复审：iTick 映射过期阈值放宽（新建库与存量库都生效）', async () => {
  let store;
  try {
    store = await createTestStore();
    const read = async () => (await store.pool.query("SELECT symbol,stale_ms FROM base_quote_sources WHERE source_id='itick' ORDER BY symbol"))[0];
    // 新建库：seed 带 ITICK_STALE_MS，与 45 秒轮询 + 13 秒间隔匹配
    for (const r of await read()) assert.equal(Number(r.stale_ms), ITICK_STALE_MS, `${r.symbol} 新建库阈值`);
    // 存量库：旧行未配置（NULL）或沿用全局 45 秒 → 迁移放宽，且不覆盖用户更宽的配置
    await store.pool.query("UPDATE base_quote_sources SET stale_ms=NULL WHERE source_id='itick' AND symbol='美元指数'");
    await store.pool.query("UPDATE base_quote_sources SET stale_ms=20000 WHERE source_id='itick' AND symbol='沪金主力'");
    await store.pool.query("UPDATE base_quote_sources SET stale_ms=600000 WHERE source_id='itick' AND symbol='沪银主力'");
    await store.pool.query("DELETE FROM migrations WHERE name='itickStaleWiden'");
    store = await reopenTestStore(store);
    const after = Object.fromEntries((await read()).map((r) => [r.symbol, Number(r.stale_ms)]));
    assert.equal(after['美元指数'], ITICK_STALE_MS, 'NULL 阈值须放宽');
    assert.equal(after['沪金主力'], ITICK_STALE_MS, '过紧阈值须放宽');
    assert.equal(after['沪银主力'], 600000, '用户已配的更宽阈值不得被收紧');
  } finally { await destroyTestStore(store); }
});
// end:aigc.

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
    // start:aigc. 2026-10-29 第四批修订：旧库升级路径同样完成退役——预置标记只豁免 sinaFailover，
    // retireSources 仍执行：用户手动启用的 sina 行（退役源）一并清理，不得再作为可用映射回流
    const hkSina = rows.find((b) => b.symbol === '伦敦金').sources.find((x) => x.sourceId === 'sina');
    assert.ok(!hkSina, '旧库升级：退役源的映射同样被清理（retired 与 enabled 区分，§9.2）');
    // end:aigc.
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
    // start:aigc. 2026-10-29 第四批终态：迁移链全部真实执行——sinaFailover 恢复行、wscnSources
    // 启用腾讯备援、retireSources 最终退役清理（sina/tencent 行全删、美黄金/美白银仅剩 rtj）。
    // 以终态 + 迁移登记共同证明三个迁移都真实执行（中间态被最终迁移收敛，§9.3 重启不复活）
    const usGoldSina = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'sina');
    const usGoldTx = rows.find((b) => b.symbol === '美黄金').sources.find((x) => x.sourceId === 'tencent');
    assert.ok(!usGoldSina && !usGoldTx, '中断后重启：sina/tencent 映射被 retireSources 最终清理');
    assert.deepEqual(rows.find((b) => b.symbol === '美黄金').sources.map((s) => s.sourceId), ['rtj']);
    assert.deepEqual(rows.find((b) => b.symbol === '美白银').sources.map((s) => s.sourceId), ['rtj']);
    // 且登记写回：再次重启不再重复执行（幂等）
    store = await reopenTestStore(store);
    const [[row]] = await store.pool.query('SELECT name FROM migrations WHERE name=?', ['sinaFailover']);
    assert.ok(row, '迁移执行后必须登记，后续重启跳过');
    const [[row2]] = await store.pool.query('SELECT name FROM migrations WHERE name=?', ['wscnSources']);
    assert.ok(row2, 'wscnSources 迁移执行后必须登记');
    const [[row3]] = await store.pool.query('SELECT name FROM migrations WHERE name=?', ['retireSources']);
    assert.ok(row3, 'retireSources 迁移执行后必须登记');
    // 重启后终态保持（retired 源行不复活、映射不回流）
    const rows2 = await store.baseQuotes();
    assert.ok(!rows2.find((b) => b.symbol === '美黄金').sources.some((x) => ['sina','tencent'].includes(x.sourceId)), '重启后退役映射不复活');
    // end:aigc.
  } finally { await destroyTestStore(store); }
});
// end:aigc.
// end:aigc.

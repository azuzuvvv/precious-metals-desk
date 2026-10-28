// start:aigc.
// MySQL 方案定案固化用例：把驱动行为与排序规则层面的关键语义锁进测试，
// 防依赖升级或环境变更时静默漂移（对应 docs/MySQL数据库改造方案.md 17.4/18 节定案）
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {createTestStore,destroyTestStore,testDbOptions} from './helpers.mjs';

test('FOUND_ROWS：affectedRows 为匹配行数而非实际更改行数', async () => {
  let store;
  try {
    store = await createTestStore();
    // 取迁移产生的既有品类行：值完全相同的 UPDATE 也应计为匹配 1 行（未开 FOUND_ROWS 时会是 0）
    const [[row]] = await store.pool.query('SELECT id,name FROM categories LIMIT 1');
    const [sameValue] = await store.pool.query('UPDATE categories SET name=? WHERE id=?', [row.name, row.id]);
    assert.equal(sameValue.affectedRows, 1, '同值 UPDATE 的 affectedRows 应为 1');
    // 不存在的 id：匹配 0 行
    const [noMatch] = await store.pool.query("UPDATE categories SET name=name WHERE id='__not_exist__'");
    assert.equal(noMatch.affectedRows, 0, '未匹配任何行的 UPDATE affectedRows 应为 0');
  } finally { await destroyTestStore(store); }
});

test('乐观锁：同库两实例并发保存同版本号，恰好一个成功、另一个 409', async () => {
  let store, storeB;
  try {
    store = await createTestStore();
    // 同库第二实例：模拟两个后端进程同时编辑同一配置
    storeB = await Store.create(store.dir, testDbOptions(store.__testDb));
    const cfg = await store.config();
    const version = cfg.version;
    const results = await Promise.allSettled([
      store.save(structuredClone(cfg), version),
      storeB.save(structuredClone(cfg), version),
    ]);
    // WHERE version=? 条件更新保证：后提交方匹配 0 行 → 恰好一个成功、一个 409
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflict = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, '恰好一个实例保存成功');
    assert.equal(conflict.length, 1, '恰好一个实例保存冲突');
    assert.equal(conflict[0].reason.status, 409, '冲突方必须抛 status=409');
  } finally {
    if (storeB) await storeB.close();
    await destroyTestStore(store);
  }
});

test('utf8mb4_bin：大小写敏感且尾随空格不敏感（PAD SPACE）', async () => {
  let store;
  try {
    store = await createTestStore();
    // 大小写不同 → 不相等（ID/符号列 _bin 排序规则的核心语义）
    const [[caseDiff]] = await store.pool.query("SELECT 'HK'='hk' COLLATE utf8mb4_bin AS v");
    assert.equal(Number(caseDiff.v), 0, "_bin 下 'HK' 与 'hk' 不相等");
    // 尾随空格在比较时被忽略（PAD SPACE 定案语义，见方案 17.5）
    const [[padSpace]] = await store.pool.query("SELECT 'HK'='HK ' COLLATE utf8mb4_bin AS v");
    assert.equal(Number(padSpace.v), 1, "_bin 为 PAD SPACE：'HK' 与 'HK ' 相等");
  } finally { await destroyTestStore(store); }
});

test('LIMIT ? 参数绑定：switchLogs(2) 最多返回 2 条', async () => {
  let store;
  try {
    store = await createTestStore();
    for (const symbol of ['伦敦金', '伦敦银', '美黄金']) {
      await store.appendSwitchLog({symbol, mode: 'auto', reason: '固化 LIMIT 参数绑定语义'});
    }
    const logs = await store.switchLogs(2);
    assert.equal(logs.length, 2, 'LIMIT ? 绑定数字参数应生效');
    assert.equal(logs[0].symbol, '美黄金', '按 id 倒序取最新记录');
  } finally { await destroyTestStore(store); }
});

test('唯一性：_bin 下大小写不同键可共存，尾随空格视为同一键冲突', async () => {
  let store;
  try {
    store = await createTestStore();
    const insert = (id) => store.pool.query(
      'INSERT INTO categories (id,name,buy_formula,sell_formula,high_formula,low_formula) VALUES (?,?,?,?,?,?)',
      [id, '探针品类', '1', '1', '', '']
    );
    await insert('HK');
    await insert('hk'); // _bin 大小写敏感：'hk' 与 'HK' 是不同键，插入成功
    // PAD SPACE：'HK ' 与 'HK' 比较相等 → 主键冲突（ER_DUP_ENTRY）
    await assert.rejects(insert('HK '), (e) => e.code === 'ER_DUP_ENTRY', "插入 'HK ' 应主键冲突");
    const [[count]] = await store.pool.query("SELECT COUNT(*) c FROM categories WHERE id IN ('HK','hk')");
    assert.equal(Number(count.c), 2, "大小写不同的两个键应共存");
  } finally { await destroyTestStore(store); }
});
// end:aigc.

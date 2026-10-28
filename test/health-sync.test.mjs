// start:aigc.
// F03（四查）回归：健康状态写库失败后，相同状态必须在下一轮重试（不能被 synced 缓存吞掉）；
// 成功后相同状态跳过；同源在途写不重复发起（防重叠，慢写入不会以旧状态乱序覆盖新状态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthSyncer } from '../src/health-sync.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 可编排的假 store：按序返回预设结果（reject/resolve），记录全部调用参数
const fakeStore = (script) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    async updateSourceHealth(id, lastSuccessAt, lastError) {
      calls.push({ id, lastSuccessAt, lastError });
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'fail') throw new Error('db down');
      return undefined;
    },
  };
};

test('F03：写失败后相同状态仍重试，成功后才跳过', async () => {
  const status = new Map([['sina', { lastSuccessAt: new Date('2026-10-28T02:00:00Z'), lastError: 'HTTP 500' }]]);
  // 第一次失败、第二次成功：失败不得标记 synced，下一轮相同状态必须再写
  const store = fakeStore(['fail', 'ok']);
  const errors = [];
  const syncer = createHealthSyncer({ store, sourceStatus: () => status, intervalMs: 600000, onError: (e) => errors.push(e.message) });
  try {
    syncer.tick(); await sleep(10);   // 第一轮：写失败
    assert.equal(store.calls.length, 1);
    assert.equal(errors.length, 1, '写失败必须上报错误');
    syncer.tick(); await sleep(10);   // 第二轮：相同状态重试（F03 核心）
    assert.equal(store.calls.length, 2, '失败后相同状态不得被 synced 缓存跳过');
    syncer.tick(); await sleep(10);   // 第三轮：已成功落库且状态未变 → 跳过
    assert.equal(store.calls.length, 2, '成功后相同状态才允许跳过');
    assert.deepEqual(store.calls[0], { id: 'sina', lastSuccessAt: '2026-10-28T02:00:00.000Z', lastError: 'HTTP 500' });
  } finally { syncer.stop(); }
});

test('F03：同源在途写未完成时不重复发起（防重叠）', async () => {
  const status = new Map([['sina', { lastSuccessAt: new Date('2026-10-28T02:00:00Z'), lastError: null }]]);
  let release;
  const gate = new Promise((r) => { release = r; });   // 第一笔写挂起，模拟慢写入
  const calls = [];
  const store = { async updateSourceHealth(id, s, e) { calls.push({ id, s, e }); await gate; } };
  const syncer = createHealthSyncer({ store, sourceStatus: () => status, intervalMs: 600000, onError: () => {} });
  try {
    syncer.tick(); await sleep(5);    // 第一笔在途
    status.set('sina', { lastSuccessAt: new Date('2026-10-28T03:00:00Z'), lastError: 'HTTP 500' });
    syncer.tick(); await sleep(5);    // 状态已变但第一笔在途：本轮让位，不产生乱序第二笔
    assert.equal(calls.length, 1, '在途写未完成时不得重复发起');
    release(); await sleep(10);       // 第一笔完成后，下一轮以最新状态写入
    syncer.tick(); await sleep(10);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].s, '2026-10-28T03:00:00.000Z', '补写必须携带最新状态');
    assert.equal(calls[1].e, 'HTTP 500');
  } finally { release?.(); syncer.stop(); }
});
// end:aigc.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Selector, HEALTHY, STALE, DISCONNECTED } from '../src/selector.mjs';

const BASE = [{ symbol: '美元指数', sources: [
  { sourceId: 'sina', priority: 1, enabled: true },
  { sourceId: 'yahoo', priority: 2, enabled: true },
] }];
const tick = (time) => ({ symbol: '美元指数', buy: 103.5, sell: 103.55, time });

test('主源健康时选中优先级最高来源，且 mode 为 primary', () => {
  const s = new Selector(); s.configure(BASE);
  s.ingest('美元指数', 'sina', tick(1000), { now: 1000 });
  assert.equal(s.state('美元指数', 1000).sourceId, 'sina');
  assert.equal(s.state('美元指数', 1000).mode, 'primary');
  assert.equal(s.state('美元指数', 1000).status, HEALTHY);
});

test('主源失效且备援已健康时立即切换为 failover', () => {
  const s = new Selector(); s.configure(BASE); const now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.ingest('美元指数', 'yahoo', tick(now), { now });
  s.markFailure('美元指数', 'sina', '断线');
  assert.equal(s.state('美元指数', now).sourceId, 'yahoo');
  assert.equal(s.state('美元指数', now).mode, 'failover');
});

test('主源失效且备援无数据时回退 last-known', () => {
  const s = new Selector(); s.configure(BASE); const now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.markFailure('美元指数', 'sina', '断线');
  assert.equal(s.state('美元指数', now).mode, 'last-known');
  assert.equal(s.state('美元指数', now).sourceId, 'sina');
  assert.equal(s.getTick('美元指数').buy, 103.5);
});

test('主源恢复需连续 3 次有效更新才切回', () => {
  const s = new Selector(); s.configure(BASE); let now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.ingest('美元指数', 'yahoo', tick(now), { now });
  s.markFailure('美元指数', 'sina', '断线');
  assert.equal(s.state('美元指数', now).sourceId, 'yahoo');
  s.ingest('美元指数', 'sina', tick(now += 1), { now }); assert.equal(s.state('美元指数', now).sourceId, 'yahoo', '首次恢复不切回');
  s.ingest('美元指数', 'sina', tick(now += 1), { now }); assert.equal(s.state('美元指数', now).sourceId, 'yahoo', '第二次恢复不切回');
  s.ingest('美元指数', 'sina', tick(now += 1), { now }); assert.equal(s.state('美元指数', now).sourceId, 'sina', '第三次恢复切回');
});

test('超时变 stale，全部失效时保留 last-known', () => {
  const s = new Selector({ staleMs: 45000 }); s.configure(BASE); let now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.refresh(now + 45001);
  assert.equal(s.state('美元指数', now + 45001).mode, 'last-known');
  assert.equal(s.state('美元指数', now + 45001).sourceId, 'sina');
  assert.equal(s.getTick('美元指数', now + 45001).buy, 103.5);
});

test('切换时触发 onSwitch 日志', () => {
  const events = []; const s = new Selector({ onSwitch: (e) => events.push(e) }); s.configure(BASE);
  let now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.ingest('美元指数', 'yahoo', tick(now), { now });
  s.markFailure('美元指数', 'sina', '断线');
  assert.equal(events.length, 1);
  assert.deepEqual({ symbol: events[0].symbol, oldSource: events[0].oldSource, newSource: events[0].newSource, mode: events[0].mode },
    { symbol: '美元指数', oldSource: 'sina', newSource: 'yahoo', mode: 'failover' });
});

test('disabled 来源不被选择', () => {
  const s = new Selector(); s.configure([{ symbol: 'X', sources: [
    { sourceId: 'a', priority: 1, enabled: false },
    { sourceId: 'b', priority: 2, enabled: true },
  ] }]);
  s.ingest('X', 'a', { symbol: 'X', buy: 1, time: 1 }, { now: 1 });
  s.ingest('X', 'b', { symbol: 'X', buy: 2, time: 1 }, { now: 1 });
  assert.equal(s.state('X', 1).sourceId, 'b');
});
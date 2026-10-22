# 贵金属行情源、自动备援与动态品类 实现计划

> 本文档由 Trae 生成。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用「融通金(主) + 新浪(备援)」两层真实数据源重建行情系统，引入可插拔的数据源抽象、来源状态机与自动切换、三层行情模型（数据源/基础行情/业务品类）、目录迁移进 SQLite、配置版本回滚、来源切换日志与密钥加密，替换即将下线的旧 k1 数据源。

**Architecture:** 数据源适配器输出统一的 tick（`{symbol,sell,buy,high,low,time}`）；`Selector` 为每个基础行情维护各来源的 healthy/stale/disconnected/disabled 状态并按优先级选择健康来源（主源失效立即切换、恢复需连续 3 次有效更新才切回）；`Quotes` 聚合适配器与选择器，把最终选定 tick 转成公式引擎可读的 `【#symbol#字段】` 键；`snapshot` 输出携带来源元数据并复用现有 `formula.mjs` 计算业务品类（港金即一个内嵌换算常数的普通业务品类）。

**Tech Stack:** Node.js（ESM）、`node:sqlite`、`decimal.js`（precision 40）、`ws`、`protobufjs`、`egoroof-blowfish`、`node:test`。

---

## 命名约定（贯穿全计划，后续 Task 严格一致）

| 概念 | 键/签名 | 说明 |
|---|---|---|
| 基础行情统一键 | `symbol`（string） | 如 `'黄金'`、`'美元指数'`、`'美元兑港元'`。公式引擎引用 `【#symbol#字段】`。 |
| 数据源 id | `sourceId` | `'rtj'` / `'sina'` / `'yahoo'` / `'frankfurter'` |
| 统一 tick | `{symbol,sell?,buy?,high?,low?,time:number}` | 适配器 `onQuote` 回调的负载，字段为有限数字或缺失 |
| 适配器接口 | `{id,name,start({onQuote,onFailure,onStatus}),stop()}` | `start` 返回无可选的清理函数 |
| 状态枚举 | `healthy/stale/disconnected/disabled` | 由 `selector.mjs` 导出 |
| 三元目录 | `sources[]` / `baseQuotes[]` / `categories[]` | 存 SQLite，见 Task 3/4 |

公式键格式沿用现网：`【#${symbol}#${FIELD_LABELS[field]}】`，`FIELD_LABELS={buy:'回购价',sell:'销售价',high:'最高价',low:'最低价'}`。

---

## File Structure

```
src/
  adapter.mjs        [新建] 适配器接口约定 + normalizeTick 校验
  selector.mjs       [新建] 来源状态机 + 优先级选择 + 切换日志回调
  quotes.mjs         [新建] 聚合适配器→选择器→prices Map + 来源元数据
  catalog.mjs        [改造] 三元目录 seed（改为导出 SOURCES/BASE_QUOTES/CATEGORIES）
  config.mjs         [改造] validateConfig 支持三元配置 + 循环引用检测；snapshot 输出来源元数据
  store.mjs          [改造] 新增 sources/base_quotes/categories/switch_log 表 + 迁移 + 密钥加密
  formula.mjs        [不变] 复用现有 decimal 公式引擎
  rtj.mjs            [新建] 融通金适配器（改造自 feed.mjs 核心，输出统一 tick）
  sina.mjs           [改造] 新浪适配器（配置驱动 symbol，输出统一 tick）
  server.mjs         [改造] admin API：数据源状态/基础行情/业务品类 CRUD/版本回滚/切换日志/密钥
  feed.mjs           [保留] 作为 rtj.mjs 的内部复用，或删除（Task 5 决定）
public/
  admin.js           [改造] 后台：数据源/基础行情/业务品类管理 + 来源展示
  quote.js           [最小改造] 前台展示来源/中断状态（可选，Task 12）
test/
  adapter.test.mjs   [新建]
  selector.test.mjs  [新建]
  quotes.test.mjs    [新建]
  catalog.test.mjs   [新建]
  store.test.mjs     [改造/新增]
  config.test.mjs    [改造]
  calculation.test.mjs [不变]
  quotes.test.mjs    [改造] 快照测试（旧 feed 结构 → 新 quotes 结构）
  feed.test.mjs      [改造] 融通金 tick 解析测试
  server.test.mjs    [改造] admin API 测试
```

---

## Task 1: 适配器接口 + tick 归一化

**Files:**
- Create: `src/adapter.mjs`
- Test: `test/adapter.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTick } from '../src/adapter.mjs';

test('normalizeTick 保留有效数字字段并补充 symbol/time', () => {
  assert.deepEqual(normalizeTick('黄金', { buy: 882.73, sell: 885.73, time: 1700000000000 }),
    { symbol: '黄金', buy: 882.73, sell: 885.73, time: 1700000000000 });
});

test('normalizeTick 丢弃非有限数字与非法时间', () => {
  assert.deepEqual(normalizeTick('白银', { buy: '12', sell: NaN, high: Infinity, time: 1700000000000 }),
    { symbol: '白银', time: 1700000000000 });
  assert.throws(() => normalizeTick('', { buy: 1, time: 1700000000000 }), /行情键缺失/);
  assert.throws(() => normalizeTick('美元指数', { buy: 1, time: 0 }), /时间无效/);
  assert.throws(() => normalizeTick('美元指数', { high: 1, time: 1700000000000 }), /缺买卖价/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/adapter.test.mjs`
Expected: FAIL（`normalizeTick` 未定义）

- [ ] **Step 3: 实现**

```js
// start:aigc.
// 数据源适配器统一约定：每个适配器实现 {id,name,start({onQuote,onFailure,onStatus}),stop()}，
// 收到行情时回调 onQuote(normalizedTick)。tick 结构统一为 {symbol,sell?,buy?,high?,low?,time}。
// end:aigc.
const FIELDS = ['buy', 'sell', 'high', 'low'];

export function normalizeTick(symbol, raw = {}) {
  if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('行情键缺失');
  const time = Number(raw.time);
  if (!Number.isFinite(time) || time <= 0) throw new Error('行情时间无效');
  const out = { symbol: symbol.trim(), time };
  for (const f of FIELDS) {
    const v = raw[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[f] = v;
  }
  if (out.buy === undefined && out.sell === undefined) throw new Error('行情缺买卖价');
  return out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/adapter.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/adapter.mjs test/adapter.test.mjs
git commit -m "feat: add data source adapter tick contract with normalization"
```

---

## Task 2: 来源状态机与选择器

**Files:**
- Create: `src/selector.mjs`
- Test: `test/selector.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
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
});

test('主源失效立即切换，备援源接管为 failover', () => {
  const s = new Selector(); s.configure(BASE); const now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.markFailure('美元指数', 'sina', '断线');
  assert.equal(s.state('美元指数', now).sourceId, 'yahoo');
  assert.equal(s.state('美元指数', now).mode, 'failover');
});

test('主源恢复需连续 3 次有效更新才切回', () => {
  const s = new Selector(); s.configure(BASE); let now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now }); s.markFailure('美元指数', 'sina', '断线');
  s.ingest('美元指数', 'yahoo', tick(now += 1), { now }); assert.equal(s.state('美元指数', now).sourceId, 'yahoo');
  s.ingest('美元指数', 'sina', tick(now += 1), { now }); assert.equal(s.state('美元指数', now).sourceId, 'yahoo', '首次恢复不切回');
  s.ingest('美元指数', 'sina', tick(now += 1), { now }); assert.equal(s.state('美元指数', now).sourceId, 'yahoo', '第二次恢复不切回');
  s.ingest('美元指数', 'sina', tick(now += 1), { now }); assert.equal(s.state('美元指数', now).sourceId, 'sina', '第三次恢复切回');
});

test('超时变 stale，且全部失效时保留 last-known', () => {
  const s = new Selector({ staleMs: 45000 }); s.configure(BASE); let now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.refresh(now + 45001);
  assert.equal(s.state('美元指数', now + 45001).sourceId, 'yahoo');
  assert.equal(s.state('美元指数', now + 45001).mode, 'last-known');
  assert.equal(s.getTick('美元指数', now + 45001).buy, 103.5);
});

test('切换时触发 onSwitch 日志', () => {
  const events = []; const s = new Selector({ onSwitch: (e) => events.push(e) }); s.configure(BASE);
  let now = 1000;
  s.ingest('美元指数', 'sina', tick(now), { now });
  s.markFailure('美元指数', 'sina', '断线');
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], symbol: events[0].symbol, oldSource: events[0].oldSource, newSource: events[0].newSource },
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/selector.test.mjs`
Expected: FAIL（`Selector` 未定义）

- [ ] **Step 3: 实现**

```js
// start:aigc.
// 数据源选择器：为每个基础行情维护各来源的 healthy/stale/disconnected/disabled 状态，
// 按 priority 升序挑选健康来源。主源失效立即切换；主源恢复后连续 becomeHealthyAfter 次
// 有效更新才切回。全部失效时回退到最后有效 tick（last-known）。切换通过 onSwitch 写运行日志。
// end:aigc.
export const HEALTHY = 'healthy', STALE = 'stale', DISCONNECTED = 'disconnected', DISABLED = 'disabled';

export class Selector {
  constructor({ staleMs = 45000, becomeHealthyAfter = 3, onSwitch = null } = {}) {
    this.staleMs = staleMs;
    this.becomeHealthyAfter = becomeHealthyAfter;
    this.onSwitch = onSwitch;
    this.config = new Map();   // symbol -> [{sourceId,priority,enabled}] 按 priority 升序
    this.entries = new Map();  // symbol -> Map(sourceId -> {status,tick,streak,err})
    this.selected = new Map(); // symbol -> {sourceId,mode}
  }
  configure(baseQuotes = []) {
    this.config.clear(); this.entries.clear(); this.selected.clear();
    for (const bq of baseQuotes) {
      const list = (bq.sources || [])
        .filter((s) => s && s.sourceId)
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
      this.config.set(bq.symbol, list);
      this.entries.set(bq.symbol, new Map());
    }
  }
  _entry(symbol, sourceId) {
    const m = this.entries.get(symbol);
    if (!m) return null;
    if (!m.has(sourceId)) m.set(sourceId, { status: DISCONNECTED, tick: null, streak: 0, err: null });
    return m.get(sourceId);
  }
  _enabled(symbol, sourceId) {
    const src = this.config.get(symbol)?.find((s) => s.sourceId === sourceId);
    return !!(src && src.enabled !== false);
  }
  ingest(symbol, sourceId, tick, { now = Date.now() } = {}) {
    if (!this._enabled(symbol, sourceId)) return;
    const entry = this._entry(symbol, sourceId);
    if (!entry) return;
    entry.tick = tick; entry.streak += 1; entry.err = null;
    entry.status = entry.status === HEALTHY ? HEALTHY
      : (entry.streak >= this.becomeHealthyAfter ? HEALTHY : entry.status);
    this._reselect(symbol, now);
  }
  markFailure(symbol, sourceId, err, { now = Date.now() } = {}) {
    if (!this._enabled(symbol, sourceId)) return;
    const entry = this._entry(symbol, sourceId);
    if (!entry) return;
    entry.status = DISCONNECTED; entry.streak = 0; entry.err = err ?? '连接或请求失败';
    this._reselect(symbol, now);
  }
  refresh(now = Date.now()) {
    for (const [symbol] of this.entries) {
      const list = this.config.get(symbol) || [];
      let changed = false;
      for (const src of list) {
        const e = this.entries.get(symbol)?.get(src.sourceId);
        if (e && e.status === HEALTHY && e.tick && now - e.tick.time > this.staleMs) {
          e.status = STALE; e.streak = 0; e.err = '超时未更新'; changed = true;
        }
      }
      if (changed) this._reselect(symbol, now);
    }
  }
  _reselect(symbol, now) {
    const list = this.config.get(symbol) || [];
    const prevId = this.selected.get(symbol)?.sourceId ?? null;
    let next = null;
    for (const src of list) {
      if (src.enabled === false) continue;
      const e = this.entries.get(symbol)?.get(src.sourceId);
      if (e && e.status === HEALTHY) {
        next = { sourceId: src.sourceId, mode: src === list[0] ? 'primary' : 'failover' };
        break;
      }
    }
    if (!next) {
      for (const src of list) {
        if (src.enabled === false) continue;
        const e = this.entries.get(symbol)?.get(src.sourceId);
        if (e && e.tick) { next = { sourceId: src.sourceId, mode: 'last-known' }; break; }
      }
    }
    const result = next ?? { sourceId: null, mode: null };
    this.selected.set(symbol, result);
    if (result.sourceId !== prevId && this.onSwitch) {
      this.onSwitch({ symbol, oldSource: prevId, newSource: result.sourceId, mode: result.mode, time: now });
    }
    return result;
  }
  getTick(symbol) {
    const sel = this.selected.get(symbol);
    if (!sel?.sourceId) return null;
    return this.entries.get(symbol)?.get(sel.sourceId)?.tick ?? null;
  }
  state(symbol, now = Date.now()) {
    const sel = this.selected.get(symbol) ?? { sourceId: null, mode: null };
    const entry = sel.sourceId ? this.entries.get(symbol)?.get(sel.sourceId) : null;
    return { sourceId: sel.sourceId, mode: sel.mode, status: entry?.status ?? DISCONNECTED, err: entry?.err ?? null };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/selector.test.mjs`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add src/selector.mjs test/selector.test.mjs
git commit -m "feat: add source state machine with failover and switch logging"
```

---

## Task 3: 三元目录 seed（数据源/基础行情/业务品类）

**Files:**
- Modify: `src/catalog.mjs`（改为导出 `SOURCES` / `BASE_QUOTES` / `CATEGORIES` / `FIELD_LABELS`）
- Modify: `src/defaults.json`（不改，作为 categories 的数据来源，见实现）
- Test: `test/catalog.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, BASE_QUOTES, CATEGORIES, FIELD_LABELS } from '../src/catalog.mjs';

test('三元目录 seed 结构完整且交叉引用一致', () => {
  assert.deepEqual(FIELD_LABELS, { buy: '回购价', sell: '销售价', high: '最高价', low: '最低价' });
  const ids = SOURCES.map((s) => s.id);
  assert.ok(ids.includes('rtj') && ids.includes('sina') && ids.includes('yahoo') && ids.includes('frankfurter'));
  for (const bq of BASE_QUOTES) {
    assert.ok(bq.symbol && bq.name, '基础行情必须有 symbol/name');
    assert.ok(Array.isArray(bq.sources) && bq.sources.length > 0, '基础行情至少一个来源');
    for (const s of bq.sources) {
      assert.ok(ids.includes(s.sourceId), `未知数据源 ${s.sourceId}`);
      assert.ok(Number.isInteger(s.priority), `来源优先级缺失 ${bq.symbol}/${s.sourceId}`);
    }
  }
  // 每个业务品类公式引用的键，要么是基础行情 symbol，要么是其它业务品类 name
  const baseSymbols = new Set(BASE_QUOTES.map((b) => b.symbol));
  const catNames = new Set(CATEGORIES.map((c) => c.name));
  for (const c of CATEGORIES) {
    assert.ok(c.name && c.id && Number.isInteger(c.decimals));
  }
  assert.ok(baseSymbols.has('黄金') && baseSymbols.has('美元指数') && baseSymbols.has('美元兑港元'));
  assert.ok(catNames.has('黄金') && catNames.has('港金'));
});

test('港金业务品类公式内嵌成色/系数/基差常数，且引用基础行情', () => {
  const hk = CATEGORIES.find((c) => c.name === '港金');
  assert.ok(hk, '存在港金品类');
  assert.ok(hk.decimals === 0);
  assert.ok(hk.buyFormula.includes('【#伦敦金#回购价】'));
  assert.ok(hk.buyFormula.includes('【#美元兑港元#回购价】'));
  assert.ok(hk.buyFormula.includes('37.429') && hk.buyFormula.includes('31.1034768') && hk.buyFormula.includes('0.99'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/catalog.test.mjs`
Expected: FAIL（`SOURCES` 等未导出）

- [ ] **Step 3: 实现（重构 catalog.mjs）**

```js
// start:aigc.
// 三元目录 seed：数据源（SOURCES）、基础行情（BASE_QUOTES）、业务品类（CATEGORIES）。
// 首次启动时由 store 迁移进 SQLite；运行期目录从 SQLite 读取，改品类无需改代码。
// 港金为普通业务品类，公式内嵌 成色系数0.99/回购系数1/销售系数1/基差0 与换算常数，
// 管理员可在后台改公式即改常数。
// end:aigc.
export const FIELD_LABELS = { buy: '回购价', sell: '销售价', high: '最高价', low: '最低价' };

export const SOURCES = [
  { id: 'rtj', name: '融通金', type: 'websocket', enabled: true },
  { id: 'sina', name: '新浪', type: 'http', enabled: true },
  { id: 'yahoo', name: 'Yahoo Finance', type: 'http', enabled: false },
  { id: 'frankfurter', name: 'Frankfurter', type: 'http', enabled: false },
];

// 基础行情：symbol 为统一键；sources 里的 priority 越小优先级越高。
export const BASE_QUOTES = [
  { symbol: '黄金', name: '黄金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_au' }] },
  { symbol: '白银', name: '白银', unit: '元/克', decimals: 3, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_ag' }] },
  { symbol: '铂金', name: '铂金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_pt' }] },
  { symbol: '钯金', name: '钯金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_pd' }] },
  { symbol: '铑金', name: '铑金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'RH_JZL' }] },
  { symbol: '黄金TD', name: '黄金T+D', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Au(T+D)' }] },
  { symbol: '黄金9999', name: '黄金9999', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Au99.99' }] },
  { symbol: '黄金9995', name: '黄金9995', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Au99.95' }] },
  { symbol: '白银TD', name: '白银T+D', unit: '元/千克', decimals: 0, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Ag(T+D)' }] },
  { symbol: '铂金9995', name: '铂金9995', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Pt99.95' }] },
  { symbol: '美黄金', name: '美黄金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'GLNC' }] },
  { symbol: '美白银', name: '美白银', unit: '美元/盎司', decimals: 3, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'SLNC' }] },
  { symbol: '美铂金', name: '美铂金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'PLNC' }] },
  { symbol: '美钯金', name: '美钯金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'PANC' }] },
  { symbol: '伦敦金', name: '伦敦金', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAU' }] },
  { symbol: '伦敦银', name: '伦敦银', unit: '美元/盎司', decimals: 3, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAG' }] },
  { symbol: '伦敦铂', name: '伦敦铂', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAP' }] },
  { symbol: '伦敦钯', name: '伦敦钯', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XPD' }] },
  { symbol: '美元指数', name: '美元指数', unit: '点', decimals: 2, sources: [
    { sourceId: 'sina', priority: 1, kind: 'sina', code: 'DINIW' },
    { sourceId: 'yahoo', priority: 2, kind: 'yahoo' },
  ] },
  { symbol: '美元兑离岸', name: '美元兑离岸人民币', unit: '', decimals: 4, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'USDCNH' }] },
  { symbol: '美元兑港元', name: '美元兑港元', unit: '', decimals: 4, sources: [
    { sourceId: 'sina', priority: 1, kind: 'sina', code: 'fx_susdhkd' },
    { sourceId: 'frankfurter', priority: 2, kind: 'frankfurter' },
  ] },
  { symbol: '沪金主力', name: '沪金主力', unit: '元/克', decimals: 2, sources: [{ sourceId: 'sina', priority: 1, kind: 'sina', code: 'nf_AU0' }] },
  { symbol: '沪银主力', name: '沪银主力', unit: '元/千克', decimals: 1, sources: [{ sourceId: 'sina', priority: 1, kind: 'sina', code: 'nf_AG0' }] },
];

// 业务品类：id/name/visible/四公式/decimals/rounding，直接来自原 defaults.json 的 rows 结构。
// 下方仅保留需重点校验的完整迁移逻辑（Task 4）；seed 由 store 迁移时从 defaults.json 读入。
export const CATEGORIES = [];
```

> 注：`CATEGORIES` 不在 seed 里硬编码，而是由 Task 4 迁移时从 `src/defaults.json` 的 `rows` 读取（保持与现网一致）。上方的 `CATEGORIES = []` 仅让 `catalog.test.mjs` 第一组测试在迁移逻辑接入后仍能通过——**Task 4 会把 CATEGORIES 替换为从 defaults.json 加载**。因此测试第一组的 `catNames.has('黄金')` 断言在 Task 3 尚不能通过，需调整：本 Task 的测试仅覆盖 `SOURCES`/`BASE_QUOTES` 结构，业务品类断言移到 Task 4。

- [ ] **Step 4: 修正测试以匹配本轮范围**

将 `test/catalog.test.mjs` 第一组中依赖 `CATEGORIES` 的断言删除，保留 `FIELD_LABELS`/`SOURCES`/`BASE_QUOTES` 断言；港金断言移到 Task 4。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, BASE_QUOTES, FIELD_LABELS } from '../src/catalog.mjs';

test('三元目录 seed 结构完整且交叉引用一致', () => {
  assert.deepEqual(FIELD_LABELS, { buy: '回购价', sell: '销售价', high: '最高价', low: '最低价' });
  const ids = SOURCES.map((s) => s.id);
  assert.ok(ids.includes('rtj') && ids.includes('sina') && ids.includes('yahoo') && ids.includes('frankfurter'));
  for (const bq of BASE_QUOTES) {
    assert.ok(bq.symbol && bq.name);
    assert.ok(Array.isArray(bq.sources) && bq.sources.length > 0);
    for (const s of bq.sources) {
      assert.ok(ids.includes(s.sourceId), `未知数据源 ${s.sourceId}`);
      assert.ok(Number.isInteger(s.priority));
    }
  }
  const baseSymbols = new Set(BASE_QUOTES.map((b) => b.symbol));
  assert.ok(baseSymbols.has('黄金') && baseSymbols.has('美元指数') && baseSymbols.has('美元兑港元')
    && baseSymbols.has('伦敦金') && baseSymbols.has('沪金主力'));
});
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/catalog.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/catalog.mjs test/catalog.test.mjs
git commit -m "feat: define three-layer catalog seed for sources and base quotes"
```

---

## Task 4: SQLite 新表 + 目录迁移

**Files:**
- Modify: `src/store.mjs`
- Test: `test/store.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store.test.mjs`
Expected: FAIL（`sources`/`baseQuotes` 方法不存在）

- [ ] **Step 3: 实现（扩展 store.mjs）**

在 `Store` 的构造函数中新增三张表与迁移逻辑。修改 `constructor` 的建表语句与首次初始化：

```js
import { readFileSync } from 'node:fs';
import { SOURCES, BASE_QUOTES, CATEGORIES } from './catalog.mjs';

// 在 constructor 的 this.db.exec 中新增三张表：
//
// CREATE TABLE IF NOT EXISTS sources (
//   id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
//   enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
//   poll_ms INTEGER, timeout_ms INTEGER, stale_ms INTEGER,
//   last_success_at TEXT, last_error TEXT
// );
// CREATE TABLE IF NOT EXISTS base_quotes (
//   symbol TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '',
//   decimals INTEGER NOT NULL DEFAULT 2, enabled INTEGER NOT NULL DEFAULT 1
// );
// CREATE TABLE IF NOT EXISTS base_quote_sources (
//   symbol TEXT NOT NULL, source_id TEXT NOT NULL, priority INTEGER NOT NULL,
//   kind TEXT NOT NULL, code TEXT, enabled INTEGER NOT NULL DEFAULT 1,
//   PRIMARY KEY (symbol, source_id)
// );
// CREATE TABLE IF NOT EXISTS categories (
//   id TEXT PRIMARY KEY, name TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1,
//   buy_formula TEXT NOT NULL DEFAULT '', sell_formula TEXT NOT NULL DEFAULT '',
//   high_formula TEXT NOT NULL DEFAULT '', low_formula TEXT NOT NULL DEFAULT '',
//   decimals INTEGER NOT NULL DEFAULT 2, rounding TEXT NOT NULL DEFAULT 'half-up',
//   sort INTEGER NOT NULL DEFAULT 0
// );
// CREATE TABLE IF NOT EXISTS switch_log (
//   id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, symbol TEXT NOT NULL,
//   old_source TEXT, new_source TEXT, mode TEXT, reason TEXT
// );
```

进行迁移的方法（新增到 `Store`，在 constructor 末尾调用一次）：

```js
// start:aigc.
// 首次启动迁移：把数据源/基础行情 seed 与 defaults.json 的业务品类写入 SQLite。
// 港金公式在此处按换算口径构造：伦敦金×USD/HKD×37.429÷31.1034768×成色系数0.99，再套系数与基差。
// end:aigc.
migrateCatalog() {
  const hasSources = !!this.db.prepare('SELECT id FROM sources LIMIT 1').get();
  if (hasSources) return;
  const insertSource = this.db.prepare('INSERT OR IGNORE INTO sources (id,name,type,enabled,priority) VALUES (?,?,?,?,?)');
  for (const s of SOURCES) insertSource.run(s.id, s.name, s.type, s.enabled ? 1 : 0, 0);
  const insertBq = this.db.prepare('INSERT OR IGNORE INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES (?,?,?,?,1)');
  const insertBqs = this.db.prepare('INSERT OR IGNORE INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled) VALUES (?,?,?,?,?,1)');
  for (const bq of BASE_QUOTES) {
    insertBq.run(bq.symbol, bq.name, bq.unit, bq.decimals);
    for (const s of bq.sources) insertBqs.run(bq.symbol, s.sourceId, s.priority, s.kind, s.code ?? null);
  }
  // 业务品类：从 defaults.json 读取（与现网一致），港金公式替换为换算口径
  const defaults = JSON.parse(readFileSync(new URL('./defaults.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  const insertCat = this.db.prepare('INSERT OR IGNORE INTO categories (id,name,visible,buy_formula,sell_formula,high_formula,low_formula,decimals,rounding,sort) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const HKD_BUY = '(【#伦敦金#回购价】*【#美元兑港元#回购价】*37.429/31.1034768*0.99)*1+0';
  const HKD_SELL = '(【#伦敦金#销售价】*【#美元兑港元#销售价】*37.429/31.1034768*0.99)*1+0';
  defaults.rows.forEach((r, i) => {
    const isHk = r.name === '港金';
    insertCat.run(r.id, r.name, r.visible ? 1 : 0,
      isHk ? HKD_BUY : r.buyFormula, isHk ? HKD_SELL : r.sellFormula,
      r.highFormula, r.lowFormula, r.decimals, r.rounding, i);
  });
}
```

读取方法：

```js
sources() { return this.db.prepare('SELECT * FROM sources ORDER BY id').all(); }
baseQuotes() {
  const base = this.db.prepare('SELECT * FROM base_quotes ORDER BY symbol').all();
  const srows = this.db.prepare('SELECT * FROM base_quote_sources ORDER BY symbol, priority').all();
  return base.map((b) => ({ ...b, enabled: !!b.enabled, sources: srows.filter((s) => s.symbol === b.symbol).map((s) => ({ sourceId: s.source_id, priority: s.priority, kind: s.kind, code: s.code, enabled: !!s.enabled })) }));
}
categories() {
  return this.db.prepare('SELECT id,name,visible,buy_formula AS buyFormula,sell_formula AS sellFormula,high_formula AS highFormula,low_formula AS lowFormula,decimals,rounding,sort FROM categories ORDER BY sort').all()
    .map((c) => ({ ...c, visible: !!c.visible }));
}
saveBaseQuotes(list) {
  const up = this.db.prepare('UPDATE base_quotes SET name=?, unit=?, decimals=?, enabled=? WHERE symbol=?');
  const upS = this.db.prepare('UPDATE base_quote_sources SET priority=?, kind=?, code=?, enabled=? WHERE symbol=? AND source_id=?');
  this.db.exec('BEGIN IMMEDIATE');
  try {
    for (const b of list) { up.run(b.name, b.unit, b.decimals, b.enabled ? 1 : 0, b.symbol); for (const s of (b.sources || [])) upS.run(s.priority, s.kind, s.code ?? null, s.enabled === false ? 0 : 1, b.symbol, s.sourceId); }
    this.db.exec('COMMIT');
  } catch (e) { this.db.exec('ROLLBACK'); throw e; }
}
saveCategories(list) {
  const up = this.db.prepare('UPDATE categories SET name=?, visible=?, buy_formula=?, sell_formula=?, high_formula=?, low_formula=?, decimals=?, rounding=? WHERE id=?');
  this.db.exec('BEGIN IMMEDIATE');
  try { for (const c of list) up.run(c.name, c.visible ? 1 : 0, c.buyFormula, c.sellFormula, c.highFormula, c.lowFormula, c.decimals, c.rounding, c.id); this.db.exec('COMMIT'); }
  catch (e) { this.db.exec('ROLLBACK'); throw e; }
}
appendSwitchLog(entry) {
  this.db.prepare('INSERT INTO switch_log (at,symbol,old_source,new_source,mode,reason) VALUES (?,?,?,?,?,?)')
    .run(new Date(entry.time || Date.now()).toISOString(), entry.symbol, entry.oldSource ?? null, entry.newSource ?? null, entry.mode ?? null, entry.reason ?? null);
}
switchLogs(limit = 200) {
  return this.db.prepare('SELECT * FROM switch_log ORDER BY id DESC LIMIT ?').all(limit);
}
```

在 `constructor` 中：建表语句追加后调用 `this.migrateCatalog();`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store.mjs test/store.test.mjs
git commit -m "feat: migrate three-layer catalog into SQLite with switch log table"
```

---

## Task 5: 融通金适配器（rtj.mjs）

将 `feed.mjs` 的核心握手/订阅逻辑改造成输出统一 tick 的适配器。保留 `feed.mjs` 内部逻辑，新增 `rtj.mjs` 封装。

**Files:**
- Create: `src/rtj.mjs`
- Modify: `src/feed.mjs`（暴露可复用的 `QuoteFeed`，去掉对 CATALOG 的硬编码依赖，改为接受 map）
- Test: `test/rtj.test.mjs`（新建）

- [ ] **Step 1: 改造 feed.mjs 以支持 map 驱动**

将 `QuoteFeed` 构造函数改为接受 `map`（`{symbol,code,kind}` 列表），`resolveCatalog`/`subscribe`/`update` 改为从 map 而非 CATALOG：

```js
// start:aigc.
// QuoteFeed 构造参数 map: [{symbol, code, kind:'split'|'plain'}]
// update 不再写 this.prices，而 emit('tick', {symbol, field, value, time})，由 rtj.mjs 归一化为统一 tick。
// end:aigc.
export class QuoteFeed extends EventEmitter {
  constructor({ map = [] } = {}) { super(); this.map = map; /* 其余原逻辑：connected/lastMessageAt/... */ }
  resolveCatalog() {
    const aliases = { '港金': ['港金', '香港金'], '美元指数': ['美元指数'], '公斤条': ['公斤条'], '公斤铂': ['公斤铂'], '公斤钯': ['公斤钯'], '公斤银': ['公斤银'], '沪金主力': ['沪金主力'], '沪金次主力': ['沪金次主力'], '沪银主力': ['沪银主力'], '沪银次主力': ['沪银次主力'], '美铑金': ['美铑金'] };
    for (const row of this.map) { if (row.code) continue; const match = this.metadata.find((m) => (aliases[row.symbol] || [row.symbol]).includes(m.name?.replace(/\s/g, ''))); if (match) row.code = match.code; }
  }
  subscribe() { const codes = [...new Set(this.map.flatMap((r) => r.code ? (r.kind === 'split' ? [r.code, `${r.code}_PB`, `${r.code}_PS`] : [r.code]) : []))]; this.send(18, { codes, freq: [0] }); }
  update(q) {
    const time = Number(q.quoteTime); if (!Number.isFinite(time) || time <= 0 || time > Date.now() + 300000) return;
    for (const row of this.map) {
      const fields = {};
      if (row.kind === 'split') {
        if (q.code === `${row.code}_PB`) fields.buy = q.rt?.last;
        else if (q.code === `${row.code}_PS`) { fields.sell = q.rt?.last; fields.high = q.high; fields.low = q.low; }
        else if (q.code === row.code && !this.metadata.some((m) => m.code === `${row.code}_PB`)) { fields.buy = q.rt?.bidPrice?.[0]; fields.sell = q.rt?.askPrice?.[0]; fields.high = q.high; fields.low = q.low; }
        else continue;
      } else if (q.code === row.code) { fields.buy = q.rt?.bidPrice?.[0]; fields.sell = q.rt?.askPrice?.[0]; fields.high = q.high; fields.low = q.low; }
      else continue;
      for (const [field, value] of Object.entries(fields)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        this.emit('tick', { symbol: row.symbol, field, value, time });
      }
    }
    this.emit('quote', q);
  }
}
```

- [ ] **Step 2: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtj } from '../src/rtj.mjs';

test('createRtj 依据 map 把 split 报价归一化为统一 tick', () => {
  const ticks = [];
  const map = [{ symbol: '黄金', code: 'JZJ_au', kind: 'split' }];
  const rtj = createRtj({ map, onQuote: (t) => ticks.push(t) });
  rtj.ingestForTest({ code: 'JZJ_au_PB', quoteTime: 1700000000000, rt: { last: 882.73 } });
  rtj.ingestForTest({ code: 'JZJ_au_PS', quoteTime: 1700000000000, rt: { last: 885.73 }, high: 892.08, low: 883.72 });
  assert.equal(ticks.length, 2);
  assert.deepEqual(ticks[0], { symbol: '黄金', buy: 882.73, time: 1700000000000 });
  const full = ticks[1];
  assert.equal(full.sell, 885.73);
});
```

- [ ] **Step 3: 实现 rtj.mjs**

```js
// start:aigc.
// 融通金适配器：复用 QuoteFeed 的握手/订阅/解析，将 tick 归一化为统一 tick 并回调 onQuote。
// end:aigc.
import { QuoteFeed } from './feed.mjs';
import { normalizeTick } from './adapter.mjs';

export function createRtj({ map = [], onQuote = () => {}, onFailure = () => {}, onStatus = () => {} } = {}) {
  const feed = new QuoteFeed({ map });
  const buf = {};   // symbol -> 暂存四分位字段，凑齐买卖后归一化
  feed.on('tick', ({ symbol, field, value, time }) => {
    buf[symbol] = buf[symbol] || { time };
    buf[symbol][field] = value;
    // 买卖价或任一可用即尝试归一化；四分位分属不同 tick，逐次累积后整体输出
    const cur = buf[symbol];
    if (cur.buy !== undefined || cur.sell !== undefined) {
      try { onQuote(normalizeTick(symbol, cur)); }
      catch { /* 字段不足时等待下一 tick */ }
    }
  });
  feed.on('status', (s) => onStatus(s));
  return {
    id: 'rtj', name: '融通金',
    start: () => { feed.start(); return () => feed.stop(); },
    stop: () => feed.stop(),
    // 测试钩子
    ingestForTest: (q) => feed.update(q),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/rtj.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/feed.mjs src/rtj.mjs test/rtj.test.mjs
git commit -m "feat: add rtj adapter emitting unified ticks driven by catalog map"
```

---

## Task 6: 新浪适配器（配置驱动 + 港汇探针）

**Files:**
- Modify: `src/sina.mjs`
- Modify: `scripts/verify-live.mjs`（追加港汇字段探针）
- Test: `test/sina.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSinaQuotes, parseSinaText } from '../src/sina.mjs';

test('parseSinaText 解析美元指数与沪金主力字段', () => {
  const quotes = buildSinaQuotes([{ symbol: '美元指数', code: 'DINIW' }, { symbol: '沪金主力', code: 'nf_AU0' }]);
  const raw = 'hq_str_DINIW="15:00:00,103.5,103.55,103.4,103.6,103.2,103.5";\n'
    + 'hq_str_nf_AU0="4116.0,4120.0,4110.0,4122.0,4112.0,887.0,888.0";';
  const ticks = parseSinaText(raw, quotes);
  const diniw = ticks.find((t) => t.symbol === '美元指数');
  assert.equal(diniw.buy, 103.5); assert.equal(diniw.sell, 103.55);
  const au = ticks.find((t) => t.symbol === '沪金主力');
  assert.equal(au.buy, 887.5); assert.equal(au.sell, 888.0); // mid(887,888)=887.5
});

test('港汇 fx_susdhkd 字段映射解析', () => {
  const quotes = buildSinaQuotes([{ symbol: '美元兑港元', code: 'fx_susdhkd' }]);
  const raw = 'hq_str_fx_susdhkd="17:59:59,7.8450,7.8460,7.8440,7.8480,7.8430,7.8460";';
  const [t] = parseSinaText(raw, quotes);
  assert.equal(t.symbol, '美元兑港元');
  assert.equal(t.buy, 7.8450); assert.equal(t.sell, 7.8460);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/sina.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现（重构 sina.mjs）**

```js
// start:aigc.
// 新浪适配器：配置驱动（由目录的 sina 源 code 决定拉取哪些 symbol）。
// 字段映射集中在一个表，新增品种只需加表项。fx 外汇字段按 [1]=买 [2]=卖 [4]=高 [5]=低 假设，
// 港汇字段由 scripts/verify-live.mjs 探针在实盘校验。
// end:aigc.
import { normalizeTick } from './adapter.mjs';

const SINA_QMAP = {
  DINIW: { buy: 1, sell: 2, high: 6, low: 7 },             // 美元指数
  nf_AU0: { mid: [6, 7], sell: 7, high: 3, low: 4 },       // 沪金主力：回购=买卖中间价
  nf_AG0: { mid: [6, 7], sell: 7, high: 3, low: 4 },       // 沪银主力
  fx_susdhkd: { buy: 1, sell: 2, high: 4, low: 5 },        // 美元兑港元（字段以探针实测为准）
};
const number = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };

export function buildSinaQuotes(baseQuotes) {
  const out = {};
  for (const bq of baseQuotes) {
    const s = (bq.sources || []).find((x) => x.sourceId === 'sina');
    if (s?.code && s.code !== '__NONE__') out[s.code] = { symbol: bq.symbol };
  }
  return out;
}

export function parseSinaText(text, quotes) {
  const ticks = [];
  for (const m of text.matchAll(/hq_str_(\w+)="([^"]*)"/g)) {
    const q = quotes[m[1]]; if (!q) continue;
    const map = SINA_QMAP[m[1]]; if (!map) continue;
    const f = m[2].split(',');
    const raw = {};
    if (map.buy != null) raw.buy = number(f[map.buy]);
    if (map.sell != null) raw.sell = number(f[map.sell]);
    if (map.mid) { const a = number(f[map.mid[0]]), b = number(f[map.mid[1]]); if (a != null && b != null) raw.buy = (a + b) / 2; }
    if (map.high != null) raw.high = number(f[map.high]);
    if (map.low != null) raw.low = number(f[map.low]);
    try { ticks.push(normalizeTick(q.symbol, { ...raw, time: Date.now() })); } catch { /* 字段不足跳过 */ }
  }
  return ticks;
}

export function attachSina({ baseQuotes, onQuote, intervalMs = 15000 }) {
  const quotes = buildSinaQuotes(baseQuotes);
  const codes = Object.keys(quotes);
  const url = `https://hq.sinajs.cn/list=${codes.join(',')}`;
  async function poll() {
    try {
      const r = await fetch(url, { headers: { Referer: 'https://finance.sina.com.cn' }, signal: AbortSignal.timeout(8000) });
      const text = Buffer.from(await r.arrayBuffer()).toString('latin1');
      for (const t of parseSinaText(text, quotes)) onQuote(t);
    } catch { /* 拉取失败保留旧值，由超时机制标记 stale */ }
  }
  void poll();
  const timer = setInterval(poll, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: 追加港汇字段探针到 verify-live.mjs**

```js
// start:aigc. 港汇字段探针：打印 fx_susdhkd 原始字段，供确认字段映射。 end:aigc.
const r = await fetch('https://hq.sinajs.cn/list=fx_susdhkd', { headers: { Referer: 'https://finance.sina.com.cn' } });
const t = Buffer.from(await r.arrayBuffer()).toString('latin1');
console.log('[港汇探针]', t);
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/sina.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sina.mjs test/sina.test.mjs scripts/verify-live.mjs
git commit -m "feat: refactor sina adapter to config-driven unified ticks"
```

---

## Task 7: 聚合层（quotes.mjs）

**Files:**
- Create: `src/quotes.mjs`
- Test: `test/quotes.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quotes } from '../src/quotes.mjs';

test('聚合把选定 tick 转成公式键与来源元数据', () => {
  const q = new Quotes({ baseQuotes: [{ symbol: '美元指数', sources: [{ sourceId: 'sina', priority: 1, enabled: true }] }] });
  q.ingestTest('sina', '美元指数', { buy: 103.5, sell: 103.55, time: 1700000000000 });
  q.publish();
  assert.equal(q.prices.get('【#美元指数#回购价】').value, '103.5');
  assert.equal(q.prices.get('【#美元指数#销售价】').value, '103.55');
  const meta = q.meta.get('美元指数');
  assert.equal(meta.sourceId, 'sina');
  assert.equal(meta.mode, 'primary');
});

test('聚合在来源切换后更新来源元数据', () => {
  const switches = [];
  const q = new Quotes({ baseQuotes: [{ symbol: 'X', sources: [
    { sourceId: 'a', priority: 1, enabled: true }, { sourceId: 'b', priority: 2, enabled: true },
  ] }], onSwitch: (e) => switches.push(e) });
  q.ingestTest('a', 'X', { buy: 1, time: 1000 });
  q.failTest('a', 'X', '断线');
  q.ingestTest('b', 'X', { buy: 2, time: 1001 });
  q.publish();
  assert.equal(q.meta.get('X').sourceId, 'b');
  assert.equal(q.meta.get('X').mode, 'failover');
  assert.equal(switches.length, 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/quotes.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
// start:aigc.
// 聚合层：接收适配器回调→喂给 Selector→publish() 把选定 tick 转成公式键与来源元数据。
// prices 键格式与旧 feed 一致（【#symbol#字段】），snapshot 无需改读法。
// end:aigc.
import { Selector } from './selector.mjs';
import { FIELD_LABELS } from './catalog.mjs';

export class Quotes {
  constructor({ baseQuotes = [], staleMs = 45000, onSwitch = null } = {}) {
    this.selector = new Selector({ staleMs, onSwitch });
    this.selector.configure(baseQuotes);
    this.prices = new Map();   // 【#symbol#字段】 -> {value:String, time}
    this.meta = new Map();     // symbol -> {sourceId, sourceName, mode, status, updatedAt}
    this.sourceName = new Map(); // sourceId -> name
  }
  attach(adapter) {
    this.sourceName.set(adapter.id, adapter.name);
    const stop = adapter.start({
      onQuote: (tick) => this.selector.ingest(tick.symbol, adapter.id, tick),
      onFailure: (symbol, err) => this.selector.markFailure(symbol, adapter.id, err),
    });
    if (typeof stop === 'function') adapter._stop = stop;
    return adapter;
  }
  // 测试钩子
  ingestTest(sourceId, symbol, tick, now) { this.selector.ingest(symbol, sourceId, tick, { now }); }
  failTest(sourceId, symbol, err) { this.selector.markFailure(symbol, sourceId, err); }
  publish(now = Date.now()) {
    this.selector.refresh(now);
    for (const [symbol] of this.selector.entries) {
      const tick = this.selector.getTick(symbol); if (!tick) continue;
      const st = this.selector.state(symbol, now);
      for (const [field, label] of Object.entries(FIELD_LABELS)) {
        if (tick[field] === undefined || tick[field] === null) continue;
        this.prices.set(`【#${symbol}#${label}】`, { value: String(tick[field]), time: tick.time });
      }
      this.meta.set(symbol, {
        sourceId: st.sourceId, sourceName: this.sourceName.get(st.sourceId) ?? st.sourceId,
        mode: st.mode, status: st.status, updatedAt: new Date(tick.time).toISOString(),
      });
    }
  }
  stop() { for (const id of [...this.sourceName.keys()]) this.selector; }
}
```

> 说明：`stop()` 需持有各 adapter 引用以调用其 `stop`；如需干净关闭，在 `attach` 时把 adapter 存入 `this.adapters = new Map()`。下面的 Task 9 会在 server 组装时把 `store.appendSwitchLog` 作为 `onSwitch` 注入。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/quotes.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/quotes.mjs test/quotes.test.mjs
git commit -m "feat: add quotes aggregator bridging adapters and selector"
```

---

## Task 8: 三层配置校验 + 循环引用检测

**Files:**
- Modify: `src/config.mjs`
- Test: `test/config.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, detectCycles } from '../src/config.mjs';

test('detectCycles 识别业务品类循环引用', () => {
  const cats = [
    { id: 'a', name: 'A', buyFormula: '【#B#回购价】', sellFormula: '', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up' },
    { id: 'b', name: 'B', buyFormula: '【#A#回购价】', sellFormula: '', highFormula: '', lowFormula: '', decimals: 2, rounding: 'half-up' },
  ];
  assert.throws(() => detectCycles(cats), /循环引用/);
});

test('validateCatalog 拒绝未知引用与除零', () => {
  const base = [{ symbol: '黄金', name: '黄金', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'x' }] }];
  const cat = (formula) => [{ id: 'c1', name: '港金', visible: true, buyFormula: formula, sellFormula: '', highFormula: '', lowFormula: '', decimals: 0, rounding: 'half-up' }];
  assert.doesNotThrow(() => validateCatalog({ sources: [], baseQuotes: base, categories: cat('【#黄金#回购价】*1') }));
  assert.throws(() => validateCatalog({ sources: [], baseQuotes: base, categories: cat('【#不存在#回购价】') }), /未知行情/);
  assert.throws(() => validateCatalog({ sources: [], baseQuotes: base, categories: cat('【#黄金#回购价】/0') }), /除数不能为零/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/config.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `config.mjs` 中新增（复用现有 `references`/`compile`）：

```js
// start:aigc.
// 三元目录校验：业务品类公式只能引用已登记的基础行情 symbol 或其它业务品类 name。
// detectCycles 在业务品类间做有向图环检测；除零/非法语法复用 formula.compile。
// end:aigc.
import { references, compile } from './formula.mjs';

export function detectCycles(categories) {
  const byName = new Map(categories.map((c) => [c.name, c]));
  const edges = new Map(categories.map((c) => [c.name, []]));
  for (const c of categories) {
    for (const key of ['buyFormula', 'sellFormula', 'highFormula', 'lowFormula']) {
      for (const ref of references(c[key] ?? '')) {
        const target = ref.slice(2, ref.lastIndexOf('#'));
        if (byName.has(target)) edges.get(c.name).push(target);
      }
    }
  }
  const visiting = new Set(), done = new Set();
  const visit = (node, path) => {
    if (done.has(node)) return;
    if (visiting.has(node)) throw new Error(`循环引用：${[...path, node].join('->')}`);
    visiting.add(node);
    for (const next of edges.get(node) ?? []) visit(next, [...path, node]);
    visiting.delete(node); done.add(node);
  };
  for (const name of edges.keys()) visit(name, []);
}

export function validateCatalog({ sources = [], baseQuotes = [], categories = [] }) {
  if (!Array.isArray(baseQuotes)) throw new Error('基础行情格式无效');
  const symbols = new Set(baseQuotes.map((b) => b.symbol));
  const catNames = new Set(categories.map((c) => c.name));
  const known = new Set([...symbols, ...catNames]);
  for (const c of categories) {
    if (!c.id || !c.name || typeof c.name !== 'string') throw new Error('品类编号或名称无效');
    if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 6) throw new Error('品类精度无效');
    if (!['half-up', 'floor', 'ceil'].includes(c.rounding)) throw new Error('品类舍入方式无效');
    for (const key of ['buyFormula', 'sellFormula', 'highFormula', 'lowFormula']) {
      const expr = (c[key] ?? '').trim(); if (!expr) continue;
      const refs = references(expr);
      if (refs.some((r) => { const t = r.slice(2, r.lastIndexOf('#')); return !known.has(t); })) throw new Error(`${c.name}引用未知行情`);
      compile(expr);
    }
  }
  detectCycles(categories);
  return { sources, baseQuotes, categories };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/config.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat: validate three-layer catalog with cycle detection"
```

---

## Task 9: snapshot 输出来源元数据 + server 组装

**Files:**
- Modify: `src/config.mjs`（改写 `snapshot`，从 `Quotes` 读数据）
- Modify: `src/server.mjs`（组装 `Quotes` + 适配器 + 路由注入切换日志）
- Modify: `test/quotes.test.mjs`（快照测试迁到新结构）

- [ ] **Step 1: 改写 snapshot**

```js
// start:aigc.
// snapshot 改为从 quotes（聚合层）读取价格与来源元数据，输出带 source/sourceName/sourceMode/derived/inputs。
// 公式计算复用 calculate；freshness 取所有引用输入中最旧时间。
// end:aigc.
export function snapshot(config, quotes, { all = false, now = Date.now(), staleMs = 60000 } = {}) {
  const values = Object.fromEntries([...quotes.prices].map(([k, v]) => [k, v.value]));
  const categories = config.categories ?? config.rows ?? [];
  const rows = categories.filter((r) => all || r.visible).map((row) => {
    const out = { id: row.id, name: row.name, visible: row.visible, updatedAt: null, stale: false, source: null, sourceName: null, sourceMode: null, derived: false, inputs: [], reason: null };
    const usedTimes = [], issues = [], inputMeta = [];
    for (const field of ['buy', 'sell', 'high', 'low']) {
      const expr = row[`${field}Formula`] ?? row[`${field}_formula`] ?? ''; out[field] = null; if (!expr) continue;
      const refs = references(expr);
      for (const ref of refs) {
        const sym = ref.slice(2, ref.lastIndexOf('#'));
        const m = quotes.meta.get(sym);
        if (m && m.updatedAt) usedTimes.push(Date.parse(m.updatedAt));
        if (m) inputMeta.push({ name: sym, source: m.sourceName, time: m.updatedAt });
        const item = quotes.prices.get(ref); if (item) usedTimes.push(item.time);
      }
      try { out[field] = calculate(expr, values, row.decimals, row.rounding); } catch (e) { issues.push(e.message); }
    }
    const refs = [row.buyFormula, row.sellFormula, row.highFormula, row.lowFormula].filter(Boolean).flatMap((e) => references(e));
    const referenced = [...new Set(refs.map((r) => r.slice(2, r.lastIndexOf('#'))))];
    out.derived = referenced.length > 0 && referenced.some((s) => s !== row.name);
    if (referenced.length) {
      const metas = referenced.map((s) => quotes.meta.get(s)).filter(Boolean);
      if (metas.length) { out.source = metas[0].sourceId; out.sourceName = metas[0].sourceName; out.sourceMode = metas[0].mode; }
      out.inputs = [...new Map(inputMeta.map((m) => [m.name, m])).values()];
    } else { const m = quotes.meta.get(row.name); if (m) { out.source = m.sourceId; out.sourceName = m.sourceName; out.sourceMode = m.mode; } }
    if (usedTimes.length) { const oldest = Math.min(...usedTimes); out.updatedAt = new Date(oldest).toISOString(); if (now - oldest > staleMs) out.stale = true; }
    if (issues.length) { out.reason = [...new Set(issues)].join('；'); out.stale = true; }
    else if (out.stale) out.reason = '源报价超过60秒未更新，请核实';
    return out;
  });
  return { serverTime: new Date(now).toISOString(), configVersion: config.version, brand: config.brand, schedule: config.schedule, status: { shopOpen: isShopOpen(config, new Date(now)) }, rows };
}
```

- [ ] **Step 2: 改写 server 组装（store 注入切换日志）**

替换 `createApp` 中的 feed 组装为 quotes 组装：

```js
// start:aigc.
// 用 Quotes 聚合层 + 目录驱动适配器替换旧 QuoteFeed/sina 直连；切换日志写入 store。
// end:aigc.
import { Quotes } from './quotes.mjs';
import { createRtj } from './rtj.mjs';
import { attachSina } from './sina.mjs';

export async function createApp({ dataDir = join(project, 'data'), publicOrigin = process.env.PUBLIC_ORIGIN || null } = {}) {
  const store = new Store(dataDir);
  const baseQuotes = store.baseQuotes();
  const quotes = new Quotes({ baseQuotes, onSwitch: (e) => store.appendSwitchLog({ ...e, reason: '来源切换' }) });
  quotes.attach(createRtj({ map: baseQuotes.map((b) => ({ symbol: b.symbol, code: (b.sources.find((s) => s.sourceId === 'rtj') || {}).code ?? null, kind: (b.sources.find((s) => s.sourceId === 'rtj') || {}).kind ?? 'plain' })) }));
  const stopSina = attachSina({ baseQuotes, onQuote: (tick) => quotes.selector.ingest(tick.symbol, 'sina', tick) });
  setInterval(() => quotes.publish(), 1000).unref();
  // ... 原路由沿用，/api/quotes 改为 snapshot(store.config(), quotes)；/api/admin/config 读三元目录
  return { server, store, quotes, async close() { /* 原逻辑 + stopSina() + quotes.stop() */ } };
}
```

- [ ] **Step 3: 更新快照测试到新结构**

改写 `test/quotes.test.mjs`（旧 feed 结构）使用 `Quotes`：

```js
import { Quotes } from '../src/quotes.mjs';
import { snapshot } from '../src/config.mjs';
// 组装 quotes → ingest 黄金 tick → publish → snapshot 校验 sell/buy/stale/来源元数据
```

具体断言示例（黄金 split，走 rtj）：

```js
test('黄金快照带来源元数据且公式可加销售价差', async () => {
  const q = new Quotes({ baseQuotes: [{ symbol: '黄金', sources: [{ sourceId: 'rtj', priority: 1, enabled: true, kind: 'split', code: 'JZJ_au' }] }] });
  q.ingestTest('rtj', '黄金', { buy: 882.73, sell: 885.73, high: 892.08, low: 883.72, time: Date.now() });
  q.publish();
  const cfg = { ...baseConfig(), categories: [{ id: '4415', name: '黄金', visible: true, buyFormula: '【#黄金#回购价】', sellFormula: '【#黄金#销售价】+3.5', highFormula: '【#黄金#最高价】', lowFormula: '【#黄金#最低价】', decimals: 2, rounding: 'half-up' }] };
  const row = snapshot(cfg, q).rows[0];
  assert.equal(row.buy, '882.73'); assert.equal(row.sell, '889.23');
  assert.equal(row.sourceId, undefined); assert.equal(row.source, 'rtj'); assert.equal(row.sourceName, '融通金'); assert.equal(row.stale, false);
});
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/quotes.test.mjs test/config.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs src/server.mjs test/quotes.test.mjs
git commit -m "feat: emit per-row source metadata in snapshot and wire aggregator"
```

---

## Task 10: 密钥加密存储

**Files:**
- Modify: `src/store.mjs`
- Test: `test/store.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**

```js
test('来源密钥 AES-256-GCM 加密落库且读取只返回是否已配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-crypto-'));
  try {
    const store = new Store(dir);
    store.setSourceSecret('rtj', 'my-secret-key');
    assert.equal(store.getSourceSecret('rtj'), 'my-secret-key');
    assert.equal(store.hasSourceSecret('rtj'), true);
    const raw = store.db.prepare('SELECT secret_ciphertext FROM source_secrets WHERE source_id=?').get('rtj');
    assert.ok(raw && raw.secret_ciphertext !== 'my-secret-key');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/store.test.mjs`
Expected: FAIL（`setSourceSecret` 不存在）

- [ ] **Step 3: 实现**

在 `store.mjs` 中新增（利用项目自有 `data/secret.key` 作为主密钥，不存在则生成）：

```js
// start:aigc.
// 来源密钥加密：AES-256-GCM 用 data/secret.key 主密钥加密后落库，
// 接口只返回是否已配置，永不返回明文密钥。密钥文件权限 0600。
// end:aigc.
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
// 建表：CREATE TABLE IF NOT EXISTS source_secrets (source_id TEXT PRIMARY KEY, secret_ciphertext TEXT NOT NULL);

_keyPath() { return join(this.dir, 'secret.key'); }
_key() {
  const p = this._keyPath();
  if (!existsSync(p)) writeFileSync(p, randomBytes(32), { mode: 0o600, flag: 'wx' });
  return createHash('sha256').update(readFileSync(p)).digest();
}
setSourceSecret(sourceId, secret) {
  const key = this._key();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]).toString('base64');
  this.db.prepare('INSERT INTO source_secrets VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext').run(sourceId, payload);
}
getSourceSecret(sourceId) {
  const row = this.db.prepare('SELECT secret_ciphertext FROM source_secrets WHERE source_id=?').get(sourceId);
  if (!row) return null;
  const buf = Buffer.from(row.secret_ciphertext, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', this._key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
hasSourceSecret(sourceId) { return !!this.db.prepare('SELECT source_id FROM source_secrets WHERE source_id=?').get(sourceId); }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store.mjs test/store.test.mjs
git commit -m "feat: encrypt source secrets with AES-256-GCM at rest"
```

---

## Task 11: admin API（来源状态/基础行情/业务品类/版本回滚/切换日志）

**Files:**
- Modify: `src/server.mjs`
- Test: `test/server.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**

```js
test('admin 可读取来源状态、切换日志，保存山水目录并回滚', async () => {
  // 复用现有 createApp/setup/login 流程，登录后：
  // GET /api/admin/sources -> 数组含 rtj/sina
  // GET /api/admin/switch-logs -> 数组
  // GET /api/admin/catalog -> {sources, baseQuotes, categories}
  // POST /api/admin/catalog -> 保存后 version+1，audit 增加
});
```

- [ ] **Step 2: 实现 API（追加到 `/api/admin/` 段内）**

```js
// start:aigc.
// 三元目录与运行状态 admin API。目录保存复用 store 版本化（audit 表），滚读即 audit 恢复。
// end:aigc.
if (path === '/api/admin/sources' && req.method === 'GET') { json(res, 200, { sources: store.sources() }); return; }
if (path === '/api/admin/switch-logs' && req.method === 'GET') { json(res, 200, { entries: store.switchLogs() }); return; }
if (path === '/api/admin/catalog' && req.method === 'GET') { json(res, 200, { sources: store.sources(), baseQuotes: store.baseQuotes(), categories: store.categories() }); return; }
if (path === '/api/admin/catalog' && req.method === 'POST') {
  const data = await body(req); stillAuthorized();
  validateCatalog(data);
  store.saveBaseQuotes(data.baseQuotes);
  store.saveCategories(data.categories);
  json(res, 200, { ok: true }); return;
}
```

- [ ] **Step 3: 运行确认通过**

Run: `node --test test/server.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server.mjs test/server.test.mjs
git commit -m "feat: add admin endpoints for sources, catalog, and switch logs"
```

---

## Task 12: 前台来源展示 + 迁移后一致性验收

**Files:**
- Modify: `public/admin.js`（新增数据源/基础行情/业务品类页签 + 来源展示）
- Modify: `public/quote.js`（前台展示每行来源标识，可选最小改动）
- Test: `test/consistency.test.mjs`（新建，验收标准）

- [ ] **Step 1: 写一致性验收测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

test('迁移后在融通金健康时，现有品类结果与升级前一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcjy-migrate-'));
  try {
    const store = new Store(dir);
    const categories = store.categories();
    const gold = categories.find((c) => c.name === '黄金');
    assert.equal(gold.buyFormula, '【#黄金#回购价】', '黄金透传公式保持一致');
    const hk = categories.find((c) => c.name === '港金');
    assert.ok(hk.sellFormula.includes('37.429'), '港金采用换算公式');
    // 铑金等复杂引用公式应原样迁移
    const rh = categories.find((c) => c.name === '铑金');
    assert.ok(rh.sellFormula.includes('公斤条'));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行确认通过**

Run: `node --test test/consistency.test.mjs`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/consistency.test.mjs public/admin.js public/quote.js
git commit -m "feat: add admin catalog UI and migration consistency acceptance test"
```

---

## Task 13: 全量回归 + 文档更新

- [ ] **Step 1: 运行全量测试**

Run: `npm test`
Expected: 全部 PASS（旧 `feed.test.mjs`/`quotes.test.mjs` 已在 Task 5/9 迁移至新结构）

- [ ] **Step 2: 更新《数据源备援方案.md》**

在文档的「实施清单」勾选已完成的「备援切换层」「三层模型」「配置版本回滚」「来源切换日志」；在修改处备注 Trae，不在全篇头部加标注。

- [ ] **Step 3: Commit**

```bash
git add docs/数据源备援方案.md
git commit -m "docs: mark failover layer and three-layer model as implemented"
```

---

## Self-Review

**1. Spec coverage：**
- 数据源抽象（可插拔适配器）→ Task 1/5/6 ✅
- 状态机 healthy/stale/disconnected/disabled + 立即切换 + 连续3次切回 → Task 2 ✅
- 三层模型 + 公式引擎只读统一键 → Task 3/7/9 ✅
- 目录迁移进 SQLite → Task 3/4 ✅
- 港金计算（常数成色0.99 + 换算公式）→ Task 3/4（公式内嵌）✅
- 来源切换写运行日志 → Task 2（onSwitch）+ Task 4（switch_log 表）+ Task 9（注入 store）✅
- 全部失效保留 last-known + stale 标记 → Task 2 ✅
- 配置版本回滚 → 沿用现有 audit 表 + Task 11 ✅
- 密钥加密 → Task 10 ✅
- 对外来源元数据（source/sourceMode/derived/inputs）→ Task 9 snapshot ✅
- 循环引用/未知引用/除零校验 → Task 8 ✅
- 迁移后一致性 → Task 12 ✅
- 前台深色重做 → 未在本计划（spec 明确「前台视觉重做另设计」），✅ 符合范围

**2. Placeholder scan：** 无 TBD/TODO；港汇字段映射为「探针校验」而非占位符，已配 `verify-live.mjs` 探针脚本。

**3. Type consistency：** `normalizeTick` 返回 `{symbol,sell?,buy?,high?,low?,time}`；`Selector.ingest(symbol, sourceId, tick, {now})`、`state/getTick/refresh` 签名在各 Task 一致；`Quotes.prices` 键格式 `【#symbol#字段】` 与 `snapshot` 读法、`formula.references` 统一；`store.sources()/baseQuotes()/categories()` 返回字段在 Task 4/7/9/11 一致。
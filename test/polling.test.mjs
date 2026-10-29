// start:aigc.
// 2026-10-28 重构测试：统一轮询运行器行为（F01 停用零请求/F02 失败通知/F03 停止零回调/F04 业务错误）
// + wscn/tencent/itick 解析器单测（真实格式夹具，fetch 全注入不依赖网络）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWscnAdapter, parseWscnJson } from '../src/wscn.mjs';
import { createItickAdapter, parseItickJson } from '../src/itick.mjs';
import { createTencentAdapter, parseTencentText } from '../src/tencent.mjs';
import { createPollingAdapter } from '../src/polling-adapter.mjs';

// start:aigc. 构造假 fetch 响应（运行器统一走 arrayBuffer→latin1，JSON 文本要字符串化）
const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => Buffer.from(body, 'latin1') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bq = (symbol, sourceId, code, enabled) => [{ symbol, enabled: enabled !== false, sources: [{ sourceId, code, enabled: enabled !== false }] }];
test('R04：真实请求超时不被误判为主动停止——通知失败且继续同批后续请求', async () => {
  const events = [];
  const a = createPollingAdapter({
    id: 'z', name: 'z',
    baseQuotes: [{ symbol: '美元指数', enabled: true, sources: [{ sourceId: 'z', code: 'C1', enabled: true }] }, { symbol: '港金', enabled: true, sources: [{ sourceId: 'z', code: 'C2', enabled: true }] }],
    buildQuotes: (b) => { const m = {}; for (const x of b) { const s = x.sources[0]; (m[s.code] ??= []).push({ symbol: x.symbol }); } return m; },
    requestsFor: (codes, quoteMap) => codes.map((c) => ({ url: `u/${c}`, headers: {}, symbols: quoteMap[c].map((q) => q.symbol) })),
    parseResponse: (text) => (text.includes('C2') ? [{ symbol: '港金', time: Date.now(), buy: 1, sell: 1 }] : []),
    timeoutMs: 15,   // 第一个请求挂 60ms > 15ms 超时；第二个立即成功
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(res('C2')), 60);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });   // 模拟真实 fetch 的 abort 语义
      if (url.includes('C2')) { clearTimeout(t); resolve(res('C2')); }
    }),
  });
  const stop = a.start({ onQuote: (t) => events.push(['q', t.symbol]), onFailure: (s, e) => events.push(['f', s, e.message]) });
  await sleep(80); stop();
  assert.ok(events.some((e) => e[0] === 'q' && e[1] === '港金'), '超时不得中断同批后续请求');
  assert.ok(events.some((e) => e[0] === 'f' && e[1] === '美元指数'), '真实超时必须通知失败（暴露备源）');
});
// end:aigc.

test('wscn 解析：fields 顺序动态变化不依赖固定下标（验收踩坑回归）', () => {
  const quotes = { 'DXY.OTC': [{ symbol: '美元指数' }] };
  const five = parseWscnJson({ code: 20000, data: { fields: ['prod_name', 'last_px', 'high_px', 'low_px', 'update_time', 'delisting_date'], snapshot: { 'DXY.OTC': ['美元指数', 102.39, 102.41, 102.31, 1793151429, 0] } } }, quotes);
  const eight = parseWscnJson({ code: 20000, data: { fields: ['prod_name', 'last_px', 'high_px', 'low_px', 'open_px', 'px_change', 'update_time', 'delisting_date'], snapshot: { 'DXY.OTC': ['美元指数', 102.39, 102.41, 102.31, 102.3, 0.05, 1793151429, 0] } } }, quotes);
  for (const t of [five[0], eight[0]]) {
    assert.equal(t.symbol, '美元指数'); assert.equal(t.buy, 102.39); assert.equal(t.high, 102.41); assert.equal(t.low, 102.31);
  }
  assert.equal(five[0].time, 1793151429000);
});

test('wscn 运行器：业务码非 20000 抛错并通知失败，不产 tick（F04 同类守卫）', async () => {
  const calls = [];
  const a = createWscnAdapter(bq('美元指数', 'wscn', 'DXY.OTC'), { fetchImpl: async () => res(JSON.stringify({ code: 500, message: 'boom' })) });
  const stop = a.start({ onQuote: () => calls.push('quote'), onFailure: (s, e) => calls.push(['fail', s, e.message]) });
  await sleep(50); stop();
  assert.equal(calls.filter((c) => c === 'quote').length, 0);
  assert.ok(calls.some((c) => Array.isArray(c) && c[1] === '美元指数' && /业务码 500/.test(c[2])));
});

test('itick 运行器：HTTP 200 + 业务错误码不静默（F04）', async () => {
  const a = createItickAdapter(bq('美元指数', 'itick', 'DXY'), { token: 't', fetchImpl: async () => res(JSON.stringify({ code: 401, msg: 'invalid token' })) });
  const events = [];
  const stop = a.start({ onQuote: (t) => events.push(['q', t]), onFailure: (s, e) => events.push(['f', s, e.message]) });
  await sleep(50); stop();
  assert.equal(events.filter((e) => e[0] === 'q').length, 0);
  assert.ok(events.some((e) => e[0] === 'f' && e[1] === '美元指数' && /业务码 401/.test(e[2])));
});

test('itick 运行器：未配 Token 优雅降级为空适配器', async () => {
  let fetched = 0;
  const a = createItickAdapter(bq('美元指数', 'itick', 'DXY'), { token: null, fetchImpl: async () => { fetched++; return res('{}'); } });
  const statuses = [];
  const stop = a.start({ onQuote: () => {}, onFailure: () => {}, onStatus: (t) => statuses.push(t) });
  await sleep(30); stop();
  assert.equal(fetched, 0);
  // 四查观察项：空适配器必须上报停跑原因，红绿灯据此区分"缺凭据"与"已配置未响应"
  assert.ok(statuses.some((t) => /未配置 Token/.test(t)), '缺凭据原因必须进入 onStatus（note）');
});

test('F01：映射或基础行情停用 → 适配器零请求', async () => {
  let fetched = 0;
  const mk = (base) => createWscnAdapter(base, { fetchImpl: async () => { fetched++; return res('{}'); } });
  mk(bq('美元指数', 'wscn', 'DXY.OTC', false)).start({ onQuote: () => {}, onFailure: () => {} });          // 映射停用
  mk([{ symbol: '美元指数', enabled: false, sources: [{ sourceId: 'wscn', code: 'DXY.OTC', enabled: true }] }]).start({ onQuote: () => {}, onFailure: () => {} }); // 行情停用
  await sleep(30);
  assert.equal(fetched, 0, '停用映射不得产生任何请求（iTick 配额保护）');
});

test('F02：请求失败按源覆盖 symbol 通知 onFailure', async () => {
  const a = createTencentAdapter([{ symbol: '美黄金', enabled: true, sources: [{ sourceId: 'tencent', code: 'hf_GC', enabled: true }] }], { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const fails = [];
  const stop = a.start({ onQuote: () => {}, onFailure: (s, e) => fails.push([s, e.message]) });
  await sleep(50); stop();
  assert.ok(fails.length >= 1 && fails.every(([s]) => s === '美黄金'), '失败必须通知到 selector.markFailure');
});

test('F03：stop 后在途请求完成也不得回调 onQuote', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const a = createTencentAdapter(bq('美黄金', 'tencent', 'hf_GC'), { fetchImpl: async () => { await gate; return res('v_hf_GC="1,1,4000.5,4000.6,4080,3990,09:30:00,0,0,0,0,1,2026-10-28,x";'); } });
  let quotes = 0, fails = 0;
  const stop = a.start({ onQuote: () => quotes++, onFailure: () => fails++ });
  stop();          // 在途 fetch 挂起时立即停止
  release();       // 放行在途请求
  await sleep(50);
  assert.equal(quotes, 0, '停止后零回调');
  assert.equal(fails, 0, '主动停止的中断不算故障');
});

test('tencent 解析：东八区时间与字段位（真实格式夹具）', () => {
  const ticks = parseTencentText('v_hf_GC="4007.12,-0.77,4007.30,4007.60,4038.90,4001.60,18:20:03,4038.40,4032.80,0,1,1,2026-10-27,纽约黄金";', { hf_GC: [{ symbol: '美黄金' }] });
  assert.equal(ticks.length, 1);
  const t = ticks[0];
  assert.equal(t.buy, 4007.3); assert.equal(t.sell, 4007.6); assert.equal(t.high, 4038.9); assert.equal(t.low, 4001.6);
  assert.equal(new Date(t.time).toISOString(), '2026-10-27T10:20:03.000Z');   // 18:20:03+08:00
});

test('itick 解析：毫秒时间戳与高低价', () => {
  const ticks = parseItickJson({ code: 0, data: { s: 'DXY', ld: 101.87, h: 102.2, l: 101.65, t: 1793098376000 } }, { DXY: [{ symbol: '美元指数' }] });
  assert.deepEqual(ticks.map((t) => t.symbol), ['美元指数']);
  assert.equal(ticks[0].buy, 101.87); assert.equal(ticks[0].high, 102.2); assert.equal(ticks[0].time, 1793098376000);
});

test('itick 内盘期货：AU/AG 走 future 端点且 region=CN', async () => {
  // start:aigc. 2026-10-29 沪金/沪银主力复活：内盘期货必须用 /future 端点 + region=CN，
  // 且映射正确（sina nf_AU0/nf_AG0 退役后的唯一源）。逐码单启（每适配器独立节奏），
  // 避开 13 秒逐请求间隔，测试无需真等一个配额周期
  const firstUrl = async (symbol, code) => {
    const urls = [];
    const a = createItickAdapter(bq(symbol, 'itick', code), {
      token: 't',
      fetchImpl: async (url) => {
        urls.push(url);
        return res(JSON.stringify({ code: 0, data: { s: code, ld: 868.1, h: 875.16, l: 866.82, t: 1793244125224 } }));
      },
    });
    const stop = a.start({ onQuote: () => {}, onFailure: () => {} });
    await sleep(60); stop(); await sleep(10);
    return urls[0];
  };
  assert.ok((await firstUrl('沪金主力', 'AU')).includes('/future/quote?region=CN&code=AU'), '沪金应走 future/CN');
  assert.ok((await firstUrl('沪银主力', 'AG')).includes('/future/quote?region=CN&code=AG'), '沪银应走 future/CN');
  // 对照组：指数仍走 indices/GB，不得被改成 future
  assert.ok((await firstUrl('美元指数', 'DXY')).includes('/indices/quote?region=GB&code=DXY'), 'DXY 仍走 indices/GB');
  // end:aigc.
});


test('P2 复审：逐请求最小间隔锁死配额（任意 60s 窗口 ≤5 次）', async () => {
  // start:aigc. 2026-10-29 P2：3 码背靠背连发 + 45s 周期，60 秒内可发出 6 次，超免费版配额。
  // 这里按同一比例缩小（窗口 600ms / 间隔 120ms）验证：任意 600ms 半开窗口内最多 5 次
  const ts = [];
  const a = createPollingAdapter({
    id: 'q', name: 'q',
    baseQuotes: ['A', 'B', 'C'].map((c) => ({ symbol: 'S' + c, enabled: true, sources: [{ sourceId: 'q', code: c, enabled: true }] })),
    buildQuotes: (list) => Object.fromEntries(list.map((x) => [x.sources[0].code, [{ symbol: x.symbol }]])),
    requestsFor: (codes) => codes.map((c) => ({ url: 'u' + c, headers: {}, symbols: ['S' + c] })),
    parseResponse: () => [],
    intervalMs: 120, minGapMs: 120,
    fetchImpl: async () => { ts.push(Date.now()); return res('{}'); },
  });
  const stop = a.start({ onQuote: () => {}, onFailure: () => {} });
  await sleep(1500); stop(); await sleep(20);
  assert.ok(ts.length >= 10, `应持续轮询（实际 ${ts.length} 次）`);
  let max = 0;
  for (let i = 0; i < ts.length; i += 1) {
    let n = 0;
    for (let j = i; j < ts.length && ts[j] - ts[i] < 600; j += 1) n += 1;
    if (n > max) max = n;
  }
  assert.ok(max <= 5, `任意 600ms 窗口最多 5 次，实测 ${max}`);
  // end:aigc.
});

test('运行器：防重叠——慢请求期间并发始终为 1，完成后下一轮继续（R03 修正版）', async () => {
  let inFlight = false, overlaps = 0, started = 0;
  const a = createPollingAdapter({
    id: 'x', name: 'x', baseQuotes: bq('美元指数', 'x', 'C1'),
    buildQuotes: (b) => ({ C1: [{ symbol: b[0].symbol }] }),
    requestsFor: () => [{ url: 'u', headers: {} }],
    parseResponse: () => [],
    intervalMs: 40,   // R03：短周期确保真实触发多次轮询机会（默认 15s 测不到）
    fetchImpl: async () => { started++; if (inFlight) overlaps++; inFlight = true; await sleep(80); inFlight = false; return res('{}'); },
  });
  const stop = a.start({ onQuote: () => {}, onFailure: () => {} });
  await sleep(260); stop(); await sleep(20);
  assert.ok(started >= 2, `至少两轮轮询（实际 ${started}），证明测试有效`);
  assert.equal(overlaps, 0, '慢请求期间并发必须恒为 1');
});

test('R02：多请求批次中单请求失败只判该请求品种，不影响其他端点', async () => {
  const events = [];
  const a = createPollingAdapter({
    id: 'y', name: 'y',
    baseQuotes: [{ symbol: '美元指数', enabled: true, sources: [{ sourceId: 'y', code: 'C1', enabled: true }] }, { symbol: '港金', enabled: true, sources: [{ sourceId: 'y', code: 'C2', enabled: true }] }],
    buildQuotes: (b) => { const m = {}; for (const x of b) { const s = x.sources[0]; (m[s.code] ??= []).push({ symbol: x.symbol }); } return m; },
    requestsFor: (codes, quoteMap) => codes.map((c) => ({ url: `u/${c}`, headers: {}, symbols: quoteMap[c].map((q) => q.symbol) })),
    parseResponse: (text) => (text.includes('C1') ? [{ symbol: '美元指数', time: Date.now(), buy: 1, sell: 1 }] : []),
    fetchImpl: async (url) => { if (url.includes('C2')) throw new Error('endpoint B down'); return res('C1'); },
  });
  const stop = a.start({ onQuote: (t) => events.push(['q', t.symbol]), onFailure: (s, e) => events.push(['f', s, e.message]) });
  await sleep(50); stop();
  assert.ok(events.some((e) => e[0] === 'q' && e[1] === '美元指数'), '成功端点照常上报');
  const fails = events.filter((e) => e[0] === 'f');
  assert.deepEqual(fails.map((e) => e[1]), ['港金'], '失败只通知故障端点覆盖的品种');
});
// end:aigc.

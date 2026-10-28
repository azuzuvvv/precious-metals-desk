// start:aigc.
// 通用 HTTP 轮询适配器运行器：统一承担订阅过滤(F01)、轮询防重叠、超时、停止取消(F03)、
// 失败通知(F02)、错误去重。每个数据源只写协议差异（URL/请求头/解析/业务码校验），
// 产物符合 adapter.mjs 契约 {id,name,start({onQuote,onFailure,onStatus})→stop,stop()}，
// 由 Quotes.attach 统一管理生命周期与来源名注册。
//
// 协议参数：
//   buildQuotes(baseQuotes)   -> {code: [{symbol}]}：含 enabled 过滤，空则不轮询（F01：停用映射零请求）
//   requestsFor(codes, quoteMap) -> [{url, headers, symbols}]：一或多个请求；symbols 为该请求覆盖的
//     品种列表（R02：请求级故障归属，失败只通知本请求品种，不影响同批其他端点）
//   parseResponse(text, quotes) -> ticks 数组：文本 latin1 已解码；业务错误必须 throw（F04）
//   intervalMs/timeoutMs       -> 运行频率与超时；可被来源级配置覆盖（R01，带安全下限防高频轮询）
//   fetchImpl                  -> 可注入 fetch（确定性测试）
const clampMs = (v, min, fallback) => { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback; };

export function createPollingAdapter({
  id, name, baseQuotes,
  buildQuotes, requestsFor, parseResponse,
  intervalMs = 15000, timeoutMs = 8000,
  pollMs = null, reqTimeoutMs = null,   // R01：来源级配置覆盖（poll_ms/timeout_ms）
  fetchImpl = fetch,
  onError = null,          // 可选钩子：(msg) => void，默认 console.error（同错只报一次）
}) {
  const quoteMap = buildQuotes(baseQuotes ?? []);
  const codes = Object.keys(quoteMap);
  // start:aigc. R01：仅钳制"来源配置覆盖值"（数据库/后台输入不可信，poll ≥5s、timeout ≥2s
  // 防打爆上游）；协议模块自带的 intervalMs/timeoutMs 是审查过的可信常量，直接使用
  const interval = pollMs != null ? clampMs(pollMs, 5000, intervalMs) : intervalMs;
  const timeout = reqTimeoutMs != null ? clampMs(reqTimeoutMs, 2000, timeoutMs) : timeoutMs;
  const symbols = [...new Set(codes.flatMap((c) => quoteMap[c].map((q) => q.symbol)))];
  let stopped = false, timer = null, controller = null, inFlight = false, lastErr = null;
  const report = (msg) => { if (onError) onError(msg); else if (msg !== lastErr) console.error(`[${id}] 拉取失败:`, msg); };

  async function poll(handlers) {
    if (stopped || inFlight) return;   // 防重叠：上轮未完成跳过本轮，不排队堆积
    inFlight = true;
    controller = new AbortController();   // 本轮停止通道（stop() 时 abort 在途请求）
    try {
    // start:aigc. R02：请求级故障归属——每个请求独立 try/catch，失败只通知该请求覆盖的
    // symbols 且不中断同批后续请求；全部失败时退化为源级失败（等价旧行为）
    const reqs = requestsFor(codes, quoteMap);
    let okAny = false;
    for (const req of reqs) {
      if (stopped) break;   // 双保险：传输层未响应 abort 时也绝不停后回写（F03 复查点）
      try {
        // 超时与主动停止双通道合并：任一触发即中断在途请求（F03：stop 后零回调）
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
        const r = await fetchImpl(req.url, { headers: req.headers, signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = Buffer.from(await r.arrayBuffer()).toString('latin1');
        if (stopped) break;   // 解码耗时后停止：不回调不通知
        for (const t of parseResponse(text, quoteMap)) if (!stopped) handlers.onQuote(t);
        okAny = true;
      } catch (err) {
        // start:aigc. R04（2026-10-28 二查）：主动停止只认本轮控制器的 signal.aborted——
        // stop() 时它必为 true；AbortSignal.timeout 触发时它仍为 false → 超时走正常失败路径
        // （通知本请求 symbols + 继续同批后续请求），不再用异常消息猜测
        if (stopped || controller.signal.aborted) break;
        const msg = err?.message ?? String(err);
        report(msg); lastErr = msg;
        // F02：失败必须通知 Selector（markFailure → 立即暴露备源），范围仅限本请求品种
        for (const symbol of req.symbols ?? symbols) handlers.onFailure(symbol, new Error(msg));
        // end:aigc.
      }
    }
    if (okAny) lastErr = null;
    // end:aigc.
    } finally { inFlight = false; }
  }

  return {
    id, name,
    start(handlers) {
      if (!codes.length) return () => {};   // 无启用映射的源零开销
      void poll(handlers);
      timer = setInterval(() => poll(handlers), interval); timer.unref?.();
      return () => { stopped = true; clearInterval(timer); controller?.abort(); };
    },
    stop() { stopped = true; clearInterval(timer); controller?.abort(); },
  };
}
// end:aigc.

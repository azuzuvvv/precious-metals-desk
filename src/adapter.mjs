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
  if (raw.buy === undefined && raw.sell === undefined) throw new Error('行情缺买卖价');
  return out;
}
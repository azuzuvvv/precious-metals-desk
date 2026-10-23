// start:aigc.
// 新浪 hf_ 外盘字段校准探针：同时抓取融通金（rtj）伦敦金/美黄金现价与新浪 hf_XAU/hf_GC
// 原始字段，肉眼对比确定字段位（现价/买/卖/高/低/时间），为备援映射提供实测依据。
// 用法：node scripts/probe-sina-hf.mjs（约采样 10 秒）
// end:aigc.
import { QuoteFeed } from '../src/feed.mjs';

const feed = new QuoteFeed({ map: [
  { symbol: '伦敦金', code: 'XAU', kind: 'plain' },
  { symbol: '美黄金', code: 'GLNC', kind: 'plain' },
] });
const rtj = {};
feed.on('tick', (t) => { rtj[t.symbol] = t; });
await feed.start();

async function grabSina() {
  const r = await fetch('https://hq.sinajs.cn/list=hf_XAU,hf_GC', { headers: { Referer: 'https://finance.sina.com.cn' }, signal: AbortSignal.timeout(8000) });
  return Buffer.from(await r.arrayBuffer()).toString('latin1');
}

try {
  await new Promise((r) => setTimeout(r, 8000)); // 等 rtj 握手出价
  const text = await grabSina();
  console.log('== rtj (融通金) ==');
  for (const [s, t] of Object.entries(rtj)) console.log(s, JSON.stringify(t));
  console.log('== sina hf_ ==');
  for (const line of text.trim().split('\n')) {
    const key = line.match(/hf_str_(\w+)/)?.[1];
    const fields = line.match(/"([^"]*)"/)?.[1]?.split(',');
    if (fields) console.log(key, fields.map((v, i) => `[${i}]=${v}`).join(' '));
  }
} catch (e) {
  console.error('探针失败：', e.message);
} finally { feed.stop(); }

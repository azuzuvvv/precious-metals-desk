import {QuoteFeed} from '../src/feed.mjs';
import Decimal from 'decimal.js';
// start:aigc. 修复订阅（R 系列遗留）：QuoteFeed 现为 map 驱动，必须传入黄金映射才能收到行情。
// 比对假设黄金品类为默认透传公式 sell=【#黄金#销售价】；若后台改过公式请按实际基差人工核对。
// end:aigc.
const feed=new QuoteFeed({map:[{symbol:'黄金',code:'JZJ_au',kind:'split'}]}),history=[],samples=[];
feed.on('quote',q=>{if(q.code==='JZJ_au_PS'&&Number.isFinite(q.rt?.last)){history.push({at:q.quoteTime,price:String(q.rt.last)});if(history.length>300)history.shift();}});
await feed.start();
try{
  for(let i=0;i<20&&samples.length<3;i++){
    await new Promise(r=>setTimeout(r,1000));
    const response=await fetch('http://127.0.0.1:3188/api/quotes',{signal:AbortSignal.timeout(3000)});
    const data=await response.json(),gold=data.rows.find(r=>r.id==='4415');
    if(!gold?.sell||gold.stale)continue;
    // start:aigc. 默认透传：源销售价应与公开报价一致（原 +3.50 是历史公式，已随配置演进移除）
    const match=history.findLast(q=>Math.abs(q.at-Date.parse(gold.updatedAt))<2000&&new Decimal(q.price).toFixed(2)===gold.sell);
    if(match&&!samples.some(s=>s.sourceTime===match.at))samples.push({sourceTime:match.at,localQuoteTime:gold.updatedAt,sourceSell:match.price,newSell:gold.sell});
    // end:aigc.
  }
  console.log(JSON.stringify({passed:samples.length>=3,samples},null,2));
  if(samples.length<3)process.exitCode=1;
}finally{feed.stop();}

// start:aigc. 港汇字段探针：打印 fx_susdhkd 原始字段，供确认字段映射。 end:aigc.
try {
  const _hkR = await fetch('https://hq.sinajs.cn/list=fx_susdhkd', { headers: { Referer: 'https://finance.sina.com.cn' } });
  const _hkT = Buffer.from(await _hkR.arrayBuffer()).toString('latin1');
  console.log('[港汇探针]', _hkT);
} catch (e) { console.warn('[港汇探针] 拉取失败：', e.message); }

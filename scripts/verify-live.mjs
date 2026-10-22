import {QuoteFeed} from '../src/feed.mjs';
import Decimal from 'decimal.js';
const feed=new QuoteFeed(),history=[],samples=[];
feed.on('quote',q=>{if(q.code==='JZJ_au_PS'&&Number.isFinite(q.rt?.last)){history.push({at:q.quoteTime,price:String(q.rt.last)});if(history.length>300)history.shift();}});
await feed.start();
try{
  for(let i=0;i<20&&samples.length<3;i++){
    await new Promise(r=>setTimeout(r,1000));
    const response=await fetch('http://127.0.0.1:3188/api/quotes',{signal:AbortSignal.timeout(3000)});
    const data=await response.json(),gold=data.rows.find(r=>r.id==='4415');
    if(!gold?.sell||gold.stale)continue;
    const match=history.findLast(q=>Math.abs(q.at-Date.parse(gold.updatedAt))<2000&&new Decimal(q.price).plus('3.50').toFixed(2)===gold.sell);
    if(match&&!samples.some(s=>s.sourceTime===match.at))samples.push({sourceTime:match.at,localQuoteTime:gold.updatedAt,sourceSell:match.price,newSell:gold.sell,add:'3.50'});
  }
  console.log(JSON.stringify({passed:samples.length>=3,samples},null,2));
  if(samples.length<3)process.exitCode=1;
}finally{feed.stop();}

// start:aigc.
// 融通金适配器：复用 QuoteFeed 的握手/订阅/解析，把合并 tick 跨消息累积后归一化为统一 tick 并回调 onQuote。
// start() 返回一个清理函数（内部调用 feed.stop()），供聚合层统一管理生命周期。
import {QuoteFeed} from './feed.mjs';
import {normalizeTick} from './adapter.mjs';

export function createRtj({map=[],onQuote=()=>{},onFailure=()=>{},onStatus=()=>{}}={}){
  const feed=new QuoteFeed({map});
  const buf={};   // symbol -> 跨消息累积字段，凑齐买卖价后归一化输出
  feed.on('tick',(tick)=>{
    const prev=buf[tick.symbol];
    if(prev&&prev.time>tick.time)return;   // 忽略更旧的乱序消息，防止旧值覆盖新值
    buf[tick.symbol]={...prev,...tick};
    const cur=buf[tick.symbol];
    if(cur.buy!==undefined||cur.sell!==undefined){
      try{onQuote(normalizeTick(tick.symbol,cur));}
      catch{/* 字段不足时等待下一 tick */}
    }
  });
  feed.on('status',(s)=>onStatus(s));
  return {
    id:'rtj',name:'融通金',
    start:()=>{feed.start();return()=>feed.stop();},
    stop:()=>feed.stop(),
    // 测试钩子：直接注入一条行情消息，绕过真实 WebSocket 握手
    ingestForTest:(q)=>feed.update(q),
  };
}
// end:aigc.
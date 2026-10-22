// start:aigc.
// 融通金适配器：复用 QuoteFeed 的握手/订阅/解析，把合并 tick 跨消息累积后归一化为统一 tick 并回调 onQuote。
// 回调可在构造时传入，也可在 start({onQuote,onStatus}) 注入（聚合层 attach 的标准契约，start 注入优先）。
// start() 返回清理函数（内部调用 feed.stop()），供聚合层统一管理生命周期。
import {QuoteFeed} from './feed.mjs';
import {normalizeTick} from './adapter.mjs';

export function createRtj({map=[],onQuote=()=>{},onFailure=()=>{},onStatus=()=>{}}={}){
  const feed=new QuoteFeed({map});
  const buf={};   // symbol -> 跨消息累积字段，凑齐买卖价后归一化输出
  let handleQuote=onQuote;   // start() 注入的回调优先于构造参数
  feed.on('tick',(tick)=>{
    const prev=buf[tick.symbol];
    if(prev&&prev.time>tick.time)return;   // 忽略更旧的乱序消息，防止旧值覆盖新值
    buf[tick.symbol]={...prev,...tick};
    const cur=buf[tick.symbol];
    if(cur.buy!==undefined||cur.sell!==undefined){
      try{handleQuote(normalizeTick(tick.symbol,cur));}
      catch{/* 字段不足时等待下一 tick */}
    }
  });
  feed.on('status',()=>onStatus(feed.sourceStatus));
  return {
    id:'rtj',name:'融通金',
    start(handlers={}){
      if(handlers.onQuote)handleQuote=handlers.onQuote;
      feed.start();
      return ()=>feed.stop();
    },
    stop:()=>feed.stop(),
    // 测试钩子：直接注入一条行情消息，绕过真实 WebSocket 握手
    ingestForTest:(q)=>feed.update(q),
  };
}
// end:aigc.

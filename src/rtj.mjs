// start:aigc.
// 融通金适配器：复用 QuoteFeed 的握手/订阅/解析，把合并 tick 跨消息累积后归一化为统一 tick 并回调 onQuote。
// 回调可在构造时传入，也可在 start({onQuote,onStatus}) 注入（聚合层 attach 的标准契约，start 注入优先）。
// start() 返回清理函数（内部调用 feed.stop()），供聚合层统一管理生命周期。
import {QuoteFeed} from './feed.mjs';
import {normalizeTick} from './adapter.mjs';

export function createRtj({map=[],onQuote=()=>{},onFailure=()=>{},onStatus=()=>{}}={}){
  const feed=new QuoteFeed({map});
  const buf={};   // symbol -> {fields:{字段:{v,t}}}，跨消息按字段累积，凑齐买卖价后归一化输出
  let handleQuote=onQuote;   // start() 注入的回调优先于构造参数
  let handleStatus=onStatus;
  feed.on('tick',(tick)=>{
    const prev=buf[tick.symbol];
    // 字段级合并：同字段更旧时间戳的更新直接丢弃（乱序守卫下沉到字段级）
    const merged={...(prev?.fields??{})};
    for(const field of ['buy','sell','high','low']){
      const v=tick[field];
      if(v===undefined||v===null)continue;
      const cur=merged[field];
      if(cur&&cur.t>tick.time)continue;
      merged[field]={v,t:tick.time};
    }
    buf[tick.symbol]={fields:merged};
    const cur=buf[tick.symbol].fields;
    if(cur.buy!==undefined||cur.sell!==undefined){
      // 买卖侧（buy/sell）是核心字段：输出时间取其最旧，高低缺失/停更不拖垮买卖新鲜度（F03）
      const core=['buy','sell'].filter((f)=>cur[f]!==undefined);
      const time=Math.min(...core.map((f)=>cur[f].t));
      const out={symbol:tick.symbol,time};
      for(const [f,x] of Object.entries(cur))out[f]=x.v;
      try{handleQuote(normalizeTick(tick.symbol,out));}
      catch{/* 字段不足时等待下一 tick */}
    }
  });
  feed.on('status',()=>handleStatus(feed.sourceStatus));
  return {
    id:'rtj',name:'融通金',
    start(handlers={}){
      if(handlers.onQuote)handleQuote=handlers.onQuote;
      if(handlers.onStatus)handleStatus=handlers.onStatus;
      feed.start();
      return ()=>feed.stop();
    },
    stop:()=>feed.stop(),
    // 测试钩子：直接注入一条行情消息，绕过真实 WebSocket 握手
    ingestForTest:(q)=>feed.update(q),
  };
}
// end:aigc.

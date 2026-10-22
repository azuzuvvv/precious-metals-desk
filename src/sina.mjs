// start:aigc.
// 新浪补充行情源：负责融通金缺失的品种（美元指数、沪金/沪银主力）。
// 数据写入 feed.prices（键格式与融通金一致：【#品种#字段】），公式引擎无需感知来源。
import {FIELD_LABELS} from './catalog.mjs';

const SINA_URL='https://hq.sinajs.cn/list=DINIW,nf_AU0,nf_AG0';
// 新浪返回 GBK 编码，数字段均为 ASCII，latin1 解码即可
const num=v=>{const n=Number(v);return Number.isFinite(n)&&n!==0?n:null;};

export function attachSina(feed,{intervalMs=15000}={}){
  const set=(name,field,value,time)=>{if(value==null)return;
    feed.prices.set(`【#${name}#${FIELD_LABELS[field]}】`,{value:String(value),time});};

  async function poll(){
    try{
      const r=await fetch(SINA_URL,{headers:{Referer:'https://finance.sina.com.cn'},signal:AbortSignal.timeout(8000)});
      const text=Buffer.from(await r.arrayBuffer()).toString('latin1');
      const now=Date.now();
      for(const m of text.matchAll(/hq_str_(\w+)="([^"]*)"/g)){
        const f=m[2].split(',');
        if(m[1]==='DINIW'){
          // DINIW 字段：[0]时间 [1]买入 [2]卖出 [5]开盘 [6]最高 [7]最低 [8]最新
          set('美元指数','buy',num(f[1]),now);set('美元指数','sell',num(f[2]),now);
          set('美元指数','high',num(f[6]),now);set('美元指数','low',num(f[7]),now);
        }else if(m[1]==='nf_AU0'||m[1]==='nf_AG0'){
          // 期货字段：[3]最高 [4]最低 [6]买价 [7]卖价
          // 与原站口径对齐：回购=买卖中间价，销售=卖价（实测原站 886.44/886.50 即 mid/ask）
          const name=m[1]==='nf_AU0'?'沪金主力':'沪银主力';
          const bid=num(f[6]),ask=num(f[7]);
          set(name,'buy',bid!=null&&ask!=null?(bid+ask)/2:null,now);
          set(name,'sell',ask,now);
          set(name,'high',num(f[3]),now);set(name,'low',num(f[4]),now);
        }
      }
    }catch{/* 拉取失败保留旧值，由 60 秒过期机制统一标记 */}
  }
  void poll();
  const timer=setInterval(poll,intervalMs);timer.unref?.();
  return ()=>clearInterval(timer);
}
// end:aigc.

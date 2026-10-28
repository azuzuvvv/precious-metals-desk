import {QuoteFeed} from '../src/feed.mjs';
import Decimal from 'decimal.js';
// start:aigc. 修复（R 系列遗留）：QuoteFeed 现为 map 驱动，必须传入黄金映射才能收到行情。
// 比对假设黄金品类为默认透传公式 sell=【#黄金#销售价】；若后台改过公式请按实际基差人工核对。
// end:aigc.
// start:aigc.
// 访问保护适配（方案 §17.3）：基础地址可配置（VERIFY_BASE，默认本机 3188，不硬编码公网 IP）；
// Node fetch 不自动保持 Cookie，显式保存会话 Cookie 并随行情请求回传；不用管理员会话/生产 Key，
// 失败只报状态码不输出 Cookie 明文。验收双分支：带会话正常读取 + 无会话请求的状态观测。
const BASE=process.env.VERIFY_BASE||'http://127.0.0.1:3188';
let viewerCookie=null;
async function ensureSession(){
  if(viewerCookie)return;
  const response=await fetch(BASE+'/api/viewer/session',{method:'POST',headers:{origin:BASE,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw new Error(`会话初始化失败 HTTP ${response.status}`);
  const setCookie=response.headers.get('set-cookie')||'';
  const match=/(?:^|;\s*)lcjy_viewer=([0-9a-f]{64})/.exec(setCookie);
  if(!match)throw new Error('未收到访客会话 Cookie');
  viewerCookie=`lcjy_viewer=${match[1]}`;
}
const fetchQuotes=async()=>fetch(BASE+'/api/quotes',{headers:{cookie:viewerCookie},signal:AbortSignal.timeout(3000)});
// end:aigc.
const feed=new QuoteFeed({map:[{symbol:'黄金',code:'JZJ_au',kind:'split'}]}),history=[],samples=[];
feed.on('quote',q=>{if(q.code==='JZJ_au_PS'&&Number.isFinite(q.rt?.last)){history.push({at:q.quoteTime,price:String(q.rt.last)});if(history.length>300)history.shift();}});
await feed.start();
try{
  // start:aigc. 双分支验收（§17.3）：先建会话；无会话探测仅报状态（401= enforce 生效，200= observe/off）
  await ensureSession();
  const anon=await fetch(BASE+'/api/quotes',{signal:AbortSignal.timeout(3000)}).catch((e)=>({status:`网络错误:${e.message}`}));
  console.log(JSON.stringify({base:BASE,anonProbe:{status:anon.status,expected401InEnforce:anon.status===401}}));
  // end:aigc.
  for(let i=0;i<20&&samples.length<3;i++){
    await new Promise(r=>setTimeout(r,1000));
    const response=await fetchQuotes();
    if(!response.ok)throw new Error(`行情请求失败 HTTP ${response.status}`);
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

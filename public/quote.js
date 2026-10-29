'use strict';
const $=id=>document.getElementById(id);
let snapshot=null, hidden=new Set(), failed=false;
try{hidden=new Set(JSON.parse(localStorage.getItem('lcjy-hidden')||'[]'));}catch{}
const formatTime=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'暂无';
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function persist(){try{localStorage.setItem('lcjy-hidden',JSON.stringify([...hidden]));}catch{}render();}
function render(){if(!snapshot)return;const s=snapshot;
 document.title=s.brand.name+' | 贵金属行情';$('logo').alt=s.brand.name;
 const logo=s.brand.logo||'/assets/logo.png';if(logo.startsWith('/assets/')&&!logo.includes('..'))$('logo').src=logo;
 $('subtitle').textContent=s.brand.subtitle;$('notice').textContent=s.brand.notice;$('brand-footer').textContent=s.brand.footer;$('phone').textContent=s.brand.phone?'联系方式：'+s.brand.phone:'';
// start:aigc. 右上角营业状态文案：按要求由"店铺开盘/店铺停盘"改为"开盘/闭盘"
 $('server-time').textContent=formatTime(s.serverTime);$('shop').textContent=s.status.shopOpen?'开盘':'闭盘';
 // end:aigc.
 // start:aigc. 与原站一致的视觉（不置灰），但保留停更/单边可见性（M02）：
// 行内轻量标签（收盘/单边/停更），半截/过期报价必须可辨识
// 2026-10-28 按需求移除顶部状态行（"行情源已连接 · 源状态：… · N 项行情停更/单边"整行不再展示），
// 连接状态异常仍可通过行内标签与"缺少数据"按钮辨识
 $('connection').hidden=true;
 // end:aigc.
 const fragment=document.createDocumentFragment();for(const r of s.rows){if(hidden.has(r.id))continue;const tr=el('tr',undefined,failed?'stale':'');const name=el('td',undefined,'product');name.append(el('span',r.name));
 // 2026-10-29 按要求移除行内文字小标签（停更/收盘/单边/引用）：影响客户观感；
 // 异常仍通过"缺少数据"按钮（可点击看原因）与整行置灰传达，不加任何显眼字样
 // start:aigc. 2026-10-29 P2：按钮触发条件从"reason 文案包含缺少"改为**结构化状态判断**——
 // 后端 reason 文案多种多样（停更/收盘/单边/暂无数据源/品类引用等），靠 includes 匹配会漏判。
 // 2026-10-29 P2 复审：固定报价（纯数字公式）天然没有 source/sourceMode，不能用"无来源"判定异常，
 // 只能以"整行四个报价字段全为空"为准；网络级中断另由 failed 兜底。
 const anyQuoteNull = r => r.buy == null && r.sell == null && r.high == null && r.low == null;
 const showMissingBtn = failed || anyQuoteNull(r);
 if (showMissingBtn) {
   const note=el('button','缺少数据 ⓘ','row-note');note.setAttribute('aria-label',r.name+'行情状态');note.onclick=()=>{$('detail-title').textContent=r.name;$('detail-text').textContent=(failed?'网络已中断，以下是最后收到的价格。':(r.reason||'该品种暂无可用数据源'))+'\n报价更新时间：'+formatTime(r.updatedAt);$('quote-detail').showModal();};name.append(note);}
 // end:aigc.
 // 商品名列必须显式 append（"缺少数据"按钮也挂在此单元格内），漏掉会导致整列消失且只剩三列
 tr.title='报价更新时间：'+formatTime(r.updatedAt);tr.append(name);
 let color='';const midpoint=(Number(r.high)+Number(r.low))/2,main=Number(r.sell??r.buy);if(r.high!=null&&r.low!=null&&(r.sell??r.buy)!=null)color=main>midpoint?'high':main<midpoint?'low':'';
 tr.append(el('td',r.buy??'--',color),el('td',r.sell??'--',color));const range=el('td');range.append(el('div',r.high??'--','high'),el('div',r.low??'--','low'));tr.append(range);fragment.append(tr);}
 $('prices').replaceChildren(fragment);$('empty').hidden=$('prices').children.length>0;
}
function choices(){const frag=document.createDocumentFragment();for(const r of snapshot?.rows||[]){const label=el('label'),input=el('input');input.type='checkbox';input.checked=!hidden.has(r.id);input.addEventListener('change',()=>{input.checked?hidden.delete(r.id):hidden.add(r.id);persist();});label.append(input,el('span',r.name));frag.append(label);}$('choices').replaceChildren(frag);}
$('choose').onclick=()=>{choices();$('selection').showModal();};$('all').onclick=()=>{hidden.clear();persist();choices();};$('none').onclick=()=>{hidden=new Set((snapshot?.rows||[]).map(r=>r.id));persist();choices();};
// start:aigc.
// 会话与轮询（方案 §6/§15.2.2/§17.2）：基础 2 秒 ±10% 零均值抖动，上一请求完成后再调度（不重叠）；
// 401 只重建一次会话再重试；429 遵守 Retry-After（最早重试时间，随机化只额外延后）；
// 网络失败按 2/4/8/16/30 秒退避；恢复事件（online/visibilitychange）只触发去重后的恢复检查。
// AP-01 修复：统一在请求结束后释放 polling 并调度下一轮，成功/401/429/异常后都继续，页面不冻结。
// AP-02 修复：会话初始化错误保留 Retry-After；最早重试时间统一约束恢复事件，不提前打断 429 等待。
let backoff=0,pollTimer=null,polling=false,lastOkAt=0,rebuildPromise=null,earliestRetryAt=0;
const jitterDelay=()=>2000+Math.round((Math.random()-0.5)*400); // 均值 2000ms（±10%），消解重启后的同步轮询波
function schedulePoll(ms){pollTimer=setTimeout(runPoll,ms);}
// start:aigc. 统一受限提示（B-02 补充）：boot 初始化封禁、行情 GET 403、401 重建遇封禁三条路径共用
function showRestricted(){
  failed=true;if(snapshot)render();
  $('connection').hidden=false;
  $('connection').textContent='访问暂受限制，价格已停止更新。约每 30 秒自动探测恢复，解封后无需刷新页面。';
  $('connection').className='connection warning';
}
// end:aigc.
// 会话重建任务全页唯一（§6：多个失败不能同时触发大量初始化）；错误携带服务器最早重试时间（AP-02）；
// 403+IP_BLOCKED（第三批 B-02）：标记 blocked，boot/轮询按受限提示处理，Retry-After 由服务端给约 30 秒
function ensureSession(){
  if(!rebuildPromise)rebuildPromise=fetch('/api/viewer/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(6000)})
    .then(async(response)=>{
      if(!response.ok){
        const retryAfterSec=Number(response.headers.get('retry-after'))||0;
        const err=Error('session:'+response.status);
        if(response.status===403){
          let blocked=false;
          try{blocked=(await response.clone().json()).error==='IP_BLOCKED';}catch{}
          if(blocked){err.blocked=true;err.retryAfterMs=30000;throw err;} // 封禁：约 30 秒探测，不按剩余时长长等
        }
        if(retryAfterSec>0)err.retryAfterMs=retryAfterSec*1000;
        throw err;
      }
    })
    .finally(()=>{rebuildPromise=null;});
  return rebuildPromise;
}
async function fetchQuotes(){ // 401：重建会话后重试一次，不无限循环、不刷新整页
  const response=await fetch('/api/quotes',{cache:'no-store',signal:AbortSignal.timeout(6000)});
  if(response.status===401){await ensureSession();return fetch('/api/quotes',{cache:'no-store',signal:AbortSignal.timeout(6000)});}
  return response;
}
// 从错误里提取服务器要求的最早重试间隔，无则用通用指数退避（AP-02）
function delayFromError(err){
  if(err&&err.retryAfterMs)return err.retryAfterMs+Math.round(Math.random()*500);
  return [2000,4000,8000,16000,30000][Math.min(backoff++,4)];
}
async function runPoll(){
  if(polling)return;polling=true;clearTimeout(pollTimer);
  let nextMs;
  try{
    const response=await fetchQuotes();
    if(response.status===429){ // 服务端已拒绝：保留旧报价并显示访问暂受限制（failed 置灰即停更标识）
      failed=true;render();
      nextMs=Math.max(1,Number(response.headers.get('retry-after'))||2)*1000+Math.round(Math.random()*500);
    }else if(response.status===403){
      // 手动封禁（§5，第三批）：403+IP_BLOCKED 走统一受限提示；不发起 401 会话重建、不刷新整页
      let blocked=false;
      try{blocked=(await response.clone().json()).error==='IP_BLOCKED';}catch{}
      if(!blocked)throw Error('http:403');
      showRestricted();
      nextMs=30000;
    }else if(!response.ok){
      throw Error('http:'+response.status);
    }else{
      snapshot=await response.json();failed=false;backoff=0;lastOkAt=Date.now();render();
      nextMs=jitterDelay();
    }
  }catch(err){
    if(err&&err.blocked)showRestricted(); // B-02 补充：401 重建会话遇封禁（ensureSession 抛出）与 GET 403 同提示
    else{
      failed=true;if(snapshot)render();else{$('connection').textContent='无法连接行情服务，暂无报价。正在重试…';$('connection').className='connection warning';}
    }
    nextMs=delayFromError(err); // blocked 错误携带 30 秒探测间隔
  }
  earliestRetryAt=Date.now()+nextMs; // 记录最早重试时间，供恢复事件判定（AP-02）
  polling=false; // AP-01：统一释放请求标记，保证下一轮可继续
  schedulePoll(nextMs);
}
// 恢复检查去重（§6 + AP-02）：仅空闲、页面可见、在线、已过最早重试时间且距上次成功超过 5 秒时提前触发一次
function nudge(){
  if(polling||document.hidden||!navigator.onLine)return;
  if(Date.now()<earliestRetryAt)return; // 尊重服务器最早重试时间，不提前打断 429/初始化限流等待
  if(Date.now()-lastOkAt>5000)runPoll();
}
window.addEventListener('online',nudge);
document.addEventListener('visibilitychange',nudge);
// end:aigc.
window.addEventListener('offline',()=>{failed=true;render();});
// start:aigc. AP-02 残留修复：首次会话创建失败（如 429 限流）不得吞错即轮询，
// 须先设最早重试时间并退避，期限前不发起行情/二次创建请求，期限后才 runPoll。
function boot(){
  ensureSession().then(()=>runPoll()).catch((err)=>{
    if(err.blocked)showRestricted(); // B-02 补充：首次打开即被封 → 统一受限提示
    else{
      failed=true;
      if(snapshot)render();
      if(!snapshot){$('connection').textContent='无法连接行情服务，暂无报价。正在重试…';$('connection').className='connection warning';}
    }
    const nextMs=delayFromError(err); // 携带 Retry-After 时优先遵守（封禁为 30 秒），否则按指数退避
    earliestRetryAt=Date.now()+nextMs; // 让到期定时器与 nudge 都遵守该最早时间
    schedulePoll(nextMs);
  });
}
boot();
// end:aigc.

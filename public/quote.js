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
 // start:aigc. 行内轻量标签：stale 且有原因时显示精简词（不置灰、不弹窗），移动端可见
 // F01：补"引用"类（品类间引用暂不支持），与收盘/单边同为文案映射模式
 if(!failed&&r.stale&&r.reason)name.append(el('span',r.reason.includes('收盘')?'收盘':r.reason.includes('单边')?'单边':r.reason.includes('引用')?'引用':'停更','row-tag'));
 // end:aigc.
 if(failed||(r.reason&&r.reason.includes('缺少'))){const note=el('button','缺少数据 ⓘ','row-note');note.setAttribute('aria-label',r.name+'行情状态');note.onclick=()=>{$('detail-title').textContent=r.name;$('detail-text').textContent=(failed?'网络已中断，以下是最后收到的价格。':'该品种暂无可用数据源')+'\n报价更新时间：'+formatTime(r.updatedAt);$('quote-detail').showModal();};name.append(note);}tr.title='报价更新时间：'+formatTime(r.updatedAt);tr.append(name);
 let color='';const midpoint=(Number(r.high)+Number(r.low))/2,main=Number(r.sell??r.buy);if(r.high!=null&&r.low!=null&&(r.sell??r.buy)!=null)color=main>midpoint?'high':main<midpoint?'low':'';
 tr.append(el('td',r.buy??'--',color),el('td',r.sell??'--',color));const range=el('td');range.append(el('div',r.high??'--','high'),el('div',r.low??'--','low'));tr.append(range);fragment.append(tr);}
 $('prices').replaceChildren(fragment);$('empty').hidden=$('prices').children.length>0;
}
function choices(){const frag=document.createDocumentFragment();for(const r of snapshot?.rows||[]){const label=el('label'),input=el('input');input.type='checkbox';input.checked=!hidden.has(r.id);input.addEventListener('change',()=>{input.checked?hidden.delete(r.id):hidden.add(r.id);persist();});label.append(input,el('span',r.name));frag.append(label);}$('choices').replaceChildren(frag);}
$('choose').onclick=()=>{choices();$('selection').showModal();};$('all').onclick=()=>{hidden.clear();persist();choices();};$('none').onclick=()=>{hidden=new Set((snapshot?.rows||[]).map(r=>r.id));persist();choices();};
async function poll(){try{const response=await fetch('/api/quotes',{cache:'no-store',signal:AbortSignal.timeout(6000)});if(!response.ok)throw Error();snapshot=await response.json();failed=false;render();}catch{failed=true;if(snapshot)render();else{$('connection').textContent='无法连接行情服务，暂无报价。正在重试…';$('connection').className='connection warning';}}finally{setTimeout(poll,2000);}}
window.addEventListener('offline',()=>{failed=true;render();});poll();

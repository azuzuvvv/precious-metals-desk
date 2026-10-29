'use strict';
const $=id=>document.getElementById(id);
// start:aigc.
let csrf=null,draft=null,version=null,dirty=false,needsSetup=false,busy=false,catalogDraft=null,catalogVersion=null,catalogSources=[],catalogDirty=false;
// end:aigc.
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function message(text,isError=false){$('message').textContent=text;$('message').className=isError?'error':'';$('message').hidden=false;}
function changed(){dirty=true;$('dirty-state').textContent='有未保存修改';$('dirty-state').className='unsaved';}
async function api(path,data){const response=await fetch('/api/admin/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf||''},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',signal:AbortSignal.timeout(12000)});const result=await response.json();if(!response.ok){if(response.status===401&&path!=='login'){showAuth(false);}throw Object.assign(new Error(result.error||'请求失败'),{status:response.status});}return result;}
function showAuth(setup){needsSetup=setup;csrf=null;$('workspace').hidden=true;$('auth').hidden=false;$('loading').hidden=true;$('logout').hidden=true;$('token-field').hidden=!setup;$('confirm-field').hidden=!setup;$('setup-token').required=setup;$('confirm-password').required=setup;$('password').minLength=setup?12:1;$('password').autocomplete=setup?'new-password':'current-password';$('auth-title').textContent=setup?'设置新盘管理员':'管理员登录';$('auth-help').textContent=setup?'使用本机一次性令牌设置密码。与现有后台账号完全独立。':'请输入新报价盘的管理员密码。';$('auth-submit').textContent=setup?'完成初始化':'登录';}
// start:aigc. 目录页签复用 input() 时通过 dirtyFn 指定置脏回调（默认仍为旧配置的 changed）
function input(labelText,value,onInput,{type='text',cls='',options=null,dirtyFn=changed}={}){const label=el('label',labelText);const field=el(options?'select':'input');if(options){for(const [v,t]of options){const op=el('option',t);op.value=v;field.append(op);}}else field.type=type;field.value=value;field.className=cls;field.setAttribute('aria-label',labelText);field.addEventListener('input',()=>{onInput(field.value);dirtyFn();});label.append(field);return label;}
// end:aigc.
function renderBrand(){const fields=$('brand-fields');fields.replaceChildren();for(const [key,title]of [['name','品牌名称'],['subtitle','副标题'],['notice','滚动公告'],['footer','地址 / 页脚说明'],['phone','联系电话']]){const label=input(title,draft.brand[key],v=>draft.brand[key]=v);if(key==='notice'||key==='footer')label.className='wide';fields.append(label);}$('open-mode').value=draft.openMode;$('open-mode').onchange=()=>{draft.openMode=$('open-mode').value;changed();};$('schedule-fields').replaceChildren();['周日','周一','周二','周三','周四','周五','周六'].forEach((day,i)=>$('schedule-fields').append(input(day,draft.schedule[i],v=>draft.schedule[i]=v)));}
// start:aigc.
// 行情目录页签：加载/渲染三元目录与切换日志，保存走版本化乐观锁。
async function loadCatalog(){const data=await api('catalog');catalogDraft={baseQuotes:data.baseQuotes,sources:data.sources,categories:data.categories};catalogSources=data.sources;catalogVersion=data.version;catalogDirty=false;$('catalog-dirty').textContent='目录已保存';$('catalog-dirty').className='';renderCatalogBase();renderCatalogRows();}
function catalogChanged(){catalogDirty=true;$('catalog-dirty').textContent='目录有未保存修改';$('catalog-dirty').className='unsaved';}
// start:aigc.
// 数据源红绿灯渲染（设计文档"数据源管理"）：状态灯/品种健康数/最近成功/最近错误/密钥入口。
// 数据来自 GET /api/admin/sources（内存实时聚合优先，库值兜底），与目录草稿独立加载
const RUN_STATUS={healthy:['正常','dot dot-green'],partial:['部分正常','dot dot-yellow'],stale:['数据过期','dot dot-yellow'],disconnected:['连接失败','dot dot-red'],idle:['无订阅','dot dot-idle'],disabled:['已停用','dot dot-gray']};
let sourceRows=[],secretTarget=null;
async function loadSources(){const data=await api('sources');sourceRows=data.sources;renderSourceRows();}
function renderSourceRows(){
  const frag=document.createDocumentFragment();
  for(const s of sourceRows){
    const tr=el('tr');
    const [label,cls]=RUN_STATUS[s.runStatus]??RUN_STATUS.idle;
    // F04：密钥列区分"当前实际凭据来源"——后台已配置 / 环境变量兜底 / 未配置
    const credLabel=s.credentialSource==='db'?'后台已配置':s.credentialSource==='env'?'环境变量兜底':(s.hasSecret?'已配置':'未配置');
    const credCls=s.credentialSource||s.hasSecret?'available':'missing';
    tr.append(el('td',label,cls),el('td',s.name),
      el('td',(s.runStatus==='disabled'||s.runStatus==='idle')?'—':`${s.runHealthy}/${s.runTotal}`),
      el('td',s.lastSuccessAt?new Date(s.lastSuccessAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—'),
      el('td',s.lastError||s.note||'—'),
      el('td',credLabel,credCls));
    const tools=el('td');const cfg=el('button',s.hasSecret?'更新密钥':'配置密钥');
    cfg.onclick=()=>openSecretDialog(s);tools.append(cfg);tr.append(tools);frag.append(tr);
  }
  $('source-rows').replaceChildren(frag);
}
// 密钥配置对话框（iTick Token）：密文落库不回显；留空保存=清除；改动重启后生效
function openSecretDialog(s){secretTarget=s;$('secret-title').textContent=`配置 ${s.name} 密钥`;$('secret-input').value='';$('secret-dialog').showModal();$('secret-input').focus();}
$('close-secret').onclick=()=>$('secret-dialog').close();
$('secret-form').onsubmit=event=>{event.preventDefault();if(!secretTarget)return;const value=$('secret-input').value.trim();task($('secret-save'),async()=>{await api('source-secret',{sourceId:secretTarget.id,secret:value});$('secret-dialog').close();await loadSources().catch(()=>{});message(value?'密钥已保存，重启服务后生效。':'密钥已清除，重启服务后生效。');});};
$('secret-clear').onclick=()=>{if(!secretTarget)return;
  // F04：清除只删后台密钥；服务器若配了 ITICK_TOKEN 环境变量，重启后将回落使用——文案必须说清
  if(!confirm(`确认清除 ${secretTarget.name} 的后台密钥？仅清除后台保存的密钥；若服务器还配置了 ITICK_TOKEN 环境变量，重启后将回落使用环境变量。`))return;
  task($('secret-clear'),async()=>{await api('source-secret',{sourceId:secretTarget.id,secret:''});$('secret-dialog').close();await loadSources().catch(()=>{});message('后台密钥已清除，重启服务后生效。');});};
// end:aigc.
// start:aigc. 基础行情编辑支持增删与来源映射增删（R10）
function renderCatalogBase(){const frag=document.createDocumentFragment();for(const b of catalogDraft.baseQuotes){const card=el('article',undefined,'row-card'+(!b.enabled?' disabled':''));const head=el('div',undefined,'row-header');head.append(el('strong',b.symbol),el('span',b.unit||'—','row-id'));const en=el('label',undefined,'inline');const ck=el('input');ck.type='checkbox';ck.checked=b.enabled;ck.setAttribute('aria-label',`${b.symbol} 启用`);ck.onchange=()=>{b.enabled=ck.checked;card.classList.toggle('disabled',!ck.checked);catalogChanged();};en.append(ck,el('span','启用'));const tools=el('div',undefined,'row-tools');const addSrc=el('button','＋ 来源');addSrc.setAttribute('aria-label',`${b.symbol} 新增来源映射`);addSrc.onclick=()=>{b.sources.push({sourceId:'sina',priority:2,kind:'sina',code:'',enabled:true});catalogChanged();renderCatalogBase();};const remove=el('button','删除');remove.setAttribute('aria-label',`${b.symbol} 删除基础行情`);remove.onclick=()=>{if(confirm(`删除基础行情“${b.symbol}”？引用它的品类公式将成为软引用（运行时空值），保存后生效。`)){catalogDraft.baseQuotes=catalogDraft.baseQuotes.filter((x)=>x!==b);catalogChanged();renderCatalogBase();}};tools.append(addSrc,remove);head.append(en,tools);card.append(head);const fields=el('div',undefined,'row-fields');fields.append(input('代码键 symbol',b.symbol,v=>b.symbol=v.trim(),{dirtyFn:catalogChanged}),input('名称',b.name,v=>b.name=v,{dirtyFn:catalogChanged}),input('单位',b.unit,v=>b.unit=v,{dirtyFn:catalogChanged}),input('小数位',b.decimals,v=>b.decimals=Number(v),{options:Array.from({length:7},(_,i)=>[i,String(i)]),dirtyFn:catalogChanged}));for(const s of b.sources){const src=el('div',undefined,'row-fields');src.append(input(`来源ID`,s.sourceId,v=>s.sourceId=v.trim(),{dirtyFn:catalogChanged}),input('优先级',s.priority,v=>s.priority=Number(v),{type:'number',dirtyFn:catalogChanged}),input('类型',s.kind,v=>s.kind=v,{options:[['plain','普通'],['split','拆分买卖'],['sina','新浪'],['yahoo','Yahoo'],['frankfurter','汇率'],],dirtyFn:catalogChanged}),input('代码',s.code??'',v=>s.code=v||null,{dirtyFn:catalogChanged}),input('过期阈值(秒)',s.staleMs?s.staleMs/1000:'',v=>s.staleMs=v===''||Number(v)<=0?null:Number(v)*1000,{type:'number',dirtyFn:catalogChanged}));const se=el('label',undefined,'inline');const sc=el('input');sc.type='checkbox';sc.checked=s.enabled!==false;sc.onchange=()=>{s.enabled=sc.checked;catalogChanged();};se.append(sc,el('span','启用'));const rm=el('button','删除来源');rm.onclick=()=>{b.sources=b.sources.filter((x)=>x!==s);catalogChanged();renderCatalogBase();};src.append(rm,se);card.append(src);}card.append(fields);frag.append(card);}$('catalog-base').replaceChildren(frag);}
// end:aigc.
// start:aigc. 品类编辑支持新增模板、删除与排序（R10）：数组顺序即保存后的 sort
function renderCatalogRows(){const frag=document.createDocumentFragment();for(const [i,c] of catalogDraft.categories.entries()){const card=el('article',undefined,'row-card'+(!c.visible?' disabled':''));const head=el('div',undefined,'row-header');const name=el('input');name.value=c.name;name.className='row-name';name.maxLength=40;name.setAttribute('aria-label',`品类名称 ${c.id}`);name.oninput=()=>{c.name=name.value;catalogChanged();};const vis=el('label',undefined,'inline');const ck=el('input');ck.type='checkbox';ck.checked=c.visible;ck.setAttribute('aria-label',`${c.name} 显示`);ck.onchange=()=>{c.visible=ck.checked;card.classList.toggle('disabled',!ck.checked);catalogChanged();};vis.append(ck,el('span','显示'));const tools=el('div',undefined,'row-tools');for(const [text,delta] of [['上移',-1],['下移',1]]){const button=el('button',text);button.disabled=i+delta<0||i+delta>=catalogDraft.categories.length;button.onclick=()=>{const arr=catalogDraft.categories;[arr[i],arr[i+delta]]=[arr[i+delta],arr[i]];catalogChanged();renderCatalogRows();};tools.append(button);}const remove=el('button','删除');remove.onclick=()=>{if(confirm(`删除品类“${c.name}”？保存后生效。`)){catalogDraft.categories.splice(i,1);catalogChanged();renderCatalogRows();}};tools.append(remove);head.append(name,el('span','#'+c.id,'row-id'),vis,tools);card.append(head);const fields=el('div',undefined,'row-fields');for(const [key,title] of [['buyFormula','回购公式'],['sellFormula','销售公式'],['highFormula','最高公式'],['lowFormula','最低公式']])fields.append(input(title,c[key],v=>c[key]=v,{cls:'formula',dirtyFn:catalogChanged}));fields.append(input('小数位',c.decimals,v=>c.decimals=Number(v),{options:Array.from({length:7},(_,i)=>[i,String(i)]),dirtyFn:catalogChanged}),input('舍入方式',c.rounding,v=>c.rounding=v,{options:[['half-up','四舍五入'],['floor','向下取整'],['ceil','向上取整']],dirtyFn:catalogChanged}));card.append(fields);frag.append(card);}$('catalog-rows').replaceChildren(frag);}
// end:aigc.
async function loadSwitchLogs(){const data=await api('switch-logs');$('switch-log-list').replaceChildren(...data.entries.map(e=>{const d=el('div',undefined,'history-entry');d.append(el('time',new Date(e.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})),el('strong',e.symbol),el('span',`${e.old_source??'无'} → ${e.new_source??'无'}（${e.mode??''}）${e.reason?' · '+e.reason:''}`));return d;}));if(!data.entries.length)$('switch-log-list').append(el('p','尚无来源切换记录。'));}
// end:aigc.
// start:aigc. R02：旧「品种与基差」页签退役，config 仅承载品牌/营业时间（rows 冻结回传不展示）
async function load(){const data=await api('config');draft=data.config;version=data.version;dirty=false;$('dirty-state').textContent='已保存';$('dirty-state').className='';$('version').textContent='配置版本 '+version;$('auth').hidden=true;$('workspace').hidden=false;$('logout').hidden=false;$('loading').hidden=true;renderBrand();
// start:aigc. 业务品类为默认页签，登录后预载目录草稿（加载失败不阻断品牌编辑）
loadCatalog().catch(e=>message(e.message,true));
// end:aigc.
}
// end:aigc.
async function task(button,work){if(busy)return;busy=true;button.disabled=true;try{await work();}catch(e){message(e.message,true);}finally{busy=false;button.disabled=false;}}
$('auth-form').onsubmit=event=>{event.preventDefault();task($('auth-submit'),async()=>{if(needsSetup&&$('password').value!==$('confirm-password').value)throw Error('两次密码输入不一致');const result=await api(needsSetup?'setup':'login',{password:$('password').value,...(needsSetup?{setupToken:$('setup-token').value.trim()}:{})});csrf=result.csrf;$('auth-form').reset();await load();$('message').hidden=true;});};
// start:aigc. 重新加载同样拦截目录未保存修改
// end:aigc.
// start:aigc. reload 后品牌与目录一起重载（reload 自带 confirm 守卫；目录加载失败不阻塞品牌加载）
$('reload').onclick=()=>task($('reload'),async()=>{if((dirty||catalogDirty)&&!confirm('放弃尚未保存的修改，重新加载已保存配置？'))return;await load();await loadCatalog().catch(()=>{});message('已加载最新配置。');});
// end:aigc.
// start:aigc. R02：本保存路径仅剩品牌与营业时间（rows 原样回传冻结）
// start:aigc. 顶部保存升级为全量保存：sticky 工具栏在所有页签可见，用户在品类页签极易误点
// 此按钮以为目录已存——检测到目录有未保存修改时自动一并保存，消除"点了没反应"陷阱
$('save').onclick=()=>task($('save'),async()=>{
// start:aigc. F02：品牌无改动时不发品牌保存——重复点击不得保存未变化的品牌配置
// 制造多余版本与审计记录（Codex F02 第三点）；仅目录脏时直接走目录保存，
// 跳过品牌（响应丢失后用旧版本重试品牌保存会 409，反而阻断目录保存）
if(!dirty){
  if(catalogDirty&&catalogDraft){await saveCatalog();return;}
  message('当前没有需要保存的修改。');return;}
// end:aigc.
const result=await api('config',{config:draft,expectedVersion:version});draft=result.config;version=result.version;// start:aigc. 品牌/目录共用版本号：保存后同步另一表单的已知版本，避免同窗口交替保存误报 409（F04） // end:aigc.
catalogVersion=result.version;dirty=false;$('dirty-state').textContent='已保存';$('dirty-state').className='';$('version').textContent='配置版本 '+version;
if(catalogDirty&&catalogDraft){
// start:aigc. M07/F02：全量保存非原子——目录失败时分段提示（品牌已存）。F02 按错误类型三分流：
// 409=另一窗口已保存目录（版本冲突），回读版本同样前进，若走回读会被误判成"响应丢失已保存"，
// 把 catalogDraft 覆盖成远端内容导致本窗口修改静默丢失——必须先短路，提示刷新重载；
// 400 等=服务端明确拒绝（校验失败），必然未提交，保留脏状态可直接重试；
// 无 status（网络中断/超时）=可能是"已提交但响应丢失"，才回读共享版本号确认——
// 前进即实际已保存，同步本地状态；未前进即服务端未收到，保守按未保存处理
try{await saveCatalog();message('品牌与行情目录已一并保存。基础行情调整需重启服务后生效。');}
catch(e){let note='品牌已保存，行情目录保存失败：'+e.message;
if(e.status===409)note='品牌已保存，行情目录保存失败：版本冲突（配置已被其他窗口修改），本窗口的目录修改未保存，请点「重新加载」获取最新目录后重新修改。';
else if(e.status>=400)note+='（服务端已拒绝，目录仍为未保存状态，可直接重试）';
else{try{const cur=await api('catalog');
if(cur.version>catalogVersion){catalogVersion=cur.version;version=cur.version;catalogDraft={baseQuotes:cur.baseQuotes,sources:cur.sources,categories:cur.categories};catalogSources=cur.sources;catalogDirty=false;$('catalog-dirty').textContent='目录已保存';$('catalog-dirty').className='';$('version').textContent='配置版本 '+version;note='品牌与行情目录实际均已保存（此前失败为网络响应丢失），状态已同步。';}
else note+='（服务端未收到请求，目录仍为未保存状态，可直接重试）';}
catch{/* 回读也失败：网络持续中断，保守按未保存处理 */}}
message(note,true);}
return;}
message('品牌与营业时间已保存。');});
// end:aigc.
// start:aigc. 预览目录草稿：走与公开报价一致的 categories 路径（R02）
$('preview').onclick=()=>task($('preview'),async()=>{if(!catalogDraft){message('目录尚未加载完成，请稍候重试',true);return;}const data=await api('preview',{categories:catalogDraft.categories});$('preview-body').replaceChildren(...data.rows.map(r=>{const tr=el('tr');for(const value of [r.name+(r.visible?'':'（隐藏）'),r.buy??'--',r.sell??'--',`${r.high??'--'} / ${r.low??'--'}`,r.reason||(r.stale?'报价过期':'正常')])tr.append(el('td',value));return tr;}));$('preview-status').textContent=`${new Date(data.serverTime).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · ${data.status.connected?'行情已连接':'行情未连接'} · ${data.status.sourceStatus}`;$('preview-dialog').showModal();});
// end:aigc.
$('close-preview').onclick=()=>$('preview-dialog').close();
async function history(){const data=await api('audit');$('history-list').replaceChildren(...data.entries.map(e=>{const entry=el('div',undefined,'history-entry');entry.append(el('strong','v'+e.version),el('time',new Date(e.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})),el('span',e.summary));return entry;}));if(!data.entries.length)$('history-list').append(el('p','尚无修改记录。'));}
$('refresh-history').onclick=()=>task($('refresh-history'),history);
// start:aigc.
// 刷新前确认：目录有未保存修改时避免静默覆盖；红绿灯与切换日志一并重载
$('refresh-switch-logs').onclick=()=>task($('refresh-switch-logs'),async()=>{if(catalogDirty&&!confirm('行情目录有未保存修改，刷新将丢弃，继续？'))return;await loadCatalog();await Promise.all([loadSources(),loadSwitchLogs()]);});
// start:aigc. F02：目录保存提取为独立函数——顶部保存"仅目录脏"分支直接复用
//（不能调 $('catalog-save').onclick()：task() 的 busy 守卫在外层已置位时会静默吞掉内层执行）
async function saveCatalog(){if(!catalogDraft)return;const result=await api('catalog',{...catalogDraft,expectedVersion:catalogVersion});catalogVersion=result.version;// 同窗口目录保存后同步品牌表单版本（F04）
version=result.version;catalogDirty=false;$('catalog-dirty').textContent='目录已保存';$('catalog-dirty').className='';message('行情目录已保存。基础行情调整需重启服务后生效。');}
// end:aigc.
$('catalog-save').onclick=()=>task($('catalog-save'),saveCatalog);
// start:aigc. 目录拆分（业务品类/基础行情/数据源与日志）：两个目录编辑页签共用整体保存与预览
$('catalog-save-base').onclick=()=>$('catalog-save').onclick();
$('preview-cat').onclick=()=>$('preview').onclick();
// end:aigc.
// start:aigc. 目录新增模板（R10）：品类默认引用黄金透传；基础行情默认带一条 rtj 映射
$('add-category').onclick=()=>{catalogDraft.categories.push({id:'custom-'+Date.now(),name:'新黄金品种',visible:false,buyFormula:'【#黄金#回购价】',sellFormula:'【#黄金#销售价】',highFormula:'',lowFormula:'',decimals:2,rounding:'half-up'});catalogChanged();renderCatalogRows();};
$('add-base-quote').onclick=()=>{catalogDraft.baseQuotes.push({symbol:'new-'+Date.now().toString(36),name:'新基础行情',unit:'',decimals:2,enabled:false,sources:[{sourceId:'rtj',priority:1,kind:'plain',code:'',enabled:true}]});catalogChanged();renderCatalogBase();};
// end:aigc.
// end:aigc.
// start:aigc.
// 目录拆分后：三个目录相关页签（业务品类/基础行情/数据源与日志）。
// 编辑发生在前两个；切出编辑页签且有未保存修改时先确认，防止覆盖丢失。
const CATALOG_EDIT_TABS=['categories','basequotes'];
const catalogTab=()=>document.querySelector('[data-tab][aria-selected=true]')?.dataset.tab;
// end:aigc.
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{
// start:aigc.
// 目录有未保存修改时，从编辑页签切走先确认，防止 loadCatalog 覆盖丢失编辑
if(catalogDirty&&CATALOG_EDIT_TABS.includes(catalogTab())&&!CATALOG_EDIT_TABS.includes(button.dataset.tab)&&!confirm('行情目录有未保存修改，切换页签将丢失，继续？'))return;
// end:aigc.
document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));document.querySelectorAll('.tab-panel').forEach(p=>p.hidden=p.id!==button.dataset.tab);if(button.dataset.tab==='history')history().catch(e=>message(e.message,true));
// start:aigc.
// 业务品类/基础行情页签进入时加载目录草稿（未修改时刷新）；数据源页签额外拉红绿灯与切换日志
if(button.dataset.tab==='categories'||button.dataset.tab==='basequotes'){if(!catalogDirty)loadCatalog().catch(e=>message(e.message,true));}
if(button.dataset.tab==='sourcelog'){if(!catalogDirty)loadCatalog().catch(e=>message(e.message,true));loadSources().catch(e=>message(e.message,true));loadSwitchLogs().catch(e=>message(e.message,true));}
// start:aigc. 访问管理（§3）：进入页签启动 10s 自动刷新，切出/隐藏暂停
if(button.dataset.tab==='access')startAccessTimer();else stopAccessTimer();
// end:aigc.
});
// start:aigc.
// 退出登录同样拦截目录未保存修改
// end:aigc.
$('logout').onclick=()=>task($('logout'),async()=>{if((dirty||catalogDirty)&&!confirm('存在未保存修改，仍要退出？'))return;await api('logout',{});dirty=false;catalogDirty=false;draft=null;showAuth(false);message('已退出。');});
$('password-form').onsubmit=event=>{event.preventDefault();task($('password-form').querySelector('button'),async()=>{if($('new-password').value!==$('new-password-confirm').value)throw Error('两次新密码输入不一致');await api('password',{oldPassword:$('old-password').value,newPassword:$('new-password').value});$('password-form').reset();dirty=false;showAuth(false);message('密码已更新，请重新登录。');});};
// start:aigc. 目录页签未保存同样拦截
window.addEventListener('beforeunload',event=>{if(dirty||catalogDirty){event.preventDefault();event.returnValue='';}});
// end:aigc.
// start:aigc.
// 访问管理（方案 §3，第二批只读）：10 秒自动刷新、隐藏或切出页签暂停；管理查询本身不计入访客行情统计。
// 顶部健康状态显式标注统计缺口/降级/汇总延迟（§3 不以零请求伪装正常）；灯色仅绿/黄（红=手动封禁第三批）。
let accessTimer=null,accessPage=1,accessLast=null,blocksPage=1,blocksLast=null;
const ACCESS_PAGE_SIZE=20;
function stopAccessTimer(){if(accessTimer){clearInterval(accessTimer);accessTimer=null;}}
function startAccessTimer(){stopAccessTimer();loadAccess();accessTimer=setInterval(loadAccess,10000);}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAccessTimer();else if(catalogTab()==='access')startAccessTimer();});
async function loadAccess(){
  if(catalogTab()!=='access')return;
  try{
    const q=new URLSearchParams({page:accessPage,size:ACCESS_PAGE_SIZE,sort:$('access-sort').value});
    const f=$('access-ip-filter').value.trim();if(f)q.set('ip',f);
    // 访问统计与有效封禁两条独立分页（B-05a/b）：互不挤占、互不插零
    const [stats,blocks]=await Promise.all([api('access/ips?'+q.toString()),api(`access/blocks?page=${blocksPage}&size=${ACCESS_PAGE_SIZE}`)]);
    accessLast=stats;blocksLast=blocks;
    renderAccess();renderBlocks();
  }catch(e){message(e.message,true);stopAccessTimer();}
}
const fmtMinuteUtc=(utc)=>utc?new Date(utc*60000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
const fmtMs=(ms)=>ms?new Date(ms).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
function renderAccess(){
  const d=accessLast;if(!d)return;
  const s=d.summary||{};
  const warn=[];
  if(s.redisDegraded)warn.push('访问保护降级中（统计可能缺失）');
  if((s.lossMinutes||[]).length)warn.push('统计缺口分钟：'+s.lossMinutes.map(fmtMinuteUtc).join('、'));
  if(s.flush&&s.flush.lastError)warn.push('汇总延迟：'+s.flush.lastError);
  $('access-summary').replaceChildren(
    el('span',`保护模式：${d.mode}`),
    el('span',`最近完整1分钟请求：${s.lastComplete&&s.lastComplete.fields?s.lastComplete.fields.req:'—'}`),
    el('span',`当前分钟请求（实时）：${s.cur?s.cur.req:'—'}`),
    el('span',`新建会话（1分钟）：${s.lastComplete&&s.lastComplete.fields?s.lastComplete.fields.issue:'—'}`),
    el('span',`统计截至：${s.statsLastOkAt?fmtMs(s.statsLastOkAt):'尚无成功写入'}`),
    ...(warn.length?[el('b','⚠ '+warn.join('；'))]:[]),
    ...(d.truncated?[el('b','明细已截断：按请求数排序时最多聚合最近 500 个 IP')]:[]),
  );
  const rows=d.rows.map(r=>{
    const tr=el('tr');
    // S2-01 修复：原生 Element.append 返回 undefined，不能链式回传外层；
    // 先建 td/tr、子级 append 完成后再交给外层，否则状态灯丢失且出现"undefined"文本
    const statusText=r.status==='red'?'红':r.status==='yellow'?'黄':'绿';
    const statusCls=r.status==='red'?'red':r.status==='yellow'?'yellow':'green';
    const tdDot=el('td');tdDot.append(el('span',statusText,'dot dot-'+statusCls));
    const pct=r.m10.req?Math.round(r.m10.noSess*100/r.m10.req)+'%':'—';
    // 第三批（§5）：封禁/解封操作按钮；被封禁到期时间并入原因列
    const tdOp=el('td');
    const btn=r.blocked?el('button','解封'):el('button','封禁');
    btn.onclick=()=>r.blocked?openUnblock(r):openBlock(r);
    tdOp.append(btn);
    const reasonText=(r.reasons||[]).join('；')+(r.blockedUntilMs?`（至 ${new Date(r.blockedUntilMs).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}）`:'');
    tr.append(tdDot,
      el('td',r.ip),
      el('td',fmtMs(r.lastSeen)),
      el('td',String(r.m1?r.m1.req:0)),
      el('td',String(r.m10?r.m10.req:0)),
      el('td',pct),
      el('td',r.sessionsTruncated?r.sessions10m+'+（已截断）':String(r.sessions10m||0)),
      el('td',reasonText),
      tdOp);
    return tr;
  });
  // S2-01：空态行同样先建 tr 再挂 td，避免 replaceChildren(undefined)
  if(rows.length)$('access-rows').replaceChildren(...rows);
  else{const empty=el('td','最近 24 小时暂无访问记录（或该 IP 不在最近访问索引中）。');empty.colSpan=9;const emptyTr=el('tr');emptyTr.append(empty);$('access-rows').replaceChildren(emptyTr);}
  const pages=Math.max(1,Math.ceil(d.total/ACCESS_PAGE_SIZE));
  $('access-page-info').textContent=`第 ${d.page}/${pages} 页 · 共 ${d.total} 个 IP（最近 24 小时）`;
}
$('access-refresh').onclick=()=>{accessPage=1;blocksPage=1;loadAccess();};
$('access-prev').onclick=()=>{if(accessPage>1){accessPage--;loadAccess();}};
$('access-next').onclick=()=>{const pages=Math.max(1,Math.ceil((accessLast?accessLast.total:0)/ACCESS_PAGE_SIZE));if(accessPage<pages){accessPage++;loadAccess();}};
$('access-ip-filter').onchange=()=>{accessPage=1;loadAccess();};
$('access-sort').onchange=()=>{accessPage=1;loadAccess();};
// start:aigc. 有效封禁独立分页（B-05a/b）：渲染 + 翻页；行内解封复用统一对话框
const fmtFull=(ms)=>ms?new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
function renderBlocks(){
  const d=blocksLast;if(!d)return;
  const rows=d.rows.map((r)=>{
    const tr=el('tr');
    const tdOp=el('td');
    const btn=el('button','解封');
    btn.onclick=()=>openUnblock({ip:r.ip,blockedUntilMs:r.blockedUntilMs,blockedRowVersion:r.blockedRowVersion});
    tdOp.append(btn);
    tr.append(el('td',r.ip),el('td',fmtFull(r.blockedUntilMs)),el('td',r.lastSeen?fmtMs(r.lastSeen):'（近 24 小时无访问）'),el('td',r.blockedReason),tdOp);
    return tr;
  });
  if(rows.length)$('blocks-rows').replaceChildren(...rows);
  else{const td=el('td','当前没有有效封禁。');td.colSpan=5;const tr=el('tr');tr.append(td);$('blocks-rows').replaceChildren(tr);}
  const pages=Math.max(1,Math.ceil(d.total/ACCESS_PAGE_SIZE));
  $('blocks-page-info').textContent=d.total?`第 ${d.page}/${pages} 页 · 共 ${d.total} 条`:'';
}
$('blocks-prev').onclick=()=>{if(blocksPage>1){blocksPage--;loadAccess();}};
$('blocks-next').onclick=()=>{const pages=Math.max(1,Math.ceil((blocksLast?blocksLast.total:0)/ACCESS_PAGE_SIZE));if(blocksPage<pages){blocksPage++;loadAccess();}};
// end:aigc.
// start:aigc.
// 手动封禁/解封（§5，第三批）：必填原因 + 二次确认（明示同一 IP 可能有多个设备、observe 同样生效）；
// 解封必须带行版本（expectedVersion），冲突 409 时提示刷新。行版本在列表 rows 的 blockedRowVersion。
let blockTarget=null,unblockTarget=null;
function openBlock(row){
  blockTarget=row;
  $('block-title').textContent='封禁 '+row.ip;
  $('block-hint').textContent='保存后立即禁止该 IP 看盘（当前为'+({observe:'观测',enforce:'强制',off:'关闭'}[accessLast?.mode]||'当前')+'模式也同样生效）。同一 IP 可能有多个家庭/店铺共用设备，请确认影响。';
  $('block-form').reset();$('block-custom-field').hidden=true;
  $('block-dialog').showModal();
}
function openUnblock(row){
  unblockTarget=row;
  $('unblock-hint').textContent='解除 '+row.ip+' 的封禁（至 '+new Date(row.blockedUntilMs).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'）。解封后该 IP 约 30 秒内自动恢复看盘，无需重启。';
  $('unblock-form').reset();
  $('unblock-dialog').showModal();
}
$('block-minutes').onchange=()=>{$('block-custom-field').hidden=$('block-minutes').value!=='custom';};
$('close-block').onclick=()=>$('block-dialog').close();
$('close-unblock').onclick=()=>$('unblock-dialog').close();
$('block-save').onclick=()=>{ if($('block-form').reportValidity()===false)return;
  const minutes=$('block-minutes').value==='custom'?Number($('block-custom').value):Number($('block-minutes').value);
  if(!Number.isInteger(minutes)||minutes<1||minutes>10080){message('时长必须为 1 分钟至 7 天',true);return;}
  if(!confirm(`确认封禁 ${blockTarget.ip}？保存后立即禁止该 IP 看盘。`))return;
  task($('block-save'),async()=>{
    await api('access/block',{ip:blockTarget.ip,minutes,reason:$('block-reason').value.trim()});
    $('block-dialog').close();message('已封禁 '+blockTarget.ip+'（立即生效）');
    await loadAccess();
  });
};
$('unblock-save').onclick=()=>{ if($('unblock-form').reportValidity()===false)return;
  if(!confirm(`确认解除 ${unblockTarget.ip} 的封禁？`))return;
  task($('unblock-save'),async()=>{
    await api('access/unblock',{ip:unblockTarget.ip,reason:$('unblock-reason').value.trim(),expectedVersion:unblockTarget.blockedRowVersion});
    $('unblock-dialog').close();message('已解封 '+unblockTarget.ip);
    await loadAccess();
  });
};
// end:aigc.
(async()=>{try{const session=await api('session');if(session.authenticated){csrf=session.csrf;await load();}else showAuth(session.needsSetup);}catch(e){$('loading').textContent='后台加载失败，可刷新重试。';message(e.message,true);}})();

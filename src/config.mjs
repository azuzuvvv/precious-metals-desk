import {calculate,references,compile} from './formula.mjs';
import {CATALOG,FIELD_LABELS} from './catalog.mjs';

const FORMULAS=['buyFormula','sellFormula','highFormula','lowFormula'];
export const allowedReferences=()=>new Set(CATALOG.flatMap(r=>Object.values(FIELD_LABELS).map(f=>`【#${r.name}#${f}】`)));
export function validateConfig(input){
  if(!input||typeof input!=='object'||!input.brand||!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>100)throw new Error('配置格式无效');
  const c=structuredClone(input), brand={};
  for(const key of ['name','subtitle','notice','footer','phone']){const v=c.brand[key];if(typeof v!=='string'||v.length>1000)throw new Error('品牌信息无效');brand[key]=v;}
  if(c.brand.logo!=='/assets/logo.png')throw new Error('Logo路径无效');brand.logo=c.brand.logo;
  if(!['open','closed','schedule'].includes(c.openMode))throw new Error('营业模式无效');
  if(!Array.isArray(c.schedule)||c.schedule.length!==7)throw new Error('需要完整七天营业时间');
  for(const day of c.schedule){
    if(typeof day!=='string'||day.length>250)throw new Error('营业时间无效');
    if(!day)continue;
    for(const period of day.split(',')){
      const parts=period.match(/^([01]\d|2[0-3]):([0-5]\d)~([01]\d|2[0-4]):([0-5]\d)$/);
      if(!parts||(+parts[3]===24&&+parts[4]!==0)||(+parts[1]*60+ +parts[2])>=(+parts[3]*60+ +parts[4]))throw new Error('时段应为09:00~12:00，跨天请分开填写');
    }
  }
  const seen=new Set(),known=allowedReferences();
  const rows=c.rows.map(row=>{
    if(!row||typeof row.id!=='string'||!/^[\w-]{1,40}$/.test(row.id)||seen.has(row.id))throw new Error('品种编号无效或重复');seen.add(row.id);
    if(typeof row.name!=='string'||!row.name.trim()||row.name.length>40||typeof row.visible!=='boolean')throw new Error('品种名称或显示设置无效');
    if(!Number.isInteger(row.decimals)||row.decimals<0||row.decimals>6||!['half-up','floor','ceil'].includes(row.rounding))throw new Error('价格精度无效');
    const out={id:row.id,name:row.name,visible:row.visible,decimals:row.decimals,rounding:row.rounding};
    for(const key of FORMULAS){
      if(typeof row[key]!=='string'||row[key].length>500)throw new Error(`${row.name}公式无效`);
      out[key]=row[key].trim();if(!out[key])continue;
      const refs=references(out[key]);if(refs.some(r=>!known.has(r)))throw new Error(`${row.name}引用未知行情`);
      compile(out[key]);
    }
    return out;
  });
  return {version:Number.isInteger(c.version)?c.version:1,brand,openMode:c.openMode,schedule:[...c.schedule],rows};
}

export function isShopOpen(config,date=new Date()){
  if(config.openMode!=='schedule')return config.openMode==='open';
  const local=new Date(date.getTime()+8*3600000),minutes=local.getUTCHours()*60+local.getUTCMinutes();
  return (config.schedule[local.getUTCDay()]||'').split(',').filter(Boolean).some(period=>{const [start,end]=period.split('~').map(t=>{const [h,m]=t.split(':').map(Number);return h*60+m;});return minutes>=start&&minutes<end;});
}

// start:aigc.
// snapshot 改为从聚合层 quotes 读取价格与来源元数据：每行输出 source/sourceName/sourceMode/derived/inputs。
// 品类优先读 config.categories（SQLite 目录），回落 config.rows（旧配置，供后台预览接口）。
// freshness 取所有引用输入（价格时间与来源元数据时间）中最旧时间；status 从 quotes.meta 派生，
// 保留 connected/sourceStatus/lastMessageAt 字段与前台兼容。
export function snapshot(config,quotes,{all=false,now=Date.now(),staleMs=60000}={}){
  const values=Object.fromEntries([...quotes.prices].map(([k,v])=>[k,v.value]));
  const categories=config.categories??config.rows??[];
  // start:aigc. M06：品类引用品类（引用名是品类、非基础 symbol）与软引用在运行时同构——
  // 品类计算结果不进 values，公式字段静默为空。硬拒绝会误伤既有软引用场景
  // （铑金引用公斤条 + 用户登记公斤条品类），改为快照层提示：不阻塞保存，但明确告知取值为空
  const categoryNames=new Set(categories.map((c)=>c?.name).filter(Boolean));
  // end:aigc.
  const rows=categories.filter(r=>all||r.visible).map(row=>{
    const out={id:row.id,name:row.name,visible:row.visible,updatedAt:null,stale:false,source:null,sourceName:null,sourceMode:null,derived:false,inputs:[],reason:null};
    const usedTimes=[],inputMeta=[];let sourceDown=false,catRef=null;
    for(const field of ['buy','sell','high','low']){
      const expr=row[`${field}Formula`];out[field]=null;if(!expr)continue;
      for(const ref of references(expr)){
        const sym=ref.slice(2,ref.lastIndexOf('#'));
        // 引用目标是品类名而非基础行情（meta 无此键）：值不可得，行级提示（M06）
        if(categoryNames.has(sym)&&!quotes.meta.has(sym))catRef=sym;
        const m=quotes.meta.get(sym);
        if(m&&m.updatedAt)usedTimes.push(Date.parse(m.updatedAt));
        if(m)inputMeta.push({name:sym,source:m.sourceName,time:m.updatedAt});
        // 输入源处于 last-known/无源或非健康状态时，行级必须标记过期（R09）
        if(m&&((m.mode!=='primary'&&m.mode!=='failover')||(m.status&&m.status!=='healthy')))sourceDown=true;
        const item=quotes.prices.get(ref);if(item)usedTimes.push(item.time);
      }
      // start:aigc. 所有字段求值失败都仅显示 --，不标整行过期（源站原生单行情品种如 Pt99.95）
      try{out[field]=calculate(expr,values,row.decimals,row.rounding);}catch(e){}
      // end:aigc.
    }
    const referenced=[...new Set(FORMULAS.map((k)=>row[k]).filter(Boolean).flatMap((e)=>references(e)).map((r)=>r.slice(2,r.lastIndexOf('#'))))];
    out.derived=referenced.length>0&&referenced.some((s)=>s!==row.name);
    if(referenced.length){
      const metas=referenced.map((s)=>quotes.meta.get(s)).filter(Boolean);
      if(metas.length){out.source=metas[0].sourceId;out.sourceName=metas[0].sourceName;out.sourceMode=metas[0].mode;}
      out.inputs=[...new Map(inputMeta.map((m)=>[m.name,m])).values()];
    }else{const m=quotes.meta.get(row.name);if(m){out.source=m.sourceId;out.sourceName=m.sourceName;out.sourceMode=m.mode;}}
    if(usedTimes.length){const oldest=Math.min(...usedTimes);out.updatedAt=new Date(oldest).toISOString();if(now-oldest>staleMs)out.stale=true;}
    // start:aigc. 单字段缺失已静默处理，行级 stale 只由 usedTimes 超时或 sourceDown 决定
    if(sourceDown){
      // start:aigc. 文案细分：last-known 时若引用源上报"闭盘"（如上金所周五收盘停推），
      // 显示收盘语义；否则用中性的"停更"（可能是收盘/停推/断线，数据侧无法总是区分）
      const srcIds=[...new Set(referenced.map((s)=>quotes.meta.get(s)?.sourceId).filter(Boolean))];
      const closed=srcIds.length>0&&srcIds.every((id)=>(quotes.adapterStatus.get(id)??'').includes('闭盘'));
      // M01：任一引用源为 partial（单边降级）且未闭盘时，提示单边缺失——
      // 半截报价必须让员工可辨识，不得与健康完整组视觉无差别
      const partialMode=referenced.some((s)=>quotes.meta.get(s)?.mode==='partial');
      out.stale=true;
      out.reason=closed?'已收盘，显示收盘价':partialMode?'部分行情缺失，仅单边报价':'行情已停更，显示最后有效报价';
    }
    // end:aigc.
      // start:aigc. M06：品类间引用取值为空——源状态正常时也要明确提示（否则手写
      // B=A 链式公式会静默全 --），但不阻塞保存（软引用是已确认的业务要求）
      else if(catRef){out.stale=true;out.reason=`公式引用了品类「${catRef}」，品类间引用暂不支持，相应字段为空`;}
      else if(out.stale)out.reason='源报价超过60秒未更新，请核实';
    return out;
  });
  const metas=[...quotes.meta.values()];
  const connected=metas.some((m)=>m.status==='healthy');
  const lastAt=metas.length?Math.max(...metas.map((m)=>Date.parse(m.updatedAt))):null;
  return {serverTime:new Date(now).toISOString(),configVersion:config.version,brand:config.brand,schedule:config.schedule,status:{connected,sourceStatus:connected?'已连接':(metas.length?'行情中断':'等待行情'),lastMessageAt:lastAt?new Date(lastAt).toISOString():null,shopOpen:isShopOpen(config,new Date(now))},rows};
}
// end:aigc.

// start:aigc.
// 三元目录校验：品类公式可引用已登记基础行情 symbol、其它业务品类名，或软引用（未知键，运行时空值）。
// 软引用允许是业务要求——铑金公式引用未登记的公斤条，需与线上行为等价（销售价为空）。
// detectCycles 只对「品类→品类」画边；引用目标是基础 symbol 时不画边（基础 symbol 优先于同名品类），
// 避免直连透传品类（如品类「黄金」引用【#黄金#回购价】）被误判自环。
export function detectCycles(categories, baseSymbols = new Set()) {
  const byName = new Map(categories.map((c) => [c.name, c]));
  const edges = new Map(categories.map((c) => [c.name, []]));
  for (const c of categories) {
    for (const key of FORMULAS) {
      const expr = (c[key] ?? '').trim(); if (!expr) continue;  // 空公式跳过：references('') 会因 tokens 非空校验抛错
      for (const ref of references(expr)) {
        const target = ref.slice(2, ref.lastIndexOf('#'));
        // 目标是基础 symbol 时不画边：解析为基础行情而非品类
        if (byName.has(target) && !baseSymbols.has(target)) edges.get(c.name).push(target);
      }
    }
  }
  const visiting = new Set(), done = new Set();
  const visit = (node, path) => {
    if (done.has(node)) return;
    if (visiting.has(node)) throw new Error(`循环引用：${[...path, node].join('->')}`);
    visiting.add(node);
    for (const next of edges.get(node) ?? []) visit(next, [...path, node]);
    visiting.delete(node); done.add(node);
  };
  for (const name of edges.keys()) visit(name, []);
}

export function validateCatalog({ sources = [], baseQuotes = [], categories = [] }) {
  if (!Array.isArray(baseQuotes)) throw new Error('基础行情格式无效');
  if (!Array.isArray(categories)) throw new Error('业务品类格式无效');
  // start:aigc. T08：三重唯一性/外键校验——拼写错误的来源、重复 symbol、重复来源映射
  // 必须在保存前以可读错误拒绝，否则静默收不到数据或撞主键以 500 暴露
  const sourceIds = new Set(sources.map((s) => s?.id));
  const seenSymbols = new Set();
  for (const b of baseQuotes) {
    if (!b || typeof b.symbol !== 'string' || !b.symbol.trim()) throw new Error('基础行情键无效');
    if (seenSymbols.has(b.symbol)) throw new Error(`基础行情 ${b.symbol} 重复`); seenSymbols.add(b.symbol);
    // end:aigc.
    // 与品类对称的结构校验，防止未知 symbol/非法精度透传到 UPDATE 静默丢失
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 40) throw new Error('基础行情名称无效');
    if (!Number.isInteger(b.decimals) || b.decimals < 0 || b.decimals > 6) throw new Error('基础行情精度无效');
    if (b.sources !== undefined && !Array.isArray(b.sources)) throw new Error('基础行情来源格式无效');
    // start:aigc. T08：来源外键 + 单基础行情内 sourceId 唯一
    const seenSourceIds = new Set();
    for (const s of (b.sources || [])) {
      if (!s || typeof s.sourceId !== 'string' || !s.sourceId.trim()) throw new Error('行情来源标识无效');
      if (!sourceIds.has(s.sourceId)) throw new Error(`${b.name} 的来源 ${s.sourceId} 未在数据源中登记`);
      if (seenSourceIds.has(s.sourceId)) throw new Error(`${b.name} 的来源 ${s.sourceId} 重复`);
      seenSourceIds.add(s.sourceId);
      if (!Number.isInteger(s.priority)) throw new Error('行情来源优先级无效');
    }
    // end:aigc.
  }
  const seenIds = new Set(), seenNames = new Set();
  const symbols = new Set(baseQuotes.map((b) => b.symbol));
  for (const c of categories) {
    if (!c || typeof c.id !== 'string' || !/^[\w-]{1,40}$/.test(c.id) || seenIds.has(c.id)) throw new Error('品类编号无效或重复');
    seenIds.add(c.id);
    // name 是引用解析键，重复会导致环检测与运行时解析歧义
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 40 || seenNames.has(c.name)) throw new Error('品类名称无效或重复');
    seenNames.add(c.name);
    if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 6) throw new Error('品类精度无效');
    if (!['half-up', 'floor', 'ceil'].includes(c.rounding)) throw new Error('品类舍入方式无效');
    for (const key of FORMULAS) {
      if (typeof c[key] !== 'string' || c[key].length > 500) throw new Error(`${c.name}公式无效`);
      const expr = c[key].trim(); if (!expr) continue;
      compile(expr);   // 语法与静态除零校验；未知引用为软引用，不在此报错
    }
  }
  detectCycles(categories, symbols);
  return { sources, baseQuotes, categories };
}
// end:aigc.

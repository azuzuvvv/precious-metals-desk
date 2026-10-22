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

export function snapshot(config,feed,{all=false,now=Date.now(),staleMs=60000}={}){
  const values=Object.fromEntries([...feed.prices].map(([k,v])=>[k,v.value]));
  const rows=config.rows.filter(r=>all||r.visible).map(row=>{
    const out={id:row.id,name:row.name,visible:row.visible,updatedAt:null,stale:!feed.connected,reason:null};
    const usedTimes=[],issues=[];
    for(const field of ['buy','sell','high','low']){
      const expr=row[`${field}Formula`];out[field]=null;if(!expr)continue;
      const refs=references(expr);
      for(const ref of refs){const item=feed.prices.get(ref);if(item)usedTimes.push(item.time);}
      try{out[field]=calculate(expr,values,row.decimals,row.rounding);}catch(e){issues.push(e.message);}
    }
    // Freshness follows all referenced inputs, not a heartbeat or the web clock.
    if(usedTimes.length){const oldest=Math.min(...usedTimes);out.updatedAt=new Date(oldest).toISOString();if(now-oldest>staleMs)out.stale=true;}
    else if(FORMULAS.some(f=>row[f]&&references(row[f]).length))out.stale=true;
    if(issues.length){out.reason=[...new Set(issues)].join('；');out.stale=true;}
    else if(!feed.connected)out.reason='行情连接中断，显示最后有效报价';
    else if(out.stale)out.reason='源报价超过60秒未更新，请核实';
    return out;
  });
  return {serverTime:new Date(now).toISOString(),configVersion:config.version,brand:config.brand,schedule:config.schedule,status:{connected:feed.connected,lastMessageAt:feed.lastMessageAt||null,sourceStatus:feed.sourceStatus||'等待行情',shopOpen:isShopOpen(config,new Date(now))},rows};
}

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
  for (const b of baseQuotes) {
    if (!b || typeof b.symbol !== 'string' || !b.symbol.trim()) throw new Error('基础行情键无效');
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

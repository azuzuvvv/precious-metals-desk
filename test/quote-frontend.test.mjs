// start:aigc.
// 前端轮询流程测试（AP-01 回归，codex 审查要求"真正执行多轮请求"）：
// 用 node:vm 在 mock 浏览器环境执行 public/quote.js，断言会话初始化 + 至少三轮行情轮询都发生，
// 证明 runPoll 的 polling 标记被正确释放、页面不会在首轮后冻结。不依赖真实 DOM/网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const code=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../public/quote.js'),'utf8');

test('AP-01 回归：会话初始化后至少三轮行情轮询都执行，不冻结',async()=>{
  const elements=new Map();
  const makeEl=()=>({textContent:'',className:'',src:'',alt:'',hidden:false,title:'',type:'',checked:false,children:[],onclick:null,append(...a){this.children.push(...a);},replaceChildren(...a){this.children=a;},addEventListener(){},setAttribute(){},showModal(){}});
  const getEl=(id)=>{if(!elements.has(id))elements.set(id,makeEl());return elements.get(id);};

  let fetchCount=0;
  const mockSnapshot={brand:{name:'测试',logo:'/assets/logo.png',subtitle:'',notice:'',footer:'',phone:''},serverTime:new Date().toISOString(),status:{shopOpen:true},rows:[]};
  const fetchMock=async(url)=>{
    fetchCount++;
    if(String(url).includes('/api/viewer/session'))return {ok:true,status:200};
    return {ok:true,status:200,json:async()=>mockSnapshot,headers:{get:()=>null}};
  };

  // 假定时器：手动推进，验证每一轮 schedulePoll 都重新安排了下一轮
  let timers=[];let timerId=0;
  const setTimeoutMock=(fn)=>{timers.push(fn);return ++timerId;};
  const clearTimeoutMock=()=>{};

  const context=vm.createContext({
    document:{title:'',hidden:false,getElementById:getEl,createElement:()=>makeEl(),createDocumentFragment:()=>makeEl(),addEventListener(){}},
    window:{addEventListener(){}},
    localStorage:{getItem:()=>null,setItem(){}},
    navigator:{onLine:true},
    fetch:fetchMock,setTimeout:setTimeoutMock,clearTimeout:clearTimeoutMock,
    AbortSignal:{timeout:()=>({signal:undefined})},
    console,
  });
  vm.runInContext(code,context);

  const flush=()=>new Promise((r)=>setTimeout(r,20)); // 真实 setTimeout 冲刷微任务
  await flush();
  assert.ok(fetchCount>=2,`初始化+首轮至少 2 次 fetch，实际 ${fetchCount}`);

  // 手动推进两轮：每轮触发定时器里登记的 runPoll，然后冲刷微任务
  const runNext=async()=>{
    const pending=timers.splice(0); // 取出并清空本轮已登记的回调
    for(const fn of pending)await fn();
    await flush();
  };
  await runNext();
  assert.ok(fetchCount>=3,`第二轮行情轮询应执行，fetch 总数 ${fetchCount}`);
  await runNext();
  assert.ok(fetchCount>=4,`第三轮行情轮询应执行，fetch 总数 ${fetchCount}（AP-01 修复后不冻结）`);
});

test('AP-02 残留回归：首次会话创建即 429，期限前不发行情/二次创建，期限后恢复',async()=>{
  const elements=new Map();
  const makeEl=()=>({textContent:'',className:'',src:'',alt:'',hidden:false,title:'',type:'',checked:false,children:[],onclick:null,append(...a){this.children.push(...a);},replaceChildren(...a){this.children=a;},addEventListener(){},setAttribute(){},showModal(){}});
  const getEl=(id)=>{if(!elements.has(id))elements.set(id,makeEl());return elements.get(id);};

  const calls=[];let sessionPosts=0,quoteGets=0;
  const mockSnapshot={brand:{name:'测试',logo:'/assets/logo.png',subtitle:'',notice:'',footer:'',phone:''},serverTime:new Date().toISOString(),status:{shopOpen:true},rows:[]};
  const fetchMock=async(url)=>{
    calls.push(String(url));
    // 会话发放：首次被限流 429 + Retry-After 60 秒，重建后成功
    if(String(url).includes('/api/viewer/session')){
      sessionPosts++;
      if(sessionPosts===1)return {ok:false,status:429,headers:{get:(h)=>h.toLowerCase()==='retry-after'?'60':null}};
      return {ok:true,status:200,headers:{get:()=>null}};
    }
    // 行情：未取得会话返回 401，重建会话后第二次成功
    quoteGets++;
    if(quoteGets===1)return {ok:false,status:401,headers:{get:()=>null}};
    return {ok:true,status:200,json:async()=>mockSnapshot,headers:{get:()=>null}};
  };

  let timers=[];let timerId=0;
  const setTimeoutMock=(fn,ms)=>{timers.push({fn,ms});return ++timerId;};
  const clearTimeoutMock=()=>{};

  const context=vm.createContext({
    document:{title:'',hidden:false,getElementById:getEl,createElement:()=>makeEl(),createDocumentFragment:()=>makeEl(),addEventListener(){}},
    window:{addEventListener(){}},
    localStorage:{getItem:()=>null,setItem(){}},
    navigator:{onLine:true},
    fetch:fetchMock,setTimeout:setTimeoutMock,clearTimeout:clearTimeoutMock,
    AbortSignal:{timeout:()=>({signal:undefined})},
    console,
  });
  vm.runInContext(code,context);
  const flush=()=>new Promise((r)=>setTimeout(r,20)); // 真实 setTimeout 冲刷微任务
  await flush();

  // 期限前：仅首次会话创建，不发起行情、不二次创建，登记一个 >=60s 的到期定时器
  assert.equal(calls.filter(u=>u.includes('/api/viewer/session')).length,1,'期限前仅首次会话创建');
  assert.equal(calls.filter(u=>u.includes('/api/quotes')).length,0,'期限前不发起行情请求');
  assert.equal(timers.length,1,'退避后登记一个到期定时器');
  assert.ok(timers[0].ms>=60000,`退避应至少 60 秒，实际 ${timers[0].ms}ms`);

  // 期限后：触发到期回调（runPoll），发起行情请求、遇 401 重建会话并恢复
  const due=timers.splice(0);
  for(const t of due)await t.fn();
  await flush();
  assert.ok(calls.filter(u=>u.includes('/api/quotes')).length>=1,'期限后发起了行情请求');
  assert.equal(calls.filter(u=>u.includes('/api/viewer/session')).length,2,'期限后按 401 重建了会话');
});
// start:aigc.
// 2026-10-29 P1 回归：一行注释曾吞掉 tr.append(name)，导致商品名列整列消失、每行只剩三列，
// 且"缺少数据"按钮挂在商品名单元格里也随之不可见。
// 本测试直接执行 render：断言每行四列、首列是商品名；固定报价行不得出现按钮，
// 真正无数据的行必须出现"缺少数据"按钮（P2 同步回归）。
test('P1/P2 回归：每行四列、商品名在首列、固定报价不显示缺少数据按钮',async()=>{
  const elements=new Map();
  const makeEl=()=>({textContent:'',className:'',src:'',alt:'',hidden:false,title:'',type:'',checked:false,children:[],onclick:null,append(...a){this.children.push(...a);},replaceChildren(...a){this.children=a;},addEventListener(){},setAttribute(){},showModal(){}});
  const getEl=(id)=>{if(!elements.has(id))elements.set(id,makeEl());return elements.get(id);};

  const rows=[
    // 固定报价：纯数字公式，无 source/sourceMode，但价格已算出 → 属正常
    {id:'fixed',name:'工费固定',visible:true,buy:'10.00',sell:'12.00',high:null,low:null,source:null,sourceName:null,sourceMode:null,derived:false,inputs:[],reason:null,stale:false,updatedAt:null},
    // 完全无数据：四字段全 null → 应显示按钮
    {id:'none',name:'暂无数据品',visible:true,buy:null,sell:null,high:null,low:null,source:null,sourceName:null,sourceMode:null,derived:false,inputs:[],reason:'暂无可用数据源',stale:true,updatedAt:null},
  ];
  const mockSnapshot={brand:{name:'测试',logo:'/assets/logo.png',subtitle:'',notice:'',footer:'',phone:''},serverTime:new Date().toISOString(),status:{shopOpen:true},rows};
  const fetchMock=async(url)=>{
    if(String(url).includes('/api/viewer/session'))return {ok:true,status:200,headers:{get:()=>null}};
    return {ok:true,status:200,json:async()=>mockSnapshot,headers:{get:()=>null}};
  };

  const context=vm.createContext({
    document:{title:'',hidden:false,getElementById:getEl,createElement:()=>makeEl(),createDocumentFragment:()=>({isFragment:true,children:[],append(...a){this.children.push(...a);}}),addEventListener(){}},
    window:{addEventListener(){}},
    localStorage:{getItem:()=>null,setItem(){}},
    navigator:{onLine:true},
    fetch:fetchMock,setTimeout:()=>0,clearTimeout:()=>{},
    AbortSignal:{timeout:()=>({signal:undefined})},
    console,
  });
  vm.runInContext(code,context);
  await new Promise((r)=>setTimeout(r,20));

  const prices=getEl('prices');
  // mock 的 replaceChildren 收到 documentFragment 时原样保存，这里按真实 DOM 语义展开其子节点
  const trs=prices.children.flatMap((c)=>c&&c.isFragment?c.children:[c]);
  assert.equal(trs.length,2,'应渲染两行');
  for(const tr of trs)assert.equal(tr.children.length,4,'每行必须四列（商品名+回购价+销售价+高低）');

  const [fixedTr,noneTr]=trs;
  assert.equal(fixedTr.children[0].className,'product','首列必须是商品名单元格');
  assert.equal(fixedTr.children[0].children[0].textContent,'工费固定');
  assert.equal(fixedTr.children[0].children.some((c)=>c.textContent==='缺少数据 ⓘ'),false,'固定报价有价格，不得显示缺少数据按钮');

  assert.equal(noneTr.children[0].children.some((c)=>c.textContent==='缺少数据 ⓘ'),true,'四字段全空必须显示缺少数据按钮');
});
// end:aigc.

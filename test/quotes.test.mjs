import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateConfig,snapshot,isShopOpen} from '../src/config.mjs';
const defaults=JSON.parse(readFileSync(new URL('../src/defaults.json',import.meta.url)));
// start:aigc.
import { Quotes } from '../src/quotes.mjs';
// end:aigc.
// start:aigc.
test('default gold pricing follows the source and supports a configured sales spread',()=>{
  const cfg=validateConfig(structuredClone(defaults));const now=Date.now();
  const q=new Quotes({baseQuotes:[{symbol:'黄金',sources:[{sourceId:'rtj',priority:1,enabled:true}]}]});
  q.ingestTest('rtj','黄金',{buy:882.73,sell:885.73,high:892.08,low:883.72,time:now});
  q.publish(now);
  const row=snapshot(cfg,q).rows.find(r=>r.name==='黄金');assert.equal(row.sell,'885.73');assert.equal(row.buy,'882.73');assert.equal(row.stale,false);
  cfg.rows.find(r=>r.name==='黄金').sellFormula='【#黄金#销售价】+3.5';
  assert.equal(snapshot(cfg,q).rows.find(r=>r.name==='黄金').sell,'889.23');
  q.prices.get('【#黄金#销售价】').time=now-120000;assert.equal(snapshot(cfg,q).rows.find(r=>r.name==='黄金').stale,true);
  q.prices.delete('【#黄金#销售价】');assert.equal(snapshot(cfg,q).rows.find(r=>r.name==='黄金').sell,null);
});
// end:aigc.
test('validates entire config, unknown references, duplicate ids and schema types',()=>{
  for(const mutate of [c=>c.rows[0].buyFormula='alert(1)',c=>c.rows[0].buyFormula='【#黄金#销售价】/0)',c=>c.rows[0].buyFormula='【#不存在#销售价】',c=>c.rows[1].id=c.rows[0].id,c=>c.brand.logo='https://example.com/a',c=>c.schedule[1]='25:00~26:00',c=>c.rows[0].visible='true']){
    const c=structuredClone(defaults);mutate(c);assert.throws(()=>validateConfig(c));
  }
});
test('shop schedule uses Shanghai weekday and separate status',()=>{
  const c={openMode:'schedule',schedule:['','09:00~11:00','','','','','']};
  assert.equal(isShopOpen(c,new Date('2026-10-19T02:00:00Z')),true);
  assert.equal(isShopOpen(c,new Date('2026-10-19T04:00:00Z')),false);
  c.openMode='open';assert.equal(isShopOpen(c),true);
});

// start:aigc.
test('聚合把选定 tick 转成公式键与来源元数据', () => {
  const q = new Quotes({ baseQuotes: [{ symbol: '美元指数', sources: [{ sourceId: 'sina', priority: 1, enabled: true }] }] });
  q.ingestTest('sina', '美元指数', { buy: 103.5, sell: 103.55, time: 1700000000000 });
  q.publish(1700000000000);
  assert.equal(q.prices.get('【#美元指数#回购价】').value, '103.5');
  assert.equal(q.prices.get('【#美元指数#销售价】').value, '103.55');
  assert.equal(q.prices.get('【#美元指数#最高价】'), undefined); // tick 缺失的字段不写键
  const meta = q.meta.get('美元指数');
  assert.equal(meta.sourceId, 'sina');
  assert.equal(meta.mode, 'primary');
});

test('聚合在来源切换后更新来源元数据', () => {
  const switches = [];
  const q = new Quotes({ baseQuotes: [{ symbol: 'X', sources: [
    { sourceId: 'a', priority: 1, enabled: true }, { sourceId: 'b', priority: 2, enabled: true },
  ] }], onSwitch: (e) => switches.push(e) });
  q.ingestTest('a', 'X', { buy: 1, time: 1000 });
  q.failTest('a', 'X', '断线');
  q.ingestTest('b', 'X', { buy: 2, time: 1001 });
  q.publish(1002);
  assert.equal(q.meta.get('X').sourceId, 'b');
  assert.equal(q.meta.get('X').mode, 'failover');
  assert.equal(switches.length, 1);
});

// start:aigc.
test('黄金快照带来源元数据且公式可加销售价差',()=>{
  const now=Date.now();
  const q=new Quotes({baseQuotes:[{symbol:'黄金',sources:[{sourceId:'rtj',priority:1,enabled:true,kind:'split',code:'JZJ_au'}]}]});
  q.sourceName.set('rtj','融通金'); // 模拟 attach 注册的来源名
  q.ingestTest('rtj','黄金',{buy:882.73,sell:885.73,high:892.08,low:883.72,time:now});
  q.publish(now);
  const cfg={version:1,brand:{},openMode:'open',schedule:['','','','','','',''],categories:[{id:'4415',name:'黄金',visible:true,buyFormula:'【#黄金#回购价】',sellFormula:'【#黄金#销售价】+3.5',highFormula:'【#黄金#最高价】',lowFormula:'【#黄金#最低价】',decimals:2,rounding:'half-up'}]};
  const row=snapshot(cfg,q).rows[0];
  assert.equal(row.buy,'882.73');assert.equal(row.sell,'889.23');
  assert.equal(row.source,'rtj');assert.equal(row.sourceName,'融通金');assert.equal(row.sourceMode,'primary');assert.equal(row.stale,false);assert.equal(row.derived,false);
});
// end:aigc.
// end:aigc.

// start:aigc.
// 数据源红绿灯聚合（设计文档"数据源管理"）：healthy/partial/disconnected/idle 与最近成功/最近错误
const fakeAdapter=(id)=>({id,name:id,start:()=>()=>{},stop(){}});
test('sourceStatus：按源聚合品种健康度、最近成功与最近错误',()=>{
  const now=Date.now();
  const q=new Quotes({baseQuotes:[
    {symbol:'美元指数',sources:[{sourceId:'wscn',priority:1,enabled:true},{sourceId:'itick',priority:2,enabled:true}]},
    {symbol:'美元兑港元',sources:[{sourceId:'wscn',priority:1,enabled:true}]},
    {symbol:'黄金',sources:[{sourceId:'rtj',priority:1,enabled:true}]},
  ]});
  q.attach(fakeAdapter('wscn'));q.attach(fakeAdapter('itick'));q.attach(fakeAdapter('rtj'));q.attach(fakeAdapter('empty'));
  // F01（四查）：分母从配置枚举——美元指数已配置 itick 但从未响应，必须计入分母（不能漏算成全绿）
  q.ingestTest('wscn','美元指数',{buy:103.5,sell:103.55,time:now});
  q.ingestTest('wscn','美元兑港元',{buy:7.8,sell:7.81,time:now-1000});
  q.publish(now);
  let st=q.sourceStatus().get('wscn');
  assert.equal(st.status,'healthy');
  assert.equal(st.healthy,2);assert.equal(st.total,2);
  assert.equal(st.lastSuccessAt.getTime(),now);      // 取全部品种 tick 最大时间
  st=q.sourceStatus().get('itick');
  assert.equal(st.status,'disconnected','配置未响应的品种计入分母：0/1 连接失败而非 idle');
  assert.equal(st.total,1);assert.equal(st.healthy,0);
  assert.equal(st.lastSuccessAt,null);
  // 真正零订阅（无任何启用映射的已挂载源）才是 idle
  assert.equal(q.sourceStatus().get('empty').status,'idle');
  assert.equal(q.sourceStatus().get('rtj').status,'disconnected','黄金配置 rtj 未响应 → 0/1，非 idle');
  // itick 收到过数据后断线 → 红，最近错误可追溯且保留断线前最近成功
  q.ingestTest('itick','美元指数',{buy:103.4,sell:103.45,time:now-500});
  q.failTest('itick','美元指数',new Error('HTTP 401'));
  q.publish(now);
  st=q.sourceStatus().get('itick');
  assert.equal(st.status,'disconnected');
  assert.equal(st.lastError,'HTTP 401');
  assert.equal(st.lastSuccessAt.getTime(),now-500);
  // wscn 一品种断线 → 部分正常（黄灯）
  q.failTest('wscn','美元兑港元',new Error('HTTP 500'));
  q.publish(now);
  st=q.sourceStatus().get('wscn');
  assert.equal(st.status,'partial');
  assert.equal(st.lastError,'HTTP 500');
});

// start:aigc.
// 红绿灯按接口返回的数据流统计（2026-10-28 回退 V5-01，用户决策）：源站原生单边品种
// （如 Pt99.95 只推单侧）是常态，按品类公式必需字段降级会让红绿灯常态黄灯、淹没真故障——
// 选源层的单边降级（M01/partial 模式）已在前台与快照呈现，红绿灯只关心连接与数据流
test('单边返回的品种不降级红绿灯（回退 V5-01 的决策固化）',()=>{
  const now=Date.now();
  const q=new Quotes({
    baseQuotes:[{symbol:'X',sources:[{sourceId:'a',priority:1,enabled:true}]}],
    categories:[{id:'c1',name:'C',visible:true,buyFormula:'【#X#回购价】',sellFormula:'【#X#销售价】',highFormula:'',lowFormula:'',decimals:2,rounding:'half-up'}],
  });
  q.attach(fakeAdapter('a'));
  q.ingestTest('a','X',{buy:100,time:now});   // 只有买价：接口数据流正常，销售报价缺失由前台提示
  q.publish(now);
  assert.equal(q.selector.state('X',now).mode,'partial','选源层仍按 M01 单边降级');
  const st=q.sourceStatus().get('a');
  assert.equal(st.status,'healthy','接口正常返回单边数据时红绿灯保持绿灯');
  assert.equal(st.healthy,1);assert.equal(st.total,1);
});

// V5-02（五查）：采样间隔内"失败→恢复"的短暂故障不得从错误历史中丢失——
// 失败回调即记错误事件，恢复（entry.err 清空）后 lastError 仍保留，分钟落库可追溯
test('V5-02：失败后恢复，最近错误事件仍保留',()=>{
  const now=Date.now();
  const q=new Quotes({baseQuotes:[{symbol:'X',sources:[{sourceId:'a',priority:1,enabled:true}]}]});
  let handlers;   // 截获 attach 注入的回调，模拟真实适配器的失败/恢复路径
  q.attach({id:'a',name:'a',start(h){handlers=h;return()=>{};},stop(){}});
  handlers.onFailure('X',new Error('HTTP 500'));           // 短暂故障
  q.ingestTest('a','X',{buy:1,sell:2,time:now});            // 下一分钟采样前已恢复（err 被清空）
  q.publish(now);
  const st=q.sourceStatus().get('a');
  assert.equal(st.status,'healthy','恢复后连接状态是健康的');
  assert.equal(st.lastError,'HTTP 500','短暂故障必须保留在最近错误中（供分钟落库）');
});
// end:aigc.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateConfig,snapshot,isShopOpen} from '../src/config.mjs';
const defaults=JSON.parse(readFileSync(new URL('../src/defaults.json',import.meta.url)));
test('default gold pricing follows the source and supports a configured sales spread',()=>{
  const cfg=validateConfig(structuredClone(defaults));const now=Date.now();
  const feed={connected:true,prices:new Map([['【#黄金#回购价】',{value:'882.73',time:now}],['【#黄金#销售价】',{value:'885.73',time:now}],['【#黄金#最高价】',{value:'892.08',time:now}],['【#黄金#最低价】',{value:'883.72',time:now}]])};
  const row=snapshot(cfg,feed).rows.find(r=>r.name==='黄金');assert.equal(row.sell,'885.73');assert.equal(row.buy,'882.73');assert.equal(row.stale,false);
  cfg.rows.find(r=>r.name==='黄金').sellFormula='【#黄金#销售价】+3.5';
  assert.equal(snapshot(cfg,feed).rows.find(r=>r.name==='黄金').sell,'889.23');
  feed.prices.get('【#黄金#销售价】').time=now-120000;assert.equal(snapshot(cfg,feed).rows[0].stale,true);
  feed.prices.delete('【#黄金#销售价】');assert.equal(snapshot(cfg,feed).rows[0].sell,null);
});
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

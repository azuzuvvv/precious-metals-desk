import test from 'node:test';
import assert from 'node:assert/strict';
import {createRtj} from '../src/rtj.mjs';

test('createRtj 依据 map 把 split 报价归一化为统一 tick',()=>{
  const ticks=[];
  const map=[{symbol:'黄金',code:'JZJ_au',kind:'split'}];
  const rtj=createRtj({map,onQuote:(t)=>ticks.push(t)});
  rtj.ingestForTest({code:'JZJ_au_PB',quoteTime:1700000000000,rt:{last:882.73}});
  rtj.ingestForTest({code:'JZJ_au_PS',quoteTime:1700000000000,rt:{last:885.73},high:892.08,low:883.72});
  assert.equal(ticks.length,2);
  assert.deepEqual(ticks[0],{symbol:'黄金',buy:882.73,time:1700000000000});
  const full=ticks[1];
  assert.equal(full.sell,885.73);
});

test('createRtj 忽略更旧的乱序消息，防止旧值覆盖新值',()=>{
  const ticks=[];
  const map=[{symbol:'黄金',code:'JZJ_au',kind:'split'}];
  const rtj=createRtj({map,onQuote:(t)=>ticks.push(t)});
  rtj.ingestForTest({code:'JZJ_au_PB',quoteTime:1700000000000,rt:{last:882.73}});
  rtj.ingestForTest({code:'JZJ_au_PS',quoteTime:1700000000000,rt:{last:885.73},high:892.08,low:883.72});
  // 更旧的 PS 消息不应覆盖已累积的最新值
  rtj.ingestForTest({code:'JZJ_au_PS',quoteTime:1699999999999,rt:{last:800},high:1,low:2});
  // start:aigc.
  // 口径变更（R04 字段级乱序守卫）：乱序字段被逐个丢弃但合并视图仍随每条消息重发一次，故输出 3 条；
  // 输出 time 取各字段最旧时间（此处全部字段 t 相同），旧值不被覆盖。
  assert.equal(ticks.length,3);
  const last=ticks[ticks.length-1];
  assert.equal(last.sell,885.73);
  assert.equal(last.high,892.08);
  assert.equal(last.time,1700000000000,'输出时间取字段最旧值');
  // end:aigc.
});
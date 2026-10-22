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
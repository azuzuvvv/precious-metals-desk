import test from 'node:test';
import assert from 'node:assert/strict';
import {QuoteFeed} from '../src/feed.mjs';

test('split quote decodes buy and sell sides into separate tick events',()=>{
  const ticks=[];
  const feed=new QuoteFeed({map:[{symbol:'黄金',code:'JZJ_au',kind:'split'}]});
  feed.on('tick',(t)=>ticks.push(t));
  const now=Date.now();
  feed.update({code:'JZJ_au_PB',quoteTime:now,rt:{last:882.73}});
  feed.update({code:'JZJ_au_PS',quoteTime:now,rt:{last:885.73},high:892.08,low:883.72});
  assert.equal(ticks.length,2);
  assert.deepEqual(ticks[0],{symbol:'黄金',time:now,buy:882.73});
  assert.deepEqual(ticks[1],{symbol:'黄金',time:now,sell:885.73,high:892.08,low:883.72});
});

test('plain quote keeps bid/ask distinct and drops non-finite fields',()=>{
  const ticks=[];
  const feed=new QuoteFeed({map:[{symbol:'美元兑离岸',code:'USDCNH',kind:'plain'}]});
  feed.on('tick',(t)=>ticks.push(t));
  const now=Date.now();
  feed.update({code:'USDCNH',quoteTime:now,rt:{last:6.8,bidPrice:[6.75],askPrice:[6.76]},high:Infinity,low:6.7});
  assert.equal(ticks.length,1);
  assert.deepEqual(ticks[0],{symbol:'美元兑离岸',time:now,buy:6.75,sell:6.76,low:6.7});
});

test('invalid quote time is ignored',()=>{
  const ticks=[];
  const feed=new QuoteFeed({map:[{symbol:'黄金',code:'JZJ_au',kind:'split'}]});
  feed.on('tick',(t)=>ticks.push(t));
  feed.update({code:'JZJ_au_PB',quoteTime:0,rt:{last:1}});
  feed.update({code:'JZJ_au_PB',quoteTime:Date.now()+3600000,rt:{last:2}});
  assert.equal(ticks.length,0);
});
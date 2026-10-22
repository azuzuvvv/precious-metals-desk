import test from 'node:test';
import assert from 'node:assert/strict';
import {QuoteFeed} from '../src/feed.mjs';
import {snapshot} from '../src/config.mjs';
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../src/defaults.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
test('split quotes decode into separate sides; older events cannot overwrite latest',()=>{
  const feed=new QuoteFeed(),now=Date.now();feed.connected=true;
  feed.update({code:'JZJ_au_PB',quoteTime:now,rt:{last:882.73}});
  feed.update({code:'JZJ_au_PS',quoteTime:now,rt:{last:885.73},high:892.08,low:883.72});
  feed.update({code:'JZJ_au_PS',quoteTime:now-1000,rt:{last:800}});
  assert.equal(snapshot(config,feed).rows[0].sell,'885.73');
  feed.update({code:'JZJ_au_PS',quoteTime:now+600000,rt:{last:1000}});
  assert.equal(snapshot(config,feed).rows[0].sell,'885.73');
});
test('heartbeat alone never refreshes stale quote time',()=>{
  const feed=new QuoteFeed(),now=Date.now();feed.connected=true;
  feed.update({code:'JZJ_au_PB',quoteTime:now-120000,rt:{last:882.73}});
  feed.update({code:'JZJ_au_PS',quoteTime:now-120000,rt:{last:885.73},high:892.08,low:883.72});
  feed.handle({msgid:16});const row=snapshot(config,feed).rows[0];
  assert.equal(row.stale,true);assert.equal(row.updatedAt,new Date(now-120000).toISOString());
});
test('non-split source keeps bid/ask prices distinct',()=>{
  const feed=new QuoteFeed(),now=Date.now();
  feed.update({code:'USDCNH',quoteTime:now,rt:{last:6.8,bidPrice:[6.75],askPrice:[6.76]},high:6.9,low:6.7});
  assert.equal(feed.prices.get('【#美元兑离岸#回购价】').value,'6.75');
  assert.equal(feed.prices.get('【#美元兑离岸#销售价】').value,'6.76');
});

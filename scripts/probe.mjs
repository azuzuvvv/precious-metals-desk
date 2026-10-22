import {QuoteFeed} from '../src/feed.mjs';
const feed=new QuoteFeed(); let done=false;
const timeout=setTimeout(()=>{if(!done){console.error('行情验证超时：'+feed.sourceStatus);feed.stop();process.exitCode=1;}},45000);
feed.on('quote',()=>{const buy=feed.prices.get('【#黄金#回购价】'),sell=feed.prices.get('【#黄金#销售价】');if(buy&&sell&&!done){done=true;console.log(JSON.stringify({connected:feed.connected,buy,sell,metadataCount:feed.metadata.length,catalogMissing:feed.metadata.length?undefined:'metadata pending'}));clearTimeout(timeout);feed.stop();}});
await feed.start();

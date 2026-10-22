// Isolated deterministic UI acceptance fixture. Never used by npm start.
import {createApp} from '../src/server.mjs';
import {passwordHash} from '../src/store.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const now=Date.now();
const feed={connected:true,lastMessageAt:new Date(now).toISOString(),sourceStatus:'验收测试数据',prices:new Map(Object.entries({'回购价':'882.73','销售价':'885.73','最高价':'892.08','最低价':'883.72'}).map(([key,value])=>[`【#黄金#${key}】`,{value,time:now}]))};
const app=await createApp({dataDir:mkdtempSync(join(tmpdir(),'lcjy-ui-')),feed});
app.store.setPassword(await passwordHash('QA-only-Password-2026!'));
app.server.listen(3210,'127.0.0.1',()=>console.log('UI acceptance fixture: http://127.0.0.1:3210/ (test data only)'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});

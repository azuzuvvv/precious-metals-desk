// Isolated deterministic UI acceptance fixture. Never used by npm start.
import {createApp} from '../src/server.mjs';
import {passwordHash} from '../src/store.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// start:aigc.
// F02 修复：MySQL 改造后临时 dataDir 只隔离本地文件（secret.key/setup-token），不隔离数据库连接——
// 若本脚本在继承正式 DB_* 环境变量的环境运行，setPassword 会把正式库 admin 密码覆盖为公开测试密码。
// 启动前强制验证数据库名为专用验收库（lcjy_qa 前缀），不满足即拒绝启动。
const dbName=process.env.DB_NAME||'gold_quote';
if(!/^lcjy_qa/.test(dbName)){
  console.error(`拒绝启动：qa-server 只能连接专用验收库（DB_NAME 需以 lcjy_qa 开头，当前为 ${dbName}）。
请先创建并指定专用库，例如：
  mysql -uroot -p -e "CREATE DATABASE lcjy_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
然后设置 DB_NAME=lcjy_qa 再运行本脚本。`);
  process.exit(1);
}
// end:aigc.
const now=Date.now();
const feed={connected:true,lastMessageAt:new Date(now).toISOString(),sourceStatus:'验收测试数据',prices:new Map(Object.entries({'回购价':'882.73','销售价':'885.73','最高价':'892.08','最低价':'883.72'}).map(([key,value])=>[`【#黄金#${key}】`,{value,time:now}]))};
const app=await createApp({dataDir:mkdtempSync(join(tmpdir(),'lcjy-ui-')),feed});
await app.store.setPassword(await passwordHash('QA-only-Password-2026!'));
app.server.listen(3210,'127.0.0.1',()=>console.log('UI acceptance fixture: http://127.0.0.1:3210/ (test data only)'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});

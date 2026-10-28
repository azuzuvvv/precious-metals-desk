// start:aigc.
// MySQL 改造（方案第 11 节）：原 SQLite 在线备份改为 mysqldump 一致性导出。
// - --single-transaction：InnoDB 一致性快照，不锁业务（备份期间避免 DDL）
// - 密码经 MYSQL_PWD 环境变量传给子进程，不出现在命令行参数（不在 ps 中暴露）
// - 恢复需同时使用 data/secret.key（来源密钥主密钥），见方案第 9/11 节
// - F03 修复：createWriteStream 异步打开（初始 fd=null）不能作 spawn stdio，改为 stdout 管道写入。
// - R1 修复（写失败留半成品 P2）：补文件流 error 处理；子进程退出与输出流关闭"双事件收敛"后
//   才判定成功/清理——磁盘写满等写入失败会终止导出、清理半成品，只在两者都成功时报告成功。
// end:aigc.
import {mkdirSync,createWriteStream,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
const dir=resolve('data'),out=join(dir,'backups');mkdirSync(out,{recursive:true});
const path=join(out,`gold-quote-${new Date().toISOString().replace(/[:.]/g,'-')}.sql`);
const args=['--single-transaction','--routines','--triggers','--default-character-set=utf8mb4',
  '-h',process.env.DB_HOST||'127.0.0.1','-P',String(process.env.DB_PORT||3306),
  '-u',process.env.DB_USER||'gold_quote_app',process.env.DB_NAME||'gold_quote'];
const env={...process.env,MYSQL_PWD:process.env.DB_PASSWORD||''};
const removePartial=()=>{try{unlinkSync(path);}catch{/* 清理失败不掩盖原始错误 */}};
const file=createWriteStream(path,{mode:0o600});
const child=spawn('mysqldump',args,{env,stdio:['ignore','pipe','inherit']});
// 子进程状态：null=运行中 / true=正常退出 / false=失败；file 同义。两者都收敛后统一结算
let childState=null,fileState=null;
const settle=()=>{
  if(childState===null||fileState===null)return;           // 未全部结束，等待另一方
  if(childState&&fileState){console.log(`${path}\n提示：恢复时需同时使用 ${join(dir,'secret.key')}`);return;}
  removePartial();process.exitCode=1;                       // 任一失败：清理半成品并置非零退出码
};
child.on('error',(e)=>{console.error(`mysqldump 启动失败（需安装 MySQL 客户端）: ${e.message}`);childState=false;settle();});
child.on('close',(code)=>{if(code!==0)console.error(`mysqldump 退出码 ${code}`);childState=code===0;settle();});
file.on('error',(e)=>{console.error(`备份文件写入失败: ${e.message}`);fileState=false;child.kill();settle();}); // 磁盘满等：终止导出
file.on('close',()=>{if(fileState===null)fileState=true;settle();});         // 管道正常 end 关闭视为成功
child.stdout.pipe(file);

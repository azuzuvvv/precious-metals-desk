// start:aigc.
// MySQL 测试基建：为每个测试用例创建独立隔离库 + Store 实例，用完即 DROP，避免用例间相互污染。
// 管理连接参数优先级：DB_TEST_*（测试专用）→ DB_*（生产同款）→ 本机默认。
import mysql from 'mysql2/promise';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.mjs';

// 管理连接参数（仅建库/删库用，不指定 database）
const adminParams=()=>({
  host:process.env.DB_TEST_HOST||process.env.DB_HOST||'127.0.0.1',
  port:Number(process.env.DB_TEST_PORT||process.env.DB_PORT||3306),
  user:process.env.DB_TEST_USER||process.env.DB_USER||'root',
  password:process.env.DB_TEST_PASSWORD||process.env.DB_PASSWORD||'',
});

// 删除安全栅栏：库名必须落在测试库白名单内，防误删业务库
const SAFE_DB_NAME=/^lcjy_test_[a-z0-9_]+$/;
// 库名 = 前缀 + 时间戳36进制 + 随机 hex：并发/重跑不冲突，且天然匹配白名单
const newDbName=()=>`lcjy_test_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

// 业务库连接参数：供 Store.create 第二参数覆盖默认 env 配置（如乐观锁测试的第二个实例）
export const testDbOptions=(database)=>({...adminParams(),database});

// 仅建独立测试库（server.test 等无法注入 store 的场景，配合 DB_* 环境变量使用）
export async function createTestDatabase(){
  const name=newDbName();
  const conn=await mysql.createConnection(adminParams());
  try{await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);}
  finally{await conn.end();}
  return name;
}

// 删测试库：先过白名单校验再 DROP，不匹配直接抛错
export async function dropTestDatabase(name){
  if(!SAFE_DB_NAME.test(name))throw new Error(`拒绝删除非测试库: ${name}`);
  const conn=await mysql.createConnection(adminParams());
  try{await conn.query(`DROP DATABASE \`${name}\``);}
  finally{await conn.end();}
}

// 创建隔离 Store：临时目录 + 独立库；库名挂到 __testDb 供 reopen/destroy 使用
export async function createTestStore(){
  const dir=mkdtempSync(join(tmpdir(),'lcjy-mysql-'));
  const database=await createTestDatabase();
  const store=await Store.create(dir,testDbOptions(database));
  store.__testDb=database;
  return store;
}

// 关旧实例后用同一库 + 同一目录重建：覆盖"重启后迁移幂等"类场景
export async function reopenTestStore(store){
  const {dir,__testDb:database}=store;
  await store.close();
  const reopened=await Store.create(dir,testDbOptions(database));
  reopened.__testDb=database;
  return reopened;
}

// 销毁：关连接池 → 白名单校验 → DROP 库 → 清理临时目录；store 为空（建库阶段即失败）时跳过
export async function destroyTestStore(store){
  if(!store)return;
  const {dir,__testDb:database}=store;
  await store.close();
  if(!SAFE_DB_NAME.test(database))throw new Error(`拒绝删除非测试库: ${database}`);
  await dropTestDatabase(database);
  rmSync(dir,{recursive:true,force:true});
}

// 转成可直接注入 process.env 的 DB_* 变量（createApp 内部 Store.create 读取这些变量）
export const testDbEnv=(database)=>{const p=adminParams();return {DB_HOST:p.host,DB_PORT:String(p.port),DB_USER:p.user,DB_PASSWORD:p.password,DB_NAME:database};};

// start:aigc. Redis 测试基建（审查 R2/R2残留）：随机测试命名空间 + 严格清理校验 + 就绪超时。
// 测试一律使用 lcjy:test:<random>: 前缀，与生产前缀 lcjy:quote:access:v1: 完全隔离，
// 清理只删本次随机前缀，且拒绝生产/空/宽泛 pattern，防止误删真实访问状态。
// start:aigc. 每次测试进程生成唯一命名空间（12 位 hex），createApp/limiter/sessions 全链路注入
export const randomTestPrefix=()=>`lcjy:test:${randomBytes(6).toString('hex')}:`;
// 清理 pattern 白名单：必须是本 helper 生成的随机测试前缀 + 通配符，其余一律拒绝
const SAFE_TEST_PATTERN=/^lcjy:test:[a-f0-9]{12}:\*$/;
export async function scanDelPrefix(redis,pattern){
  if(!SAFE_TEST_PATTERN.test(pattern))throw new Error(`拒绝清理非随机测试命名空间: ${pattern}`);
  let cursor='0';
  do{
    const [next,keys]=await redis.scan(cursor,'MATCH',pattern,'COUNT',200);
    cursor=next;
    if(keys.length)await redis.del(...keys);
  }while(cursor!=='0');
}
// 等待 Redis 就绪（带超时）：enableOfflineQueue:false 下命令不排队，未就绪即失败；
// 不监听 error 事件（ioredis 重连期间会周期性报错，最终 ready 即算成功），只等 ready 或超时退出
export function waitRedisReady(client,timeoutMs=5000){
  if(client.status==='ready')return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{client.off('ready',onReady);reject(new Error(`Redis ${timeoutMs}ms 内未就绪（status=${client.status}）`));},timeoutMs);
    const onReady=()=>{clearTimeout(timer);resolve();};
    client.once('ready',onReady);
  });
}
// end:aigc.
// end:aigc.
// end:aigc.

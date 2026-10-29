// start:aigc.
// MySQL 改造（方案见 docs/MySQL数据库改造方案.md 第 17.8/18 节定案）：
// - node:sqlite → mysql2/promise 连接池，全部查询异步化（Store.create() 工厂替代同步构造建库）
// - 连接显式 flags:['FOUND_ROWS']：affectedRows 语义 = 匹配行数，与 SQLite changes 一致（17.4）
// - ID/符号类字段 utf8mb4_bin；配置/审计 JSON 用 MEDIUMTEXT（17.5 / 第 7 节）
// - 乐观锁改为 WHERE version=? 条件更新 + 命中检查（18.2）；INSERT OR IGNORE → ON DUPLICATE KEY UPDATE（16.6）
// - 移除 SQLite 在线备份 backup()，备份改由 scripts/backup.mjs 调 mysqldump（第 11 节）
// end:aigc.
import mysql from 'mysql2/promise';
import {mkdirSync,readFileSync,existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,scrypt,timingSafeEqual,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {validateConfig} from './config.mjs';
import {SOURCES,BASE_QUOTES,ITICK_STALE_MS} from './catalog.mjs';
const derive=promisify(scrypt);
// start:aigc. MySQL 连接参数：环境变量优先（DB_*，见方案第 5 节），db 参数供测试注入隔离库
const dbOptions=(db={})=>({
  host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),
  database:process.env.DB_NAME||'gold_quote',user:process.env.DB_USER||'gold_quote_app',password:process.env.DB_PASSWORD||'',
  waitForConnections:true,connectionLimit:Number(process.env.DB_POOL_SIZE||5),queueLimit:0,
  charset:'utf8mb4',timezone:'Z',
  // 17.4 定案：显式声明 FOUND_ROWS，防驱动默认 flags 变更导致 affectedRows 语义漂移
  flags:['FOUND_ROWS'],
  ...db,
});
// end:aigc.
export async function passwordHash(password,salt=randomBytes(16).toString('hex')){
  const key=await derive(password,salt,64);return `${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password,hash){if(typeof password!=='string'||password.length>256||!hash)return false;const [salt,expected]=hash.split(':');const actual=await passwordHash(password,salt);return timingSafeEqual(Buffer.from(actual.split(':')[1],'hex'),Buffer.from(expected,'hex'));}
export function validPassword(password){if(typeof password!=='string'||password.length<12||password.length>256)throw new Error('密码长度必须为12至256个字符');}

export class Store{
  // start:aigc. 轻构造只准备目录（secret.key / setup-token.txt 仍落盘）；连接与建表在 create() 完成
  constructor(dir){this.dir=dir;mkdirSync(dir,{recursive:true});this.pool=null;}
  static async create(dir,db){
    const store=new Store(dir);
    store.pool=mysql.createPool(dbOptions(db));
    await store.pool.query('SELECT 1'); // 6.1：启动即验证连接，失败则终止启动
    await store._init();
    return store;
  }
  // start:aigc. 单连接贯穿事务（第 8 节）：异常回滚、最终归还连接
  async _tx(fn){
    const conn=await this.pool.getConnection();
    try{await conn.beginTransaction();const result=await fn(conn);await conn.commit();return result;}
    catch(e){try{await conn.rollback();}catch{/* 回滚失败仅透传原异常 */}throw e;}
    finally{conn.release();}
  }
  // start:aigc. MySQL DDL（幂等建表）。表默认 utf8mb4_general_ci，ID/符号列显式 utf8mb4_bin 保持大小写敏感语义（18.1）
  async _tableExists(conn,name){
    const [rows]=await conn.query('SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',[name]);
    return rows[0].c>0;
  }
  async _columnExists(conn,table,column){
    const [rows]=await conn.query('SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',[table,column]);
    return rows[0].c>0;
  }
  async _init(){
    const conn=this.pool;
    // 旧三表（与 SQLite 版迁移历史对应：先建旧表，再做"旧版三层库"判定）
    await conn.query('CREATE TABLE IF NOT EXISTS settings (id TINYINT PRIMARY KEY, version INT NOT NULL, json MEDIUMTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS admin (id TINYINT PRIMARY KEY, hash VARCHAR(255) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    // start:aigc. 管理员会话撤销版本号（审查 R1）：epoch 存 MySQL，随改密在同一 UPDATE 内原子 +1，
    // 作为会话撤销的事实来源，避免 Redis 存 epoch 时"改密成功但 INCR 失败"导致旧会话复活
    if(!await this._columnExists(conn,'admin','epoch'))await conn.query('ALTER TABLE admin ADD COLUMN epoch INT NOT NULL DEFAULT 0');
    await conn.query('CREATE TABLE IF NOT EXISTS audit (version INT PRIMARY KEY, at VARCHAR(40) NOT NULL, summary VARCHAR(512) NOT NULL, before_json MEDIUMTEXT NOT NULL, after_json MEDIUMTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    // M05/F03：判定"旧版三层库"——base_quote_sources 已存在而 migrations 不存在（两表都查的原因见 SQLite 版注释）
    const legacyThreeLayer=await this._tableExists(conn,'base_quote_sources')&&!await this._tableExists(conn,'migrations');
    await conn.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, name VARCHAR(128) NOT NULL, type VARCHAR(32) NOT NULL, enabled TINYINT NOT NULL DEFAULT 1, priority INT NOT NULL DEFAULT 0, poll_ms INT, timeout_ms INT, stale_ms INT, last_success_at VARCHAR(40), last_error TEXT, retired TINYINT NOT NULL DEFAULT 0, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS base_quotes (symbol VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, name VARCHAR(128) NOT NULL, unit VARCHAR(32) NOT NULL DEFAULT \'\', decimals INT NOT NULL DEFAULT 2, enabled TINYINT NOT NULL DEFAULT 1, PRIMARY KEY (symbol)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS base_quote_sources (symbol VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, source_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, priority INT NOT NULL, kind VARCHAR(32) NOT NULL, code VARCHAR(64) DEFAULT NULL, enabled TINYINT NOT NULL DEFAULT 1, stale_ms INT DEFAULT NULL, PRIMARY KEY (symbol, source_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS categories (id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, name VARCHAR(128) NOT NULL, visible TINYINT NOT NULL DEFAULT 1, buy_formula TEXT NOT NULL, sell_formula TEXT NOT NULL, high_formula TEXT NOT NULL, low_formula TEXT NOT NULL, decimals INT NOT NULL DEFAULT 2, rounding VARCHAR(16) NOT NULL DEFAULT \'half-up\', sort INT NOT NULL DEFAULT 0, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS switch_log (id BIGINT NOT NULL AUTO_INCREMENT, at VARCHAR(40) NOT NULL, symbol VARCHAR(64) NOT NULL, old_source VARCHAR(64) DEFAULT NULL, new_source VARCHAR(64) DEFAULT NULL, mode VARCHAR(32) DEFAULT NULL, reason TEXT, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS source_secrets (source_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, secret_ciphertext TEXT NOT NULL, PRIMARY KEY (source_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS migrations (name VARCHAR(128) COLLATE utf8mb4_bin NOT NULL, at VARCHAR(40) NOT NULL, PRIMARY KEY (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    if(legacyThreeLayer)await conn.execute('INSERT INTO migrations (name,at) VALUES (?,?) ON DUPLICATE KEY UPDATE name=name',['sinaFailover',new Date().toISOString()]);
    // 旧版本已建 base_quote_sources 无 stale_ms 列，幂等补列（MySQL 无 ADD COLUMN IF NOT EXISTS，先查元数据）
    if(!await this._columnExists(conn,'base_quote_sources','stale_ms'))await conn.query('ALTER TABLE base_quote_sources ADD COLUMN stale_ms INT');
    const [rows]=await conn.execute('SELECT id FROM settings WHERE id=1');
    if(!rows.length){
      const defaults=validateConfig(JSON.parse(readFileSync(new URL('./defaults.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')));
      // ON DUPLICATE KEY UPDATE id=id：等价 INSERT OR IGNORE 的"键冲突跳过"，且不吞其他错误（16.6）
      await conn.execute('INSERT INTO settings (id,version,json) VALUES (1,1,?) ON DUPLICATE KEY UPDATE id=id',[JSON.stringify(defaults)]);
    }
    this.setupPath=join(this.dir,'setup-token.txt');
    if(!await this.hasAdmin()&&!existsSync(this.setupPath))writeFileSync(this.setupPath,randomBytes(24).toString('hex'),{mode:0o600,flag:'wx'});
    if(await this.hasAdmin()&&existsSync(this.setupPath))unlinkSync(this.setupPath);
    await this.migrateCatalog();
    // F01 修复：回调必须接收并转交事务连接，否则 upgradeSinaFailover 拿到 undefined 导致空库首次启动即崩
    await this.runMigration('sinaFailover',(conn)=>this.upgradeSinaFailover(conn));
    // start:aigc. 2026-10-28 换源迁移：新浪 hq 对阿里云机房 IP 403，见闻/腾讯/iTick 顶上。
    // 必须走 runMigration：线上库已初始化（migrateCatalog 的 seed 不会重跑）
    await this.runMigration('wscnSources',(conn)=>this.upgradeWscnSources(conn));
    // start:aigc. 第四批退役（§9/§17.2，2026-10-29）：sina/tencent/yahoo/frankfurter 四源归档退役——
    // retired 与 enabled 区分（§9.2）：retired=1 的源不再被 sources()/导出/目录校验当作可用源返回，
    // 旧导入/目录保存再引用会得到"未登记数据源"的明确错误；有效映射一并清理，历史切源日志不删（§9.2）。
    // 沪金主力/沪银主力（sina 唯一源，线上本就不可达）随 sina 移除基础行情行；
    // 其同名透传品类及次主力软引用品类一并移除（用户确认"直接全部去掉"，公式仅透传已删品种无保留价值）
    // start:aigc. 第四批复查整改：删除不再按名称无条件执行——用户改过公式/差价、
    // 或为品种配置了其他非退役源映射的，一律保留（含基础行情行与品类行），
    // 只有"仍是默认透传公式 + 已无任何非退役源映射"才随源退役删除
    await this.runMigration('retireSources',async(conn)=>{
      if(!await this._columnExists(conn,'sources','retired'))
        await conn.query('ALTER TABLE sources ADD COLUMN retired TINYINT NOT NULL DEFAULT 0');
      await conn.execute("UPDATE sources SET retired=1, enabled=0 WHERE id IN ('sina','tencent','yahoo','frankfurter')");
      await conn.execute("DELETE FROM base_quote_sources WHERE source_id IN ('sina','tencent','yahoo','frankfurter')");
      // 基础行情只删"无任何非退役源映射"的行：用户配过 wscn/itick 等有效源映射的品种保留，
      // 也不会留下"映射在、行情行没了"的孤立映射（评审整改第 2 点）
      await conn.execute(`DELETE bq FROM base_quotes bq WHERE bq.symbol IN ('沪金主力','沪银主力')
        AND NOT EXISTS (SELECT 1 FROM base_quote_sources m JOIN sources s ON s.id=m.source_id
          WHERE m.symbol=bq.symbol AND s.retired=0)`);
      // 品类只删"四项公式均为默认透传（引用自身名）且同名基础行情已随退役移除"的；
      // 公式被用户改过（加差价/改引用其他品种）或品种仍有有效数据源的保留（评审整改第 1 点）
      for(const name of ['沪金主力','沪金次主力','沪银主力','沪银次主力']){
        await conn.execute(`DELETE c FROM categories c WHERE c.name=?
          AND c.buy_formula=? AND c.sell_formula=? AND c.high_formula=? AND c.low_formula=?
          AND NOT EXISTS (SELECT 1 FROM base_quotes b WHERE b.symbol=?)`,
          [name,`【#${name}#回购价】`,`【#${name}#销售价】`,`【#${name}#最高价】`,`【#${name}#最低价】`,name]);
      }
    });
    // end:aigc.
    // start:aigc. 2026-10-29 沪金/沪银主力复活（iTick 内盘期货，实测依据见 catalog.mjs 注释）：
    // 线上库的 retireSources 已删除这两个品种与同名品类，此迁移按"缺失才补"恢复基础行情、
    // itick 映射与业务品类（ON DUPLICATE KEY 跳过，不覆盖用户后续的自定义改动）；
    // 次主力仍无数据源，不恢复
    await this.runMigration('itickCnFutures',async(conn)=>{
      for(const [sym,unit,dec,code] of [['沪金主力','元/克',2,'AU'],['沪银主力','元/千克',1,'AG']]){
        await conn.execute('INSERT INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE symbol=symbol',[sym,sym,unit,dec]);
        await conn.execute("INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,'itick',1,'itick',?,1,?) ON DUPLICATE KEY UPDATE symbol=symbol",[sym,code,ITICK_STALE_MS]);
      }
      // 品类追加到末尾：sort 取当前最大值递增，避免与已有行冲突
      const [[mx]]=await conn.query('SELECT COALESCE(MAX(sort),0) m FROM categories');
      let sort=Number(mx.m)||0;
      for(const [id,name,dec] of [['4391','沪金主力',2],['4393','沪银主力',1]]){
        await conn.execute(`INSERT INTO categories (id,name,visible,buy_formula,sell_formula,high_formula,low_formula,decimals,rounding,sort)
          VALUES (?,?,1,?,?,?,?,?,'half-up',?) ON DUPLICATE KEY UPDATE id=id`,
          [id,name,`【#${name}#回购价】`,`【#${name}#销售价】`,`【#${name}#最高价】`,`【#${name}#最低价】`,dec,++sort]);
      }
    });
    // end:aigc.
    // start:aigc. 访问统计表（方案 §7）：分钟桶事实存储 + 落库水位；建表与初始水位同一迁移事务
    await this.runMigration('accessStats',async(conn)=>{
      await conn.query(`CREATE TABLE IF NOT EXISTS access_ip_minute (
        minute_utc BIGINT UNSIGNED NOT NULL,
        ip VARCHAR(45) NOT NULL,
        req INT UNSIGNED NOT NULL DEFAULT 0,
        ok INT UNSIGNED NOT NULL DEFAULT 0,
        e401 INT UNSIGNED NOT NULL DEFAULT 0,
        e429 INT UNSIGNED NOT NULL DEFAULT 0,
        e5xx INT UNSIGNED NOT NULL DEFAULT 0,
        no_sess INT UNSIGNED NOT NULL DEFAULT 0,
        w_sess INT UNSIGNED NOT NULL DEFAULT 0,
        w_ip INT UNSIGNED NOT NULL DEFAULT 0,
        w_any INT UNSIGNED NOT NULL DEFAULT 0,
        d_sess INT UNSIGNED NOT NULL DEFAULT 0,
        d_ip INT UNSIGNED NOT NULL DEFAULT 0,
        issue INT UNSIGNED NOT NULL DEFAULT 0,
        issue_deny INT UNSIGNED NOT NULL DEFAULT 0,
        issue_full INT UNSIGNED NOT NULL DEFAULT 0,
        complete TINYINT NOT NULL DEFAULT 1,
        flushed_at VARCHAR(40) NOT NULL DEFAULT '',
        PRIMARY KEY (minute_utc, ip)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await conn.query('CREATE TABLE IF NOT EXISTS access_flush_state (id TINYINT PRIMARY KEY, watermark_minute BIGINT UNSIGNED NOT NULL, updated_at VARCHAR(40) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
      await conn.query("INSERT INTO access_flush_state (id,watermark_minute,updated_at) VALUES (1,0,'') ON DUPLICATE KEY UPDATE id=id");
    });
    // start:aigc. 二批审查 S2-06：新增每请求 0/1 的"应限流"口径列（黄灯阈值唯一依据，不叠维度）。
    // 存量库补列守卫（新库建表已含 w_any，重复 ALTER 会报错故先查列存在）
    await this.runMigration('accessStatsWAny',async(conn)=>{
      if(!await this._columnExists(conn,'access_ip_minute','w_any'))
        await conn.query('ALTER TABLE access_ip_minute ADD COLUMN w_any INT UNSIGNED NOT NULL DEFAULT 0 AFTER w_ip');
    });
    // start:aigc. 手动封禁（方案 §5，第三批）：MySQL 为事实来源 + 操作审计（保留 90 天）；
    // blocked 统计列补入分钟表（§7 结果分类含 blocked）。单进程执行走本机表，Redis 镜像未做（见 access-blocks.mjs 注释）
    await this.runMigration('accessBlocks',async(conn)=>{
      await conn.query(`CREATE TABLE IF NOT EXISTS access_ip_block (
        ip VARCHAR(45) NOT NULL PRIMARY KEY,
        until_ms BIGINT UNSIGNED NOT NULL,
        reason VARCHAR(512) NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        released TINYINT NOT NULL DEFAULT 0,
        released_reason VARCHAR(512) NOT NULL DEFAULT '',
        updated_at VARCHAR(40) NOT NULL,
        INDEX idx_active (released, until_ms)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await conn.query(`CREATE TABLE IF NOT EXISTS access_ip_block_audit (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        action VARCHAR(16) NOT NULL,
        minutes INT UNSIGNED NULL,
        reason VARCHAR(512) NOT NULL,
        version_before INT UNSIGNED NOT NULL,
        version_after INT UNSIGNED NOT NULL,
        at VARCHAR(40) NOT NULL,
        INDEX idx_at (at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      if(!await this._columnExists(conn,'access_ip_minute','blocked'))
        await conn.query('ALTER TABLE access_ip_minute ADD COLUMN blocked INT UNSIGNED NOT NULL DEFAULT 0 AFTER e5xx');
    });
    // end:aigc.
    // start:aigc. 2026-10-29 P2 复审（存量库）：iTick 降频为 45 秒 + 13 秒逐请求间隔后，
    // 旧的过期阈值（未配置走全局 45 秒）与刷新周期零余量——一次抖动即判停更。
    // 统一放宽到 ITICK_STALE_MS；只放宽不放宽到更紧，保留用户已配置的更宽阈值
    await this.runMigration('itickStaleWiden',async(conn)=>{
      await conn.execute('UPDATE base_quote_sources SET stale_ms=? WHERE source_id=? AND (stale_ms IS NULL OR stale_ms < ?)',[ITICK_STALE_MS,'itick',ITICK_STALE_MS]);
    });
    // end:aigc.
  }
  // end:aigc.
  async hasAdmin(){const [rows]=await this.pool.execute('SELECT id FROM admin WHERE id=1');return rows.length>0;}
  async getHash(){const [rows]=await this.pool.execute('SELECT hash FROM admin WHERE id=1');return rows[0]?.hash;}
  // start:aigc. 会话撤销版本号读取（审查 R1）：未初始化或无记录时按 0 处理
  async getEpoch(){const [rows]=await this.pool.execute('SELECT epoch FROM admin WHERE id=1');return rows[0]?.epoch ?? 0;}
  // start:aigc. 凭据快照（审查 R6）：hash 与 epoch 取自同一 SELECT 的一致性读，
  // 供登录"验证该快照的密码 + 用同一快照 epoch 签发"——改密并发提交时旧密码会话只会带旧 epoch，
  // 随即被 epoch 比对拒绝；不再存在"旧 hash 验证通过却读到新 epoch"的两步读取窗口
  async getCredential(){const [rows]=await this.pool.execute('SELECT hash, epoch FROM admin WHERE id=1');return rows[0] ?? {hash:null, epoch:0};}
  async setPassword(hash){await this.pool.execute('INSERT INTO admin (id,hash) VALUES (1,?) ON DUPLICATE KEY UPDATE hash=VALUES(hash)',[hash]);if(existsSync(this.setupPath))unlinkSync(this.setupPath);}
  // start:aigc. R2 修复（并发覆盖 P1）：原子初始化——纯 INSERT，主键冲突即"已初始化"，
  // 消除 setup 路由"先查 hasAdmin 再写"两步之间的竞态窗口（两请求都返回 200、密码被后写覆盖）
  async setPasswordIfAbsent(hash){
    try{await this.pool.execute('INSERT INTO admin (id,hash) VALUES (1,?)',[hash]);if(existsSync(this.setupPath))unlinkSync(this.setupPath);return true;}
    catch(e){if(e.code==='ER_DUP_ENTRY')return false;throw e;}
  }
  // start:aigc. R3 修复（并发覆盖 P1）+ 审查 R1：原子改密——单条 UPDATE 同时改密码并递增 epoch，
  // 他人已改则匹配 0 行返回 false；epoch 与密码在同一语句内原子提交，无"密码已改但会话未撤销"窗口
  async replacePassword(oldHash,newHash){
    const [res]=await this.pool.execute('UPDATE admin SET hash=?, epoch=epoch+1 WHERE id=1 AND hash=?',[newHash,oldHash]);
    return res.affectedRows===1;
  }
  // start:aigc. 访问分钟统计落库（方案 §7 + 二轮审查 §16.3）：按绝对累计值 upsert（GREATEST 防旧/较小
  // 快照回退，禁止增量累加翻倍）；数据行与成功水位同一事务推进，事务外不前进。complete 取 LEAST：缺口保持 0。
  static ACCESS_MINUTE_FIELDS=['req','ok','e401','e429','e5xx','blocked','noSess','wSess','wIp','wAny','dSess','dIp','issue','issueDeny','issueFull'];
  async getAccessWatermark(){const [rows]=await this.pool.execute('SELECT watermark_minute FROM access_flush_state WHERE id=1');return Number(rows[0]?.watermark_minute||0);}
  async upsertAccessMinute(minute,rows){
    const at=new Date().toISOString();
    if(!rows.length){ // 空桶也要推水位，避免同一分钟反复扫描
      await this.pool.execute('UPDATE access_flush_state SET watermark_minute=GREATEST(watermark_minute,?),updated_at=? WHERE id=1',[minute,at]);
      return;
    }
    const F=Store.ACCESS_MINUTE_FIELDS,snake=(s)=>s.replace(/[A-Z]/g,(c)=>'_'+c.toLowerCase());
    const cols=['minute_utc','ip',...F.map(snake),'complete','flushed_at'];
    const values=rows.map((r)=>[minute,r.ip,...F.map((f)=>Number(r.fields?.[f]||0)),r.complete?1:0,at]);
    const upd=F.map((f)=>{const c=snake(f);return `${c}=GREATEST(${c},VALUES(${c}))`;}).join(',');
    const sql=`INSERT INTO access_ip_minute (${cols.join(',')}) VALUES ? ON DUPLICATE KEY UPDATE ${upd}, complete=LEAST(complete,VALUES(complete)), flushed_at=VALUES(flushed_at)`;
    await this._tx(async(conn)=>{
      await conn.query(sql,[values]);
      await conn.execute('UPDATE access_flush_state SET watermark_minute=GREATEST(watermark_minute,?),updated_at=? WHERE id=1',[minute,at]);
    });
  }
  async cleanupAccessMinutes(days=7){ // §7 分钟统计保留 7 天，按批清理
    const cutoff=Math.floor(Date.now()/60000-days*1440);
    let total=0;
    for(;;){const [res]=await this.pool.execute('DELETE FROM access_ip_minute WHERE minute_utc < ? LIMIT 5000',[cutoff]);total+=res.affectedRows;if(res.affectedRows<5000)break;}
    return total;
  }
  // start:aigc. 手动封禁存取（方案 §5，第三批）：MySQL 为事实来源；数据与审计同一事务写入；
  // expectedVersion 行级乐观锁防两个管理员互相覆盖；解封不删行（保留操作历史），有效=未解除且未到期。
  // 审计 90 天清理随写操作低频执行（§7），行量小无需独立任务。
  async loadActiveBlocks(nowMs=Date.now()){
    const [rows]=await this.pool.execute('SELECT ip,until_ms,reason,version FROM access_ip_block WHERE released=0 AND until_ms>?',[nowMs]);
    return rows;
  }
  async getBlockVersion(ip){
    const [rows]=await this.pool.execute('SELECT version,released FROM access_ip_block WHERE ip=?',[ip]);
    return rows[0]??null;
  }
  // 封禁/延长/重新封禁：行不存在→INSERT(v1)；存在且有效→CAS(version=expectedVersion) 后 v+1；
  // 存在但已解除或已到期（绝对到期时间，B-03）→ 允许 expectedVersion=0 重新封禁（无有效状态可覆盖）
  async saveBlock({ip,untilMs,minutes,reason,expectedVersion=0}){
    const at=new Date().toISOString();
    return this._tx(async(conn)=>{
      const [[row]]=await conn.execute('SELECT version,released,until_ms FROM access_ip_block WHERE ip=?',[ip]);
      if(!row){
        if(expectedVersion>0)return {ok:false,code:'VERSION'};
        await conn.execute('INSERT INTO access_ip_block (ip,until_ms,reason,version,released,updated_at) VALUES (?,?,?,1,0,?)',[ip,untilMs,reason,at]);
        await conn.execute("INSERT INTO access_ip_block_audit (ip,action,minutes,reason,version_before,version_after,at) VALUES (?,'block',?,?,0,1,?)",[ip,minutes,reason,at]);
        return {ok:true,version:1};
      }
      const expired=Number(row.until_ms)<=Date.now();
      if(row.version!==expectedVersion&&!(expectedVersion===0&&(row.released===1||expired)))return {ok:false,code:'VERSION'};
      const before=row.version;
      const [res]=await conn.execute('UPDATE access_ip_block SET until_ms=?,reason=?,version=version+1,released=0,released_reason=\'\',updated_at=? WHERE ip=? AND version=?',[untilMs,reason,at,ip,before]);
      if(res.affectedRows!==1)return {ok:false,code:'VERSION'};
      await conn.execute("INSERT INTO access_ip_block_audit (ip,action,minutes,reason,version_before,version_after,at) VALUES (?,'block',?,?,?,?,?)",[ip,minutes,reason,before,before+1,at]);
      try{await conn.execute("DELETE FROM access_ip_block_audit WHERE at < ?",[new Date(Date.now()-90*86400000).toISOString()]);}catch{/* 审计清理失败不影响主操作 */}
      return {ok:true,version:before+1};
    });
  }
  // 解封：必须带当前版本（CAS）；已解除/不存在都视为版本冲突，强制管理员刷新后操作。
  // 返回解封后的行版本（B-01：供内存表版本条件删除，旧响应不得删掉其后的重封）
  async releaseBlock({ip,reason,expectedVersion}){
    const at=new Date().toISOString();
    return this._tx(async(conn)=>{
      const [res]=await conn.execute("UPDATE access_ip_block SET released=1,released_reason=?,version=version+1,updated_at=? WHERE ip=? AND version=? AND released=0",[reason,at,ip,expectedVersion]);
      if(res.affectedRows!==1)return {ok:false,code:'VERSION'};
      await conn.execute("INSERT INTO access_ip_block_audit (ip,action,reason,version_before,version_after,at) VALUES (?,'unblock',?,?,?,?)",[ip,reason,expectedVersion,expectedVersion+1,at]);
      return {ok:true,version:expectedVersion+1};
    });
  }
  // start:aigc. R4 修复（混版本读 P2）：一致性目录快照——单连接 + 只读事务，
  // version/sources/baseQuotes/categories 取自同一 InnoDB 一致性视图（首读建立快照），
  // 消除并发保存提交落在多次读取之间造成的"旧版本号配新目录/来源映射错配"
  async catalogSnapshot(){
    const conn=await this.pool.getConnection();
    try{
      await conn.beginTransaction();
      const [[setting]]=await conn.execute('SELECT version,json FROM settings WHERE id=1');
      const [sources]=await conn.execute('SELECT * FROM sources WHERE retired=0 ORDER BY id');
      const baseQuotes=await this._baseQuotesOn(conn);
      const categories=await this._categoriesOn(conn);
      await conn.commit();
      return {config:{...JSON.parse(setting.json),version:setting.version},sources,baseQuotes,categories};
    }catch(e){try{await conn.rollback();}catch{/* 只读事务回滚失败仅透传原异常 */}throw e;}
    finally{conn.release();}
  }
  checkSetup(token){if(typeof token!=='string'||!existsSync(this.setupPath))return false;const expected=readFileSync(this.setupPath,'utf8').trim();return token.length===expected.length&&timingSafeEqual(Buffer.from(token),Buffer.from(expected));}
  async config(){const [rows]=await this.pool.execute('SELECT version,json FROM settings WHERE id=1');const row=rows[0];return {...JSON.parse(row.json),version:row.version};}
  async save(config,expectedVersion){
    // start:aigc. 乐观锁（18.2 定案）：普通读拿 before 快照 → WHERE version=? 条件更新原子校验，matched=0 即并发冲突
    return this._tx(async conn=>{
      const [rows]=await conn.execute('SELECT version,json FROM settings WHERE id=1');
      const previous={...JSON.parse(rows[0].json),version:rows[0].version};
      if(previous.version!==expectedVersion){const e=new Error('配置已被其他窗口修改，请重新加载后再编辑');e.status=409;throw e;}
      const next={...config,version:previous.version+1};
      const changed=next.rows.filter(r=>JSON.stringify(r)!==JSON.stringify(previous.rows.find(p=>p.id===r.id))).map(r=>r.name);
      const summary=changed.length?`修改 ${changed.join('、')}`:'更新品牌、营业时间或排列';
      const [res]=await conn.execute('UPDATE settings SET version=?,json=? WHERE id=1 AND version=?',[next.version,JSON.stringify(next),expectedVersion]);
      if(res.affectedRows!==1){const e=new Error('配置已被其他窗口修改，请重新加载后再编辑');e.status=409;throw e;}
      await conn.execute('INSERT INTO audit (version,at,summary,before_json,after_json) VALUES (?,?,?,?,?)',[next.version,new Date().toISOString(),summary,JSON.stringify(previous),JSON.stringify(next)]);
      return next;
    });
    // end:aigc.
  }
  async audit(){const [rows]=await this.pool.execute('SELECT version,at,summary FROM audit ORDER BY version DESC LIMIT 100');return rows;}
  // start:aigc. 首次启动迁移：把数据源/基础行情 seed 与 defaults.json 的业务品类写入 MySQL（港金换算口径等说明见 SQLite 版注释）
  async migrateCatalog(){
    const [has]=await this.pool.execute('SELECT id FROM sources LIMIT 1');
    if(has.length)return;
    await this._tx(async conn=>{
      const seeds=SOURCES.map((s)=>[s.id,s.name,s.type,s.enabled?1:0]);
      for(const [id,name,type,enabled] of seeds)await conn.execute('INSERT INTO sources (id,name,type,enabled,priority) VALUES (?,?,?, ?,0) ON DUPLICATE KEY UPDATE id=id',[id,name,type,enabled]);
      const HKD_BUY='(【#伦敦金#回购价】*【#美元兑港元#回购价】*37.429/31.1034768*0.99)*1+0';
      const HKD_SELL='(【#伦敦金#销售价】*【#美元兑港元#销售价】*37.429/31.1034768*0.99)*1+0';
      const HKD_HIGH='(【#伦敦金#最高价】*【#美元兑港元#销售价】*37.429/31.1034768*0.99)*1+0';
      const HKD_LOW='(【#伦敦金#最低价】*【#美元兑港元#销售价】*37.429/31.1034768*0.99)*1+0';
      const HARD_GAPS=new Set(['公斤条','公斤铂','公斤钯','公斤银','沪金次主力','沪银次主力','美铑金']);
      // rows 取自当前生效配置（用户可能已改过基差/自定义品类/排序），避免升级丢失用户配置（R01）
      const [settingRows]=await conn.execute('SELECT version,json FROM settings WHERE id=1');
      const rows=JSON.parse(settingRows[0].json).rows;
      for(const bq of BASE_QUOTES){
        await conn.execute('INSERT INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES (?,?,?,?,1) ON DUPLICATE KEY UPDATE symbol=symbol',[bq.symbol,bq.name,bq.unit,bq.decimals]);
        for(const s of bq.sources)await conn.execute('INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,?,?,?,?,1,?) ON DUPLICATE KEY UPDATE symbol=symbol',[bq.symbol,s.sourceId,s.priority,s.kind,s.code??null,s.staleMs??null]);
      }
      for(const [i,r] of rows.entries()){
        if(HARD_GAPS.has(r.name))continue;
        const isHk=r.name==='港金';
        await conn.execute('INSERT INTO categories (id,name,visible,buy_formula,sell_formula,high_formula,low_formula,decimals,rounding,sort) VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id',[r.id,r.name,r.visible?1:0,isHk?HKD_BUY:r.buyFormula,isHk?HKD_SELL:r.sellFormula,isHk?HKD_HIGH:r.highFormula,isHk?HKD_LOW:r.lowFormula,r.decimals,r.rounding,i]);
      }
    });
  }
  // T07 版本化一次性迁移：migrations 表登记，已执行过的名字直接跳过；事务与登记同一事务提交
  async runMigration(name,fn){
    const [exists]=await this.pool.execute('SELECT name FROM migrations WHERE name=?',[name]);
    if(exists.length)return false;
    let ran=false;
    await this._tx(async conn=>{
      await fn(conn);
      await conn.execute('INSERT INTO migrations (name,at) VALUES (?,?)',[name,new Date().toISOString()]);
      ran=true;
    });
    return ran;
  }
  // R03 备援补登记（内部不再开事务，由 runMigration 的事务覆盖；时效红线 20s 说明见 SQLite 版注释）
  async upgradeSinaFailover(conn){
    const FAILBACK=[['美黄金','hf_GC'],['美白银','hf_SI']];
    const DISCARD=[['伦敦金','hf_XAU'],['伦敦银','hf_XAG'],['美铂金','hf_XPT'],['美钯金','hf_XPD'],['伦敦铂','hf_XPT'],['伦敦钯','hf_XPD']];
    for(const [symbol,code] of FAILBACK)await conn.execute('INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,\'sina\',2,\'sina\',?,1,20000) ON DUPLICATE KEY UPDATE symbol=symbol',[symbol,code]);
    for(const [symbol,code] of DISCARD)await conn.execute('UPDATE base_quote_sources SET enabled=0, stale_ms=20000 WHERE symbol=? AND source_id=\'sina\' AND code=?',[symbol,code]);
    await conn.execute("UPDATE base_quote_sources SET stale_ms=20000 WHERE source_id='sina' AND code IN ('hf_GC','hf_SI') AND stale_ms IS NULL");
  }
  // start:aigc. 2026-10-28 换源迁移（wscnSources）：新增见闻/腾讯/iTick 三个源与映射，
  // 禁用（不删除，保留回滚余地）被机房 403 封死的新浪行。口径依据见 catalog.mjs 注释。
  async upgradeWscnSources(conn){
    // 1) 登记新数据源（sources 表 ON DUPLICATE 跳过）
    for(const [id,name] of [['wscn','华尔街见闻'],['tencent','腾讯'],['itick','iTick']])
      await conn.execute('INSERT INTO sources (id,name,type,enabled,priority) VALUES (?,?,"http",1,0) ON DUPLICATE KEY UPDATE id=id',[id,name]);
    // 2) 登记新映射：美元指数（wscn 主 + itick 备）、美元兑港元（wscn 主）、美黄金/美白银备援（腾讯，与原 sina 备援同红线 20s）
    const INS='INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,?,?,?,?,1,?) ON DUPLICATE KEY UPDATE symbol=symbol';
    await conn.execute(INS,['美元指数','wscn',1,'wscn','DXY.OTC',null]);
    await conn.execute(INS,['美元指数','itick',2,'itick','DXY',null]);
    await conn.execute(INS,['美元兑港元','wscn',1,'wscn','USDHKD.OTC',null]);
    await conn.execute(INS,['美黄金','tencent',2,'tencent','hf_GC',20000]);
    await conn.execute(INS,['美白银','tencent',2,'tencent','hf_SI',20000]);
    // 3) 禁用被封死的旧映射：新浪（美元指数/港汇/美黄金/美白银备援）与未实现的 yahoo 占位。
    //    沪金/沪银主力的 sina 行保留：本地开发仍可用，暂无替代源（见闻无上期所）
    await conn.execute("UPDATE base_quote_sources SET enabled=0 WHERE source_id='sina' AND ((symbol='美元指数' AND code='DINIW') OR (symbol='美元兑港元' AND code='fx_susdhkd') OR (symbol IN ('美黄金','美白银') AND code IN ('hf_GC','hf_SI')))");
    await conn.execute("UPDATE base_quote_sources SET enabled=0 WHERE symbol='美元指数' AND source_id='yahoo'");
  }
  // end:aigc.
  async sources(){const [rows]=await this.pool.execute('SELECT * FROM sources WHERE retired=0 ORDER BY id');return rows;}
  async _baseQuotesOn(conn){
    const [base]=await conn.execute('SELECT * FROM base_quotes ORDER BY symbol');
    const [srows]=await conn.execute('SELECT * FROM base_quote_sources ORDER BY symbol, priority');
    return base.map((b)=>({...b,enabled:!!b.enabled,sources:srows.filter((s)=>s.symbol===b.symbol).map((s)=>({sourceId:s.source_id,priority:s.priority,kind:s.kind,code:s.code,enabled:!!s.enabled,staleMs:s.stale_ms}))}));
  }
  async baseQuotes(){return this._baseQuotesOn(this.pool);}
  async _categoriesOn(conn){
    const [rows]=await conn.execute('SELECT id,name,visible,buy_formula AS buyFormula,sell_formula AS sellFormula,high_formula AS highFormula,low_formula AS lowFormula,decimals,rounding,sort FROM categories ORDER BY sort');
    return rows.map((c)=>({...c,visible:!!c.visible}));
  }
  async categories(){return this._categoriesOn(this.pool);}
  async saveBaseQuotes(list){
    await this._tx(async conn=>{
      const up='UPDATE base_quotes SET name=?, unit=?, decimals=?, enabled=? WHERE symbol=?';
      const upS='UPDATE base_quote_sources SET priority=?, kind=?, code=?, enabled=? WHERE symbol=? AND source_id=?';
      for(const b of list){await conn.execute(up,[b.name,b.unit,b.decimals,b.enabled?1:0,b.symbol]);for(const s of(b.sources||[]))await conn.execute(upS,[s.priority,s.kind,s.code??null,s.enabled===false?0:1,b.symbol,s.sourceId]);}
    });
  }
  async saveCategories(list){
    await this._tx(async conn=>{
      const up='UPDATE categories SET name=?, visible=?, buy_formula=?, sell_formula=?, high_formula=?, low_formula=?, decimals=?, rounding=? WHERE id=?';
      for(const c of list)await conn.execute(up,[c.name,c.visible?1:0,c.buyFormula,c.sellFormula,c.highFormula,c.lowFormula,c.decimals,c.rounding,c.id]);
    });
  }
  // 三元目录整体保存（diff 语义，R10）：以提交列表为准——UPDATE 未命中（affectedRows=0）则 INSERT、库中多余 DELETE；
  // 与 settings 共用版本号做乐观锁（18.2：事务开头先条件更新版本行，拿行锁并原子校验），单事务落库并写 audit
  async saveCatalog(baseQuotes,categories,expectedVersion){
    return this._tx(async conn=>{
      const [res]=await conn.execute('UPDATE settings SET version=version+1 WHERE id=1 AND version=?',[expectedVersion]);
      if(res.affectedRows!==1){const e=new Error('目录已被其他窗口修改，请重新加载后再编辑');e.status=409;throw e;}
      const before=JSON.stringify({baseQuotes:await this._baseQuotesOn(conn),categories:await this._categoriesOn(conn)});
      const catIds=categories.map((c)=>c.id);
      const upC='UPDATE categories SET name=?, visible=?, buy_formula=?, sell_formula=?, high_formula=?, low_formula=?, decimals=?, rounding=?, sort=? WHERE id=?';
      const insC='INSERT INTO categories (id,name,visible,buy_formula,sell_formula,high_formula,low_formula,decimals,rounding,sort) VALUES (?,?,?,?,?,?,?,?,?,?)';
      for(const [i,c] of categories.entries()){
        const args=[c.name,c.visible?1:0,c.buyFormula,c.sellFormula,c.highFormula,c.lowFormula,c.decimals,c.rounding];
        const [r]=await conn.execute(upC,[...args,i,c.id]);
        if(r.affectedRows!==1)await conn.execute(insC,[c.id,...args,i]);
      }
      if(catIds.length)await conn.execute(`DELETE FROM categories WHERE id NOT IN (${catIds.map(()=>'?').join(',')})`,catIds);
      else await conn.query('DELETE FROM categories');
      const symbols=baseQuotes.map((b)=>b.symbol);
      const upB='UPDATE base_quotes SET name=?, unit=?, decimals=?, enabled=? WHERE symbol=?';
      const insB='INSERT INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES (?,?,?,?,?)';
      for(const b of baseQuotes){
        const [r]=await conn.execute(upB,[b.name,b.unit,b.decimals,b.enabled?1:0,b.symbol]);
        if(r.affectedRows!==1)await conn.execute(insB,[b.symbol,b.name,b.unit,b.decimals,b.enabled?1:0]);
      }
      if(symbols.length)await conn.execute(`DELETE FROM base_quotes WHERE symbol NOT IN (${symbols.map(()=>'?').join(',')})`,symbols);
      else await conn.query('DELETE FROM base_quotes');
      await conn.query('DELETE FROM base_quote_sources');
      const insS='INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,?,?,?,?,?,?)';
      for(const b of baseQuotes)for(const s of(b.sources||[]))await conn.execute(insS,[b.symbol,s.sourceId,s.priority,s.kind,s.code??null,s.enabled===false?0:1,s.staleMs??null]);
      const nextVersion=expectedVersion+1;
      const after=JSON.stringify({baseQuotes:await this._baseQuotesOn(conn),categories:await this._categoriesOn(conn)});
      await conn.execute('INSERT INTO audit (version,at,summary,before_json,after_json) VALUES (?,?,?,?,?)',[nextVersion,new Date().toISOString(),'更新行情目录',before,after]);
      return nextVersion;
    });
  }
  async appendSwitchLog(entry){
    await this.pool.execute('INSERT INTO switch_log (at,symbol,old_source,new_source,mode,reason) VALUES (?,?,?,?,?,?)',[new Date(entry.time||Date.now()).toISOString(),entry.symbol,entry.oldSource??null,entry.newSource??null,entry.mode??null,entry.reason??null]);
  }
  async switchLogs(limit=200){const [rows]=await this.pool.execute('SELECT * FROM switch_log ORDER BY id DESC LIMIT ?',[Number(limit)]);return rows;}
  // 来源密钥加密存储：AES-256-GCM，主密钥为 data/secret.key（不存在则生成，0600）——文件逻辑与 SQLite 版一致
  _keyPath(){return join(this.dir,'secret.key');}
  _key(){
    const p=this._keyPath();
    if(!existsSync(p))writeFileSync(p,randomBytes(32),{mode:0o600,flag:'wx'});
    return createHash('sha256').update(readFileSync(p)).digest();
  }
  async setSourceSecret(sourceId,secret){
    const iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',this._key(),iv);
    const enc=Buffer.concat([cipher.update(String(secret),'utf8'),cipher.final()]);
    const payload=Buffer.concat([iv,cipher.getAuthTag(),enc]).toString('base64');
    await this.pool.execute('INSERT INTO source_secrets (source_id,secret_ciphertext) VALUES (?,?) ON DUPLICATE KEY UPDATE secret_ciphertext=VALUES(secret_ciphertext)',[sourceId,payload]);
  }
  async getSourceSecret(sourceId){
    const [rows]=await this.pool.execute('SELECT secret_ciphertext FROM source_secrets WHERE source_id=?',[sourceId]);
    if(!rows.length)return null;
    const buf=Buffer.from(rows[0].secret_ciphertext,'base64');
    const iv=buf.subarray(0,12),tag=buf.subarray(12,28),enc=buf.subarray(28);
    const d=createDecipheriv('aes-256-gcm',this._key(),iv);d.setAuthTag(tag);
    return Buffer.concat([d.update(enc),d.final()]).toString('utf8');
  }
  async hasSourceSecret(sourceId){const [rows]=await this.pool.execute('SELECT source_id FROM source_secrets WHERE source_id=?',[sourceId]);return rows.length>0;}
  // start:aigc. 数据源红绿灯持久化（设计文档"最近成功时间、最近错误"）：由 server 层节流写回，
  // 重启后 /api/admin/sources 以库值为兜底展示（MySQL 方案 6.2：不在每个 tick 上查库/写库）。
  // F02（四查）：null 表示"本进程无新事件"（如重启后首轮无行情），不代表清除历史——
  // COALESCE 保留库中已有值，最近成功只前进、最近错误只在出现新错误时覆盖（恢复不抹历史）
  async updateSourceHealth(sourceId,lastSuccessAt,lastError){
    await this.pool.execute('UPDATE sources SET last_success_at=COALESCE(?,last_success_at), last_error=COALESCE(?,last_error) WHERE id=?',[lastSuccessAt,lastError,sourceId]);
  }
  // 清除来源密钥（后台"清除密钥"操作）
  async deleteSourceSecret(sourceId){await this.pool.execute('DELETE FROM source_secrets WHERE source_id=?',[sourceId]);}
  // end:aigc.
  async close(){await this.pool.end();}
}

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
import {SOURCES,BASE_QUOTES} from './catalog.mjs';
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
    await conn.query('CREATE TABLE IF NOT EXISTS audit (version INT PRIMARY KEY, at VARCHAR(40) NOT NULL, summary VARCHAR(512) NOT NULL, before_json MEDIUMTEXT NOT NULL, after_json MEDIUMTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
    // M05/F03：判定"旧版三层库"——base_quote_sources 已存在而 migrations 不存在（两表都查的原因见 SQLite 版注释）
    const legacyThreeLayer=await this._tableExists(conn,'base_quote_sources')&&!await this._tableExists(conn,'migrations');
    await conn.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL, name VARCHAR(128) NOT NULL, type VARCHAR(32) NOT NULL, enabled TINYINT NOT NULL DEFAULT 1, priority INT NOT NULL DEFAULT 0, poll_ms INT, timeout_ms INT, stale_ms INT, last_success_at VARCHAR(40), last_error TEXT, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci');
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
    // end:aigc.
  }
  // end:aigc.
  async hasAdmin(){const [rows]=await this.pool.execute('SELECT id FROM admin WHERE id=1');return rows.length>0;}
  async getHash(){const [rows]=await this.pool.execute('SELECT hash FROM admin WHERE id=1');return rows[0]?.hash;}
  async setPassword(hash){await this.pool.execute('INSERT INTO admin (id,hash) VALUES (1,?) ON DUPLICATE KEY UPDATE hash=VALUES(hash)',[hash]);if(existsSync(this.setupPath))unlinkSync(this.setupPath);}
  // start:aigc. R2 修复（并发覆盖 P1）：原子初始化——纯 INSERT，主键冲突即"已初始化"，
  // 消除 setup 路由"先查 hasAdmin 再写"两步之间的竞态窗口（两请求都返回 200、密码被后写覆盖）
  async setPasswordIfAbsent(hash){
    try{await this.pool.execute('INSERT INTO admin (id,hash) VALUES (1,?)',[hash]);if(existsSync(this.setupPath))unlinkSync(this.setupPath);return true;}
    catch(e){if(e.code==='ER_DUP_ENTRY')return false;throw e;}
  }
  // start:aigc. R3 修复（并发覆盖 P1）：原子改密——UPDATE 带旧哈希条件，他人已改则匹配 0 行返回 false
  async replacePassword(oldHash,newHash){
    const [res]=await this.pool.execute('UPDATE admin SET hash=? WHERE id=1 AND hash=?',[newHash,oldHash]);
    return res.affectedRows===1;
  }
  // start:aigc. R4 修复（混版本读 P2）：一致性目录快照——单连接 + 只读事务，
  // version/sources/baseQuotes/categories 取自同一 InnoDB 一致性视图（首读建立快照），
  // 消除并发保存提交落在多次读取之间造成的"旧版本号配新目录/来源映射错配"
  async catalogSnapshot(){
    const conn=await this.pool.getConnection();
    try{
      await conn.beginTransaction();
      const [[setting]]=await conn.execute('SELECT version,json FROM settings WHERE id=1');
      const [sources]=await conn.execute('SELECT * FROM sources ORDER BY id');
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
  async sources(){const [rows]=await this.pool.execute('SELECT * FROM sources ORDER BY id');return rows;}
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

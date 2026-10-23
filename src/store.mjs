import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
// start:aigc. 来源密钥加密所需 crypto 原语
import {randomBytes,scrypt,timingSafeEqual,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
// end:aigc.
import {promisify} from 'node:util';
import {validateConfig} from './config.mjs';
import {SOURCES,BASE_QUOTES} from './catalog.mjs';
const derive=promisify(scrypt);
export async function passwordHash(password,salt=randomBytes(16).toString('hex')){
  const key=await derive(password,salt,64);return `${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password,hash){if(typeof password!=='string'||password.length>256||!hash)return false;const [salt,expected]=hash.split(':');const actual=await passwordHash(password,salt);return timingSafeEqual(Buffer.from(actual.split(':')[1],'hex'),Buffer.from(expected,'hex'));}
export function validPassword(password){if(typeof password!=='string'||password.length<12||password.length>256)throw new Error('密码长度必须为12至256个字符');}

export class Store{
  constructor(dir){
    this.dir=dir;mkdirSync(dir,{recursive:true});
    this.db=new DatabaseSync(join(dir,'quotes.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (version INTEGER PRIMARY KEY, at TEXT NOT NULL, summary TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL);');
    // start:aigc.
    // 三层行情模型建表：数据源(sources)、基础行情(base_quotes)、基础行情与数据源映射(base_quote_sources)、业务品类(categories)与切换日志(switch_log)。
    this.db.exec('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, poll_ms INTEGER, timeout_ms INTEGER, stale_ms INTEGER, last_success_at TEXT, last_error TEXT); CREATE TABLE IF NOT EXISTS base_quotes (symbol TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT \'\', decimals INTEGER NOT NULL DEFAULT 2, enabled INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS base_quote_sources (symbol TEXT NOT NULL, source_id TEXT NOT NULL, priority INTEGER NOT NULL, kind TEXT NOT NULL, code TEXT, enabled INTEGER NOT NULL DEFAULT 1, stale_ms INTEGER, PRIMARY KEY (symbol, source_id)); CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1, buy_formula TEXT NOT NULL DEFAULT \'\', sell_formula TEXT NOT NULL DEFAULT \'\', high_formula TEXT NOT NULL DEFAULT \'\', low_formula TEXT NOT NULL DEFAULT \'\', decimals INTEGER NOT NULL DEFAULT 2, rounding TEXT NOT NULL DEFAULT \'half-up\', sort INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS switch_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, symbol TEXT NOT NULL, old_source TEXT, new_source TEXT, mode TEXT, reason TEXT); CREATE TABLE IF NOT EXISTS source_secrets (source_id TEXT PRIMARY KEY, secret_ciphertext TEXT NOT NULL); CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at TEXT NOT NULL);');
    // end:aigc.
    // start:aigc. 旧版本已建 base_quote_sources 无 stale_ms 列，幂等补列（列已存在时忽略报错）
    try{this.db.exec('ALTER TABLE base_quote_sources ADD COLUMN stale_ms INTEGER');}catch{/* 列已存在 */}
    // end:aigc.
    if(!this.db.prepare('SELECT id FROM settings WHERE id=1').get()){
      const defaults=validateConfig(JSON.parse(readFileSync(new URL('./defaults.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')));
      this.db.prepare('INSERT INTO settings VALUES(1,1,?)').run(JSON.stringify(defaults));
    }
    this.setupPath=join(dir,'setup-token.txt');
    if(!this.hasAdmin()&&!existsSync(this.setupPath))writeFileSync(this.setupPath,randomBytes(24).toString('hex'),{mode:0o600,flag:'wx'});
    if(this.hasAdmin()&&existsSync(this.setupPath))unlinkSync(this.setupPath);
    // start:aigc.
    // 构造末尾执行一次目录迁移，已迁移过(sources 已有数据)时内部直接返回，不重复迁移。
    this.migrateCatalog();
    // R03：旧种子迁移过的库补上新浪外盘备援映射。
    // T07：一次性数据修正经 migrations 表登记只执行一次，迁移后运行期尊重用户目录。
    this.runMigration('sinaFailover', () => this.upgradeSinaFailover());
    // end:aigc.
  }
  hasAdmin(){return !!this.db.prepare('SELECT id FROM admin WHERE id=1').get();}
  getHash(){return this.db.prepare('SELECT hash FROM admin WHERE id=1').get()?.hash;}
  setPassword(hash){this.db.prepare('INSERT INTO admin VALUES(1,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash').run(hash);if(existsSync(this.setupPath))unlinkSync(this.setupPath);}
  checkSetup(token){if(this.hasAdmin()||typeof token!=='string'||!existsSync(this.setupPath))return false;const expected=readFileSync(this.setupPath,'utf8').trim();return token.length===expected.length&&timingSafeEqual(Buffer.from(token),Buffer.from(expected));}
  config(){const row=this.db.prepare('SELECT version,json FROM settings WHERE id=1').get();return {...JSON.parse(row.json),version:row.version};}
  save(config,expectedVersion){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.config();if(previous.version!==expectedVersion){const e=new Error('配置已被其他窗口修改，请重新加载后再编辑');e.status=409;throw e;}
      const next={...config,version:previous.version+1};
      const changed=next.rows.filter(r=>JSON.stringify(r)!==JSON.stringify(previous.rows.find(p=>p.id===r.id))).map(r=>r.name);
      const summary=changed.length?`修改 ${changed.join('、')}`:'更新品牌、营业时间或排列';
      this.db.prepare('UPDATE settings SET version=?,json=? WHERE id=1').run(next.version,JSON.stringify(next));
      this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(next.version,new Date().toISOString(),summary,JSON.stringify(previous),JSON.stringify(next));
      this.db.exec('COMMIT');return next;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  audit(){return this.db.prepare('SELECT version,at,summary FROM audit ORDER BY version DESC LIMIT 100').all();}
  async backup(path){await backup(this.db,path);}
  // start:aigc.
  // 首次启动迁移：把数据源/基础行情 seed 与 defaults.json 的业务品类写入 SQLite。
  // 港金公式在此处按换算口径构造：伦敦金×USD/HKD×37.429÷31.1034768×成色系数0.99，再套系数与基差。
  // 硬缺口品类（公斤条/公斤铂/公斤钯/公斤银/沪金次主力/沪银次主力/美铑金）不迁入，后续由用户自行配置。
  migrateCatalog(){
    const hasSources=!!this.db.prepare('SELECT id FROM sources LIMIT 1').get();
    if(hasSources)return;
    // 迁移整体包在事务内：任一步失败即整体回滚，避免 sources 已写入而 base_quotes/categories
    // 缺失，导致下次启动因幂等守卫直接跳过、永久缺表。
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const insertSource=this.db.prepare('INSERT OR IGNORE INTO sources (id,name,type,enabled,priority) VALUES (?,?,?,?,?)');
      for(const s of SOURCES)insertSource.run(s.id,s.name,s.type,s.enabled?1:0,0);
      const insertBq=this.db.prepare('INSERT OR IGNORE INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES (?,?,?,?,1)');
      // start:aigc. 迁移写入 per-source 过期阈值 stale_ms（新浪 hf_ 备援更新周期长，放宽至 120s）
      const insertBqs=this.db.prepare('INSERT OR IGNORE INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,?,?,?,?,1,?)');
      for(const bq of BASE_QUOTES){
        insertBq.run(bq.symbol,bq.name,bq.unit,bq.decimals);
        for(const s of bq.sources)insertBqs.run(bq.symbol,s.sourceId,s.priority,s.kind,s.code??null,s.staleMs??null);
      }
      // 业务品类：港金公式替换为换算口径。
      // 迁移源用现有生效配置（settings.rows，用户可能已改过基差/自定义品类/排序），
      // 而不是 defaults.json——否则升级丢失用户配置（R01）
      const rows=this.config().rows;
      const insertCat=this.db.prepare('INSERT OR IGNORE INTO categories (id,name,visible,buy_formula,sell_formula,high_formula,low_formula,decimals,rounding,sort) VALUES (?,?,?,?,?,?,?,?,?,?)');
      const HKD_BUY='(【#伦敦金#回购价】*【#美元兑港元#回购价】*37.429/31.1034768*0.99)*1+0';
      const HKD_SELL='(【#伦敦金#销售价】*【#美元兑港元#销售价】*37.429/31.1034768*0.99)*1+0';
      // 港金最高/最低同样按换算口径：自引用透传（【#港金#最高价】）在环检测中因港金
      // 不在基础行情 symbol 集合而被判自环，且运行时该键无来源、恒为空值。
      const HKD_HIGH='(【#伦敦金#最高价】*【#美元兑港元#销售价】*37.429/31.1034768*0.99)*1+0';
      const HKD_LOW='(【#伦敦金#最低价】*【#美元兑港元#销售价】*37.429/31.1034768*0.99)*1+0';
      // 硬缺口品类按 name 精确排除（公斤条出现两次也都排除）
      const HARD_GAPS=new Set(['公斤条','公斤铂','公斤钯','公斤银','沪金次主力','沪银次主力','美铑金']);
      rows.forEach((r,i)=>{
        if(HARD_GAPS.has(r.name))return;
        const isHk=r.name==='港金';
        insertCat.run(r.id,r.name,r.visible?1:0,
          isHk?HKD_BUY:r.buyFormula,isHk?HKD_SELL:r.sellFormula,
          isHk?HKD_HIGH:r.highFormula,isHk?HKD_LOW:r.lowFormula,
          r.decimals,r.rounding,i);
      });
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // start:aigc.
  // T07 版本化一次性迁移：migrations 表登记，已执行过的名字直接跳过。
  // 此前 upgradeSinaFailover 每次启动都跑，用户删除的映射会复活、手动启用的
  // DISCARD 项会被重启强制禁回——与后台"永久删除/可再启用"的产品语义矛盾。
  // 事务与登记同一事务提交：执行成功必然留痕，留痕即不再执行。
  runMigration(name, fn) {
    if (this.db.prepare('SELECT name FROM migrations WHERE name=?').get(name)) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.prepare('INSERT INTO migrations VALUES(?,?)').run(name, new Date().toISOString());
      this.db.exec('COMMIT');
      return true;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  // end:aigc.
  // start:aigc.
  // R03 备援补登记（T07 版本化，经 runMigration 只执行一次，内部不再开事务）：
  // 旧种子迁移过的库补上新浪备援映射（外盘 hf_ 系列）。
  // 时效红线 20s（用户口径）：仅保留实测时延 ~0s 的美黄金/美白银备援（stale_ms=20s）。
  // hf_XAU/XAG/XPT/XPD 实测 22~122s 超红线，从登记清单移除并禁用早前已插入的行（enabled=0，可再启用）。
  upgradeSinaFailover(){
    const FAILBACK=[['美黄金','hf_GC'],['美白银','hf_SI']];
    const DISCARD=[['伦敦金','hf_XAU'],['伦敦银','hf_XAG'],['美铂金','hf_XPT'],['美钯金','hf_XPD'],['伦敦铂','hf_XPT'],['伦敦钯','hf_XPD']];
    const ins=this.db.prepare('INSERT OR IGNORE INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,?,?,?,?,1,20000)');
    const dis=this.db.prepare('UPDATE base_quote_sources SET enabled=0, stale_ms=20000 WHERE symbol=? AND source_id=? AND code=?');
    for(const [symbol,code] of FAILBACK)ins.run(symbol,'sina',2,'sina',code);
    for(const [symbol,code] of DISCARD)dis.run(symbol,'sina',code);
    this.db.prepare("UPDATE base_quote_sources SET stale_ms=20000 WHERE source_id='sina' AND code IN ('hf_GC','hf_SI') AND stale_ms IS NULL").run();
  }
  // end:aigc.
  sources(){return this.db.prepare('SELECT * FROM sources ORDER BY id').all();}
  baseQuotes(){
    const base=this.db.prepare('SELECT * FROM base_quotes ORDER BY symbol').all();
    const srows=this.db.prepare('SELECT * FROM base_quote_sources ORDER BY symbol, priority').all();
    // start:aigc. 读取含 per-source 过期阈值 staleMs（未配置为 null，选择器回落全局默认）
    return base.map((b)=>({...b,enabled:!!b.enabled,sources:srows.filter((s)=>s.symbol===b.symbol).map((s)=>({sourceId:s.source_id,priority:s.priority,kind:s.kind,code:s.code,enabled:!!s.enabled,staleMs:s.stale_ms}))}));
    // end:aigc.
  }
  categories(){
    return this.db.prepare('SELECT id,name,visible,buy_formula AS buyFormula,sell_formula AS sellFormula,high_formula AS highFormula,low_formula AS lowFormula,decimals,rounding,sort FROM categories ORDER BY sort').all()
      .map((c)=>({...c,visible:!!c.visible}));
  }
  saveBaseQuotes(list){
    const up=this.db.prepare('UPDATE base_quotes SET name=?, unit=?, decimals=?, enabled=? WHERE symbol=?');
    const upS=this.db.prepare('UPDATE base_quote_sources SET priority=?, kind=?, code=?, enabled=? WHERE symbol=? AND source_id=?');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const b of list){up.run(b.name,b.unit,b.decimals,b.enabled?1:0,b.symbol);for(const s of(b.sources||[]))upS.run(s.priority,s.kind,s.code??null,s.enabled===false?0:1,b.symbol,s.sourceId);}
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  saveCategories(list){
    const up=this.db.prepare('UPDATE categories SET name=?, visible=?, buy_formula=?, sell_formula=?, high_formula=?, low_formula=?, decimals=?, rounding=? WHERE id=?');
    this.db.exec('BEGIN IMMEDIATE');
    try{for(const c of list)up.run(c.name,c.visible?1:0,c.buyFormula,c.sellFormula,c.highFormula,c.lowFormula,c.decimals,c.rounding,c.id);this.db.exec('COMMIT');}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // start:aigc.
  // 三元目录整体保存（diff 语义，R10）：以提交列表为准——已存在 UPDATE、新 id/symbol
  // INSERT、库中多余 DELETE；品类 sort 按提交顺序重排。与 settings 共用版本号做乐观锁，
  // 单事务落库并写 audit。来源映射整体重建（表小且无外键，事务内先清后插等价且更简单）。
  saveCatalog(baseQuotes,categories,expectedVersion){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const current=this.db.prepare('SELECT version FROM settings WHERE id=1').get();
      if(current.version!==expectedVersion){const e=new Error('目录已被其他窗口修改，请重新加载后再编辑');e.status=409;throw e;}
      const before=JSON.stringify({baseQuotes:this.baseQuotes(),categories:this.categories()});
      // 业务品类：按 id diff，sort=数组下标
      const catIds=categories.map((c)=>c.id);
      const upC=this.db.prepare('UPDATE categories SET name=?, visible=?, buy_formula=?, sell_formula=?, high_formula=?, low_formula=?, decimals=?, rounding=?, sort=? WHERE id=?');
      const insC=this.db.prepare('INSERT INTO categories (id,name,visible,buy_formula,sell_formula,high_formula,low_formula,decimals,rounding,sort) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for(const [i,c] of categories.entries()){
        const args=[c.name,c.visible?1:0,c.buyFormula,c.sellFormula,c.highFormula,c.lowFormula,c.decimals,c.rounding];
        if(upC.run(...args,i,c.id).changes!==1)insC.run(c.id,...args,i);
      }
      if(catIds.length)this.db.prepare(`DELETE FROM categories WHERE id NOT IN (${catIds.map(()=>'?').join(',')})`).run(...catIds);
      else this.db.exec('DELETE FROM categories');
      // 基础行情：按 symbol diff
      const symbols=baseQuotes.map((b)=>b.symbol);
      const upB=this.db.prepare('UPDATE base_quotes SET name=?, unit=?, decimals=?, enabled=? WHERE symbol=?');
      const insB=this.db.prepare('INSERT INTO base_quotes (symbol,name,unit,decimals,enabled) VALUES (?,?,?,?,?)');
      for(const b of baseQuotes){
        if(upB.run(b.name,b.unit,b.decimals,b.enabled?1:0,b.symbol).changes!==1)insB.run(b.symbol,b.name,b.unit,b.decimals,b.enabled?1:0);
      }
      if(symbols.length)this.db.prepare(`DELETE FROM base_quotes WHERE symbol NOT IN (${symbols.map(()=>'?').join(',')})`).run(...symbols);
      else this.db.exec('DELETE FROM base_quotes');
      // 来源映射：整体重建
      this.db.exec('DELETE FROM base_quote_sources');
      // start:aigc. 重建映射保留 per-source 过期阈值（admin 编辑不丢失 staleMs）
      const insS=this.db.prepare('INSERT INTO base_quote_sources (symbol,source_id,priority,kind,code,enabled,stale_ms) VALUES (?,?,?,?,?,?,?)');
      for(const b of baseQuotes)for(const s of(b.sources||[]))insS.run(b.symbol,s.sourceId,s.priority,s.kind,s.code??null,s.enabled===false?0:1,s.staleMs??null);
      const nextVersion=current.version+1;
      this.db.prepare('UPDATE settings SET version=? WHERE id=1').run(nextVersion);
      const after=JSON.stringify({baseQuotes:this.baseQuotes(),categories:this.categories()});
      this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(nextVersion,new Date().toISOString(),'更新行情目录',before,after);
      this.db.exec('COMMIT');return nextVersion;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // end:aigc.
  appendSwitchLog(entry){
    this.db.prepare('INSERT INTO switch_log (at,symbol,old_source,new_source,mode,reason) VALUES (?,?,?,?,?,?)')
      .run(new Date(entry.time||Date.now()).toISOString(),entry.symbol,entry.oldSource??null,entry.newSource??null,entry.mode??null,entry.reason??null);
  }
  switchLogs(limit=200){
    return this.db.prepare('SELECT * FROM switch_log ORDER BY id DESC LIMIT ?').all(limit);
  }
  // end:aigc.
  // start:aigc.
  // 来源密钥加密存储：AES-256-GCM，主密钥为 data/secret.key（不存在则生成，0600）。
  // 密文落 source_secrets 表；对外接口尽量只判断是否已配置，明文仅在内部取用时解密。
  _keyPath(){return join(this.dir,'secret.key');}
  _key(){
    const p=this._keyPath();
    if(!existsSync(p))writeFileSync(p,randomBytes(32),{mode:0o600,flag:'wx'});
    return createHash('sha256').update(readFileSync(p)).digest();
  }
  setSourceSecret(sourceId,secret){
    const iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',this._key(),iv);
    const enc=Buffer.concat([cipher.update(String(secret),'utf8'),cipher.final()]);
    const payload=Buffer.concat([iv,cipher.getAuthTag(),enc]).toString('base64');
    this.db.prepare('INSERT INTO source_secrets VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext').run(sourceId,payload);
  }
  getSourceSecret(sourceId){
    const row=this.db.prepare('SELECT secret_ciphertext FROM source_secrets WHERE source_id=?').get(sourceId);
    if(!row)return null;
    const buf=Buffer.from(row.secret_ciphertext,'base64');
    const iv=buf.subarray(0,12),tag=buf.subarray(12,28),enc=buf.subarray(28);
    const d=createDecipheriv('aes-256-gcm',this._key(),iv);d.setAuthTag(tag);
    return Buffer.concat([d.update(enc),d.final()]).toString('utf8');
  }
  hasSourceSecret(sourceId){return !!this.db.prepare('SELECT source_id FROM source_secrets WHERE source_id=?').get(sourceId);}
  // end:aigc.
  close(){this.db.close();}
}

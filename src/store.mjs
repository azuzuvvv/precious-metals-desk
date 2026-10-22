import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {validateConfig} from './config.mjs';
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
    if(!this.db.prepare('SELECT id FROM settings WHERE id=1').get()){
      const defaults=validateConfig(JSON.parse(readFileSync(new URL('./defaults.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')));
      this.db.prepare('INSERT INTO settings VALUES(1,1,?)').run(JSON.stringify(defaults));
    }
    this.setupPath=join(dir,'setup-token.txt');
    if(!this.hasAdmin()&&!existsSync(this.setupPath))writeFileSync(this.setupPath,randomBytes(24).toString('hex'),{mode:0o600,flag:'wx'});
    if(this.hasAdmin()&&existsSync(this.setupPath))unlinkSync(this.setupPath);
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
  close(){this.db.close();}
}

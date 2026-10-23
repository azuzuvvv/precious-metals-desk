import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve,extname} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store,passwordHash,passwordMatches,validPassword} from './store.mjs';
// start:aigc.
import {validateConfig,validateCatalog,snapshot} from './config.mjs';
// end:aigc.
// start:aigc.
import {attachSina} from './sina.mjs';
import {Quotes} from './quotes.mjs';
import {createRtj} from './rtj.mjs';
// end:aigc.

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const error=(status,message)=>Object.assign(new Error(message),{status});
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256000)throw error(413,'请求内容过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error(400,'JSON格式无效');}}

export async function createApp({dataDir=join(project,'data'),quotes=null,publicOrigin=process.env.PUBLIC_ORIGIN||null}={}){
  const store=new Store(dataDir),sessions=new Map(),attempts=new Map();
  let closing=false;
  // start:aigc.
  // 组装聚合层：默认按 SQLite 目录构建真实适配器（生产 main 调 start() 时才连网）；
  // 注入聚合层实例（测试）时不连网。来源切换写运行日志（switch_log 表）。
  // publish 由 1 秒定时器驱动，把选定 tick 刷成公式键与来源元数据。
  const baseQuotes=store.baseQuotes();
  const aggregator=quotes??new Quotes({baseQuotes,onSwitch:(e)=>store.appendSwitchLog({...e,reason:'来源切换'})});
  let stopSina=null,stopTimer=null,started=false;
  const start=()=>{
    if(started)return stopTimer;   // 幂等：重复 start 不重复建连，避免旧 WebSocket/轮询/定时器泄漏
    started=true;
    if(!quotes){
      aggregator.attach(createRtj({map:baseQuotes.map((b)=>{const s=(b.sources||[]).find((x)=>x.sourceId==='rtj');return {symbol:b.symbol,code:s?.code??null,kind:s?.kind??'plain'};})}));
      aggregator.sourceName.set('sina','新浪'); // sina 走直连注入，注册来源名供前台展示
      stopSina=attachSina({baseQuotes,onQuote:(t)=>aggregator.selector.ingest(t.symbol,'sina',t)});
    }
    const timer=setInterval(()=>aggregator.publish(),1000);timer.unref();stopTimer=()=>clearInterval(timer);return stopTimer;
  };
  // end:aigc.
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const cookie=(req)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lcjy_session='))?.slice(13);
  const session=(req)=>{const id=cookie(req),s=sessions.get(id);if(!s||s.expires<Date.now()){if(id)sessions.delete(id);return null;}return s;};
  const secure=publicOrigin?.startsWith('https://')?' Secure;':'';
  function login(res){const token=randomBytes(32).toString('hex'),s={csrf:randomBytes(24).toString('hex'),expires:Date.now()+8*3600000};sessions.set(token,s);res.setHeader('set-cookie',`lcjy_session=${token}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=28800`);return {authenticated:true,csrf:s.csrf};}
  function rateLimit(req){const ip=req.socket.remoteAddress,now=Date.now();let a=attempts.get(ip);if(!a||now-a.start>60000){a={start:now,count:0};attempts.set(ip,a);}if(++a.count>12)throw error(429,'尝试过多，请一分钟后重试');}
  const cleanup=setInterval(()=>{const now=Date.now();for(const [k,v]of sessions)if(v.expires<now)sessions.delete(k);for(const [k,v]of attempts)if(now-v.start>60000)attempts.delete(k);},60000);cleanup.unref();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://www.jin10.com https://rili-d.jin10.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try{
      const host=req.headers.host||'',origin=publicOrigin||`http://${host}`;
      const hostname=host.split(':')[0];
      if(publicOrigin?host!==new URL(publicOrigin).host:!['127.0.0.1','localhost'].includes(hostname))throw error(403,'访问主机未配置，请设置PUBLIC_ORIGIN');
      const path=new URL(req.url,origin).pathname;
      if(req.method==='POST'){
        if(req.headers.origin!==origin)throw error(403,'只允许同站操作');
        if(!req.headers['content-type']?.startsWith('application/json'))throw error(415,'需要JSON请求');
      }
      // start:aigc.
      if(path==='/api/quotes'&&req.method==='GET'){json(res,200,snapshot({...store.config(),categories:store.categories()},aggregator));return;} // 前台快照：品类读 categories 表，价格/来源读聚合层
      // end:aigc.
      if(path==='/api/admin/session'&&req.method==='GET'){const s=session(req);json(res,200,{authenticated:!!s,needsSetup:!store.hasAdmin(),csrf:s?.csrf||null});return;}
      if(path==='/api/admin/setup'&&req.method==='POST'){
        rateLimit(req);if(store.hasAdmin())throw error(409,'管理员已经初始化');const data=await body(req);
        if(!store.checkSetup(data.setupToken))throw error(403,'初始化令牌错误');validPassword(data.password);
        const hash=await passwordHash(data.password);if(store.hasAdmin())throw error(409,'管理员已经初始化');
        store.setPassword(hash);json(res,200,login(res));return;
      }
      if(path==='/api/admin/login'&&req.method==='POST'){
        rateLimit(req);const data=await body(req),hash=store.getHash();if(!await passwordMatches(data.password,hash)||store.getHash()!==hash)throw error(401,'密码错误或管理员未初始化');json(res,200,login(res));return;
      }
      if(path.startsWith('/api/admin/')){
        const s=session(req);if(!s)throw error(401,'请先登录新盘后台');
        const stillAuthorized=()=>{if(session(req)!==s)throw error(401,'会话已失效，请重新登录');};
        if(req.method==='POST'&&!same(req.headers['x-csrf-token'],s.csrf))throw error(403,'页面凭据已过期，请重新登录');
        // start:aigc.
        if(path==='/api/admin/config'&&req.method==='GET'){const config=store.config();json(res,200,{config,version:config.version});return;} // R02：旧页签退役，不再回传 sourceCatalog
        // end:aigc.
        // start:aigc. 预览走真实报价路径：品类用目录草稿（R02 统一配置源）
        if(path==='/api/admin/preview'&&req.method==='POST'){const data=await body(req);stillAuthorized();const checked=validateCatalog({sources:store.sources(),baseQuotes:store.baseQuotes(),categories:Array.isArray(data?.categories)?data.categories:[]});json(res,200,snapshot({...store.config(),categories:checked.categories},aggregator,{all:true}));return;}
        // end:aigc.
        if(path==='/api/admin/config'&&req.method==='POST'){const data=await body(req);stillAuthorized();if(!Number.isInteger(data.expectedVersion))throw error(400,'缺少配置版本');const config=store.save(validateConfig(data.config),data.expectedVersion);json(res,200,{config,version:config.version});return;}
        // start:aigc.
        // 三元目录与运行状态 admin API：品类保存即时生效（/api/quotes 每次请求读 categories 表），
        // 基础行情保存需重启后适配器按新目录建连。来源密钥只回是否已配置，永不回明文。
        if(path==='/api/admin/sources'&&req.method==='GET'){json(res,200,{sources:store.sources().map((s)=>({...s,hasSecret:store.hasSourceSecret(s.id)}))});return;}
        if(path==='/api/admin/switch-logs'&&req.method==='GET'){json(res,200,{entries:store.switchLogs()});return;}
        if(path==='/api/admin/catalog'&&req.method==='GET'){json(res,200,{version:store.config().version,sources:store.sources().map((s)=>({...s,hasSecret:store.hasSourceSecret(s.id)})),baseQuotes:store.baseQuotes(),categories:store.categories()});return;}
        if(path==='/api/admin/catalog'&&req.method==='POST'){
          const data=await body(req);stillAuthorized();
          if(!Number.isInteger(data.expectedVersion))throw error(400,'缺少目录版本');
          validateCatalog(data);
          const version=store.saveCatalog(data.baseQuotes,data.categories,data.expectedVersion);
          json(res,200,{ok:true,version});return;
        }
        // end:aigc.
        if(path==='/api/admin/audit'&&req.method==='GET'){json(res,200,{entries:store.audit()});return;}
        if(path==='/api/admin/export'&&req.method==='GET'){res.setHeader('content-disposition','attachment; filename="lcjy-config.json"');json(res,200,store.config());return;}
        if(path==='/api/admin/logout'&&req.method==='POST'){sessions.delete(cookie(req));res.setHeader('set-cookie',`lcjy_session=; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=0`);json(res,200,{ok:true});return;}
        if(path==='/api/admin/password'&&req.method==='POST'){rateLimit(req);const data=await body(req);stillAuthorized();const oldHash=store.getHash();if(!await passwordMatches(data.oldPassword,oldHash))throw error(403,'原密码错误');validPassword(data.newPassword);const newHash=await passwordHash(data.newPassword);stillAuthorized();if(store.getHash()!==oldHash)throw error(409,'密码已在其他会话中更新');store.setPassword(newHash);sessions.clear();json(res,200,{ok:true});return;}
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw error(404,'接口不存在');
      const target=path==='/'?'index.html':path==='/admin'||path==='/admin/'?'admin.html':path.replace(/^\//,'');
      const root=join(project,'public'),file=resolve(root,target);
      if(!file.startsWith(root+ '/')&&!file.startsWith(root+'\\'))throw error(404,'页面不存在');
      let content;try{if(!(await stat(file)).isFile())throw new Error();content=await readFile(file);}catch{throw error(404,'页面不存在');}
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ico':'image/x-icon'};
      res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){if(!res.headersSent)json(res,e.status||400,{error:e.message||'请求失败'});else res.end();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,quotes:aggregator,start,async close(){if(closing)return;closing=true;clearInterval(cleanup);
    // start:aigc.
    stopSina?.();aggregator.stop();stopTimer?.();
    // end:aigc.
    await new Promise(r=>{server.close(r);server.closeAllConnections();});store.close();}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp();const port=Number(process.env.PORT||3188),host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,()=>{console.log(`报价盘 http://${host}:${port}/\n独立后台 http://${host}:${port}/admin`);if(!app.store.hasAdmin())console.log(`首次设置令牌位于 ${join(app.store.dir,'setup-token.txt')}，请在新后台设置密码。`);
  // start:aigc.
  app.start(); // 组装生产适配器（融通金+新浪）并启动 publish 定时器
  // end:aigc.
  });
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await app.close();process.exit(0);});
}

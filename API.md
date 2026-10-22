# Frontend contract

All JSON. Errors: {error:string}. Public /api/quotes GET returns:
{serverTime: ISO, configVersion:integer, brand:{name,subtitle,logo,notice,footer,phone}, status:{connected:boolean,lastMessageAt:ISO|null,sourceStatus:string,shopOpen:boolean}, rows:[{id,name,buy:string|null,sell:string|null,high:string|null,low:string|null,updatedAt:ISO|null,stale:boolean,reason:string|null}], schedule}. Prices are already calculated strings. Poll every 2 seconds, no execution of expressions in browser. /api/quotes responds with Cache-Control:no-store. Offline browser must preserve last prices with explicit stale overlay.

GET /api/admin/session -> {authenticated:boolean,needsSetup:boolean,csrf:string|null}. On first run set password through POST /api/admin/setup {password,setupToken}; setupToken is a local one-time file data/setup-token.txt read by owner, never embedded in public UI. POST /api/admin/login {password} -> {authenticated:true,csrf}. POST /api/admin/logout {}.

All POST require same Origin; admin POST except login/setup require X-CSRF-Token and session cookie. First setup password >=12 chars.

GET /api/admin/config -> {config,sourceCatalog:[{name,code,available:boolean}],version}. config={version,brand:{name,subtitle,logo,notice,footer,phone},openMode:"schedule"|"open"|"closed",schedule:[string,string,string,string,string,string,string],rows:[{id,name,visible:boolean,buyFormula,sellFormula,highFormula,lowFormula,decimals:0..6,rounding:"half-up"|"floor"|"ceil"}]}. schedule Sunday first; each string comma-separated HH:mm~HH:mm, permits end24:00. Formula refs use 【#黄金#销售价】 plus +-*/() decimal numbers. Empty formula intentionally displays --. Rows array order is display order.

POST /api/admin/preview {config} -> public quote-shaped result without persistence (all rows incl hidden returned). POST /api/admin/config {config,expectedVersion} -> {version,config}. Old version returns409. Invalid config400. GET /api/admin/audit -> {entries:[{at,version,summary}]} newest first. GET /api/admin/export -> JSON config download. POST /api/admin/password {oldPassword,newPassword} changes password and invalidates sessions.

Public /admin serves new independent admin; no connection to original admin. Settings UI must mention source freshness and unsupported reference when preview missing. Data and source keys never public. Logo path /assets/logo.png. Source catalog uses Chinese base names e.g 黄金, 黄金TD, 黄金9999, 铂金, 钯金, 白银, 铑金, 美黄金, 美白银, 伦敦金, 伦敦银, 美元兑离岸, 公斤条 (may be unavailable). Render text safely, no HTML injection from config.

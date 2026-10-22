import {EventEmitter} from 'node:events';
import protobuf from 'protobufjs';
import WebSocket from 'ws';
import {Blowfish} from 'egoroof-blowfish';
import {CATALOG,FIELD_LABELS} from './catalog.mjs';

const root=protobuf.loadSync(new URL('./quote.proto',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const Message=root.lookupType('QuotationMsg');
const ENDPOINT='wss://rtjwbqt.ytj9999.com:8443/gateway';

export class QuoteFeed extends EventEmitter {
  constructor(){super();this.connected=false;this.lastMessageAt=null;this.sourceStatus='连接中';this.prices=new Map();this.metadata=[];this.stopped=false;this.failures=0;this.seq=0;}
  async start(){this.stopped=false;await this.connect();}
  async discover(){
    const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('无法读取源站公开协议');return r.text();};
    const page=await get('https://i.jzj9999.com/quoteh5/');
    const path=page.match(/href="([^" ]*DINfont[^" ]*\.js)"/)?.[1];
    if(!path)throw new Error('源站脚本版本已变化');
    const script=await get(new URL(path,'https://i.jzj9999.com').href);
    const block=script.match(/(?:const|var|let)\s+AUTH_DATA\s*=\s*\{([^}]+)\}/)?.[1] || script.match(/AUTH_DATA\s*=\s*\{([^}]+)\}/)?.[1];
    if(!block)throw new Error('源站握手格式已变化');
    const auth={};
    for(const key of ['key','verifycode','apptype','initializationVector']){
      const value=block.match(new RegExp(`(?:^|,)\\s*${key}\\s*:\\s*(["'])(.*?)\\1`))?.[2];
      if(value===undefined)throw new Error('源站握手参数缺失'); auth[key]=value;
    }
    return auth;
  }
  async connect(){
    if(this.stopped)return;
    try{
      const auth=await this.discover(); if(this.stopped)return;
      const ws=this.ws=new WebSocket(ENDPOINT,{origin:'https://i.jzj9999.com',handshakeTimeout:12000,maxPayload:16*1024*1024});
      ws.on('open',()=>{
        const cipher=new Blowfish(auth.key,Blowfish.MODE.CBC,Blowfish.PADDING.PKCS5); cipher.setIv(auth.initializationVector);
        this.send(32,{auth:{apptype:auth.apptype,token:cipher.encode(`${auth.verifycode}${auth.apptype}${Date.now()}`)}});
        this.authTimeout=setTimeout(()=>ws.terminate(),12000);
      });
      ws.on('message',buffer=>{try{this.handle(Message.toObject(Message.decode(buffer),{longs:Number}));}catch{this.sourceStatus='行情解析失败';this.emit('status');}});
      ws.on('error',()=>{this.sourceStatus='行情连接异常';});
      ws.on('close',()=>{this.connected=false;clearInterval(this.heartbeat);clearInterval(this.watchdog);clearTimeout(this.authTimeout);this.emit('status');this.retry();});
    }catch{this.connected=false;this.sourceStatus='源行情暂不可用，正在重试';this.emit('status');this.retry();}
  }
  send(msgid,request={},json){if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(Message.encode({msgid,seq:this.seq++,request,...(json?{jsonReq:JSON.stringify(json)}:{})}).finish());}
  handle(message){
    this.lastMessageAt=new Date().toISOString();
    if(message.msgid===32){
      if(!message.response?.some(r=>r.auth)){this.sourceStatus='源行情握手未通过';this.ws?.terminate();return;}
      clearTimeout(this.authTimeout);this.connected=true;this.failures=0;this.sourceStatus='已连接';
      this.send(66,{},{});this.subscribe();this.send(28,{codes:['RTJ']});
      this.heartbeat=setInterval(()=>this.send(16),20000);
      this.watchdog=setInterval(()=>{if(Date.now()-Date.parse(this.lastMessageAt)>45000)this.ws?.terminate();},10000);
      this.emit('status');
    }
    if(message.jsonResp){try{const meta=JSON.parse(message.jsonResp);if(meta.codes){this.metadata=meta.codes;this.resolveCatalog();this.subscribe();this.emit('metadata');}}catch{}}
    for(const r of message.response||[]){
      if(r.tradeStatus?.codes?.includes('RTJ')) {const value=r.tradeStatus.tradeStatus;this.sourceStatus=[10,20,27,30].includes(value)?'源站标记开盘':value===0||value===7?'源站初始化':'源站标记闭盘';}
      for(const q of r.quotation||[])this.update(q);
    }
  }
  resolveCatalog(){
    const aliases={'港金':['港金','香港金'],'美元指数':['美元指数'],'公斤条':['公斤条'],'公斤铂':['公斤铂'],'公斤钯':['公斤钯'],'公斤银':['公斤银'],'沪金主力':['沪金主力'],'沪金次主力':['沪金次主力'],'沪银主力':['沪银主力'],'沪银次主力':['沪银次主力'],'美铑金':['美铑金']};
    for(const row of CATALOG){if(row.code)continue;const match=this.metadata.find(m=>(aliases[row.name]||[row.name]).includes(m.name?.replace(/\s/g,'')));if(match)row.code=match.code;}
  }
  subscribe(){const codes=[...new Set(CATALOG.flatMap(r=>r.code?(r.split?[r.code,`${r.code}_PB`,`${r.code}_PS`]:[r.code]):[]))];this.send(18,{codes,freq:[0]});}
  update(q){
    const time=Number(q.quoteTime);if(!Number.isFinite(time)||time<=0||time>Date.now()+300000)return;
    for(const row of CATALOG){
      const fields={};
      if(row.split){
        if(q.code===`${row.code}_PB`)fields.buy=q.rt?.last;
        else if(q.code===`${row.code}_PS`){fields.sell=q.rt?.last;fields.high=q.high;fields.low=q.low;}
        else if(q.code===row.code && !this.metadata.some(m=>m.code===`${row.code}_PB`)){fields.buy=q.rt?.bidPrice?.[0];fields.sell=q.rt?.askPrice?.[0];fields.high=q.high;fields.low=q.low;}
        else continue;
      }else if(q.code===row.code){fields.buy=q.rt?.bidPrice?.[0];fields.sell=q.rt?.askPrice?.[0];fields.high=q.high;fields.low=q.low;}
      else continue;
      for(const [field,value]of Object.entries(fields)){
        if(typeof value!=='number'||!Number.isFinite(value))continue;
        const key=`【#${row.name}#${FIELD_LABELS[field]}】`,previous=this.prices.get(key);
        if(previous&&previous.time>time)continue;
        this.prices.set(key,{value:String(value),time});
      }
    }
    this.emit('quote',q);
  }
  retry(){if(this.stopped)return;clearTimeout(this.retryTimer);const delay=Math.min(30000,1000*2**Math.min(this.failures++,5));this.retryTimer=setTimeout(()=>this.connect(),delay);}
  stop(){this.stopped=true;clearTimeout(this.retryTimer);clearTimeout(this.authTimeout);clearInterval(this.heartbeat);clearInterval(this.watchdog);this.ws?.terminate();}
}

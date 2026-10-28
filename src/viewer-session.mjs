// start:aigc.
// 匿名访客会话存储（方案 §4/§15.2.1）：32 字节随机会话标识、空闲超时 30 分钟、
// 容量上限 + 到期清扫、Cookie 剩余不足一天时续写。纯内存单进程实现（方案 §8），
// 多实例部署前不得当作全局会话存储使用。

import {randomBytes} from 'node:crypto';

export function createViewerSessions({idleMs=30*60000,maxSessions=10000,cookieMaxAgeSec=7*86400,now=Date.now}={}){
  const sessions=new Map(); // id -> {lastMs, cookieExpiresAtMs}
  const sweep=()=>{const t=now();for(const [id,s]of sessions)if(t-s.lastMs>=idleMs)sessions.delete(id);};
  return {
    // 取有效会话；过期即移除并返回 null（睡眠/休眠超 30 分钟后恢复属正常路径，不算异常）
    get(id){
      if(typeof id!=='string'||id.length!==64)return null;
      const s=sessions.get(id),t=now();
      if(!s||t-s.lastMs>=idleMs){if(s)sessions.delete(id);return null;}
      return s;
    },
    // 成功访问刷新空闲期；Cookie 剩余不足一天时续写（返回 true 由路由补 Set-Cookie）
    touch(s){
      s.lastMs=now();
      if(s.cookieExpiresAtMs-now()<86400000){s.cookieExpiresAtMs=now()+cookieMaxAgeSec*1000;return true;}
      return false;
    },
    // 新建会话；容量满时先清扫过期再判断，仍满则返回 null（路由转可重试 503，不驱逐正常看盘会话）
    issue(){
      if(sessions.size>=maxSessions){sweep();if(sessions.size>=maxSessions)return null;}
      const t=now(),id=randomBytes(32).toString('hex');
      sessions.set(id,{lastMs:t,cookieExpiresAtMs:t+cookieMaxAgeSec*1000});
      return id;
    },
    sweep,
    get size(){return sessions.size;},
  };
}
// end:aigc.

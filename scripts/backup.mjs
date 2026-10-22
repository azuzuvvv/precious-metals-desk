import {Store} from '../src/store.mjs';
import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const dir=resolve('data'),out=join(dir,'backups');mkdirSync(out,{recursive:true});
const store=new Store(dir),path=join(out,`quotes-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
try{await store.backup(path);console.log(path);}finally{store.close();}

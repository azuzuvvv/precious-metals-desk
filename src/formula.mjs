import Decimal from 'decimal.js';

const D = Decimal.clone({precision:40});
const REFERENCE = /^【#[^#【】]{1,40}#(?:回购价|销售价|最高价|最低价)】/u;
const MODES = {'half-up':D.ROUND_HALF_UP, floor:D.ROUND_FLOOR, ceil:D.ROUND_CEIL};

export function tokens(expression) {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 500) throw new Error('公式不能为空且不能超过500字');
  const out=[];
  let rest=expression.trim();
  while(rest) {
    const match=rest.match(REFERENCE) || rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)/) || rest.match(/^[+*/()-]/);
    if(!match) throw new Error('公式只允许基准价格、数字、加减乘除和括号');
    out.push(match[0]);
    if(out.length>150) throw new Error('公式过于复杂');
    rest=rest.slice(match[0].length).trimStart();
  }
  return out;
}
export function references(expression) { return [...new Set(tokens(expression).filter(t=>t.startsWith('【')))]; }

export function compile(expression) {
  const ts=tokens(expression); let index=0;
  const primary=()=>{
    const token=ts[index++];
    if(token==='+' || token==='-') return {op:token==='-'?'neg':'pos',right:primary()};
    if(token==='(') { const v=sum(); if(ts[index++]!==')') throw new Error('括号不匹配'); return v; }
    if(!token || token===')'||token==='*'||token==='/') throw new Error('公式不完整');
    return token.startsWith('【')?{ref:token}:{number:token};
  };
  const product=()=>{let v=primary();while(ts[index]==='*'||ts[index]==='/'){const op=ts[index++];v={op,left:v,right:primary()};}return v;};
  const sum=()=>{let v=product();while(ts[index]==='+'||ts[index]==='-'){const op=ts[index++];v={op,left:v,right:product()};}return v;};
  const tree=sum();if(index!==ts.length)throw new Error('公式语法无效');
  const constant=node=>{
    if(node.ref)return null;
    if(node.number!==undefined)return new D(node.number);
    const right=constant(node.right),left=node.left?constant(node.left):null;
    if(node.op==='/'&&right?.isZero())throw new Error('除数不能为零');
    if(right===null||(node.left&&left===null))return null;
    return operate(node.op,left,right);
  };
  constant(tree);return tree;
}
function operate(op,left,right){
  switch(op){case 'neg':return right.negated();case 'pos':return right;case '+':return left.plus(right);case '-':return left.minus(right);case '*':return left.times(right);case '/':if(right.isZero())throw new Error('除数不能为零');return left.div(right);default:throw new Error('无效运算符');}
}
export function evaluate(expression, values) {
  const tree=compile(expression);
  const visit=node=>{
    if(node.number!==undefined)return new D(node.number);
    if(node.ref){if(!Object.hasOwn(values,node.ref)||values[node.ref]===null||values[node.ref]==='')throw new Error(`缺少行情：${node.ref}`);const v=new D(values[node.ref]);if(!v.isFinite())throw new Error('行情无效');return v;}
    return operate(node.op,node.left?visit(node.left):null,visit(node.right));
  };
  const result=visit(tree);
  if(!result.isFinite() || result.abs().gt('1e15')) throw new Error('公式或计算结果无效');
  return result;
}
export function calculate(expression, values, decimals=2, rounding='half-up') {
  if(!Number.isInteger(decimals)||decimals<0||decimals>6||!Object.hasOwn(MODES,rounding))throw new Error('小数位或舍入方式无效');
  return evaluate(expression,values).toFixed(decimals,MODES[rounding]);
}

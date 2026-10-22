import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, references } from '../src/formula.mjs';

const values = {'【#黄金#销售价】':'885.73','【#黄金#回购价】':'882.73'};
test('gold price and weighted expressions use exact decimal arithmetic', () => {
  assert.equal(calculate('【#黄金#销售价】+3.5', values, 2), '889.23');
  assert.equal(calculate('(【#黄金#销售价】*2+【#黄金#回购价】)/3', values, 2), '884.73');
  assert.equal(calculate('0.1+0.2', {}, 2), '0.30');
  assert.equal(calculate('1.005', {}, 2), '1.01');
});
test('rounding modes handle positive and negative values', () => {
  assert.equal(calculate('-1.001',{},2,'floor'),'-1.01');
  assert.equal(calculate('1.001',{},2,'ceil'),'1.01');
  assert.equal(calculate('-(2+3)*0.1',{},3),'-0.500');
});
test('rejects executable syntax, malformed expressions, divide by zero', () => {
  for (const input of ['process.exit()', '1;2', '2**3','1/0','(1+2','1 2','1e9','', '【#bad#last】']) {
    assert.throws(()=>calculate(input,values,2), undefined, input);
  }
  assert.throws(()=>calculate('1',{},20));
  assert.throws(()=>calculate('1'.repeat(1000),{},2));
});
test('missing values never become zero', () => {
  assert.throws(()=>calculate('【#白银#销售价】+1',values,2));
  assert.deepEqual(references('【#黄金#销售价】 + 【#黄金#回购价】'),Object.keys(values));
});

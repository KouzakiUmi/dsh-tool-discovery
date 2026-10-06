// progressive-v2/domain 基础原语测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, digestOf, utf8Bytes, deepEqualCanonical } from '../../domain/canonical.mjs';
import { resolveBudgets, estimateTokens, createByteAccumulator, assertActiveBudget } from '../../domain/budgets.mjs';
import { DomainError } from '../../domain/errors.mjs';
import { DEFAULT_BUDGETS } from '../../domain/constants.mjs';

test('canonicalJson 键排序与数组保序', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  // 数组顺序保持,不改写
  assert.equal(canonicalJson({ x: [3, 1, 2] }), '{"x":[3,1,2]}');
});

test('canonicalJson 拒绝不确定值,归一 -0', () => {
  assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ a: Infinity }), /non-finite/);
  assert.throws(() => canonicalJson({ a: [undefined] }), /undefined/);
  assert.throws(() => canonicalJson({ a: () => 1 }), /unsupported type/);
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  // 对象中的 undefined 等价于缺省
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('canonicalJson 嵌套结构无损', () => {
  const v = { z: [{ b: 2, a: 1 }], y: 'x', n: null, t: true };
  assert.equal(canonicalJson(v), '{"n":null,"t":true,"y":"x","z":[{"a":1,"b":2}]}');
});

test('digestOf 对键序不敏感、对数组序敏感', () => {
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.notEqual(digestOf({ a: [1, 2] }), digestOf({ a: [2, 1] }));
  assert.match(digestOf({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test('deepEqualCanonical 忽略键序', () => {
  assert.ok(deepEqualCanonical({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }));
  assert.ok(!deepEqualCanonical({ a: 1 }, { a: 2 }));
});

test('utf8Bytes 按 UTF-8 计字节(不按字符数)', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('中'), 3);
});

test('预算默认值为 02 §9 冻结值', () => {
  assert.equal(DEFAULT_BUDGETS.maxActiveTools, 12);
  assert.equal(DEFAULT_BUDGETS.maxActiveSchemaBytes, 49152);
  assert.equal(DEFAULT_BUDGETS.maxSkillBytesPerLoad, 12288);
  assert.equal(DEFAULT_BUDGETS.maxInitialBytes, 8192);
  assert.equal(DEFAULT_BUDGETS.candidateTtlMs, 900000);
  assert.equal(DEFAULT_BUDGETS.listCursorTtlMs, 900000);
  assert.equal(DEFAULT_BUDGETS.maxSearchLimit, 8);
  assert.equal(DEFAULT_BUDGETS.defaultSearchLimit, 5);
  assert.equal(DEFAULT_BUDGETS.maxListLimit, 20);
  assert.equal(DEFAULT_BUDGETS.maxLoadBatch, 4);
});

test('预算配置只接受已知正整数', () => {
  assert.equal(resolveBudgets({ maxActiveTools: 3 }).maxActiveTools, 3);
  assert.throws(() => resolveBudgets({ nope: 1 }), DomainError);
  assert.throws(() => resolveBudgets({ maxActiveTools: 0 }), DomainError);
  assert.throws(() => resolveBudgets({ maxActiveTools: 1.5 }), DomainError);
});

test('token 估算必须显式标注 estimate', () => {
  const r = estimateTokens('hello world');
  assert.equal(r.method, 'estimate');
  assert.ok(r.value > 0);
  // 中文字符按 1 code point/token 计入,不会低估
  assert.ok(estimateTokens('中文字').value >= 3);
});

test('字节累积器只放完整项,放不下返回 false 且不截断', () => {
  const acc = createByteAccumulator(10);
  assert.ok(acc.tryAdd('abc'));
  assert.ok(!acc.tryAdd('1234567890'));
  assert.equal(acc.used, 3); // 失败的项不计入
});

test('活跃预算全批判定,超限抛 BUDGET_EXCEEDED', () => {
  const b = resolveBudgets({});
  const many = Array.from({ length: 13 }, () => ({ wireBytes: 10 }));
  assert.throws(() => assertActiveBudget(many, [], b), (e) => e.code === 'BUDGET_EXCEEDED');
  const big = [{ wireBytes: 50000 }];
  assert.throws(() => assertActiveBudget(big, [], b), (e) => e.code === 'BUDGET_EXCEEDED');
  // 刚好在限内
  assert.doesNotThrow(() => assertActiveBudget([{ wireBytes: 1000 }], [], b));
});

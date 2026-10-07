// 协议严格校验测试(负例为主)
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateListRequest, validateSearchRequest, validateLoadRequest, okEnvelope, errorEnvelope } from '../../domain/protocol.mjs';
import { DomainError } from '../../domain/errors.mjs';
import { resolveBudgets } from '../../domain/budgets.mjs';

const B = resolveBudgets({});
// 显式配置上限的预算：用于"上限仍生效"的正例/负例
const CAPPED = resolveBudgets({ maxListLimit: 20, maxSearchLimit: 8, maxQueryCodePoints: 512, maxLoadBatch: 4 });

test('list:available/loaded 需要 category', () => {
  assert.throws(() => validateListRequest({ view: 'available' }, B), (e) => e.code === 'INVALID_ARGS');
  assert.equal(validateListRequest({ view: 'available', category: 'files' }, B).category, 'files');
});

test('list:state 只允许 view', () => {
  assert.deepEqual(validateListRequest({ view: 'state' }, B), { view: 'state', limit: 20 });
  assert.throws(() => validateListRequest({ view: 'state', category: 'files' }, B), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateListRequest({ view: 'state', cursor: 'p_x' }, B), (e) => e.code === 'INVALID_ARGS');
});

test('list:categories 只允许 view/cursor/limit', () => {
  assert.doesNotThrow(() => validateListRequest({ view: 'categories', limit: 3 }, B));
  assert.throws(() => validateListRequest({ view: 'categories', category: 'files' }, B), (e) => e.code === 'INVALID_ARGS');
});

test('list:默认关闭 limit 硬上限,但显式配置上限后仍拒绝越界', () => {
  // 默认：硬上限关闭 → 模型可以要更大的页，但默认输出策略仍是 20
  assert.equal(validateListRequest({ view: 'available', category: 'files' }, B).limit, 20);
  assert.equal(validateListRequest({ view: 'available', category: 'files', limit: 21 }, B).limit, 21);
  // 显式配置上限后照旧拒绝
  assert.throws(() => validateListRequest({ view: 'available', category: 'files', limit: 21 }, CAPPED), (e) => e.code === 'INVALID_ARGS');
  assert.equal(validateListRequest({ view: 'available', category: 'files' }, CAPPED).limit, 20);
});

test('list:未知字段一律 INVALID_ARGS', () => {
  assert.throws(() => validateListRequest({ view: 'available', category: 'files', foo: 1 }, B), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateListRequest({ view: 'bogus' }, B), (e) => e.code === 'INVALID_ARGS');
});

test('list:拒绝身份/路径/自由文本/代码类字段', () => {
  for (const f of ['sessionId', 'agentId', 'path', 'url', 'skillName', 'code', 'token']) {
    assert.throws(
      () => validateListRequest({ view: 'available', category: 'files', [f]: 'x' }, B),
      (e) => e.code === 'INVALID_ARGS',
      `字段 ${f} 必须被拒绝`,
    );
  }
});

test('search:category/query 必填;默认 5,硬上限默认关闭、显式配置后为 8', () => {
  assert.throws(() => validateSearchRequest({ query: 'x' }, B), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateSearchRequest({ category: 'files' }, B), (e) => e.code === 'INVALID_ARGS');
  // 默认输出策略：5（关闭硬上限不改默认策略）
  assert.equal(validateSearchRequest({ category: 'files', query: 'x' }, B).limit, 5);
  // 默认关闭 → 更大的 limit 被接受
  assert.equal(validateSearchRequest({ category: 'files', query: 'x', limit: 9 }, B).limit, 9);
  // 显式配置上限后照旧拒绝
  assert.throws(() => validateSearchRequest({ category: 'files', query: 'x', limit: 9 }, CAPPED), (e) => e.code === 'INVALID_ARGS');
  assert.equal(validateSearchRequest({ category: 'files', query: 'x', limit: 8 }, CAPPED).limit, 8);
});

test('search:没有 action 字段', () => {
  assert.throws(() => validateSearchRequest({ category: 'files', query: 'x', action: 'load' }, B), (e) => e.code === 'INVALID_ARGS');
});

test('search:超长 query 默认放行,显式配置上限后按 code point 拒绝', () => {
  const long = '中'.repeat(600);
  // 默认关闭长度上限
  assert.equal(validateSearchRequest({ category: 'files', query: long }, B).query.length, 600);
  // 显式配置上限后照旧拒绝
  assert.throws(() => validateSearchRequest({ category: 'files', query: long }, CAPPED), (e) => e.code === 'INVALID_ARGS');
  const okQ = '中'.repeat(500);
  assert.doesNotThrow(() => validateSearchRequest({ category: 'files', query: okQ }, CAPPED));
});

test('load:candidates 与 names 必须二选一(F18)', () => {
  assert.throws(() => validateLoadRequest({ candidates: [{ ref: 'c1', revision: 'r1' }], names: ['x'] }, B), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateLoadRequest({}, B), (e) => e.code === 'INVALID_ARGS');
  const c = validateLoadRequest({ candidates: [{ ref: 'c1', revision: 'r1' }] }, B);
  assert.equal(c.action, 'load');
  assert.equal(c.candidates.length, 1);
});

test('load:数组非空;批次上限默认关闭、显式配置为 4 时生效', () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ ref: `c${i}`, revision: 'r' }));
  // 默认关闭 → 5 个一批放行
  assert.equal(validateLoadRequest({ candidates: five }, B).candidates.length, 5);
  // 显式配置上限后照旧拒绝
  assert.throws(() => validateLoadRequest({ candidates: five }, CAPPED), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateLoadRequest({ names: Array.from({ length: 5 }, (_, i) => `n${i}`) }, CAPPED), (e) => e.code === 'INVALID_ARGS');
  // 空数组始终拒绝（这不是限额问题）
  assert.throws(() => validateLoadRequest({ names: [] }, B), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateLoadRequest({ candidates: [] }, B), (e) => e.code === 'INVALID_ARGS');
});

test('load:重复 ref 的冲突 revision 是参数错误', () => {
  assert.throws(
    () => validateLoadRequest({ candidates: [{ ref: 'c1', revision: 'r1' }, { ref: 'c1', revision: 'r2' }] }, B),
    (e) => e.code === 'INVALID_ARGS',
  );
  // 相同 revision 的重复 ref 去重保留
  const same = validateLoadRequest({ candidates: [{ ref: 'c1', revision: 'r1' }, { ref: 'c1', revision: 'r1' }] }, B);
  assert.equal(same.candidates.length, 2);
});

test('load:unload 一律拒绝(模型不得自主卸载,清空点只有成功压缩)', () => {
  for (const raw of [
    { action: 'unload' },
    { action: 'unload', toolIds: [] },
    { action: 'unload', names: ['x'] },
    { action: 'unload', toolIds: ['a'], names: ['x'] },
    // 即使参数完全合法也不放行：契约层面没有这条路径
    { action: 'unload', toolIds: ['a', 'a', 'b'] },
  ]) {
    assert.throws(() => validateLoadRequest(raw, B), (e) => e.code === 'INVALID_ARGS', JSON.stringify(raw));
  }
});

test('load:load 不接受 toolIds;未知 action 拒绝', () => {
  assert.throws(() => validateLoadRequest({ names: ['x'], toolIds: ['y'] }, B), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateLoadRequest({ action: 'purge', names: ['x'] }, B), (e) => e.code === 'INVALID_ARGS');
});

test('load:拒绝携带多余字段的 candidate', () => {
  assert.throws(() => validateLoadRequest({ candidates: [{ ref: 'c', revision: 'r', sessionId: 's' }] }, B), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateLoadRequest({ candidates: [{ ref: 'c', revision: 'r', extra: 1 }] }, B), (e) => e.code === 'INVALID_ARGS');
});

test('load:非对象根拒绝', () => {
  for (const bad of [null, 'x', 5, [1], undefined]) {
    assert.throws(() => validateLoadRequest(bad, B), (e) => e.code === 'INVALID_ARGS');
  }
});

test('响应外壳形状', () => {
  const ok = okEnvelope('tool_search', 'search', { a: 1 }, 'next');
  assert.deepEqual(ok, { protocolVersion: 2, tool: 'tool_search', operation: 'search', ok: true, data: { a: 1 }, nextAction: 'next' });
  const err = errorEnvelope('tool_load', 'load', new DomainError('STALE_CANDIDATE'));
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'STALE_CANDIDATE');
  assert.equal(err.error.retryable, true);
  assert.equal(err.error.recovery, 'select_again');
  assert.equal(err.protocolVersion, 2);
  // 错误外壳不泄漏内部 details
  const withDetails = errorEnvelope('tool_load', 'load', new DomainError('INVALID_ARGS', undefined, { internal: 1 }));
  assert.equal(withDetails.error.internal, undefined);
});

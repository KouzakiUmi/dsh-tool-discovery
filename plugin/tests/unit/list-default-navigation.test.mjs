import test from 'node:test';
import assert from 'node:assert/strict';
import { validateListRequest } from '../../domain/protocol.mjs';
import { makeEngine } from './helpers.mjs';

const invalid = (e) => e.code === 'INVALID_ARGS';
test('list default: 空请求默认 categories，限额与分页仍可用', async () => {
  assert.equal(validateListRequest({}).view, 'categories');
  assert.equal(validateListRequest({ limit: 2 }).view, 'categories');
  const { engine } = await makeEngine();
  try {
    const scope = { sessionId: 'navigation', actorId: 'actor' };
    const first = engine.handleList({ limit: 2 }, scope);
    assert.equal(first.ok, true);
    assert.equal(first.data.view, 'categories');
    assert.equal(first.data.categories.length, 2);
    assert.ok(first.data.nextCursor);
    const next = engine.handleList({ cursor: first.data.nextCursor, limit: 2 }, scope);
    assert.equal(next.ok, true);
    assert.notDeepEqual(next.data.categories, first.data.categories);
    assert.equal(engine.getState(scope).selected.size, 0);
  } finally { engine.dispose(); }
});
test('list default: 省略 view 但提供 category 仍是 available', () => {
  assert.equal(validateListRequest({ category: 'files' }).view, 'available');
  assert.equal(validateListRequest({ category: 'all' }).view, 'available');
});
test('list default: 显式 available/loaded 缺 category 仍拒绝', () => {
  for (const view of ['available', 'loaded']) assert.throws(() => validateListRequest({ view }), invalid);
});
test('list default: 不把 null/空串当缺省，也不放松未知字段', () => {
  for (const view of [null, '', 1, false]) assert.throws(() => validateListRequest({ view }), invalid);
  for (const category of [null, '', 1, false]) assert.throws(() => validateListRequest({ category }), invalid);
  assert.throws(() => validateListRequest({ foo: 1 }), invalid);
  assert.throws(() => validateListRequest({ view: 'categories', category: 'files' }), invalid);
});

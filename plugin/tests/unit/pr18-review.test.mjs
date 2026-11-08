// 纯函数回归：字节预算的惰性前缀、分页游标与搜索结果卡片的懒构造。
//
// 旧文件的 freezeTool 用例（冻结 wire 保留嵌套 JSON 顺序、toJSON/getter 快照、
// 循环 JSON 拒绝）随 rc.1 删除冻结 wire 子系统而删除：宿主拥有声明，插件不再
// 保存逐字 wire 回执；目录快照的不可变/深复制性质由 registry.test.mjs 与
// review-state-races.test.mjs 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPrefixLength } from '../../domain/budgets.mjs';
import { paginateNames } from '../../domain/list.mjs';
import { makeEngine, loadTools, binding, SCOPE_A } from './helpers.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('bounded prefix examines only a byte-bounded prefix of a huge page', () => {
  let touched = 0;
  const keep = fitPrefixLength(1_000_000, 100, () => 20, () => { touched++; return 10; });
  assert.equal(keep, 7);
  assert.ok(touched <= 10, `unexpected item visits: ${touched}`);
  assert.equal(fitPrefixLength(1_000_000, null, () => assert.fail('unlimited envelope'), () => assert.fail('unlimited item')), 1_000_000);
  assert.equal(fitPrefixLength(0, 1, () => 2, () => assert.fail('empty item')), -1);
});

test('terminal cursor savings can fit a whole page after a non-fitting intermediate page', () => {
  assert.equal(fitPrefixLength(2, 30, (n) => n === 1 ? 40 : 5, () => 10), 2);
});

test('list budget never reads the undelivered tail, and mints only one usable cursor', () => {
  const names = ['中'.repeat(5), 'tail'.repeat(100)];
  Object.defineProperty(names, 2, { get() { assert.fail('serialized or sliced the whole page'); } });
  names.length = 1_000_000;
  let issued = 0;
  const page = paginateNames({ allNames: names, sessionId: 's', view: 'available', category: 'files',
    eligibilityGeneration: 1, orderDigest: 'd', now: 0, limit: 1_000_000,
    budgets: { maxListResultBytes: 150 }, cursorStore: { issue(rec) { issued++; assert.equal(rec.offset, 1); return `p_${'a'.repeat(32)}`; } },
  });
  assert.deepEqual(page.names, ['中'.repeat(5)]);
  assert.equal(page.truncated, true);
  assert.equal(issued, 1);
  assert.ok(bytes(page) <= 150);
});

test('search byte cap constructs cards lazily and returned refs remain loadable', async (t) => {
  const bindings = Array.from({ length: 100 }, (_, i) => binding({ name: `file_${String(i).padStart(3, '0')}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings, engineConfig: { budgets: { maxSearchLimit: null, maxSearchResultBytes: 800 } } });
  t.after(() => engine.dispose());
  // Search ranking uses indexed documents; candidate projection reads selected state.
  // An unreturned distant entry must never be projected under the small byte cap.
  const last = engine.getCatalog().byName.get('file_099')[0];
  const selected = engine.getState(SCOPE_A).selected;
  const get = selected.get.bind(selected);
  selected.get = (id) => {
    assert.notEqual(id, last.toolId, 'materialized the full candidate page');
    return get(id);
  };
  const response = engine.handleSearch({ category: 'files', query: 'file', limit: 100 }, SCOPE_A);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.data.candidates.length > 0 && response.data.candidates.length < 100);
  assert.ok(bytes(response) <= 800);
  assert.equal(response.data.truncated, true);
  assert.equal((await loadTools(engine, SCOPE_A, { candidates: [{ ref: response.data.candidates[0].ref }] })).response.ok, true);
});

test('an oversized first item is inspected once then fails without reading the page tail', () => {
  const names = ['x'.repeat(1024 * 1024)];
  Object.defineProperty(names, 1, { get() { assert.fail('read tail after oversized item'); } });
  names.length = 1_000_000;
  assert.throws(() => paginateNames({ allNames: names, sessionId: 's', view: 'available', category: 'files',
    eligibilityGeneration: 1, orderDigest: 'd', now: 0, limit: 1_000_000,
    budgets: { maxListResultBytes: 100 }, cursorStore: { issue() { assert.fail('issued cursor'); } },
  }), { code: 'BUDGET_EXCEEDED' });
});

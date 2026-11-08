// domain review 回归：出站响应与内部状态隔离、批次原子性与完整类别分页。
//
// 旧文件的取消/重置/pending 重放与 receipt 原位改写用例围绕已删除的 canonical
// 折叠机制；新设计里 load 立即提交，因此把“宿主/模型拿到的响应对象被改写会不会
// 影响内部状态”改成对 handleLoad 返回值的只读性验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, loadTools, SCOPE_A } from './helpers.mjs';

test('出站响应被原位改写不得影响内部 selected / admission 结果', async () => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 2 } } });
  const { response, admitted } = await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] });
  assert.equal(response.ok, true);
  assert.equal(engine.getState(SCOPE_A).selected.size, 2);

  // 模型/宿主可能拿到并改写响应对象或 admitted 数组。
  response.data.loaded.splice(1, 1);
  response.data.skills.length = 0;
  admitted.splice(0, admitted.length);
  assert.equal(engine.getState(SCOPE_A).selected.size, 2, '内部选择不受出站对象改写影响');
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 2);

  // 预算仍按内部事实核算：再加一个必须被拒。
  const blocked = await loadTools(engine, SCOPE_A, { names: ['read_file'] });
  assert.equal(blocked.response.error.code, 'BUDGET_EXCEEDED');
});

test('批次全有或全无：候选 revision 冲突不产生任何选择', async () => {
  const { engine } = await makeEngine();
  const c1 = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A).data.candidates[0];
  const c2 = engine.handleSearch({ category: 'files', query: 'grep' }, SCOPE_A).data.candidates[0];
  const res = await loadTools(engine, SCOPE_A, {
    candidates: [
      { ref: c1.ref, revision: c1.revision },
      { ref: c2.ref, revision: 'r_conflict' },
    ],
  });
  assert.equal(res.response.ok, false);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '整批不提交');
});

test('maxInitialCategories:1 限制每页而不截断全集，连续翻页无遗漏且末页标记正确', async () => {
  const { engine: baseline } = await makeEngine();
  const expected = baseline.handleList({ view: 'categories', limit: 20 }, SCOPE_A).data.categories;
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxInitialCategories: 1 } } });
  const seen = [];
  let cursor;
  for (let i = 0; i < expected.length; i += 1) {
    const page = engine.handleList({ view: 'categories', limit: 20, ...(cursor ? { cursor } : {}) }, SCOPE_A);
    assert.equal(page.ok, true);
    assert.equal(page.data.categories.length, 1, '显式 limit 也不能扩大类别页预算');
    seen.push(...page.data.categories);
    const more = i < expected.length - 1;
    assert.equal(page.data.truncated, more);
    if (more) assert.equal(typeof page.data.nextCursor, 'string');
    else assert.equal(page.data.nextCursor, null);
    cursor = page.data.nextCursor;
  }
  assert.equal(seen[0].id, 'files');
  assert.ok(seen.some((card) => card.id === 'shell'), 'shell 必须可达');
  assert.deepEqual(seen, expected, '顺序、内容与未截断全集一致，无重复无遗漏');
  assert.equal(new Set(seen.map((card) => card.id)).size, expected.length);
  // 不扩张普通名称分页：类别预算不限制 available 页大小。
  const names = engine.handleList({ view: 'available', category: 'files', limit: 20 }, SCOPE_A);
  assert.ok(names.data.names.length > 1);
  engine.dispose();
  baseline.dispose();
});

test('类别分页仍尊重更小的请求 limit，末页允许不足一页', async () => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxInitialCategories: 6 } } });
  const seen = [];
  let cursor;
  do {
    const page = engine.handleList({ view: 'categories', limit: 5, ...(cursor ? { cursor } : {}) }, SCOPE_A);
    assert.equal(page.ok, true);
    assert.equal(page.data.categories.length, seen.length < 10 ? 5 : 2);
    seen.push(...page.data.categories.map((card) => card.id));
    cursor = page.data.nextCursor;
    assert.equal(page.data.truncated, cursor !== null);
    assert.ok(seen.length <= 12, '分页必须前进，不能无限重复');
  } while (cursor !== null);
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
  engine.dispose();
});

// plugin/tests/unit/unload-atomicity.test.mjs
// tool_unload 整批事务性（全有全无）：
//   * 保护规则（entry / framework / alwaysVisible）必须先对**整批名字**校验，任何
//     一个命中就整批拒绝。不得"先删几个再抛错"——那会返回 ok:false / revoked:null，
//     adapter 因此不撤销 admission，而 selected 已被删空；随后单独 unload 该名字
//     变成空操作，撤销永远到不了 admission store。
//   * 未选中的名字保持幂等：不报错、不出现在 unloaded 里。
//   * 失败后 selected 与预算占用完全不变；随后合法 unload 正常生效。
// 会话之间互不影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, loadTools, unloadTools, SCOPE_A, SCOPE_B } from './helpers.mjs';

const namesOf = (engine, scope) =>
  [...engine.getState(scope).selected.values()].map((s) => s.name);

/** 用 view:'state' 的预算投影核对占用面（activeCount / activeSchemaBytes）。 */
const budgetsOf = (engine, scope) => {
  const res = engine.handleList({ view: 'state' }, scope);
  assert.equal(res.ok, true, 'state 视图必须可用');
  return {
    activeCount: res.data.budgets.activeCount,
    activeSchemaBytes: res.data.budgets.activeSchemaBytes,
  };
};

/**
 * adapter 侧 admission tracker 的最小模型：load 提交、unload **成功**时按请求名字
 * 撤销（未选中名字也要建撤销墓碑，故按 args.names 撤销而非 revoked）。
 */
function tracker() {
  const admitted = new Set();
  return {
    admitted,
    commit(rows) { for (const r of rows) admitted.add(r.name); },
    revoke(names) { for (const n of names) admitted.delete(n); },
  };
}

/** 与 adapter 的 entries.runUnload 同形的接线：只有成功响应才触达 admission。 */
async function adapterUnload(engine, scope, input, tr) {
  const out = await unloadTools(engine, scope, input);
  if (out.response.ok === true && tr) tr.revoke(input.names);
  return out;
}

// ---- 整批先校验：保护项任意位置都不产生半批状态 -------------------------

test('保护项在批首/批中/批尾都整批拒绝：selected 与预算不变，随后合法 unload 成功', async () => {
  const batches = [
    ['tool_list', 'glob'], // 保护项在批首
    ['glob', 'tool_unload', 'grep'], // 保护项在批中
    ['glob', 'grep', 'final_answer'], // 保护项在批尾
  ];
  for (const names of batches) {
    const { engine } = await makeEngine();
    assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] })).response.ok, true);
    const before = { selected: namesOf(engine, SCOPE_A), budgets: budgetsOf(engine, SCOPE_A) };

    const out = await unloadTools(engine, SCOPE_A, { names });
    assert.equal(out.response.ok, false, `${names.join(',')} 必须整批拒绝`);
    assert.equal(out.response.error.code, 'INVALID_ARGS');
    assert.equal(out.revoked, null, '失败不得交回半批 revoked');
    assert.deepEqual(namesOf(engine, SCOPE_A), before.selected, '失败不得留下半批删除');
    assert.deepEqual(budgetsOf(engine, SCOPE_A), before.budgets, '失败不得改变预算占用');

    const legal = await unloadTools(engine, SCOPE_A, { names: ['glob'] });
    assert.equal(legal.response.ok, true, '随后合法 unload 必须成功');
    assert.deepEqual(legal.response.data.unloaded, ['glob']);
    assert.deepEqual(legal.revoked, ['glob']);
    assert.deepEqual(namesOf(engine, SCOPE_A), ['grep']);
  }
});

test('entry / framework / alwaysVisible 三类保护名都按整批规则拒绝', async () => {
  const cases = [
    { label: 'entry', always: [], name: 'tool_list' },
    { label: 'framework', always: [], name: 'final_answer' },
    { label: 'alwaysVisible', always: ['read_file'], name: 'read_file' },
  ];
  for (const c of cases) {
    const { engine } = await makeEngine({ engineConfig: { alwaysToolNames: c.always } });
    assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
    const out = await unloadTools(engine, SCOPE_A, { names: ['glob', c.name] });
    assert.equal(out.response.ok, false, `${c.label} 必须拒绝整批`);
    assert.equal(out.response.error.code, 'INVALID_ARGS');
    assert.equal(out.revoked, null);
    assert.deepEqual(namesOf(engine, SCOPE_A), ['glob'], `${c.label} 失败后 glob 仍在`);
  }
});

// ---- 失败批不触达 admission；随后合法 unload 真的撤销 -------------------

test('失败批不撤销任何 admission：同一名字的下一次合法 unload 才生效', async () => {
  const { engine } = await makeEngine();
  const tr = tracker();
  const loaded = await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] });
  tr.commit(loaded.admitted);
  assert.deepEqual([...tr.admitted].sort(), ['glob', 'grep']);

  const failed = await adapterUnload(engine, SCOPE_A, { names: ['glob', 'tool_list'] }, tr);
  assert.equal(failed.response.ok, false);
  assert.equal(failed.revoked, null);
  assert.deepEqual([...tr.admitted].sort(), ['glob', 'grep'], '失败批不得撤销任何 admission');
  assert.deepEqual(namesOf(engine, SCOPE_A), ['glob', 'grep'], 'selected 也不得被删空');

  const legal = await adapterUnload(engine, SCOPE_A, { names: ['glob'] }, tr);
  assert.equal(legal.response.ok, true);
  assert.deepEqual(legal.revoked, ['glob'], '合法 unload 仍须报告被撤销的名字');
  assert.deepEqual([...tr.admitted], ['grep'], '合法 unload 必须真的撤销 glob');
  assert.deepEqual(namesOf(engine, SCOPE_A), ['grep']);
});

// ---- 未选中名字的幂等 ---------------------------------------------------

test('只含未选中名字的 unload 幂等：ok、unloaded 空、revoked 空、状态不变', async () => {
  const { engine } = await makeEngine();
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  const before = budgetsOf(engine, SCOPE_A);

  const out = await unloadTools(engine, SCOPE_A, { names: ['grep'] });
  assert.equal(out.response.ok, true);
  assert.deepEqual(out.response.data.unloaded, []);
  assert.deepEqual(out.revoked, []);
  assert.deepEqual(namesOf(engine, SCOPE_A), ['glob'], '未选中名字不得影响已选条目');
  assert.deepEqual(budgetsOf(engine, SCOPE_A), before);

  const dup = await unloadTools(engine, SCOPE_A, { names: ['grep', 'grep'] });
  assert.equal(dup.response.ok, true);
  assert.deepEqual(dup.revoked, []);
  assert.deepEqual(namesOf(engine, SCOPE_A), ['glob']);
});

test('混合已选中与未选中名字：只撤销已选中的，未选中的幂等', async () => {
  const { engine } = await makeEngine();
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] })).response.ok, true);
  const out = await unloadTools(engine, SCOPE_A, { names: ['read_file', 'glob', 'web_fetch'] });
  assert.equal(out.response.ok, true);
  assert.deepEqual(out.response.data.unloaded, ['glob']);
  assert.deepEqual(out.revoked, ['glob']);
  assert.deepEqual(namesOf(engine, SCOPE_A), ['grep']);
});

// ---- 失败不释放预算：占用面与可加载额度都不变 ---------------------------

test('失败批不释放预算：预算仍被占用，合法 unload 后才腾出额度', async () => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 2 } } });
  assert.equal(
    (await engine.handleLoad({ names: ['glob', 'grep'] }, SCOPE_A)).response.ok,
    true,
  );
  const before = budgetsOf(engine, SCOPE_A);
  assert.equal(before.activeCount, 2);

  const failed = await unloadTools(engine, SCOPE_A, { names: ['glob', 'final_answer'] });
  assert.equal(failed.response.ok, false);
  assert.equal(failed.revoked, null);
  assert.deepEqual(budgetsOf(engine, SCOPE_A), before, '失败后预算占用完全不变');

  const overBudget = await loadTools(engine, SCOPE_A, { names: ['edit_file'] });
  assert.equal(overBudget.response.ok, false, '失败批没有释放额度，新增仍被拒');
  assert.equal(overBudget.response.error.code, 'BUDGET_EXCEEDED');

  const legal = await unloadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(legal.response.ok, true);
  assert.equal(budgetsOf(engine, SCOPE_A).activeCount, 1, '合法 unload 才腾出额度');

  const fit = await loadTools(engine, SCOPE_A, { names: ['edit_file'] });
  assert.equal(fit.response.ok, true, '腾出额度后可以加载');
});

// ---- 跨会话 -------------------------------------------------------------

test('跨会话不影响：A 的失败批与合法 unload 都不改动 B 的 selected', async () => {
  const { engine } = await makeEngine();
  for (const scope of [SCOPE_A, SCOPE_B]) {
    assert.equal((await loadTools(engine, scope, { names: ['glob', 'grep'] })).response.ok, true);
  }
  const bBefore = budgetsOf(engine, SCOPE_B);

  const failed = await unloadTools(engine, SCOPE_A, { names: ['glob', 'tool_list'] });
  assert.equal(failed.response.ok, false);
  assert.deepEqual(namesOf(engine, SCOPE_A), ['glob', 'grep'], 'A 的失败批不改变 A');
  assert.deepEqual(namesOf(engine, SCOPE_B), ['glob', 'grep'], 'A 的失败批不改变 B');
  assert.deepEqual(budgetsOf(engine, SCOPE_B), bBefore);

  const legal = await unloadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(legal.response.ok, true);
  assert.deepEqual(namesOf(engine, SCOPE_A), ['grep']);
  assert.deepEqual(namesOf(engine, SCOPE_B), ['glob', 'grep'], 'A 的合法 unload 不改变 B');
  assert.deepEqual(budgetsOf(engine, SCOPE_B), bBefore);
});

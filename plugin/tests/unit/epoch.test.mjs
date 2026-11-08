// 旧“可信周期 / 冻结 wire”测试的 rc.1 等价覆盖（docs/14-rc1-redesign.md）。
//
// 旧 E01-E09 断言的是 epoch、frozen wire、resetCacheEpoch 与 canonical 回执；这些
// 机制已整体删除。本文件保留其中仍然成立的产品目标，并改成新语义：
//   E01 加载 A 再 B：两者都在 selected 中，预算按两者累计（不再冻结 wire，顺序由宿主决定）。
//   E02 重复 load 幂等。
//   E03 换版后旧选择失效；重新 load 恢复（执行拒绝由 guard 层另行验证）。
//   E04 撤权只移除执行资格并留诊断；admission 由 adapter 按返回名撤销。
//   E05 超预算整批拒绝且不淘汰已选。
//   E06 目录未变（含压缩后）没有特殊重置：选择原样保留。
//   E07 入口/框架/常驻不进入 selected。
//   E08 tool_load 不接受 unload 动作；tool_unload 是唯一卸载入口。
// 旧 E09“历史 unload 回执兼容回放”无等价物：历史回放子系统已删除，resume 只回放
// admission store 的 admitted 行；无该用例时以 seedSelection 的 digest 对齐测试代替。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, loadTools, unloadTools, binding, sampleBindings, SCOPE_A } from './helpers.mjs';

const namesOf = (engine, scope = SCOPE_A) => [...engine.getState(scope).selected.values()].map((s) => s.name);
const bytesOf = (engine, scope = SCOPE_A) => engine.handleList({ view: 'state' }, scope).data.budgets.activeSchemaBytes;

test('E01 load A 再 load B：两者都在 selected 中，预算按两者累计', async () => {
  const { engine } = await makeEngine();
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['grep'] })).response.ok, true);
  assert.deepEqual(namesOf(engine).sort(), ['glob', 'grep']);
  const entries = engine.getCatalog().entries;
  assert.equal(bytesOf(engine), entries.get('t_files_glob').wireBytes + entries.get('t_files_grep').wireBytes);
  assert.deepEqual(engine.handleList({ view: 'state' }, SCOPE_A).data.selected.map((s) => s.name).sort(), ['glob', 'grep']);
});

test('E02 重复 load 已选工具幂等：不重复选择、不改 revision', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const before = engine.getState(SCOPE_A).selected.get('t_files_glob');
  const again = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(again.response.ok, true);
  assert.deepEqual(again.admitted, []);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.deepEqual(engine.getState(SCOPE_A).selected.get('t_files_glob'), before);
});

test('E03 schema 换版：旧选择失效并记录原因；重新 load 恢复新定义', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const oldRevision = engine.getState(SCOPE_A).selected.get('t_files_glob').revision;
  const changed = sampleBindings().map((b) => (b.toolId === 't_files_glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern'] } } }
    : b));
  const outcome = engine.refreshCatalog(changed);
  assert.deepEqual(outcome.invalidatedNames, ['glob']);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  assert.equal(engine.getState(SCOPE_A).invalidated.get('t_files_glob').reason, 'definition-changed');
  assert.equal(engine.getState(SCOPE_A).invalidated.get('t_files_glob').revision, oldRevision);

  const reload = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(reload.response.ok, true);
  const fresh = engine.getState(SCOPE_A).selected.get('t_files_glob');
  assert.notEqual(fresh.revision, oldRevision);
  assert.equal(fresh.revision, engine.getCatalog().entries.get('t_files_glob').revision);
});

test('E04 撤权移除执行资格并返回受影响名字（供 adapter 撤销 admission）', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] });
  const names = engine.invalidate('t_files_glob', 'tool-removed');
  assert.deepEqual([...new Set(names)], ['glob']);
  assert.equal(engine.getState(SCOPE_A).selected.has('t_files_glob'), false);
  assert.equal(engine.getState(SCOPE_A).selected.has('t_files_grep'), true, '无关工具保持选择');
  assert.equal(engine.getState(SCOPE_A).invalidated.get('t_files_glob').reason, 'tool-removed');
});

test('E05 预算按 selected 核算：超预算整批拒绝且不淘汰任何已选项', async () => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 1 } } });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  const over = await loadTools(engine, SCOPE_A, { names: ['grep', 'read_file'] });
  assert.equal(over.response.ok, false);
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(namesOf(engine), ['glob'], '不得淘汰已选项');
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 1);
});

test('E06 目录未变时没有特殊重置：选择原样保留（压缩不再触发周期重置）', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const before = engine.getState(SCOPE_A).selected.get('t_files_glob');
  const generation = engine.getEligibilityGeneration();
  const outcome = engine.refreshCatalog(sampleBindings());
  assert.equal(outcome.eligibilityGeneration, generation, '内容未变的刷新走快路径');
  assert.deepEqual(outcome.invalidatedNames, []);
  assert.deepEqual(engine.getState(SCOPE_A).selected.get('t_files_glob'), before);
  assert.equal('epoch' in engine.getState(SCOPE_A), false, 'state 上不再有 epoch 字段');
  assert.equal('frozen' in engine.getState(SCOPE_A), false, 'state 上不再有 frozen 字段');
});

test('E07 常驻/入口/框架工具不进入 selected', async () => {
  const { engine } = await makeEngine({
    engineConfig: { alwaysToolNames: ['read_file'], frameworkToolNames: ['final_answer'] },
  });
  const resident = await loadTools(engine, SCOPE_A, { names: ['read_file'] });
  assert.deepEqual(resident.response.data.alreadyResident, ['read_file']);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  for (const name of ['tool_list', 'tool_search', 'tool_load', 'final_answer']) {
    assert.equal((await loadTools(engine, SCOPE_A, { names: [name] })).response.ok, false);
  }
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('E08 模型不得用 tool_load 自主 unload；tool_unload 撤销 admitted 名字', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const rejected = await loadTools(engine, SCOPE_A, { action: 'unload', names: ['glob'] });
  assert.equal(rejected.response.ok, false);
  assert.equal(rejected.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);

  const unloaded = await unloadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(unloaded.response.ok, true);
  assert.deepEqual(unloaded.response.data.unloaded, ['glob']);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  assert.equal(engine.getState(SCOPE_A).invalidated.size, 0, '主动卸载不写 invalidated');
});

test('E09 resume 只回放 admitted 行：digest 不符的行被丢弃，不复活旧定义', async () => {
  const { engine } = await makeEngine();
  const entry = engine.getCatalog().entries.get('t_files_glob');
  const dropped = engine.seedSelection(SCOPE_A, [{
    name: entry.name, toolId: entry.toolId, schemaDigest: 'sha256:stale', at: 1,
  }]);
  assert.deepEqual(dropped, { seeded: [], dropped: ['glob'] });
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('E10 常驻名单变化：setAlwaysVisibleNames 改变后续 load 的常驻判定', async () => {
  const { engine } = await makeEngine({ engineConfig: { alwaysToolNames: ['read_file'] } });
  const resident = await loadTools(engine, SCOPE_A, { names: ['read_file'] });
  assert.deepEqual(resident.response.data.alreadyResident, ['read_file']);
  assert.equal(engine.getState(SCOPE_A).selected.has('t_files_read'), false, '常驻工具不写 selected');

  // 从常驻名单移除后，同一个名字恢复为普通可加载工具。
  engine.setAlwaysVisibleNames([]);
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['read_file'] })).response.ok, true);
  assert.equal(engine.getState(SCOPE_A).selected.has('t_files_read'), true);
});

test('E11 目录新增不影响既有选择，缩小的重启目录会在 seed 阶段丢弃', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  engine.refreshCatalog([...sampleBindings(), binding({ name: 'added', toolId: 't_added', namespace: 'files' })]);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(engine.getState(SCOPE_A).invalidated.size, 0);
});

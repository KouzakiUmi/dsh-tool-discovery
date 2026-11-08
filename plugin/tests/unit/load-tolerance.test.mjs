// 容错幂等加载常驻工具（tolerantLoadProtected）及防死锁验证。
//
// rc.1 重设计：常驻（alwaysVisible）工具每轮都在 allow-list 里，无需 load；
// tolerantLoadProtected=true 时把它们当幂等空操作（报告 alreadyResident），
// 不再写 selected/admitted。关闭容错则按 protectedNotLoadable 拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, loadTools, SCOPE_A } from './helpers.mjs';

test('LT1: 默认 tolerantLoadProtected: true 下，load 常驻工具幂等成功且不占按需选择', async () => {
  const { engine } = await makeEngine({ engineConfig: { alwaysToolNames: ['read_file'] } });
  const res = await loadTools(engine, SCOPE_A, { names: ['read_file'] });
  assert.equal(res.response.ok, true, '加载常驻工具必须成功返回 ok: true');
  assert.deepEqual(res.response.data.alreadyResident, ['read_file']);
  assert.deepEqual(res.response.data.loaded, []);
  assert.deepEqual(res.admitted, [], '常驻工具不进 admission');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '常驻工具不写 selected');
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 0);
});

test('LT2: 显式关闭 tolerantLoadProtected: false 时，加载常驻工具报 INVALID_ARGS', async () => {
  const { engine } = await makeEngine({
    engineConfig: { alwaysToolNames: ['read_file'], tolerantLoadProtected: false },
  });
  const res = await loadTools(engine, SCOPE_A, { names: ['read_file'] });
  assert.equal(res.response.ok, false, '严格模式下必须拒绝加载常驻工具');
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('LT3: 无论 tolerantLoadProtected 开关如何，入口项与框架保留项坚决不可加载', async () => {
  const { engine } = await makeEngine({
    engineConfig: { frameworkToolNames: ['final_answer'], tolerantLoadProtected: true },
  });
  for (const entry of ['tool_list', 'tool_search', 'tool_load', 'tool_unload']) {
    const res = await loadTools(engine, SCOPE_A, { names: [entry] });
    assert.equal(res.response.ok, false, `${entry} 绝对不可加载`);
    assert.equal(res.response.error.code, 'INVALID_ARGS');
  }
  const fwRes = await loadTools(engine, SCOPE_A, { names: ['final_answer'] });
  assert.equal(fwRes.response.ok, false, '框架保留工具绝对不可加载');
  assert.equal(fwRes.response.error.code, 'INVALID_ARGS');
});

test('LT4: 空 candidates 占位不阻断 names 路径（协议层同一口径）', async () => {
  const { engine } = await makeEngine({ engineConfig: { alwaysToolNames: ['read_file'] } });
  const res = await loadTools(engine, SCOPE_A, { candidates: [], names: ['read_file'] });
  assert.equal(res.response.ok, true, '空数组是占位写法，不是互斥冲突');
  assert.deepEqual(res.response.data.alreadyResident, ['read_file']);
});

test('LT5: 空 names 占位不阻断 candidates 路径（LT4 的镜像方向）', async () => {
  const { engine } = await makeEngine({});
  const candidate = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A).data.candidates[0];
  assert.ok(candidate !== undefined, '前置：必须能检索到候选');
  const res = await loadTools(engine, SCOPE_A, {
    candidates: [{ ref: candidate.ref, revision: candidate.revision }], names: [],
  });
  assert.equal(res.response.ok, true, '空 names 是占位写法，不是互斥冲突');
  assert.equal(engine.getState(SCOPE_A).selected.get(candidate.toolId).selectionSource, 'candidate');
});

test('LT6: 同一个 load 批次里混合常驻与按需工具：常驻只报告，按需正常提交', async () => {
  const { engine } = await makeEngine({ engineConfig: { alwaysToolNames: ['read_file'] } });
  const res = await loadTools(engine, SCOPE_A, { names: ['read_file', 'glob'] });
  assert.equal(res.response.ok, true);
  assert.deepEqual(res.response.data.loaded, ['glob']);
  assert.deepEqual(res.response.data.alreadyResident, ['read_file']);
  assert.deepEqual(res.admitted.map((row) => row.name), ['glob']);
  assert.deepEqual([...engine.getState(SCOPE_A).selected.values()].map((s) => s.name), ['glob']);
});

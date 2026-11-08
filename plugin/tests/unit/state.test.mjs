// 会话选择状态与 resume/unload 语义（rc.1 重设计，docs/14-rc1-redesign.md）。
//
// 旧版的 canonical pair 折叠、seq/integrity 账本、advertised 曝光表、frozen wire
// 与 restoring 终态均已删除。本文件按新语义锁定：
//   * state 形状 `{sessionId, mode:'ready', selected:Map, invalidated:Map}`；
//   * tool_load 成功后 selected **立即**写入（admission 由 adapter 持久化）；
//   * tool_unload 撤销 selected，不写 invalidated（主动卸载 ≠ 资格失效）；
//   * invalidateTool / engine.invalidate 作废 selected 并留诊断；
//   * resume 用 seedSelection 按 name+schemaDigest 与当前目录对齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, cloneState, invalidateTool, removeSelection,
} from '../../domain/state.mjs';
import { buildCatalog } from '../../domain/catalog.mjs';
import { loadTools, unloadTools, makeEngine, SCOPE_A, SCOPE_B, binding, sampleBindings } from './helpers.mjs';

const catalog = buildCatalog(sampleBindings(), { now: 0, generation: 'g1' });
const entry = (id) => catalog.entries.get(id);

// ---- state 形状与 copy-on-write -----------------------------------------

test('createState: 会话创建即 ready，selected/invalidated 为空 Map', () => {
  const st = createState('s1');
  assert.deepEqual(Object.keys(st).sort(), ['invalidated', 'mode', 'selected', 'sessionId']);
  assert.equal(st.sessionId, 's1');
  assert.equal(st.mode, 'ready');
  assert.ok(st.selected instanceof Map);
  assert.ok(st.invalidated instanceof Map);
  assert.equal(st.selected.size, 0);
  assert.equal(st.invalidated.size, 0);
});

test('cloneState 复制两份 Map：改副本不影响原状态', () => {
  const st = createState('s1');
  const glob = entry('t_files_glob');
  st.selected.set(glob.toolId, {
    toolId: glob.toolId, name: glob.name, revision: glob.revision,
    schemaDigest: glob.schemaDigest, skillRevision: glob.skillRevision,
    selectionSource: 'name', activatedAt: 1,
  });
  const clone = cloneState(st);
  assert.notEqual(clone, st);
  assert.notEqual(clone.selected, st.selected);
  assert.notEqual(clone.invalidated, st.invalidated);
  clone.selected.delete(glob.toolId);
  clone.invalidated.set('x', { reason: 'r', at: 0, revision: null });
  assert.equal(st.selected.size, 1, '原 selected 不被副本修改');
  assert.equal(st.invalidated.size, 0, '原 invalidated 不被副本修改');
});

// ---- invalidateTool：作废 + 只增不减的诊断 ------------------------------

test('invalidateTool 对从未 selected/留痕的工具原样返回（不克隆、不写记录）', () => {
  const st0 = createState('s1');
  const untouched = invalidateTool(st0, 't_files_glob', 'tool-removed', 5);
  assert.equal(untouched, st0, '没有可作废的东西 → 原对象返回');
  assert.equal(untouched.invalidated.size, 0, 'invalidated 不得被无关撤权喂大');
});

test('invalidateTool 清掉 selected，并留下带被作废版本的诊断', () => {
  let st = createState('s1');
  const e = entry('t_files_glob');
  const sel = {
    toolId: e.toolId, name: e.name, revision: e.revision, schemaDigest: e.schemaDigest,
    skillRevision: e.skillRevision, selectionSource: 'name', activatedAt: 1,
  };
  st.selected.set(e.toolId, sel);
  const next = invalidateTool(st, e.toolId, 'definition-changed', 7);
  assert.equal(next.selected.size, 0);
  assert.deepEqual(next.invalidated.get(e.toolId), {
    reason: 'definition-changed', at: 7, revision: e.revision,
  });
  assert.equal(st.selected.size, 1, '原 state 不被修改（copy-on-write）');

  const again = invalidateTool(next, e.toolId, 'tool-removed', 9);
  assert.equal(again.invalidated.get(e.toolId).reason, 'tool-removed', '已留痕的工具按最新原因更新');
  assert.equal(again.invalidated.get(e.toolId).revision, null, '第二次没有 selected 可引用 → revision null');
});

test('invalidateTool 不碰其它工具的诊断与选择', () => {
  let st = createState('s1');
  const glob = entry('t_files_glob');
  const grep = entry('t_files_grep');
  for (const e of [glob, grep]) {
    st.selected.set(e.toolId, {
      toolId: e.toolId, name: e.name, revision: e.revision, schemaDigest: e.schemaDigest,
      skillRevision: e.skillRevision, selectionSource: 'name', activatedAt: 1,
    });
  }
  const next = invalidateTool(st, glob.toolId, 'definition-changed', 7);
  assert.equal(next.selected.size, 1);
  assert.equal(next.selected.has(grep.toolId), true);
  assert.equal(next.invalidated.has(grep.toolId), false);
});

test('removeSelection 只删选择，不写 invalidated（主动卸载不是资格失效）', () => {
  const st = createState('s1');
  const e = entry('t_files_glob');
  st.selected.set(e.toolId, {
    toolId: e.toolId, name: e.name, revision: e.revision, schemaDigest: e.schemaDigest,
    skillRevision: e.skillRevision, selectionSource: 'name', activatedAt: 1,
  });
  assert.equal(removeSelection(st, e.toolId), true);
  assert.equal(st.selected.size, 0);
  assert.equal(st.invalidated.size, 0, '卸载不得写 invalidated');
  assert.equal(removeSelection(st, e.toolId), false, '重复卸载返回 false');
});

// ---- engine：load 立即提交 ----------------------------------------------

test('F03 load 成功即写 selected，admitted 同时给出（不再有 pending/回执折叠）', async () => {
  const { engine } = await makeEngine();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A);
  assert.equal(res.response.ok, true);
  assert.deepEqual(res.response.data.loaded, ['glob']);
  assert.equal(res.response.data.takesEffect, 'next_request');
  assert.equal(res.response.data.schemaDelivery, 'native_tools_only');
  assert.equal(res.admitted.length, 1);
  assert.deepEqual(
    { toolId: res.admitted[0].toolId, name: res.admitted[0].name, revision: res.admitted[0].revision },
    { toolId: 't_files_glob', name: 'glob', revision: entry('t_files_glob').revision },
  );
  const sel = engine.getState(SCOPE_A).selected.get('t_files_glob');
  assert.equal(sel.name, 'glob');
  assert.equal(sel.selectionSource, 'name');
  assert.equal(sel.schemaDigest, entry('t_files_glob').schemaDigest);
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.selected.length, 1);
});

test('F03 候选路径 load 立即提交，selectionSource=candidate，只交付所选版本', async () => {
  const { engine } = await makeEngine();
  const candidate = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A).data.candidates[0];
  const res = await engine.handleLoad({ candidates: [{ ref: candidate.ref }] }, SCOPE_A);
  assert.equal(res.response.ok, true);
  const sel = engine.getState(SCOPE_A).selected.get(candidate.toolId);
  assert.equal(sel.selectionSource, 'candidate');
  assert.equal(sel.revision, candidate.revision);
  assert.equal(res.admitted[0].revision, candidate.revision);
});

test('F04 同版本重复 load 幂等：selected 不重复，admitted 为空', async () => {
  const { engine } = await makeEngine();
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  const again = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(again.response.ok, true);
  assert.deepEqual(again.response.data.loaded, [], '没有新增选择');
  assert.deepEqual(again.admitted, [], 'adapter 无需重复写 admission');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 1);
});

test('F08/tool_unload：撤销 admitted 名字；入口/framework/alwaysVisible 拒绝', async () => {
  const { engine } = await makeEngine({ engineConfig: { frameworkToolNames: ['final_answer'] } });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] })).response.ok, true);
  const out = await unloadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(out.response.ok, true);
  assert.deepEqual(out.response.data.unloaded, ['glob']);
  assert.deepEqual(out.revoked, ['glob']);
  assert.deepEqual([...engine.getState(SCOPE_A).selected.values()].map((s) => s.name), ['grep']);
  assert.equal(engine.getState(SCOPE_A).invalidated.size, 0, '卸载不写 invalidated');

  for (const name of ['tool_list', 'tool_unload', 'final_answer']) {
    const rejected = await unloadTools(engine, SCOPE_A, { names: [name] });
    assert.equal(rejected.response.ok, false, `${name} 不得被卸载`);
    assert.equal(rejected.response.error.code, 'INVALID_ARGS');
  }
  const reload = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(reload.response.ok, true, '卸载后可重新加载');
  assert.deepEqual(reload.response.data.loaded, ['glob']);
});

test('tool_unload 未选中的名字是幂等空操作，不产生半批状态', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const out = await unloadTools(engine, SCOPE_A, { names: ['glob', 'grep'] });
  assert.equal(out.response.ok, true);
  assert.deepEqual(out.response.data.unloaded, ['glob']);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('unload 与 load 串行：并发调用不产生交叉状态', async () => {
  const { engine } = await makeEngine();
  const results = await Promise.all([
    loadTools(engine, SCOPE_A, { names: ['glob'] }),
    loadTools(engine, SCOPE_A, { names: ['grep'] }),
    loadTools(engine, SCOPE_A, { names: ['read_file'] }),
  ]);
  for (const r of results) assert.equal(r.response.ok, true);
  assert.equal(engine.getState(SCOPE_A).selected.size, 3);
  const unloaded = await Promise.all([
    unloadTools(engine, SCOPE_A, { names: ['glob'] }),
    unloadTools(engine, SCOPE_A, { names: ['grep'] }),
  ]);
  for (const r of unloaded) assert.equal(r.response.ok, true);
  assert.deepEqual([...engine.getState(SCOPE_A).selected.values()].map((s) => s.name), ['read_file']);
});

test('engine.handleLoad 支持解绑调用（不依赖 this 绑定）', async () => {
  const { engine } = await makeEngine();
  const unboundHandleLoad = engine.handleLoad;
  const res = await unboundHandleLoad({ names: ['glob'] }, SCOPE_A);
  assert.equal(res.response.ok, true);
  assert.equal(res.response.data.loaded[0], 'glob');
});

// ---- resume：seedSelection 按 name + schemaDigest 对齐 ------------------

const seededRow = (e, at = 1000) => ({
  name: e.name, toolId: e.toolId, schemaDigest: e.schemaDigest, at,
});

test('resume: 名称与 schemaDigest 都匹配的行回填 selected，selectionSource=resumed', async () => {
  const { engine } = await makeEngine();
  const e = entry('t_files_glob');
  const out = engine.seedSelection(SCOPE_A, [seededRow(e)]);
  assert.deepEqual(out, { seeded: ['glob'], dropped: [] });
  const sel = engine.getState(SCOPE_A).selected.get(e.toolId);
  assert.equal(sel.revision, e.revision);
  assert.equal(sel.schemaDigest, e.schemaDigest);
  assert.equal(sel.selectionSource, 'resumed');
  assert.equal(sel.activatedAt, 1000);
});

test('resume: 定义已换版（digest 不符）或名字消失的行被丢弃，不静默升级', async () => {
  const { engine } = await makeEngine();
  const oldDigest = `sha256:${'0'.repeat(64)}`;
  const out = engine.seedSelection(SCOPE_A, [
    { name: 'glob', toolId: 't_files_glob', schemaDigest: oldDigest, at: 1 },
    { name: 'removed_tool', toolId: 't_removed', schemaDigest: 'sha256:x', at: 2 },
  ]);
  assert.deepEqual(out.seeded, []);
  assert.deepEqual(out.dropped.sort(), ['glob', 'removed_tool']);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('resume: 以当前目录解析结果为准，不信任行里自报的 toolId', async () => {
  const { engine } = await makeEngine();
  const e = entry('t_files_glob');
  const out = engine.seedSelection(SCOPE_A, [{ ...seededRow(e), toolId: 't_forged' }]);
  assert.deepEqual(out.seeded, ['glob']);
  assert.equal(engine.getState(SCOPE_A).selected.has(e.toolId), true);
  assert.equal(engine.getState(SCOPE_A).selected.has('t_forged'), false);
});

test('resume: schema 变化后 refreshCatalog 先作废旧选择，新 digest 行才能重新种入', async () => {
  const changed = sampleBindings().map((b) => (b.toolId === 't_files_glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } } }
    : b));
  const { engine } = await makeEngine({ bindings: changed });
  const fresh = engine.getCatalog().entries.get('t_files_glob');
  const oldRow = seededRow(entry('t_files_glob'));
  const dropped = engine.seedSelection(SCOPE_A, [oldRow]);
  assert.deepEqual(dropped.seeded, [], '旧 digest 不得恢复');
  const seeded = engine.seedSelection(SCOPE_A, [seededRow(fresh)]);
  assert.deepEqual(seeded.seeded, ['glob']);
  assert.equal(engine.getState(SCOPE_A).selected.get('t_files_glob').revision, fresh.revision);
});

// ---- invalidate / 会话隔离 ---------------------------------------------

test('L05 engine.invalidate 作废 selected、留诊断、升资格代次，并返回受影响名字', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  await loadTools(engine, SCOPE_B, { names: ['glob'] });
  const e = entry('t_files_glob');
  const generation = engine.getEligibilityGeneration();
  const names = engine.invalidate(e.toolId, 'definition-changed');
  // 返回的是“每个受影响会话里的工具名”，两个会话都选中了 glob → 两条同名记录；
  // adapter 在撤销 admission 时按名字集合去重。
  assert.deepEqual([...new Set(names)], ['glob']);
  assert.equal(names.length, 2, 'A/B 两个会话各报告一次');
  assert.equal(engine.getEligibilityGeneration(), generation + 1);
  for (const scope of [SCOPE_A, SCOPE_B]) {
    const st = engine.getState(scope);
    assert.equal(st.selected.size, 0);
    assert.equal(st.invalidated.get(e.toolId).reason, 'definition-changed');
  }
});

test('engine.invalidate 对未选中的工具不留诊断，也不喂大 invalidated', async () => {
  const { engine } = await makeEngine();
  engine.getState(SCOPE_A);
  engine.invalidate('t_files_grep', 'tool-removed');
  assert.equal(engine.getState(SCOPE_A).invalidated.size, 0);
});

test('会话隔离：A 的 selected 不泄漏到 B / fork', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(engine.getState(SCOPE_B).selected.size, 0);
  assert.equal(engine.getState({ sessionId: 'sess_A_fork' }).selected.size, 0);
});

// ---- engine 构造校验（不静默修正） -------------------------------------

test('binding 形状非法时 engine 直接拒绝构造(不静默修正)', async () => {
  const { DomainError } = await import('../../domain/errors.mjs');
  const { createDiscoveryEngine } = await import('../../domain/index.mjs');
  const { CATEGORY_CONFIG, fakeClock, fakeRandom } = await import('./helpers.mjs');
  const base = { categoryConfig: CATEGORY_CONFIG, clock: fakeClock(), random: fakeRandom() };
  const bad = binding({ name: 'x', toolId: 't_x' });
  delete bad.wire;                       // 缺 wire
  assert.throws(() => createDiscoveryEngine({ ...base, bindings: [bad] }), DomainError);
  const mismatch = binding({ name: 'x', toolId: 't_x' });
  mismatch.wire.name = 'other';          // wire.name 与绑定名不一致
  assert.throws(() => createDiscoveryEngine({ ...base, bindings: [mismatch] }), DomainError);
  const dup = [binding({ name: 'x', toolId: 't_same' }), binding({ name: 'y', toolId: 't_same' })];
  assert.throws(() => createDiscoveryEngine({ ...base, bindings: dup }), DomainError);
  // 非 native 展示模式首版拒绝
  assert.throws(
    () => createDiscoveryEngine({ ...base, bindings: [], capabilityKind: 'ptc' }),
    (e) => e.code === 'INCOMPATIBLE_PRESENTATION',
  );
});

test('引擎配置非法时返回结构化 DomainError，不得以 ReferenceError 逃逸', async () => {
  const { createDiscoveryEngine } = await import('../../domain/index.mjs');
  const base = { categoryConfig: {}, clock: { now: () => 0 }, random: { bytes: () => new Uint8Array(1) } };
  const invalid = [
    null,
    { ...base, protocolVersion: 99 },
    { ...base, categoryConfig: null },
    { ...base, clock: null },
    { categoryConfig: {}, clock: { now: () => 0 } },
  ];
  for (const config of invalid) {
    assert.throws(() => createDiscoveryEngine(config), (error) => {
      assert.equal(error.name, 'DomainError', `配置 ${JSON.stringify(config)} 必须走结构化错误`);
      assert.equal(error.code, 'INCOMPATIBLE_COMPOSITION');
      return true;
    });
  }
});

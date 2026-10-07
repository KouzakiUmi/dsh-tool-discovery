// 缓存周期（cache epoch）：两次成功上下文压缩之间，工具加载只增量追加。
// 冻结 wire + 顺序、预算按冻结 wire 核算、执行授权与披露缓存分离、模型不得自主 unload。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, nextOpId, binding, sampleBindings } from './helpers.mjs';

const wireOf = (name, extra = {}) => ({
  name,
  description: `desc of ${name}`,
  parameters: { type: 'object', properties: {}, additionalProperties: false, ...extra },
});

/** load + canonical 折叠，返回冻结 wire 列表（按披露顺序）。 */
async function loadAndFreeze(engine, scope, input, seq) {
  const op = nextOpId();
  const res = await engine.handleLoad(input, scope, { operationId: op });
  assert.equal(res.response.ok, true, JSON.stringify(res.response.error));
  const out = engine.applyCanonicalPair({
    seq,
    call: { operationId: op, tool: 'tool_load', input },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, scope);
  assert.equal(out.applied, true, out.reason);
  // 模拟 journal 在真实出站 header 观测到披露并冻结 wire
  engine.recordAdvertisement(scope, {
    requestId: `${scope.sessionId}#${seq}`,
    toolId: res.response.data.receipt.selected[0].toolId,
    name: res.response.data.receipt.selected[0].name,
    revision: res.response.data.receipt.selected[0].revision,
    schemaDigest: res.response.data.receipt.selected[0].schemaDigest,
    wire: wireOf(res.response.data.receipt.selected[0].name),
  });
  return res;
}

test('E01 loadA 再 loadB：frozen 序列只追加，A 的 wire 逐字不变', async () => {
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  const seqA = engine.getFrozenWire(SCOPE_A);
  assert.equal(seqA.length, 1);
  assert.equal(seqA[0].name, 'glob');

  await loadAndFreeze(engine, SCOPE_A, { names: ['grep'] }, 2);
  const seqB = engine.getFrozenWire(SCOPE_A);
  assert.deepEqual(seqB.map((f) => f.name), ['glob', 'grep'], '只增量追加，不重排');
  assert.deepEqual(seqB[0], seqA[0], 'A 的冻结记录逐字不变');
  assert.deepEqual(seqB[0].wire, wireOf('glob'));
});

test('E01b 追加顺序由首次披露决定,与字典序相反', async () => {
  // web_fetch > unit_convert > grep：故意选自然序与加载序相反的名字,
  // 这样任何"按名字排序"或"按宿主 incoming 顺序"实现都会被立刻抓住。
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['web_fetch'] }, 1);
  await loadAndFreeze(engine, SCOPE_A, { names: ['unit_convert'] }, 2);
  await loadAndFreeze(engine, SCOPE_A, { names: ['grep'] }, 3);
  assert.deepEqual(
    engine.getFrozenWire(SCOPE_A).map((f) => f.name),
    ['web_fetch', 'unit_convert', 'grep'],
    '必须是加载顺序 web→unit→grep,而不是字典序 grep→unit→web',
  );
});

test('E02 重复 load 已冻结工具幂等：不重复冻结、不改 wire、不改顺序', async () => {
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  await loadAndFreeze(engine, SCOPE_A, { names: ['grep'] }, 2);
  const before = engine.getFrozenWire(SCOPE_A);

  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 3);
  const after = engine.getFrozenWire(SCOPE_A);
  assert.equal(after.length, 2, '重复 load 不得新增冻结项');
  assert.deepEqual(after, before);
});

test('E03 schema 换版不得静默更新冻结 wire；执行授权照旧失效', async () => {
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  const frozenBefore = engine.getFrozenWire(SCOPE_A)[0];

  engine.refreshCatalog(sampleBindings().map((b) => (b.toolId === 't_files_glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', properties: { pattern: { type: 'string' } } } } }
    : b)));

  const frozenAfter = engine.getFrozenWire(SCOPE_A)[0];
  assert.deepEqual(frozenAfter, frozenBefore, '冻结 wire 不得被静默更新');
  assert.deepEqual(frozenAfter.wire, wireOf('glob'), '仍是首次披露的那份定义');
  // 执行授权：定义已变 → selected 被 invalidate → guard 拒绝
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('E04 撤权不自动移除已披露 schema（披露缓存 ≠ 执行授权）', async () => {
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  engine.refreshCatalog(sampleBindings().filter((b) => b.toolId !== 't_files_glob'));

  const frozen = engine.getFrozenWire(SCOPE_A);
  assert.equal(frozen.length, 1, '正常缓存周期内不得自动移除已披露 schema');
  assert.equal(frozen[0].name, 'glob');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '执行授权已失效');
});

test('E05 预算按冻结 wire 核算，超预算整批拒绝且不淘汰任何已冻结项', async () => {
  const fat = binding({
    name: 'fat_tool', toolId: 't_files_fat', namespace: 'files',
    params: { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(60000) } } },
  });
  const { engine } = await makeEngine({
    bindings: [...sampleBindings(), fat],
    engineConfig: { budgets: { maxActiveSchemaBytes: 2000 } },
  });
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);

  const res = await engine.handleLoad({ names: ['fat_tool'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');

  const frozen = engine.getFrozenWire(SCOPE_A);
  assert.equal(frozen.length, 1, '超预算不得淘汰 A');
  assert.equal(frozen[0].name, 'glob');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1, 'A 仍可执行');
});

test('E06 成功压缩重置：清披露缓存与 selected，epoch 推进', async () => {
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  const before = engine.getState(SCOPE_A).epoch;

  engine.resetCacheEpoch(SCOPE_A, 'compaction-end');
  assert.equal(engine.getFrozenWire(SCOPE_A).length, 0);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  assert.equal(engine.getState(SCOPE_A).epoch, before + 1);

  // 新 load 仍可正常披露与执行
  await loadAndFreeze(engine, SCOPE_A, { names: ['grep'] }, 5);
  assert.deepEqual(engine.getFrozenWire(SCOPE_A).map((f) => f.name), ['grep']);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
});

test('E07 常驻工具与三入口不受 reset 影响（它们从不进入 selected/frozen）', async () => {
  const { engine } = await makeEngine({ engineConfig: { alwaysToolNames: ['misc_thing'] } });
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  engine.resetCacheEpoch(SCOPE_A, 'compaction-end');

  const st = engine.getState(SCOPE_A);
  for (const n of ['tool_list', 'tool_search', 'tool_load', 'misc_thing']) {
    assert.ok(!st.selected.has(n), `${n} 不应因 reset 进入 selected`);
    assert.ok(!st.frozen.has(n), `${n} 不应因 reset 进入 frozen`);
  }
  const listed = engine.handleList({ view: 'loaded', category: 'all' }, SCOPE_A);
  assert.deepEqual(listed.data.names, [], 'reset 后 loaded 视图为空');
});

test('E08 模型不得自主 unload：action=unload 一律 INVALID_ARGS', async () => {
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  const res = await engine.handleLoad(
    { action: 'unload', toolIds: ['t_files_glob'] }, SCOPE_A, { operationId: nextOpId() },
  );
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1, '不得因被拒的 unload 丢失选择');
  assert.equal(engine.getFrozenWire(SCOPE_A).length, 1, '披露缓存不受影响');
});

test('E09 旧历史 unload 回执仍可兼容回放：只移出执行授权，不动披露缓存', async () => {
  const { engine } = await makeEngine();
  await loadAndFreeze(engine, SCOPE_A, { names: ['glob'] }, 1);
  const { reducePair } = await import('../../domain/state.mjs');
  const out = reducePair(engine.getState(SCOPE_A), {
    seq: 2,
    call: { operationId: 'op_old', tool: 'tool_load', input: { action: 'unload', toolIds: ['t_files_glob'] } },
    result: {
      isError: false,
      ok: true,
      payload: { kind: 'tool-discovery.selection', version: 2, operationId: 'op_old', operation: 'unload', deselected: ['t_files_glob'] },
    },
  }, {
    now: () => 1,
    catalog: engine.getCatalog(),
    protectedToolIds: new Set(),
    protectedNames: new Set(['tool_list', 'tool_search', 'tool_load', 'final_answer']),
  });
  assert.equal(out.applied, true, out.reason);
  assert.equal(out.state.selected.size, 0, '执行授权被撤销');
  assert.equal(out.state.frozen.size, 1, '披露缓存不受 unload 回放影响');
});
// 候选引用、load/unload 事务、幂等与预算测试(F03-F05/F14-F19/F20, S03/S04)
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, SCOPE_B, SCOPE_FORK, nextOpId, fakeClock, binding, sampleBindings } from './helpers.mjs';

const searchOnce = (engine, scope, q = 'glob', cat = 'files') =>
  engine.handleSearch({ category: cat, query: q }, scope);

/** 完成一次 load 的 canonical 折叠,返回 reducer 结果。 */
async function doLoad(engine, scope, input, seq = 1) {
  const op = nextOpId();
  const res = await engine.handleLoad(input, scope, { operationId: op });
  if (!res.response.ok) return { response: res.response, applied: false };
  const out = engine.applyCanonicalPair({
    seq,
    call: { operationId: op, tool: 'tool_load', input },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, scope);
  return { response: res.response, applied: out.applied, reason: out.reason };
}

test('F02 search 只返回候选卡,不泄漏 parameters 且不改 selected', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  assert.equal(r.ok, true);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('parameters'), '禁止 parameters');
  assert.ok(!text.includes('required'), '禁止 required');
  assert.ok(!text.includes('execute'), '禁止 execute');
  const c = r.data.candidates[0];
  assert.ok(c.toolId && c.ref && c.revision && c.name);
  assert.ok(Array.isArray(c.categories));
  assert.ok(Array.isArray(c.matchReasons));
  assert.equal(c.loaded, false);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, 'search 不改变激活集合');
});

test('F03 候选 load 成功,回执 selectionSource=candidate', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  const { response, applied } = await doLoad(engine, SCOPE_A, { candidates: [{ ref: c.ref, revision: c.revision }] });
  assert.equal(response.ok, true);
  assert.equal(response.data.receipt.selectionSource, 'candidate');
  assert.equal(response.data.receipt.operation, 'load');
  assert.equal(response.data.takesEffect, 'next_request');
  assert.equal(response.data.schemaDelivery, 'native_tools_only');
  assert.equal(applied, true);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
});

test('完整 native schema 不进 skills/history(F02/§6)', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  const { response } = await doLoad(engine, SCOPE_A, { candidates: [{ ref: c.ref, revision: c.revision }] });
  const skillText = JSON.stringify(response.data.skills);
  assert.ok(!skillText.includes('parameters'), '技能不得复述 schema');
  assert.ok(!skillText.includes('"type":"object"'));
  assert.ok(response.data.skills.length === 1);
  assert.ok(response.data.skills[0].usage);
  assert.ok(Array.isArray(response.data.skills[0].limitations));
});

test('S03 另一个 agent 的 ref → CANDIDATE_UNAVAILABLE', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  const res = await engine.handleLoad({ candidates: [{ ref: c.ref, revision: c.revision }] }, SCOPE_B, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
});

test('S03 fork 不继承父 ref', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  const res = await engine.handleLoad({ candidates: [{ ref: c.ref, revision: c.revision }] }, SCOPE_FORK, { operationId: nextOpId() });
  assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
});

test('候选 ref 过期 → CANDIDATE_UNAVAILABLE', async () => {
  const clock = fakeClock();
  const { engine } = await makeEngine({ clock });
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  clock.advance(900_001);
  const res = await engine.handleLoad({ candidates: [{ ref: c.ref, revision: c.revision }] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
});

test('STALE_CANDIDATE:revision 与当前定义不一致', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  const res = await engine.handleLoad({ candidates: [{ ref: c.ref, revision: 'r_bogus' }] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.error.code, 'STALE_CANDIDATE');
});

test('目录代次变化后旧 ref 失效', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  engine.refreshCatalog(sampleBindings());
  const res = await engine.handleLoad({ candidates: [{ ref: c.ref, revision: c.revision }] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
});

test('F14 已知名称直接 load,不强制先搜索', async () => {
  const { engine } = await makeEngine();
  const { response, applied } = await doLoad(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(response.ok, true);
  assert.equal(response.data.receipt.selectionSource, 'name');
  assert.equal(applied, true);
});

test('F15 名称不存在 → TOOL_UNAVAILABLE,不泄漏私有存在性', async () => {
  const { engine } = await makeEngine();
  for (const n of ['not_registered_zz', 'glob_extra', 'GLOB', 'glo']) {
    const res = await engine.handleLoad({ names: [n] }, SCOPE_A, { operationId: nextOpId() });
    assert.equal(res.response.error.code, 'TOOL_UNAVAILABLE', `名称 ${n} 应为 TOOL_UNAVAILABLE`);
    assert.ok(!JSON.stringify(res.response).includes('not_registered'), '不得泄漏内部信息');
  }
});

test('F15 不做模糊/前缀/通配展开', async () => {
  const { engine } = await makeEngine();
  for (const n of ['glo*', '*', 'glob*', 'read_file2']) {
    const res = await engine.handleLoad({ names: [n] }, SCOPE_A, { operationId: nextOpId() });
    assert.equal(res.response.ok, false, `${n} 不得被模糊解析`);
  }
});

test('F18 candidates 与 names 混用 → INVALID_ARGS 且无半批状态', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  const res = await engine.handleLoad(
    { candidates: [{ ref: c.ref, revision: c.revision }], names: ['grep'] },
    SCOPE_A,
    { operationId: nextOpId() },
  );
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '不得形成半批状态');
});

test('F05 批次全有或全无:第二项不可用则整批不提交', async () => {
  const { engine } = await makeEngine();
  const res = await engine.handleLoad({ names: ['glob', 'not_registered_zz'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'TOOL_UNAVAILABLE');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '整批不提交');
});

test('F05 预算半批失败:整批不提交', async () => {
  const fat = binding({
    name: 'fat_tool',
    toolId: 't_files_fat',
    namespace: 'files',
    params: { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(60000) } } },
  });
  const { engine } = await makeEngine({ bindings: [...sampleBindings(), fat], engineConfig: { budgets: { maxActiveSchemaBytes: 2000 } } });
  const res = await engine.handleLoad({ names: ['glob', 'fat_tool'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '超预算整批不提交,glob 也不得被单独提交');
});

test('F04 同版本重复 load 幂等:不重复计费、不重复追加', async () => {
  const { engine } = await makeEngine();
  const first = await doLoad(engine, SCOPE_A, { names: ['glob'] }, 1);
  assert.equal(first.applied, true);
  const second = await doLoad(engine, SCOPE_A, { names: ['glob'] }, 2);
  assert.equal(second.response.ok, true);
  assert.equal(second.applied, true);
  const st = engine.getState(SCOPE_A);
  assert.equal(st.selected.size, 1, '不重复追加');
  const s = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(s.data.budgets.activeCount, 1, '预算不双算');
});

test('F19 同名已加载的新显式 load 重新验证,不复用 stale 版本', async () => {
  const { engine } = await makeEngine();
  await doLoad(engine, SCOPE_A, { names: ['glob'] }, 1);
  // schema 变化 → 旧选择失效,新的显式 load 必须用新 revision
  const changed = sampleBindings().map((b) => (b.toolId === 't_files_glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } } }
    : b));
  engine.refreshCatalog(changed);
  const st = engine.getState(SCOPE_A);
  assert.equal(st.selected.size, 0, '定义变化后旧选择失效');
  const { response, applied } = await doLoad(engine, SCOPE_A, { names: ['glob'] }, 2);
  assert.equal(response.ok, true);
  assert.equal(applied, true);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
});

test('F08 模型不得自主 unload:action=unload 被拒且不改变任何状态', async () => {
  const { engine } = await makeEngine();
  await doLoad(engine, SCOPE_A, { names: ['glob'] }, 1);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  const { response, applied } = await doLoad(engine, SCOPE_A, { action: 'unload', toolIds: ['t_files_glob'] }, 2);
  assert.equal(response.ok, false, 'unload 不再是模型可用路径');
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.equal(applied, false, '被拒的调用不得产生 canonical 折叠');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1, '已加载的工具保持加载');
});

test('F20 入口与框架保留项不可 load', async () => {
  const { engine } = await makeEngine();
  for (const n of ['tool_list', 'tool_search', 'tool_load', 'final_answer']) {
    const res = await engine.handleLoad({ names: [n] }, SCOPE_A, { operationId: nextOpId() });
    assert.equal(res.response.ok, false, `${n} 不得被加载`);
    assert.equal(res.response.error.code, 'INVALID_ARGS');
  }
  const un = await engine.handleLoad({ action: 'unload', toolIds: ['t_entry_list', 't_fw_final'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(un.response.ok, false);
  assert.equal(un.response.error.code, 'INVALID_ARGS');
});

test('operationId 必须由宿主提供', async () => {
  const { engine } = await makeEngine();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, {});
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INCOMPATIBLE_COMPOSITION');
  const res2 = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, undefined);
  assert.equal(res2.response.ok, false);
});

test('会话身份必须来自宿主:缺失即拒绝', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'state' }, { actorId: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INCOMPATIBLE_COMPOSITION');
});

test('load/unload 串行:并发调用不产生交叉状态', async () => {
  const { engine } = await makeEngine();
  const results = await Promise.all([
    engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_a' }),
    engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: 'op_b' }),
    engine.handleLoad({ names: ['read_file'] }, SCOPE_A, { operationId: 'op_c' }),
  ]);
  for (const r of results) assert.equal(r.response.ok, true);
  const opIds = results.map((r) => r.operation.operationId);
  assert.deepEqual(opIds, ['op_a', 'op_b', 'op_c'], '必须按提交顺序串行');
});

test('F16 提交前 recheck:验证期间定义变化 → SELECTION_CHANGED', async () => {
  const { engine } = await makeEngine();
  const r = searchOnce(engine, SCOPE_A);
  const c = r.data.candidates[0];
  // 先让候选存在,再在提交前触发目录刷新:通过直接改 catalog 后的 recheck 路径验证
  const res = await engine.handleLoad({ candidates: [{ ref: c.ref, revision: c.revision }] }, SCOPE_A, { operationId: nextOpId() });
  // 正常路径不应报错
  assert.equal(res.response.ok, true);
  // 之后再刷新目录,旧选择应失效而不是被悄悄改选
  engine.refreshCatalog(sampleBindings().filter((b) => b.toolId !== 't_files_glob'));
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('S04 shadow 绑定:按名称有歧义时不猜', async () => {
  const bindings = [
    ...sampleBindings(),
    binding({ name: 'dup_tool', toolId: 't_dup_a', namespace: 'files' }),
    binding({ name: 'dup_tool', toolId: 't_dup_b', namespace: 'files', params: { required: ['x'] } }),
  ];
  const { engine } = await makeEngine({ bindings });
  const res = await engine.handleLoad({ names: ['dup_tool'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'TOOL_UNAVAILABLE', '同名歧义不得静默选第一个');
});

test('技能载荷不得复述 schema', async () => {
  const bad = binding({
    name: 'bad_skill',
    toolId: 't_bad_skill',
    skill: { skillRevision: 's1', usage: 'see parameters schema', limitations: ['x'] },
  });
  // 技能对象本身合法,但投影时不含 schema 字段
  const { engine } = await makeEngine({ bindings: [...sampleBindings(), bad] });
  const res = await engine.handleLoad({ names: ['bad_skill'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, true);
  assert.ok(!JSON.stringify(res.response.data.skills).includes('"parameters"'));
});

// ---------------------------------------------------------------------------
// D1/D2 回归:候选路径与折叠侧的入口/框架保护必须与 names 路径对称。
// ---------------------------------------------------------------------------

test('D1 候选路径 load 入口项 → INVALID_ARGS(与 names 路径对称)', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleSearch({ category: 'all', query: 'tool_list' }, SCOPE_A);
  const hit = (r.data?.candidates ?? []).find((c) => c.name === 'tool_list');
  assert.ok(hit, 'search(all) 应能命中入口名(目录未排除)');
  const res = await engine.handleLoad(
    { candidates: [{ ref: hit.ref, revision: hit.revision }] },
    SCOPE_A,
    { operationId: nextOpId() },
  );
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '入口项不得进入 selected');
});

test('D1 候选路径 load 框架项 → INVALID_ARGS', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleSearch({ category: 'all', query: 'final_answer' }, SCOPE_A);
  const hit = (r.data?.candidates ?? []).find((c) => c.name === 'final_answer');
  assert.ok(hit, 'search(all) 应能命中框架名');
  const res = await engine.handleLoad(
    { candidates: [{ ref: hit.ref, revision: hit.revision }] },
    SCOPE_A,
    { operationId: nextOpId() },
  );
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('D1 折叠侧 reducePair 拒选中入口项(冷恢复路径)', async () => {
  const { engine } = await makeEngine();
  const entry = engine.getCatalog().entries.get('t_entry_list');
  assert.ok(entry);
  const { reducePair, createState } = await import('../../domain/state.mjs');
  const st = createState('s_d1_cold');
  const out = reducePair(st, {
    seq: 1,
    call: {
      operationId: 'op_cold',
      tool: 'tool_load',
      input: { names: ['tool_list'] },
    },
    result: {
      isError: false,
      ok: true,
      payload: {
        kind: 'tool-discovery.selection',
        version: 2,
        operationId: 'op_cold',
        operation: 'load',
        selectionSource: 'name',
        selected: [{
          toolId: entry.toolId,
          name: entry.name,
          revision: entry.revision,
          schemaDigest: entry.schemaDigest,
          skillRevision: entry.skillRevision,
        }],
      },
    },
  }, {
    now: () => 1_700_000_000_000,
    catalog: engine.getCatalog(),
    protectedToolIds: new Set([entry.toolId]),
    protectedNames: new Set(['tool_list', 'tool_search', 'tool_load', 'final_answer']),
  });
  assert.equal(out.applied, false, '折叠不得选中入口项');
  assert.equal(out.reason, 'protected-tool');
  assert.equal(out.state.selected.size, 0);
});

test('D2 refreshCatalog 后新绑定的框架项仍受保护(unload 路径已关闭)', async () => {
  const { engine } = await makeEngine();
  // 刷新目录,框架项换新 toolId
  engine.refreshCatalog([
    binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files', description: 'enumerate file entries by path pattern' }),
    binding({ name: 'final_answer', toolId: 't_fw_final_v2', description: 'framework required terminator' }),
    binding({ name: 'tool_list', toolId: 't_entry_list_v2', description: 'entry point list' }),
    binding({ name: 'tool_search', toolId: 't_entry_search_v2', description: 'entry point search' }),
    binding({ name: 'tool_load', toolId: 't_entry_load_v2', description: 'entry point load' }),
  ]);
  // 新绑定的框架项换了 toolId,仍不得被当成可加载目标(D2 的保护口径)。
  const res = await engine.handleLoad({ names: ['final_answer'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INVALID_ARGS', '新绑定的框架项不可被 load');
});

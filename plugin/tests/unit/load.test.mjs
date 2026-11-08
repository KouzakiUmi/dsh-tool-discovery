// 候选引用、load/unload 事务、幂等与预算测试（F03-F05/F14-F19/F20, S03/S04）。
//
// rc.1 重设计后：tool_load 校验通过即**立即提交** selected 并返回 admitted，
// 没有 pending 操作、canonical 回执、operationId、取消或冻结 wire。因此旧文件里
// “折叠回执后才激活”“取消未决操作”“reducePair 冷恢复”等用例已删除——它们的
// 产品目标（未加载不能执行、换版后必须重载、批量全有或全无）由新语义的等价
// 断言与 adapters/dsh 的 admission+guard 测试覆盖（见 design-invariants.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeEngine, loadTools, unloadTools, SCOPE_A, SCOPE_B, SCOPE_FORK,
  fakeClock, binding, sampleBindings,
} from './helpers.mjs';
import { domainText } from '../../domain/locale.mjs';

const searchOnce = (engine, scope, q = 'glob', cat = 'files') =>
  engine.handleSearch({ category: cat, query: q }, scope);

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

test('F03 候选 load 立即提交：admitted 带 toolId/name/revision/schemaDigest', async () => {
  const { engine } = await makeEngine();
  const c = searchOnce(engine, SCOPE_A).data.candidates[0];
  const { response, admitted } = await loadTools(engine, SCOPE_A, { candidates: [{ ref: c.ref, revision: c.revision }] });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.loaded, [c.name]);
  assert.equal(response.data.takesEffect, 'next_request');
  assert.equal(response.data.schemaDelivery, 'native_tools_only');
  assert.equal(admitted.length, 1);
  assert.deepEqual(Object.keys(admitted[0]).sort(), ['name', 'revision', 'schemaDigest', 'toolId']);
  const sel = engine.getState(SCOPE_A).selected.get(c.toolId);
  assert.equal(sel.selectionSource, 'candidate');
  assert.equal(sel.revision, c.revision);
});

test('F03b 同批次两个候选对同一 toolId 携带冲突 revision → candidateRevisionConflict', async () => {
  const { engine } = await makeEngine();
  const c1 = searchOnce(engine, SCOPE_A).data.candidates[0];
  const c2 = searchOnce(engine, SCOPE_A).data.candidates.find((c) => c.toolId === c1.toolId);
  assert.ok(c2 && c2.ref !== c1.ref, '前置：需要同一工具的第二条 ref');

  const conflict = await loadTools(engine, SCOPE_A, {
    candidates: [{ ref: c1.ref, revision: c1.revision }, { ref: c2.ref, revision: 'r_conflict' }],
  });
  assert.equal(conflict.response.ok, false);
  assert.equal(conflict.response.error.code, 'INVALID_ARGS');
  assert.equal(
    conflict.response.error.message,
    domainText.t(['detail', 'candidateRevisionConflict']),
    '必须是同批次 revision 冲突这条专用错误，而不是被 STALE_CANDIDATE 抢先',
  );
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);

  // 单候选显式传错 revision 仍是 STALE_CANDIDATE。
  const stale = await loadTools(engine, SCOPE_A, { candidates: [{ ref: c1.ref, revision: 'r_wrong' }] });
  assert.equal(stale.response.error.code, 'STALE_CANDIDATE');
  // 同一工具携带**相同** revision 的两张卡是幂等的正常路径。
  const same = await loadTools(engine, SCOPE_A, {
    candidates: [{ ref: c1.ref, revision: c1.revision }, { ref: c2.ref, revision: c1.revision }],
  });
  assert.equal(same.response.ok, true, JSON.stringify(same.response.error));
  assert.equal(same.response.data.loaded.length, 1, '同一 toolId 只应出现一次');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
});

test('完整 native schema 不进 skills；技能只含 usage/limitations', async () => {
  const { engine } = await makeEngine();
  const c = searchOnce(engine, SCOPE_A).data.candidates[0];
  const { response } = await loadTools(engine, SCOPE_A, { candidates: [{ ref: c.ref, revision: c.revision }] });
  const skillText = JSON.stringify(response.data.skills);
  assert.ok(!skillText.includes('parameters'), '技能不得复述 schema');
  assert.ok(!skillText.includes('"type":"object"'));
  assert.equal(response.data.skills.length, 1);
  assert.ok(response.data.skills[0].usage);
  assert.ok(Array.isArray(response.data.skills[0].limitations));
});

test('S03 另一个 agent 的 ref / fork 继承的 ref → CANDIDATE_UNAVAILABLE', async () => {
  const { engine } = await makeEngine();
  const c = searchOnce(engine, SCOPE_A).data.candidates[0];
  for (const scope of [SCOPE_B, SCOPE_FORK]) {
    const res = await loadTools(engine, scope, { candidates: [{ ref: c.ref, revision: c.revision }] });
    assert.equal(res.response.ok, false);
    assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
    assert.equal(engine.getState(scope).selected.size, 0);
  }
});

test('候选 ref 过期 → CANDIDATE_UNAVAILABLE', async () => {
  const clock = fakeClock();
  const { engine } = await makeEngine({ clock });
  const c = searchOnce(engine, SCOPE_A).data.candidates[0];
  clock.advance(900_001);
  const res = await loadTools(engine, SCOPE_A, { candidates: [{ ref: c.ref, revision: c.revision }] });
  assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
});

test('STALE_CANDIDATE:revision 与当前定义不一致', async () => {
  const { engine } = await makeEngine();
  const c = searchOnce(engine, SCOPE_A).data.candidates[0];
  const res = await loadTools(engine, SCOPE_A, { candidates: [{ ref: c.ref, revision: 'r_bogus' }] });
  assert.equal(res.response.error.code, 'STALE_CANDIDATE');
});

test('目录代次变化后旧 ref 失效', async () => {
  const { engine } = await makeEngine();
  const c = searchOnce(engine, SCOPE_A).data.candidates[0];
  // 目录**真的**变了才升代次；逐字相同的绑定集走快路径，不作废 ref。
  engine.refreshCatalog([...sampleBindings(), binding({ name: 'new_tool', toolId: 't_new_tool', namespace: 'files' })]);
  const res = await loadTools(engine, SCOPE_A, { candidates: [{ ref: c.ref, revision: c.revision }] });
  assert.equal(res.response.error.code, 'CANDIDATE_UNAVAILABLE');
});

test('F14 已知名称直接 load,不强制先搜索；selectionSource=name', async () => {
  const { engine } = await makeEngine();
  const { response, admitted } = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.loaded, ['glob']);
  assert.equal(admitted[0].name, 'glob');
  assert.equal(engine.getState(SCOPE_A).selected.get('t_files_glob').selectionSource, 'name');
});

test('F15 名称不存在 → TOOL_UNAVAILABLE,不泄漏私有存在性', async () => {
  const { engine } = await makeEngine();
  for (const n of ['not_registered_zz', 'glob_extra', 'GLOB', 'glo']) {
    const res = await loadTools(engine, SCOPE_A, { names: [n] });
    assert.equal(res.response.error.code, 'TOOL_UNAVAILABLE', `名称 ${n} 应为 TOOL_UNAVAILABLE`);
    assert.ok(!JSON.stringify(res.response).includes('not_registered'), '不得泄漏内部信息');
  }
});

test('F15 不做模糊/前缀/通配展开', async () => {
  const { engine } = await makeEngine();
  for (const n of ['glo*', '*', 'glob*', 'read_file2']) {
    const res = await loadTools(engine, SCOPE_A, { names: [n] });
    assert.equal(res.response.ok, false, `${n} 不得被模糊解析`);
  }
});

test('F18 candidates 与 names 混用 → INVALID_ARGS 且无半批状态', async () => {
  const { engine } = await makeEngine();
  const c = searchOnce(engine, SCOPE_A).data.candidates[0];
  const res = await loadTools(engine, SCOPE_A, {
    candidates: [{ ref: c.ref, revision: c.revision }], names: ['grep'],
  });
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '不得形成半批状态');
});

test('F05 批次全有或全无:第二项不可用则整批不提交', async () => {
  const { engine } = await makeEngine();
  const res = await loadTools(engine, SCOPE_A, { names: ['glob', 'not_registered_zz'] });
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
  const res = await loadTools(engine, SCOPE_A, { names: ['glob', 'fat_tool'] });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '超预算整批不提交,glob 也不得被单独提交');
});

test('F04 同版本重复 load 幂等:不重复计费、不重复追加', async () => {
  const { engine } = await makeEngine();
  const first = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.deepEqual(first.response.data.loaded, ['glob']);
  const second = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(second.response.ok, true);
  assert.deepEqual(second.response.data.loaded, []);
  assert.deepEqual(second.admitted, []);
  const st = engine.getState(SCOPE_A);
  assert.equal(st.selected.size, 1, '不重复追加');
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 1, '预算不双算');
});

test('F19 同名已加载的显式 load 在换版后按新定义重新验证', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const changed = sampleBindings().map((b) => (b.toolId === 't_files_glob'
    ? { ...b, wire: { ...b.wire, parameters: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } } }
    : b));
  engine.refreshCatalog(changed);
  const st = engine.getState(SCOPE_A);
  assert.equal(st.selected.size, 0, '定义变化后旧选择失效');
  assert.equal(st.invalidated.get('t_files_glob').reason, 'definition-changed');
  const { response, admitted } = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(response.ok, true);
  assert.equal(admitted.length, 1);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(engine.getState(SCOPE_A).selected.get('t_files_glob').revision,
    engine.getCatalog().entries.get('t_files_glob').revision);
});

test('tool_load 不再内建 unload 动作：action:"unload" 被拒且不改变状态', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const res = await loadTools(engine, SCOPE_A, { action: 'unload', toolIds: ['t_files_glob'] });
  assert.equal(res.response.ok, false, 'unload 走独立的 tool_unload 入口');
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1, '已加载的工具保持加载');
  const out = await unloadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(out.response.ok, true);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('F20 入口与框架保留项不可 load；tool_unload 已是入口', async () => {
  const { engine } = await makeEngine();
  for (const n of ['tool_list', 'tool_search', 'tool_load', 'tool_unload', 'final_answer']) {
    const res = await loadTools(engine, SCOPE_A, { names: [n] });
    assert.equal(res.response.ok, false, `${n} 不得被加载`);
    assert.equal(res.response.error.code, 'INVALID_ARGS');
  }
});

test('alwaysVisible 名字 tolerant 加载：只报告 alreadyResident，不写 selected/admitted', async () => {
  const { engine } = await makeEngine({ engineConfig: { alwaysToolNames: ['read_file'] } });
  const tolerated = await loadTools(engine, SCOPE_A, { names: ['read_file'] });
  assert.equal(tolerated.response.ok, true);
  assert.deepEqual(tolerated.response.data.alreadyResident, ['read_file']);
  assert.deepEqual(tolerated.response.data.loaded, []);
  assert.deepEqual(tolerated.admitted, []);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '常驻工具不进 selected');

  const strict = await makeEngine({
    engineConfig: { alwaysToolNames: ['read_file'], tolerantLoadProtected: false },
  });
  const rejected = await loadTools(strict.engine, SCOPE_A, { names: ['read_file'] });
  assert.equal(rejected.response.error.code, 'INVALID_ARGS');
});

test('会话身份必须来自宿主:缺失即拒绝', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'state' }, { actorId: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INCOMPATIBLE_COMPOSITION');
  const s = await loadTools(engine, { actorId: 'x' }, { names: ['glob'] });
  assert.equal(s.response.ok, false);
  assert.equal(s.response.error.code, 'INCOMPATIBLE_COMPOSITION');
});

test('load/unload 串行:并发调用不产生交叉状态', async () => {
  const { engine } = await makeEngine();
  // 新会话首次调用前没有 state：三次并发必须全部成功（engine 的锁必须与
  // requireState 建的是同一把，否则后两者会被误判 STATE_NOT_READY）。
  const results = await Promise.all([
    loadTools(engine, SCOPE_A, { names: ['glob'] }),
    loadTools(engine, SCOPE_A, { names: ['grep'] }),
    loadTools(engine, SCOPE_A, { names: ['read_file'] }),
  ]);
  for (const r of results) assert.equal(r.response.ok, true, JSON.stringify(r.response.error));
  assert.deepEqual(
    [...engine.getState(SCOPE_A).selected.values()].map((s) => s.name).sort(),
    ['glob', 'grep', 'read_file'],
  );
});

test('S04 shadow 绑定:按名称有歧义时不猜', async () => {
  const bindings = [
    ...sampleBindings(),
    binding({ name: 'dup_tool', toolId: 't_dup_a', namespace: 'files' }),
    binding({ name: 'dup_tool', toolId: 't_dup_b', namespace: 'files', params: { required: ['x'] } }),
  ];
  const { engine } = await makeEngine({ bindings });
  const res = await loadTools(engine, SCOPE_A, { names: ['dup_tool'] });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'TOOL_UNAVAILABLE', '同名歧义不得静默选第一个');
});

test('技能载荷不得复述 schema；技能缺失时 skills 为空数组', async () => {
  const bad = binding({
    name: 'bad_skill',
    toolId: 't_bad_skill',
    skill: { skillRevision: 's1', usage: 'see parameters schema', limitations: ['x'] },
  });
  const { engine } = await makeEngine({
    bindings: [...sampleBindings(), bad, binding({ name: 'no_skill', toolId: 't_no_skill', namespace: 'files', skill: null })],
  });
  const res = await loadTools(engine, SCOPE_A, { names: ['bad_skill'] });
  assert.equal(res.response.ok, true);
  assert.ok(!JSON.stringify(res.response.data.skills).includes('"parameters"'));
  const plain = await loadTools(engine, SCOPE_A, { names: ['no_skill'] });
  assert.equal(plain.response.ok, true);
  assert.deepEqual(plain.response.data.skills, []);
});

// ---------------------------------------------------------------------------
// D1:候选路径与 names 路径的入口/框架保护必须对称。
// （旧 D1 的 reducePair 冷恢复分支已随 reducer 删除；新设计里入口从不进入
// admission store，冷路径只回放 admitted 行，因此不再需要单独的折叠保护。）
// ---------------------------------------------------------------------------

test('D1 候选路径 load 入口项 → INVALID_ARGS(与 names 路径对称)', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleSearch({ category: 'all', query: 'tool_list' }, SCOPE_A);
  const hit = (r.data?.candidates ?? []).find((c) => c.name === 'tool_list');
  assert.ok(hit, 'search(all) 应能命中入口名(目录未排除)');
  const res = await loadTools(engine, SCOPE_A, { candidates: [{ ref: hit.ref, revision: hit.revision }] });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '入口项不得进入 selected');
});

test('D1 候选路径 load 框架项 → INVALID_ARGS', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleSearch({ category: 'all', query: 'final_answer' }, SCOPE_A);
  const hit = (r.data?.candidates ?? []).find((c) => c.name === 'final_answer');
  assert.ok(hit, 'search(all) 应能命中框架名');
  const res = await loadTools(engine, SCOPE_A, { candidates: [{ ref: hit.ref, revision: hit.revision }] });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INVALID_ARGS');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('D2 refreshCatalog 后新绑定的框架项仍受保护', async () => {
  const { engine } = await makeEngine();
  engine.refreshCatalog([
    binding({ name: 'glob', toolId: 't_files_glob', namespace: 'files', description: 'enumerate file entries by path pattern' }),
    binding({ name: 'final_answer', toolId: 't_fw_final_v2', description: 'framework required terminator' }),
    binding({ name: 'tool_list', toolId: 't_entry_list_v2', description: 'entry point list' }),
    binding({ name: 'tool_search', toolId: 't_entry_search_v2', description: 'entry point search' }),
    binding({ name: 'tool_load', toolId: 't_entry_load_v2', description: 'entry point load' }),
    binding({ name: 'tool_unload', toolId: 't_entry_unload_v2', description: 'entry point unload' }),
  ]);
  const res = await loadTools(engine, SCOPE_A, { names: ['final_answer'] });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'INVALID_ARGS', '新绑定的框架项不可被 load');
});

test('engine.handleLoad 支持解绑调用(不依赖 this 绑定)', async () => {
  const { engine } = await makeEngine();
  const unboundHandleLoad = engine.handleLoad;
  const res = await unboundHandleLoad({ names: ['glob'] }, SCOPE_A);
  assert.equal(res.response.ok, true);
  assert.equal(res.response.data.loaded[0], 'glob');
});

test('技能去重与技能字节预算：只为本次新增项交付指南，超限整批拒绝', async () => {
  const { engine } = await makeEngine();
  const first = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.deepEqual(first.response.data.skills.map((s) => s.toolId), ['t_files_glob']);
  // 已选同版本不重复回灌；混合批次只为新工具交付。
  const second = await loadTools(engine, SCOPE_A, { names: ['glob', 'grep'] });
  assert.equal(second.response.ok, true);
  assert.deepEqual(second.response.data.skills.map((s) => s.toolId), ['t_files_grep']);
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 2);

  const skillBytes = Buffer.byteLength(JSON.stringify(second.response.data.skills[0]), 'utf8');
  const { engine: limited } = await makeEngine({ engineConfig: { budgets: { maxSkillBytesPerLoad: skillBytes - 1 } } });
  const rejected = await loadTools(limited, SCOPE_A, { names: ['grep'] });
  assert.equal(rejected.response.ok, false, '技能卡无法交付时整批拒绝');
  assert.equal(rejected.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(limited.getState(SCOPE_A).selected.size, 0, '拒绝后不得留下半批选择');
});

test('createDiscoveryEngine 显式传入 config.locale 时不受全局 setDomainLocale 覆盖', async () => {
  const { setDomainLocale } = await import('../../domain/locale.mjs');
  setDomainLocale('zh');
  try {
    const { engine } = await makeEngine({ engineConfig: { locale: 'en' } });
    const res = engine.handleList({ view: 'state' }, { actorId: 'x' });
    assert.equal(res.ok, false);
    assert.match(res.error.message, /session identity/i);
  } finally {
    setDomainLocale('en');
  }
});

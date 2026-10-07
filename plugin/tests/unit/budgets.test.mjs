// 预算、字节硬限、名称/ID 不截断与初始导航有界测试(F10/F12/§9)
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, SCOPE_B, nextOpId, commitLoad, binding, sampleBindings } from './helpers.mjs';
import { navigationFootprint } from '../../domain/list.mjs';
import { DEFAULT_BUDGETS } from '../../domain/constants.mjs';

test('F10 **显式配置** schema 字节上限 → 单个超限工具明确失败,schema 未截断', async () => {
  const fat = binding({
    name: 'fat_tool',
    toolId: 't_files_fat',
    namespace: 'files',
    params: { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(60000) } } },
  });
  // 默认关闭 → 不因单个大 schema 就阻断
  const open = await makeEngine({ bindings: [...sampleBindings(), fat] });
  const openRes = await commitLoad(open.engine, SCOPE_A, { names: ['fat_tool'] });
  assert.equal(openRes.response.ok, true, '默认不得粗暴阻断单个大 schema');

  const { engine } = await makeEngine({
    bindings: [...sampleBindings(), fat],
    engineConfig: { budgets: { maxActiveSchemaBytes: 49152 } },
  });
  const res = await engine.handleLoad({ names: ['fat_tool'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');
  // 错误信息不泄漏截断后的 schema
  assert.ok(!JSON.stringify(res.response).includes('xxxx'));
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('schema 永不被截断:完整保留 required/enum', async () => {
  const rich = binding({
    name: 'rich_tool',
    toolId: 't_files_rich',
    namespace: 'files',
    params: {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { enum: ['x', 'y', 'z'] } },
    },
  });
  const { engine } = await makeEngine({ bindings: [...sampleBindings(), rich] });
  const res = await commitLoad(engine, SCOPE_A, { names: ['rich_tool'] });
  assert.equal(res.response.ok, true);
  assert.equal(res.applied, true, 'pending execute 不改 selected；必须折叠成功回执后才选定');
  // 回执中不含 schema;身份由 digest 完整覆盖
  const sel = engine.getState(SCOPE_A).selected.get('t_files_rich');
  assert.ok(sel.schemaDigest.startsWith('sha256:'));
  const entry = engine.getCatalog().entries.get('t_files_rich');
  assert.deepEqual(entry.wire.parameters.required, ['a', 'b']);
  assert.deepEqual(entry.wire.parameters.properties.b.enum, ['x', 'y', 'z']);
});

test('**显式配置**活跃工具数量上限 12 时生效;默认不限制', async () => {
  const many = Array.from({ length: 15 }, (_, i) => binding({ name: `m_${i}`, toolId: `t_m_${i}`, namespace: 'files', params: { type: 'object' } }));

  // 默认：关闭 → 不卡在 12
  const open = await makeEngine({ bindings: many });
  for (let i = 0; i < 14; i += 5) {
    const names = Array.from({ length: Math.min(5, 14 - i) }, (_, k) => `m_${i + k}`);
    assert.equal((await commitLoad(open.engine, SCOPE_A, { names })).response.ok, true, '默认不得阻断');
  }
  assert.equal(open.engine.getState(SCOPE_A).selected.size, 14);

  // 显式配置 12：照旧生效，且不得隐式淘汰
  const { engine } = await makeEngine({
    bindings: many,
    engineConfig: { budgets: { maxActiveTools: 12 } },
  });
  for (let i = 0; i < 12; i += 4) {
    const res = await commitLoad(engine, SCOPE_A, { names: [`m_${i}`, `m_${i + 1}`, `m_${i + 2}`, `m_${i + 3}`] });
    assert.equal(res.response.ok, true, `第 ${i / 4} 批应成功`);
    assert.equal(res.applied, true);
  }
  assert.equal(engine.getState(SCOPE_A).selected.size, 12);
  const over = await engine.handleLoad({ names: ['m_12'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.getState(SCOPE_A).selected.size, 12, '不得隐式 LRU 卸载');
});

test('活跃 schema 总字节上限', async () => {
  const chunky = Array.from({ length: 4 }, (_, i) => binding({
    name: `c_${i}`, toolId: `t_c_${i}`, namespace: 'files',
    params: { type: 'object', properties: { x: { type: 'string', description: 'y'.repeat(2000) } } },
  }));
  const { engine } = await makeEngine({ bindings: chunky, engineConfig: { budgets: { maxActiveSchemaBytes: 5000 } } });
  const res = await engine.handleLoad({ names: ['c_0', 'c_1', 'c_2'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('技能字节预算:超限整批失败', async () => {
  const bulky = Array.from({ length: 2 }, (_, i) => binding({
    name: `sk_${i}`, toolId: `t_sk_${i}`, namespace: 'files',
    skill: { skillRevision: 's1', usage: 'u'.repeat(7000), limitations: ['x'] },
  }));
  const { engine } = await makeEngine({ bindings: bulky, engineConfig: { budgets: { maxSkillBytesPerLoad: 12288 } } });
  const res = await engine.handleLoad({ names: ['sk_0', 'sk_1'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('技能缺失时只发回执,不伪造 usage', async () => {
  const { engine } = await makeEngine({
    bindings: [...sampleBindings(), binding({ name: 'no_skill', toolId: 't_no_skill', namespace: 'files', skill: null })],
  });
  const res = await engine.handleLoad({ names: ['no_skill'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, true);
  assert.deepEqual(res.response.data.skills, []);
  assert.ok(res.response.data.receipt);
});

test('名称不截断:超长名称完整返回或明确失败', async () => {
  const longName = 'x'.repeat(3000);
  const { engine } = await makeEngine({ bindings: [binding({ name: longName, toolId: `t_${longName}`, namespace: 'files' })] });
  const r = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  if (r.ok) {
    assert.equal(r.data.names[0].length, 3000, '放得下就必须完整');
  } else {
    assert.equal(r.error.code, 'BUDGET_EXCEEDED', '放不下必须明确失败,不得截断');
  }
});

test('列表结果字节上限:减少完整项数而非截断', async () => {
  const longNames = Array.from({ length: 10 }, (_, i) => binding({
    name: `${'n'.repeat(300)}_${i}`, toolId: `t_ln_${i}`, namespace: 'files',
  }));
  const { engine } = await makeEngine({ bindings: longNames, engineConfig: { budgets: { maxListResultBytes: 1000 } } });
  const r = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(r.ok, true);
  assert.ok(r.data.names.length < 10, '必须减少项数');
  for (const n of r.data.names) assert.equal(n.length, 302, '每一项都必须是完整名称');
  assert.equal(r.data.truncated, true);
});

test('单个完整名称都放不下时明确失败', async () => {
  const { engine } = await makeEngine({
    bindings: [binding({ name: 'y'.repeat(500), toolId: 't_big', namespace: 'files' })],
    engineConfig: { budgets: { maxListResultBytes: 50 } },
  });
  const r = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BUDGET_EXCEEDED');
});

test('搜索结果字节上限:减少候选数', async () => {
  const { engine } = await makeEngine({
    bindings: Array.from({ length: 12 }, (_, i) => binding({
      name: `file_tool_${i}`, toolId: `t_s_${i}`, namespace: 'files',
      description: 'file path enumeration '.repeat(20),
    })),
    engineConfig: { budgets: { maxSearchResultBytes: 800 } },
  });
  const r = engine.handleSearch({ category: 'files', query: 'file', limit: 8 }, SCOPE_A);
  assert.equal(r.ok, true);
  assert.ok(r.data.candidates.length < 8);
  assert.ok(r.data.truncated);
});

test('导航体积有界:类别卡片带 estimate 标注', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'categories' }, SCOPE_A);
  const fp = navigationFootprint(r.data.categories);
  assert.equal(fp.method, 'estimate');
  assert.ok(fp.estimatedTokens > 0);
  assert.ok(r.data.categories.length <= DEFAULT_BUDGETS.maxInitialCategories);
});

test('**显式配置**上限时 B 会话独立预算:超限不影响 A', async () => {
  const many = Array.from({ length: 13 }, (_, i) => binding({ name: `m_${i}`, toolId: `t_m_${i}`, namespace: 'files', params: { type: 'object' } }));
  const { engine } = await makeEngine({ bindings: many, engineConfig: { budgets: { maxActiveTools: 12 } } });
  for (let i = 0; i < 12; i += 4) {
    const res = await commitLoad(engine, SCOPE_B, { names: [`m_${i}`, `m_${i + 1}`, `m_${i + 2}`, `m_${i + 3}`] });
    assert.equal(res.response.ok, true);
    assert.equal(res.applied, true);
  }
  const over = await engine.handleLoad({ names: ['m_12'] }, SCOPE_B, { operationId: nextOpId() });
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');
  const a = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.deepEqual(a.data.selected, []);
});

test('未知预算项被拒绝(不静默接受拼写错误)', async () => {
  await assert.rejects(async () => {
    await makeEngine({ engineConfig: { budgets: { maxActiveTool: 5 } } });
  });
});

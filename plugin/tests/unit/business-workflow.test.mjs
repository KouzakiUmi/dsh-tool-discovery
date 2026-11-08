// 人工业务回归：只用自造目录和 pure client 导出，不读取质量查询/标签。
// VM 的 React 占位对象仅允许载入 factory，任何渲染/hook 调用都将失败；不是 DOM/React 集成证明。
//
// rc.1 重设计后 tool_load 立即提交：旧文件的 pending/折叠/冻结/restoreDisclosures/
// COMPACTION_REQUIRED 用例改为直接观察 selected 与 admission 结果；resume 场景改用
// seedSelection（durable admission 行的回填入口）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeEngine, loadTools, unloadTools, binding, SCOPE_A, SCOPE_B } from './helpers.mjs';
import * as model from '../../client/model.mjs';
import { createEntryDefinitions } from '../../adapters/dsh/entries.mjs';
import { createText } from '../../domain/locale.mjs';

const makeBindings = () => ['read_file', 'extra_tool', 'third_tool'].map(name => binding({ name, namespace: 'files', skill: null }));
async function scenario(options = {}) {
  const { engine } = await makeEngine({ bindings: makeBindings(), ...options });
  const load = (input, scope = SCOPE_A) => engine.handleLoad(input, scope);
  const budget = (scope = SCOPE_A) => engine.handleList({ view: 'state' }, scope).data.budgets;
  return { engine, load, budget };
}

for (const path of ['name', 'candidate']) {
  test(`BW1 ${path}: 加载常驻初始工具不挤占按需额度`, async () => {
    const s = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], budgets: { maxActiveTools: 1 } } });
    const card = s.engine.handleSearch({ category: 'all', query: 'read_file' }, SCOPE_A).data.candidates[0];
    const a = await s.load(path === 'name' ? { names: ['read_file'] } : { candidates: [{ ref: card.ref }] });
    assert.equal(a.response.ok, true);
    assert.deepEqual(a.response.data.alreadyResident, ['read_file']);
    assert.equal(s.budget().activeCount, 0, '常驻工具不计为按需新增');
    assert.equal(s.engine.getState(SCOPE_A).selected.size, 0, '常驻工具不写 selected');

    const b = await s.load({ names: ['extra_tool'] });
    assert.equal(b.response.ok, true, '真实新增工具仍可使用那一个按需名额');
    assert.equal(s.budget().activeCount, 1);
    const extra = s.engine.getCatalog().entries.get('t_extra_tool');
    assert.equal(s.budget().activeSchemaBytes, extra.wireBytes);
    assert.equal((await s.load({ names: ['third_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
  });
}

test('BW2: 初始工具和新增工具混合成批只计后者；已有额度满也可幂等重载基线', async () => {
  const s = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], budgets: { maxActiveTools: 1 } } });
  const batch = await s.load({ names: ['read_file', 'extra_tool'] });
  assert.equal(batch.response.ok, true);
  assert.deepEqual(batch.response.data.loaded, ['extra_tool']);
  assert.deepEqual(batch.response.data.alreadyResident, ['read_file']);
  const repeated = await s.load({ names: ['read_file'] });
  assert.equal(repeated.response.ok, true);
  assert.deepEqual(repeated.response.data.alreadyResident, ['read_file']);
  assert.equal(s.budget().activeCount, 1);
});

test('BW3: 初始工具的大 schema 不消耗按需 schema 限额；未知名与严格保护仍拒绝', async () => {
  const bindings = makeBindings();
  bindings[0] = binding({ name: 'read_file', namespace: 'files', description: 'x'.repeat(2000), skill: null });
  const s = await scenario({ bindings, engineConfig: { alwaysToolNames: ['read_file', 'missing_tool'], budgets: { maxActiveSchemaBytes: 1 } } });
  const baseline = await s.load({ names: ['read_file'] });
  assert.equal(baseline.response.ok, true);
  assert.equal(s.budget().activeSchemaBytes, 0);
  assert.equal((await s.load({ names: ['extra_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
  assert.equal((await s.load({ names: ['missing_tool'] })).response.error.code, 'TOOL_UNAVAILABLE');
  const strict = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], tolerantLoadProtected: false } });
  assert.equal((await strict.load({ names: ['read_file'] })).response.error.code, 'INVALID_ARGS');
});

test('BW4: 基线免费不会使其它会话或失败混批获得额外按需名额', async () => {
  const s = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], budgets: { maxActiveTools: 1 } } });
  const a = await s.load({ names: ['extra_tool'] }, SCOPE_A);
  const b = await s.load({ names: ['extra_tool'] }, SCOPE_B);
  assert.equal(a.response.ok, true); assert.equal(b.response.ok, true);
  assert.equal(s.budget(SCOPE_A).activeCount, 1); assert.equal(s.budget(SCOPE_B).activeCount, 1);
  // 失败混批不得写入任何选择。
  assert.equal((await s.load({ names: ['read_file', 'missing_tool'] })).response.error.code, 'TOOL_UNAVAILABLE');
  assert.equal(s.engine.getState(SCOPE_A).selected.size, 1);
  assert.equal((await s.load({ names: ['third_tool'] }, SCOPE_A)).response.error.code, 'BUDGET_EXCEEDED');
});

for (const budgets of [{ maxActiveTools: 1 }, { maxActiveSchemaBytes: 1 }]) {
  test(`BW5 ${Object.keys(budgets)[0]}: resume 种子允许零新增恢复，但仍拒绝新增`, async () => {
    const hot = await scenario();
    const rows = [];
    for (const name of ['read_file', 'extra_tool']) {
      assert.equal((await hot.load({ names: [name] })).response.ok, true);
      const entry = hot.engine.getCatalog().byName.get(name)[0];
      rows.push({ name, toolId: entry.toolId, schemaDigest: entry.schemaDigest, at: 1 });
    }
    const cold = await scenario({ engineConfig: { budgets } });
    const seeded = cold.engine.seedSelection(SCOPE_A, rows);
    assert.deepEqual(seeded.seeded.sort(), ['extra_tool', 'read_file']);
    assert.equal(cold.engine.getState(SCOPE_A).selected.size, 2, '恢复不再重新核算预算');

    const repeat = await cold.load({ names: ['read_file'] });
    assert.equal(repeat.response.ok, true, '保留足迹已超新限额不该阻断零新增重选');
    assert.deepEqual(repeat.admitted, []);
    assert.equal((await cold.load({ names: ['third_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
  });
}

test('BW6: 超新限额的相同 wire 重绑可重选，冲突 schema 必须重新核算并拒绝', async () => {
  // read_file 默认 wire 约 148B；上限 200B 让它首次放得下，换大 schema 后放不下。
  const s = await scenario({ engineConfig: { budgets: { maxActiveSchemaBytes: 200 } } });
  assert.equal((await s.load({ names: ['read_file'] })).response.ok, true);
  const next = makeBindings(); next[0].bindingGeneration = 'reconnected';
  s.engine.refreshCatalog(next);
  assert.equal(s.engine.getState(SCOPE_A).selected.size, 0, '绑定代次变化使旧选择失效');
  const same = await s.load({ names: ['read_file'] });
  assert.equal(same.response.ok, true, '同 wire 的新绑定可重新选中');
  assert.equal(same.admitted.length, 1);

  next[0] = binding({ name: 'read_file', namespace: 'files', description: 'different schema '.repeat(10), generation: 'changed', skill: null });
  s.engine.refreshCatalog(next);
  assert.equal((await s.load({ names: ['read_file'] })).response.error.code, 'BUDGET_EXCEEDED');
});

function shippedPureExports() {
  let descriptor;
  vm.runInNewContext(readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: d => { descriptor = d; } } },
    console: { error() {}, warn() {}, log() {} },
  });
  return descriptor.factory(id => { assert.equal(id, 'react'); return {}; }).__test;
}

test('BW7: 单个勾选取消移除所有重复项，纯模型和实际发布内联函数一致', async () => {
  const shipped = shippedPureExports();
  let value = ['read_file', 'extra_tool', 'read_file'];
  const original = [...value];
  const next = shipped.toggleName(value, 'read_file');
  assert.deepEqual([...next], ['extra_tool']);
  assert.deepEqual(model.toggleName(value, 'read_file'), ['extra_tool']);
  assert.deepEqual(value, original, '不能原地改写配置');
  assert.equal(await shipped.saveSetting({ mutate: async edits => { value = [...edits[0].value]; return true; } }, 'alwaysVisible', next), true);
  assert.equal(shipped.buildRows({ choices: [{ name: 'read_file' }] }, value).rows.find(r => r.name === 'read_file').selected, false);
  for (let i = 0; i < 100; i++) {
    const raw = Array.from({ length: i }, (_, j) => `tool_${j % 7}`);
    const toggled = model.toggleName(raw, 'tool_3');
    assert.equal(toggled.includes('tool_3'), !raw.includes('tool_3'));
    assert.deepEqual([...shipped.toggleName(raw, 'tool_3')], toggled);
  }
});

test('BW8: 技能指南只在新选择/重新选择时交付一次，重复 load 与幂等重载不回灌', async () => {
  const s = await scenario({ bindings: [binding({ name: 'guided_tool', namespace: 'files', skill: { skillRevision: 'v1', usage: 'Use the capability according to this guidance', limitations: [] } })] });
  const first = await s.load({ names: ['guided_tool'] });
  assert.equal(first.response.data.skills.length, 1);
  const repeated = await s.load({ names: ['guided_tool'] });
  assert.equal(repeated.response.ok, true);
  assert.equal(repeated.response.data.skills.length, 0, '已提交同版本去冗余');
  assert.deepEqual(repeated.admitted, []);

  assert.equal((await unloadTools(s.engine, SCOPE_A, { names: ['guided_tool'] })).response.ok, true);
  const reload = await s.load({ names: ['guided_tool'] });
  assert.equal(reload.response.ok, true);
  assert.equal(reload.response.data.skills.length, 1, '重新选择后指南再次交付');
  assert.equal(reload.admitted.length, 1);
});

test('BW9: 新技能仍受字节上限约束，失败后不留下选择且健康工具可继续加载', async () => {
  const s = await scenario({ bindings: [...makeBindings(), binding({ name: 'guided_tool', namespace: 'files', skill: { skillRevision: 'large', usage: 'x'.repeat(500), limitations: [] } })], engineConfig: { budgets: { maxSkillBytesPerLoad: 32 } } });
  assert.equal((await s.load({ names: ['guided_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(s.engine.getState(SCOPE_A).selected.size, 0);
  const ordinary = await s.load({ names: ['extra_tool'] });
  assert.equal(ordinary.response.ok, true);
  assert.equal(s.budget().activeCount, 1);
});

for (const locale of ['en', 'zh']) {
  test(`BW10 ${locale}: 不确定类别可直接 all 搜索，已选择候选引导不重复加载且不提前调用`, async () => {
    const s = await scenario({ engineConfig: { locale, alwaysToolNames: ['read_file'] } });
    const definitions = createEntryDefinitions({
      defineTool: definition => definition,
      resolve: () => ({ engine: s.engine, scope: SCOPE_A }),
      text: createText(locale),
    });
    const search = definitions.find(d => d.name === 'tool_search');
    assert.match(search.description, /all/);
    const out = JSON.parse(await search.execute({ category: 'all', query: 'read_file' }, {}));
    assert.equal(out.ok, true); assert.equal(out.data.candidates[0].loaded, true);
    assert.match(out.nextAction, /loaded/);
    assert.match(out.nextAction, locale === 'zh' ? /下一轮/ : /next request/);
    assert.equal(s.engine.getState(SCOPE_A).selected.size, 0, '发现本身不产生选择');
  });
}

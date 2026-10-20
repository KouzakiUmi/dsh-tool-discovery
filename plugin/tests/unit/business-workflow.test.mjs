// 人工业务回归：只用自造目录和 pure client 导出，不读取质量查询/标签。
// VM 的 React 占位对象仅允许载入 factory，任何渲染/hook 调用都将失败；不是 DOM/React 集成证明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeEngine, binding, SCOPE_A, SCOPE_B } from './helpers.mjs';
import * as model from '../../client/model.mjs';
import { createEntryDefinitions } from '../../adapters/dsh/entries.mjs';
import { createText } from '../../domain/locale.mjs';

const makeBindings = () => ['read_file', 'extra_tool', 'third_tool'].map(name => binding({ name, namespace: 'files', skill: null }));
let scenarioSerial = 0;
async function scenario(options = {}) {
  const prefix = ++scenarioSerial;
  const { engine } = await makeEngine({ bindings: makeBindings(), ...options });
  let seq = options.seqStart ?? 0, op = 0;
  const history = [];
  const request = async (input, scope = SCOPE_A) => {
    const operationId = `bw_${prefix}_${scope.sessionId}_${++op}`;
    const callSeq = seq++;
    const out = await engine.handleLoad(input, scope, { operationId });
    return { input, scope, operationId, callSeq, out };
  };
  const fold = (pending, { failed = false, mismatch = false } = {}) => {
    const payload = structuredClone(pending.out.response.data.receipt);
    if (mismatch) payload.selected[0].revision += '_rewritten';
    const pair = { seq: pending.callSeq, resultSeq: seq++,
      call: { operationId: pending.operationId, tool: 'tool_load', input: pending.input },
      result: { isError: failed, ok: !failed, payload } };
    history.push(pair);
    return engine.applyCanonicalPair(pair, pending.scope);
  };
  const advertise = (name, scope = SCOPE_A) => {
    const entry = [...engine.getCatalog().entries.values()].find(e => e.name === name);
    engine.recordAdvertisement(scope, { ...entry, requestId: `bw_request_${seq}` });
  };
  return { engine, request, fold, advertise, history,
    budget: (scope = SCOPE_A) => engine.handleList({ view: 'state' }, scope).data.budgets };
}

for (const path of ['name', 'candidate']) {
  test(`BW1 ${path}: 重载初始工具从 pending 到 frozen 都不挤占按需额度`, async () => {
    const s = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], budgets: { maxActiveTools: 1 } } });
    const card = s.engine.handleSearch({ category: 'all', query: 'read_file' }, SCOPE_A).data.candidates[0];
    const a = await s.request(path === 'name' ? { names: ['read_file'] } : { candidates: [{ ref: card.ref }] });
    assert.equal(a.out.response.ok, true);
    assert.equal(s.budget().activeCount, 0, '初始工具 pending 不计为按需新增');
    const b = await s.request({ names: ['extra_tool'] });
    assert.equal(b.out.response.ok, true, '真实新增工具仍可使用那一个按需名额');
    assert.equal(s.budget().activeCount, 1);
    assert.equal(s.fold(a).applied, true);
    assert.equal(s.fold(b).applied, true);
    s.advertise('read_file'); s.advertise('extra_tool');
    assert.equal(s.budget().activeCount, 1);
    const extra = [...s.engine.getCatalog().entries.values()].find(e => e.name === 'extra_tool');
    assert.equal(s.budget().activeSchemaBytes, extra.wireBytes);
    assert.equal((await s.request({ names: ['third_tool'] })).out.response.error.code, 'BUDGET_EXCEEDED');
    assert.equal(s.engine.getPendingSize(), 0, '超限请求不建新预留');
  });
}

test('BW2: 初始工具和新增工具混合成批只计后者；已有额度满也允许单独幂等加载基线', async () => {
  const s = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], budgets: { maxActiveTools: 1 } } });
  const batch = await s.request({ names: ['read_file', 'extra_tool'] });
  assert.equal(batch.out.response.ok, true);
  assert.equal(s.fold(batch).applied, true);
  const repeated = await s.request({ names: ['read_file'] });
  assert.equal(repeated.out.response.ok, true);
  assert.equal(s.fold(repeated).applied, true);
  assert.equal(s.budget().activeCount, 1);
});

test('BW3: 初始工具的大 schema 不消耗按需 schema 限额；未知名与严格保护仍拒绝', async () => {
  const bindings = makeBindings();
  bindings[0] = binding({ name: 'read_file', namespace: 'files', description: 'x'.repeat(2000), skill: null });
  const s = await scenario({ bindings, engineConfig: { alwaysToolNames: ['read_file', 'missing_tool'], budgets: { maxActiveSchemaBytes: 1 } } });
  const baseline = await s.request({ names: ['read_file'] });
  assert.equal(baseline.out.response.ok, true);
  assert.equal(s.fold(baseline).applied, true); s.advertise('read_file');
  assert.equal(s.budget().activeSchemaBytes, 0);
  assert.equal((await s.request({ names: ['extra_tool'] })).out.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal((await s.request({ names: ['missing_tool'] })).out.response.error.code, 'TOOL_UNAVAILABLE');
  const strict = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], tolerantLoadProtected: false } });
  assert.equal((await strict.request({ names: ['read_file'] })).out.response.error.code, 'INVALID_ARGS');
});

test('BW4: 基线免费不会使其它会话或失败混批获得额外按需名额', async () => {
  const s = await scenario({ engineConfig: { alwaysToolNames: ['read_file'], budgets: { maxActiveTools: 1 } } });
  const a = await s.request({ names: ['extra_tool'] }, SCOPE_A);
  const b = await s.request({ names: ['extra_tool'] }, SCOPE_B);
  assert.equal(a.out.response.ok, true); assert.equal(b.out.response.ok, true);
  assert.equal(s.budget(SCOPE_A).activeCount, 1); assert.equal(s.budget(SCOPE_B).activeCount, 1);
  assert.equal((await s.request({ names: ['read_file', 'missing_tool'] })).out.response.error.code, 'TOOL_UNAVAILABLE');
  assert.equal(s.engine.getPendingSize(), 2);
  assert.equal((await s.request({ names: ['third_tool'] }, SCOPE_A)).out.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(s.fold(a).applied, true); assert.equal(s.fold(b).applied, true);
});

for (const budgets of [{ maxActiveTools: 1 }, { maxActiveSchemaBytes: 1 }]) {
  test(`BW5 ${Object.keys(budgets)[0]}: 降限额后的恢复允许零新增重选，但仍拒绝新增`, async () => {
    const hot = await scenario();
    for (const name of ['read_file', 'extra_tool']) {
      const p = await hot.request({ names: [name] }); assert.equal(hot.fold(p).applied, true); hot.advertise(name);
    }
    const cold = await scenario({ seqStart: hot.history.at(-1).resultSeq + 1, engineConfig: { budgets } });
    cold.engine.restoreDisclosures(SCOPE_A, hot.engine.getFrozenWire(SCOPE_A));
    assert.equal(cold.engine.restore(hot.history, SCOPE_A).applied, 2);
    const repeat = await cold.request({ names: ['read_file'] });
    assert.equal(repeat.out.response.ok, true, '保留足迹已超新限额不该阻断零新增重选');
    assert.equal(cold.fold(repeat).applied, true);
    assert.equal(cold.engine.getFrozenWire(SCOPE_A).length, 2);
    assert.equal((await cold.request({ names: ['third_tool'] })).out.response.error.code, 'BUDGET_EXCEEDED');
  });
}

test('BW6: 超新限额的相同 wire 重绑可重选，冲突 schema 仍须压缩', async () => {
  const s = await scenario({ engineConfig: { budgets: { maxActiveSchemaBytes: 1 } } });
  const entry = [...s.engine.getCatalog().entries.values()].find(e => e.name === 'read_file');
  s.engine.restoreDisclosures(SCOPE_A, [entry]);
  const next = makeBindings(); next[0].bindingGeneration = 'reconnected';
  s.engine.refreshCatalog(next);
  const same = await s.request({ names: ['read_file'] });
  assert.equal(same.out.response.ok, true); assert.equal(s.fold(same).applied, true);
  next[0] = binding({ name: 'read_file', namespace: 'files', description: 'different schema', generation: 'changed', skill: null });
  s.engine.refreshCatalog(next);
  assert.equal((await s.request({ names: ['read_file'] })).out.response.error.code, 'COMPACTION_REQUIRED');
  assert.equal(s.engine.getPendingSize(), 0);
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

for (const terminal of ['failed', 'mismatch', 'cancelled', 'success']) {
  test(`BW8 ${terminal}: 在途同版本加载不代替成功提交，后续成功响应必须自带技能`, async () => {
    const s = await scenario({ bindings: [binding({ name: 'guided_tool', namespace: 'files', skill: { skillRevision: 'v1', usage: 'Use the capability according to this guidance', limitations: [] } })] });
    const a = await s.request({ names: ['guided_tool'] }); const b = await s.request({ names: ['guided_tool'] });
    assert.equal(a.out.response.data.skills.length, 1);
    assert.equal(b.out.response.data.skills.length, 1, '前一次还没成功提交，不能假设其指南已交付');
    assert.equal(s.budget().activeCount, 1, '技能重发不重复计 schema');
    if (terminal === 'cancelled') assert.equal(s.engine.cancelOperation(a.operationId), true);
    else assert.equal(s.fold(a, { failed: terminal === 'failed', mismatch: terminal === 'mismatch' }).applied, terminal === 'success');
    assert.equal(s.fold(b).applied, true);
    const repeated = await s.request({ names: ['guided_tool'] });
    assert.equal(repeated.out.response.ok, true); assert.equal(repeated.out.response.data.skills.length, 0, '已提交同版本仍去冗余');
    assert.equal(s.fold(repeated).applied, true); assert.equal(s.engine.getPendingSize(), 0);
  });
}

test('BW9: 新技能仍受字节上限约束，失败后无预留且健康工具可继续加载', async () => {
  const s = await scenario({ bindings: [...makeBindings(), binding({ name: 'guided_tool', namespace: 'files', skill: { skillRevision: 'large', usage: 'x'.repeat(500), limitations: [] } })], engineConfig: { budgets: { maxSkillBytesPerLoad: 32 } } });
  assert.equal((await s.request({ names: ['guided_tool'] })).out.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(s.engine.getPendingSize(), 0);
  const ordinary = await s.request({ names: ['extra_tool'] }); assert.equal(ordinary.out.response.ok, true); assert.equal(s.fold(ordinary).applied, true);
});

for (const locale of ['en', 'zh']) {
  test(`BW10 ${locale}: 不确定类别可直接 all 搜索，已选择候选引导不重复加载且不提前调用`, async () => {
    const s = await scenario({ engineConfig: { locale, alwaysToolNames: ['read_file'] } });
    const definitions = createEntryDefinitions({ defineTool: definition => definition, resolve: () => ({ engine: s.engine, scope: SCOPE_A }), text: createText(locale) });
    const search = definitions.find(d => d.name === 'tool_search');
    assert.match(search.description, /all/);
    const out = JSON.parse(await search.execute({ category: 'all', query: 'read_file' }, {}));
    assert.equal(out.ok, true); assert.equal(out.data.candidates[0].loaded, true);
    assert.match(out.nextAction, /loaded/);
    assert.match(out.nextAction, locale === 'zh' ? /下一轮/ : /next request/);
    assert.equal(s.engine.getPendingSize(), 0, '发现本身不产生选择或预留');
  });
}

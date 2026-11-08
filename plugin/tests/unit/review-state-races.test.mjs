// 纯产品模块回归，不使用真实 profile 或远端模型。
//
// rc.1 重设计：pending 操作、journal 冷恢复与 epoch 重置已删除。本文件保留
// “入队后会话被销毁/插件被卸载时旧事务不得复活”的竞态目标，并验证
// seedSelection 的会话隔离（resume 的唯一入口）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, loadTools, SCOPE_A } from './helpers.mjs';
import { createRegistryAdapter } from '../../adapters/dsh/registry.mjs';

test('加载锁内使用当前 selected：已提交的选择立即占用预算', async (t) => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 1 } } });
  t.after(() => engine.dispose());
  const first = loadTools(engine, SCOPE_A, { names: ['glob'] });
  const second = loadTools(engine, SCOPE_A, { names: ['grep'] });
  assert.equal((await first).response.ok, true);
  assert.equal((await second).response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
});

for (const transition of ['destroySession', 'dispose']) {
  test(`入队后 ${transition}：旧事务不得成功或复活状态`, async (t) => {
    const { engine } = await makeEngine();
    t.after(() => engine.dispose());
    const pending = loadTools(engine, SCOPE_A, { names: ['glob'] });
    if (transition === 'destroySession') {
      engine.destroySession(SCOPE_A.sessionId);
      const result = await pending;
      assert.equal(result.response.ok, false);
      assert.equal(result.response.error.code, 'STATE_NOT_READY', '锁竞态语义');
      // 销毁后重新发起会建立新会话（旧选择不复活）。
      const fresh = await loadTools(engine, SCOPE_A, { names: ['glob'] });
      assert.equal(fresh.response.ok, true);
    } else {
      engine.dispose();
      const result = await pending;
      assert.equal(result.response.ok, false);
      assert.equal(result.response.error.code, 'ENGINE_DISPOSED', '释放语义');
    }
  });
}

test('dispose 后首次 load 也不得重建会话状态', async () => {
  const { engine } = await makeEngine();
  engine.dispose();
  const res = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'ENGINE_DISPOSED');
});

test('目录深冻结不触碰宿主 schema，原位更新后可刷新身份', async (t) => {
  const definition = { name: 'fixture_mutable', description: 'fixture',
    parameters: { type: 'object', properties: { text: { type: 'string' } } } };
  const ctx = { tools: { view: () => ({ visible: new Map([[definition.name, definition]]) }) } };
  const registry = createRegistryAdapter({ ctx });
  const { engine } = await makeEngine({ bindings: registry.bindingsFor(undefined).bindings });
  t.after(() => engine.dispose());
  const old = engine.getCatalog().entries.get('global::fixture_mutable');
  assert.equal(Object.isFrozen(definition.parameters), false);
  assert.equal(Object.isFrozen(old.wire.parameters.properties.text), true);
  definition.parameters.properties.text.description = 'changed by host';
  assert.equal(old.wire.parameters.properties.text.description, undefined);
  engine.refreshCatalog(registry.bindingsFor(undefined).bindings);
  const current = engine.getCatalog().entries.get('global::fixture_mutable');
  assert.notEqual(current.revision, old.revision);
  assert.equal(current.wire.parameters.properties.text.description, 'changed by host');
});

test('resume 种子按会话隔离：A 的 admitted 行不会进入 B', async () => {
  const { engine } = await makeEngine();
  const entry = engine.getCatalog().entries.get('t_files_glob');
  const rows = [{ name: entry.name, toolId: entry.toolId, schemaDigest: entry.schemaDigest, at: 1 }];
  assert.deepEqual(engine.seedSelection(SCOPE_A, rows), { seeded: ['glob'], dropped: [] });
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(engine.getState({ sessionId: 'other' }).selected.size, 0);
});

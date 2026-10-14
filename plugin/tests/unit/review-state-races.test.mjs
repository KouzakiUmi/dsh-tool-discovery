// 纯产品模块回归，不使用真实 profile 或远端模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, pair } from './helpers.mjs';
import { createRegistryAdapter } from '../../adapters/dsh/registry.mjs';
import { createJournal } from '../../adapters/dsh/journal.mjs';

test('加载锁内使用当前 selected：回执在入队与取锁之间折叠也不能突破预算', async (t) => {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 1 } } });
  t.after(() => engine.dispose());
  const input = { names: ['glob'] };
  const first = await engine.handleLoad(input, SCOPE_A, { operationId: 'op_first' });
  const second = engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: 'op_second' });
  assert.equal(engine.applyCanonicalPair(pair({ seq: 1, operationId: 'op_first', input,
    payload: first.response.data.receipt }), SCOPE_A).applied, true);
  assert.equal((await second).response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(engine.getPendingSize(), 0);
});

for (const transition of ['failClosed', 'dispose', 'resetCacheEpoch', 'destroySession']) {
  test(`入队后 ${transition}：旧事务不得成功或复活 pending`, async (t) => {
    const { engine } = await makeEngine();
    t.after(() => engine.dispose());
    const pending = engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_old' });
    if (transition === 'destroySession') engine.destroySession(SCOPE_A.sessionId);
    else if (transition === 'dispose') engine.dispose();
    else engine[transition](SCOPE_A);
    const result = await pending;
    assert.equal(result.response.ok, false);
    assert.equal(result.operation, null);
    assert.equal(engine.getPendingSize(), 0);
    if (transition === 'resetCacheEpoch') {
      assert.equal(result.response.error.code, 'SELECTION_CHANGED');
      assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_new' })).response.ok, true);
    } else assert.equal(result.response.error.code, 'STATE_NOT_READY');
  });
}

test('dispose 后首次 load 也不得重建会话状态', async () => {
  const { engine } = await makeEngine();
  engine.dispose();
  assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_dead' })).response.ok, false);
  assert.equal(engine.getPendingSize(), 0);
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

for (const duplicate of [false, true]) {
  test(`恢复期间摘要已 live 折叠：${duplicate ? '真实重复摘要仍拒绝' : '同一 seq 不再重复计数'}`, async (t) => {
    const { engine } = await makeEngine({ newSessionMode: 'restoring' });
    let release;
    const reading = new Promise((resolve) => { release = resolve; });
    const resets = [];
    const journal = createJournal({ ctx: {}, session: { inheritedEventCount: 0 }, scope: SCOPE_A, engine,
      query: { readSession: () => reading }, onEpochReset: (info) => resets.push(info) });
    t.after(() => { journal.dispose(); engine.dispose(); });
    const events = [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'compaction/start', data: { compactionId: 'cmp', turn: 1 } },
      { seq: 2, type: 'compaction/summary', data: { compactionId: 'cmp' } },
    ];
    if (duplicate) events.push({ ...events[2], seq: 3 });
    const restoring = journal.restore();
    for (const event of events.slice(1)) journal.onEvent(event);
    release({ inheritedEventCount: 0, events });
    assert.equal((await restoring).mode, 'ready');
    journal.onEvent({ seq: events.length, type: 'compaction/end', data: { compactionId: 'cmp', turn: 1 } });
    assert.equal(journal.currentEpoch().epochId, duplicate ? 'initial' : 'cmp@3');
    assert.equal(resets.length, duplicate ? 0 : 1);
  });
}

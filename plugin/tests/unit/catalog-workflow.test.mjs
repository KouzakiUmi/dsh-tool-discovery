// 目录变更 × 选择状态（rc.1 重设计）：手造绑定，不读取评分数据。
//
// 旧文件围绕“未决预留/原子批次/pending 取消”展开；这些机制已删除。等价的
// 产品目标改由“已提交选择”验证：换版/移除使选择失效并释放预算；无关新增不动
// 既有选择；旧候选 ref 与游标随资格代次失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryEngine } from '../../domain/index.mjs';
import { makeEngine, loadTools, binding, CATEGORY_CONFIG, fakeClock, fakeRandom, SCOPE_A } from './helpers.mjs';

const seed = () => ['task_tool', 'cheap_tool', 'spare_tool', 'last_tool'].map(name => binding({ name, namespace: 'files', skill: null }));
const enlarged = () => binding({ name: 'task_tool', namespace: 'files', generation: 'g2', description: 'expanded schema '.repeat(100), skill: null });
async function scene(budgets = {}) {
  const bindings = seed();
  const { engine } = await makeEngine({ bindings, engineConfig: { budgets } });
  const request = (input) => loadTools(engine, SCOPE_A, input);
  const inputFor = (path, name = 'task_tool') => path === 'name' ? { names: [name] } : {
    candidates: [{ ref: engine.handleSearch({ category: 'files', query: name }, SCOPE_A).data.candidates.find(c => c.name === name).ref }],
  };
  const stats = () => engine.handleList({ view: 'state' }, SCOPE_A).data.budgets;
  return { engine, bindings, request, inputFor, stats };
}

for (const path of ['name', 'candidate']) {
  test(`CW1 ${path}: 换版后旧选择失效，新大 schema 必须重新核算预算`, async () => {
    const s = await scene({ maxActiveSchemaBytes: 300 });
    const old = await s.request(s.inputFor(path));
    assert.equal(old.response.ok, true);
    assert.equal(s.stats().activeCount, 1);

    const outcome = s.engine.refreshCatalog([enlarged(), ...s.bindings.slice(1)]);
    assert.deepEqual(outcome.invalidatedNames, ['task_tool']);
    assert.equal(s.stats().activeCount, 0, '旧版本选择不得继续占预算');
    assert.equal(s.engine.getState(SCOPE_A).invalidated.get('t_task_tool').reason, 'definition-changed');

    const current = await s.request({ names: ['task_tool'] });
    assert.equal(current.response.ok, false, '新版本必须重新核算，不能借用旧 toolId 的预算');
    assert.equal(current.response.error.code, 'BUDGET_EXCEEDED');
    assert.equal(s.stats().activeCount, 0);
  });
  test(`CW2 ${path}: 失效选择不阻塞另一项小工具`, async () => {
    const s = await scene({ maxActiveSchemaBytes: 300 });
    assert.equal((await s.request(s.inputFor(path))).response.ok, true);
    s.engine.refreshCatalog([enlarged(), ...s.bindings.slice(1)]);
    const small = await s.request({ names: ['cheap_tool'] });
    assert.equal(small.response.ok, true);
    assert.equal(s.stats().activeCount, 1);
    assert.deepEqual([...s.engine.getState(SCOPE_A).selected.values()].map((x) => x.name), ['cheap_tool']);
  });
}

for (const change of ['changed', 'removed']) {
  test(`CW3 ${change}: 批次中一项失效只作废该项，其余选择与预算保持不变`, async () => {
    const s = await scene({ maxActiveTools: 2 });
    const old = await s.request({ names: ['task_tool', 'cheap_tool'] });
    assert.equal(old.response.ok, true);
    assert.equal(s.stats().activeCount, 2);

    const outcome = s.engine.refreshCatalog(change === 'changed' ? [enlarged(), ...s.bindings.slice(1)] : s.bindings.slice(1));
    assert.deepEqual(outcome.invalidatedNames, ['task_tool']);
    assert.equal(s.stats().activeCount, 1, '只有失效项离开预算');
    assert.equal(s.engine.getState(SCOPE_A).invalidated.get('t_task_tool').reason,
      change === 'changed' ? 'definition-changed' : 'tool-removed');

    const next = await s.request({ names: ['spare_tool'] });
    assert.equal(next.response.ok, true);
    assert.equal((await s.request({ names: ['last_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
    assert.equal(s.stats().activeCount, 2);
  });
}

test('CW4: 既有的独立选择不随另一个工具的失效而释放', async () => {
  const s = await scene({ maxActiveTools: 2 });
  assert.equal((await s.request({ names: ['cheap_tool'] })).response.ok, true);
  assert.equal((await s.request({ names: ['task_tool'] })).response.ok, true);
  s.engine.refreshCatalog([enlarged(), ...s.bindings.slice(1)]);

  assert.equal(s.stats().activeCount, 1, 'cheap_tool 仍在 selected');
  assert.deepEqual([...s.engine.getState(SCOPE_A).selected.values()].map((x) => x.name), ['cheap_tool']);
  const next = await s.request({ names: ['spare_tool'] });
  assert.equal(next.response.ok, true);
  assert.equal((await s.request({ names: ['last_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(s.stats().activeCount, 2);
});

test('CW5: 真正的无关目录新增不作废合法选择，也不释放其预算', async () => {
  const s = await scene({ maxActiveTools: 1 });
  assert.equal((await s.request({ names: ['task_tool'] })).response.ok, true);
  const outcome = s.engine.refreshCatalog([...s.bindings, binding({ name: 'another_tool', namespace: 'files', skill: null })]);
  assert.deepEqual(outcome.invalidatedNames, []);
  assert.equal(s.stats().activeCount, 1);
  assert.equal((await s.request({ names: ['cheap_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
  const repeated = await s.request({ names: ['task_tool'] });
  assert.equal(repeated.response.ok, true);
  assert.deepEqual(repeated.admitted, [], '同版本重复 load 幂等');
  assert.equal(s.stats().activeCount, 1);
});

test('CW6: 目录变化后旧候选 ref 失效，重新检索的新 ref 可用', async () => {
  const s = await scene({ maxActiveTools: 1 });
  const oldRef = s.inputFor('candidate');
  assert.equal((await s.request(oldRef)).response.ok, true);
  s.engine.refreshCatalog([...s.bindings, binding({ name: 'another_tool', namespace: 'files', skill: null })]);
  const stale = await s.request(oldRef);
  assert.equal(stale.response.error.code, 'CANDIDATE_UNAVAILABLE');
  assert.equal(s.stats().activeCount, 1, '资格代次变化只作废 ref，不改选择');
  const fresh = s.inputFor('candidate', 'cheap_tool');
  assert.equal((await s.request(fresh)).response.error.code, 'BUDGET_EXCEEDED');
  assert.equal((await s.request({ names: ['cheap_tool'] })).response.error.code, 'BUDGET_EXCEEDED');
});

test('CW7: 相同 wire 的新绑定也重新核算；当前选择仍去重', async () => {
  const s = await scene({ maxActiveTools: 1 });
  assert.equal((await s.request({ names: ['task_tool'] })).response.ok, true);
  const rebound = structuredClone(s.bindings);
  rebound[0].bindingGeneration = 'new_generation';
  const outcome = s.engine.refreshCatalog(rebound);
  assert.deepEqual(outcome.invalidatedNames, ['task_tool']);
  assert.equal(s.stats().activeCount, 0);

  const current = await s.request({ names: ['task_tool'] });
  assert.equal(current.response.ok, true);
  assert.equal(current.admitted.length, 1);
  const duplicate = await s.request({ names: ['task_tool'] });
  assert.equal(duplicate.response.ok, true);
  assert.deepEqual(duplicate.admitted, []);
  assert.equal(s.stats().activeCount, 1);
});

// 仅同步构造期间跟踪原生 Map 分配以观察真实游标 store，不替换业务方法；立即恢复全局 Map。
function cursorScene() {
  const maps = [], OriginalMap = globalThis.Map;
  class ObservedMap extends OriginalMap { constructor(...args) { super(...args); maps.push(this); } }
  let engine;
  globalThis.Map = ObservedMap;
  try { engine = createDiscoveryEngine({ bindings: seed(), categoryConfig: CATEGORY_CONFIG, clock: fakeClock(), random: fakeRandom(), locale: 'en' }); }
  finally { globalThis.Map = OriginalMap; }
  const page = engine.handleList({ category: 'files', limit: 1 }, SCOPE_A);
  assert.equal(page.ok, true); assert.ok(page.data.nextCursor);
  const stores = maps.filter(map => [...map.values()].some(rec => Number.isInteger(rec?.offset) && typeof rec?.orderDigest === 'string'));
  assert.equal(stores.length, 1);
  return { engine, page, store: stores[0] };
}
for (const action of ['refresh', 'invalidate']) {
  test(`CW8 ${action}: 资格代次变化即时回收已不可用游标`, () => {
    const { engine, page, store } = cursorScene(); assert.equal(store.size, 1);
    if (action === 'refresh') engine.refreshCatalog([...seed(), binding({ name: 'another_tool', namespace: 'files', skill: null })]);
    else engine.invalidate('t_task_tool', 'changed');
    assert.equal(store.size, 0, '旧游标不应一直占着内存等 TTL');
    assert.equal(engine.handleList({ category: 'files', cursor: page.data.nextCursor }, SCOPE_A).error.code, 'CURSOR_UNAVAILABLE');
    assert.equal(engine.handleList({ category: 'files', limit: 1 }, SCOPE_A).ok, true);
    assert.equal(store.size, 1); engine.dispose(); assert.equal(store.size, 0);
  });
}
test('CW9: 目录未变或刷新失败不清理仍有效的游标', () => {
  const { engine, page, store } = cursorScene();
  const generation = engine.getEligibilityGeneration();
  engine.refreshCatalog(structuredClone(seed()));
  assert.equal(engine.getEligibilityGeneration(), generation); assert.equal(store.size, 1);
  assert.throws(() => engine.refreshCatalog([{ toolId: 'bad' }]), error => error.code === 'INCOMPATIBLE_COMPOSITION');
  assert.equal(store.size, 1);
  assert.equal(engine.handleList({ category: 'files', cursor: page.data.nextCursor }, SCOPE_A).ok, true);
  engine.dispose(); assert.equal(store.size, 0);
});

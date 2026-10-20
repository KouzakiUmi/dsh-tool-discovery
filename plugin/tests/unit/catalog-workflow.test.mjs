// 目录变更 × 在途预留：手造绑定，不读取评分数据；不改变候选提交/TTL 规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryEngine } from '../../domain/index.mjs';
import { makeEngine, binding, CATEGORY_CONFIG, fakeClock, fakeRandom, SCOPE_A } from './helpers.mjs';

const seed = () => ['task_tool', 'cheap_tool', 'spare_tool', 'last_tool'].map(name => binding({ name, namespace: 'files', skill: null }));
const enlarged = () => binding({ name: 'task_tool', namespace: 'files', generation: 'g2', description: 'expanded schema '.repeat(100), skill: null });
let serial = 0;
async function scene(budgets = {}) {
  const bindings = seed();
  const { engine } = await makeEngine({ bindings, engineConfig: { budgets } });
  let seq = 0;
  const request = async (input) => {
    const operationId = `cw_${++serial}`, callSeq = seq++;
    return { input, operationId, callSeq, out: await engine.handleLoad(input, SCOPE_A, { operationId }) };
  };
  const inputFor = (path, name = 'task_tool') => path === 'name' ? { names: [name] } : {
    candidates: [{ ref: engine.handleSearch({ category: 'files', query: name }, SCOPE_A).data.candidates.find(c => c.name === name).ref }],
  };
  const fold = p => engine.applyCanonicalPair({ seq: p.callSeq, resultSeq: seq++,
    call: { operationId: p.operationId, tool: 'tool_load', input: p.input },
    result: { isError: false, ok: true, payload: structuredClone(p.out.response.data.receipt) },
  }, SCOPE_A);
  const stats = () => engine.handleList({ view: 'state' }, SCOPE_A).data.budgets;
  return { engine, bindings, request, inputFor, fold, stats };
}

for (const path of ['name', 'candidate']) {
  test(`CW1 ${path}: 旧版本预留不能让新大 schema 被当成零新增`, async () => {
    const s = await scene({ maxActiveSchemaBytes: 300 });
    const old = await s.request(s.inputFor(path)); assert.equal(old.out.response.ok, true);
    s.engine.refreshCatalog([enlarged(), ...s.bindings.slice(1)]);
    const current = await s.request({ names: ['task_tool'] });
    assert.equal(current.out.response.ok, false, '新版本必须重新核算，不能借用旧 toolId 的预留');
    assert.equal(current.out.response.error.code, 'BUDGET_EXCEEDED');
    assert.equal(s.stats().activeSchemaBytes, 0);
    assert.equal(s.engine.getPendingSize(), 1, '只移除计费资格，不粗暴取消未决回执');
    assert.equal(s.fold(old).applied, false, '旧定义最终回执仍不应提交');
    assert.equal(s.engine.getPendingSize(), 0);
  });
  test(`CW2 ${path}: 无法提交的旧版本不阻塞另一项小工具`, async () => {
    const s = await scene({ maxActiveSchemaBytes: 300 });
    const old = await s.request(s.inputFor(path));
    s.engine.refreshCatalog([enlarged(), ...s.bindings.slice(1)]);
    const small = await s.request({ names: ['cheap_tool'] });
    assert.equal(small.out.response.ok, true);
    assert.equal(s.fold(small).applied, true);
    assert.equal(s.stats().activeCount, 1);
    assert.equal(s.fold(old).applied, false);
    assert.equal(s.stats().activeCount, 1, '迟到失败不能释放另一笔合法选择');
    assert.equal(s.engine.getPendingSize(), 0);
  });
}

for (const change of ['changed', 'removed']) {
  test(`CW3 ${change}: 原子批次一项失效后整笔预留不再计费`, async () => {
    const s = await scene({ maxActiveTools: 2 });
    const old = await s.request({ names: ['task_tool', 'cheap_tool'] }); assert.equal(old.out.response.ok, true);
    s.engine.refreshCatalog(change === 'changed' ? [enlarged(), ...s.bindings.slice(1)] : s.bindings.slice(1));
    assert.equal(s.stats().activeCount, 0, '不能继续为同一失败批次的其它项保留额度');
    const next = await s.request({ names: ['spare_tool', 'last_tool'] });
    assert.equal(next.out.response.ok, true); assert.equal(s.fold(next).applied, true);
    assert.equal(s.fold(old).applied, false); assert.equal(s.stats().activeCount, 2);
  });
}

for (const frozen of [false, true]) {
  test(`CW4 frozen=${frozen}: 失效批次不释放独立存在的 selected/frozen`, async () => {
    const s = await scene({ maxActiveTools: 2 });
    const committed = await s.request({ names: ['cheap_tool'] }); assert.equal(s.fold(committed).applied, true);
    if (frozen) s.engine.recordAdvertisement(SCOPE_A, { ...s.engine.getCatalog().entries.get('t_cheap_tool'), requestId: 'cw_header' });
    const old = await s.request({ names: ['task_tool', 'cheap_tool'] }); assert.equal(old.out.response.ok, true);
    s.engine.refreshCatalog([enlarged(), ...s.bindings.slice(1)]);
    assert.equal(s.stats().activeCount, 1);
    const next = await s.request({ names: ['spare_tool'] }); assert.equal(next.out.response.ok, true);
    assert.equal(s.fold(next).applied, true);
    assert.equal((await s.request({ names: ['last_tool'] })).out.response.error.code, 'BUDGET_EXCEEDED');
    assert.equal(s.fold(old).applied, false); assert.equal(s.stats().activeCount, 2);
  });
}

test('CW5: 真正的无关目录新增不取消合法 names 在途操作或释放其额度', async () => {
  const s = await scene({ maxActiveTools: 1 });
  const old = await s.request({ names: ['task_tool'] });
  s.engine.refreshCatalog([...s.bindings, binding({ name: 'another_tool', namespace: 'files', skill: null })]);
  assert.equal(s.stats().activeCount, 1);
  assert.equal((await s.request({ names: ['cheap_tool'] })).out.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(s.fold(old).applied, true);
  const repeated = await s.request({ names: ['task_tool'] }); assert.equal(repeated.out.response.ok, true);
  assert.equal(s.fold(repeated).applied, true); assert.equal(s.stats().activeCount, 1);
});

test('CW6: 不改变既有候选代次校验，待正式失败后才释放该未决操作', async () => {
  const s = await scene({ maxActiveTools: 1 });
  const input = s.inputFor('candidate'); const old = await s.request(input);
  s.engine.refreshCatalog([...s.bindings, binding({ name: 'another_tool', namespace: 'files', skill: null })]);
  assert.equal((await s.request(input)).out.response.error.code, 'CANDIDATE_UNAVAILABLE');
  assert.equal(s.stats().activeCount, 1, '本轮只过滤定义版本失效，不改候选事务规则');
  assert.equal(s.fold(old).applied, false);
  assert.equal(s.stats().activeCount, 0);
  const next = await s.request({ names: ['cheap_tool'] }); assert.equal(next.out.response.ok, true);
  assert.equal(s.fold(next).applied, true);
});

test('CW7: 相同 wire 的新绑定也不能借用旧版本预留，但当前预留仍去重', async () => {
  const s = await scene({ maxActiveTools: 1 });
  const old = await s.request({ names: ['task_tool'] });
  const rebound = structuredClone(s.bindings); rebound[0].bindingGeneration = 'new_generation';
  s.engine.refreshCatalog(rebound);
  assert.equal(s.stats().activeCount, 0);
  const current = await s.request({ names: ['task_tool'] }); assert.equal(current.out.response.ok, true);
  const duplicate = await s.request({ names: ['task_tool'] }); assert.equal(duplicate.out.response.ok, true);
  assert.equal(s.stats().activeCount, 1);
  assert.equal(s.fold(old).applied, false); assert.equal(s.fold(current).applied, true);
  assert.equal(s.fold(duplicate).applied, true); assert.equal(s.stats().activeCount, 1);
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

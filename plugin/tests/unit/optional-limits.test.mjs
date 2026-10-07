// 可选限额（optional limits）：默认关闭的硬上限。
//
// 产品立场：限额可以配置，但**默认不粗暴限制**。默认关闭不等于没有约束 ——
// 默认输出策略（defaultListLimit / defaultSearchLimit）与分页仍然有界；关闭的只是
// 「数量 / 批次 / 字节 / 查询长度」这类**硬上限**。
//
// 编码约定：null = 关闭（JSON 可表达）；显式正整数 = 启用。
// 绝不用 Infinity —— 它进不了协议 JSON，会变成 null 并静默改变语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, SCOPE_B, nextOpId, commitLoad, binding, sampleBindings } from './helpers.mjs';
import { DEFAULT_BUDGETS, resolveBudgets, validateListRequest, validateSearchRequest, validateLoadRequest, CONTROLLED_CATEGORIES } from '../../domain/index.mjs';
import { DomainError } from '../../domain/errors.mjs';

/** 一组人工 fixture：13 个工具，每个 schema 约 6 KiB（累计 > 49 KiB 历史默认上限）。 */
function manyBindings(count = 13) {
  return Array.from({ length: count }, (_, i) => binding({
    name: `bulk_${String(i).padStart(2, '0')}`,
    toolId: `t_bulk_${i}`,
    namespace: 'files',
    description: 'a normal file-oriented capability '.repeat(10),
    params: { type: 'object', properties: { p: { type: 'string', description: 'q'.repeat(6000) } } },
  }));
}

/** 已披露 wire 的累计字节（走真实 advertisement 路径冻结后统计）。 */
async function freezeAll(engine, scope, requestId) {
  for (const [toolId, rec] of engine.getState(scope).selected) {
    engine.recordAdvertisement(scope, {
      requestId, toolId, name: rec.name, revision: rec.revision,
      schemaDigest: rec.schemaDigest, wire: { name: rec.name, description: 'x', parameters: {} },
    });
  }
}

const sumWireBytes = (engine, scope) => engine
  .getFrozenWire(scope)
  .reduce((sum, f) => sum + f.bytes, 0);

test('O01 默认配置下所有 max* 硬上限都是 null（关闭），不是某个数字', () => {
  for (const key of [
    'maxActiveTools', 'maxActiveSchemaBytes', 'maxLoadBatch',
    'maxListLimit', 'maxSearchLimit', 'maxListResultBytes',
    'maxSearchResultBytes', 'maxQueryCodePoints', 'maxSkillBytesPerLoad',
  ]) {
    assert.equal(DEFAULT_BUDGETS[key], null, `${key} 默认必须关闭`);
  }
});

test('O02 默认输出策略与 TTL 不变（关闭硬上限不等于无界输出）', () => {
  assert.equal(DEFAULT_BUDGETS.defaultListLimit, 20);
  assert.equal(DEFAULT_BUDGETS.defaultSearchLimit, 5);
  assert.equal(DEFAULT_BUDGETS.candidateTtlMs, 900_000);
  assert.equal(DEFAULT_BUDGETS.listCursorTtlMs, 900_000);
  // maxInitialCategories 是受控分类的自然总数，用于自然遍历，不是权限门槛
  assert.equal(DEFAULT_BUDGETS.maxInitialCategories, 12);
  assert.equal(CONTROLLED_CATEGORIES.length, DEFAULT_BUDGETS.maxInitialCategories);
  // initialSchemaTargetTokens / maxInitialBytes 是历史目标值，生产路径未使用，
  // 不得被当成"实测保证的初始 2K"
  assert.equal(DEFAULT_BUDGETS.initialSchemaTargetTokens, 2048);
  assert.equal(DEFAULT_BUDGETS.maxInitialBytes, 8192);
});

test('O03 默认可单批 load 超过历史批次上限 4', async () => {
  const { engine } = await makeEngine({ bindings: manyBindings(8) });
  const names = Array.from({ length: 6 }, (_, i) => `bulk_${String(i).padStart(2, '0')}`);
  const res = await commitLoad(engine, SCOPE_A, { names });
  assert.equal(res.response.ok, true, `默认应允许 6 个一批：${JSON.stringify(res.response.error)}`);
  assert.equal(engine.getState(SCOPE_A).selected.size, 6);
});

test('O04 默认可累计超过历史数量上限 12', async () => {
  const { engine } = await makeEngine({ bindings: manyBindings(15) });
  for (let i = 0; i < 14; i += 5) {
    const names = Array.from({ length: Math.min(5, 14 - i) }, (_, k) => `bulk_${String(i + k).padStart(2, '0')}`);
    const res = await commitLoad(engine, SCOPE_A, { names });
    assert.equal(res.response.ok, true, `第 ${i} 批应成功：${JSON.stringify(res.response.error)}`);
  }
  assert.equal(engine.getState(SCOPE_A).selected.size, 14, '默认不得卡在 12');
});

test('O05 默认可累计超过历史 schema 字节上限 49KiB', async () => {
  const { engine } = await makeEngine({ bindings: manyBindings(13) });
  for (let i = 0; i < 10; i += 5) {
    const names = Array.from({ length: 5 }, (_, k) => `bulk_${String(i + k).padStart(2, '0')}`);
    const res = await commitLoad(engine, SCOPE_A, { names });
    assert.equal(res.response.ok, true, `第 ${i} 批应成功：${JSON.stringify(res.response.error)}`);
  }
  // 每个 fixture 约 6 KiB → 累计远超历史 49152
  const catalog = engine.getCatalog();
  const liveBytes = Array.from(engine.getState(SCOPE_A).selected.values())
    .reduce((sum, s) => sum + catalog.entries.get(s.toolId).wireBytes, 0);
  assert.ok(liveBytes > 49_152, `累计 schema 字节应超过 49KiB，实际 ${liveBytes}`);
});

test('O06 显式小上限仍阻断新增项，且旧项/顺序/披露不受影响', async () => {
  const { engine } = await makeEngine({
    bindings: manyBindings(6),
    engineConfig: { budgets: { maxActiveTools: 3, maxLoadBatch: 2 } },
  });
  const first = ['bulk_00', 'bulk_01'];
  assert.equal((await commitLoad(engine, SCOPE_A, { names: first })).response.ok, true);
  await freezeAll(engine, SCOPE_A, 'r1');
  const frozenBefore = engine.getFrozenWire(SCOPE_A);
  assert.equal(frozenBefore.length, 2);

  // 批次上限 2 仍然生效
  const tooBig = await engine.handleLoad({ names: ['bulk_02', 'bulk_03', 'bulk_04'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(tooBig.response.ok, false);
  assert.equal(tooBig.response.error.code, 'INVALID_ARGS');

  // 数量上限 3：再加一个成功，再加一个被拒
  assert.equal((await commitLoad(engine, SCOPE_A, { names: ['bulk_02'] })).response.ok, true);
  const over = await engine.handleLoad({ names: ['bulk_03'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');

  // 被拒的新增不得卸载、不得重排、不得改写任何已冻结 wire
  const frozenAfter = engine.getFrozenWire(SCOPE_A);
  assert.deepEqual(frozenAfter.slice(0, 2), frozenBefore, '已冻结项逐字不变且顺序不变');
  assert.equal(engine.getState(SCOPE_A).selected.size, 3, '超限只是拒绝新增，不淘汰');
});

test('O07 显式字节上限同样只阻断新增，不动已冻结项', async () => {
  const { engine } = await makeEngine({
    bindings: manyBindings(6),
    engineConfig: { budgets: { maxActiveSchemaBytes: 12_000 } },
  });
  assert.equal((await commitLoad(engine, SCOPE_A, { names: ['bulk_00'] })).response.ok, true);
  await freezeAll(engine, SCOPE_A, 'r1');
  const frozenBefore = engine.getFrozenWire(SCOPE_A);
  assert.equal(frozenBefore.length, 1);
  const over = await engine.handleLoad({ names: ['bulk_03', 'bulk_04', 'bulk_05'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(engine.getFrozenWire(SCOPE_A), frozenBefore, '超限不得触发任何淘汰');
});

test('O08 resolveBudgets：null 关闭、正整数启用、其他类型与取值被拒', () => {
  assert.equal(resolveBudgets({ maxActiveTools: null }).maxActiveTools, null);
  assert.equal(resolveBudgets({ maxActiveTools: 7 }).maxActiveTools, 7);
  assert.equal(resolveBudgets({}).maxActiveTools, null, '缺省回落默认值（关闭）');
  for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, '8', true, {}]) {
    assert.throws(() => resolveBudgets({ maxActiveTools: bad }), DomainError,
      `maxActiveTools=${String(bad)} 必须被拒`);
  }
  // 未受影响的键不受影响
  assert.throws(() => resolveBudgets({ defaultListLimit: 0 }), DomainError, '输出策略仍是严格正整数');
});

test('O09 关闭后 limit 可以更大，分页仍然按请求 limit 有界', () => {
  assert.deepEqual(validateListRequest({ view: 'state' }, DEFAULT_BUDGETS).limit, 20);
  assert.equal(validateListRequest({ view: 'available', category: 'files', limit: 500 }, DEFAULT_BUDGETS).limit, 500);
  assert.equal(validateSearchRequest({ category: 'files', query: 'x', limit: 500 }, DEFAULT_BUDGETS).limit, 500);
  // 仍必须拒绝非法 limit
  assert.throws(() => validateListRequest({ view: 'available', category: 'files', limit: 0 }, DEFAULT_BUDGETS), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateListRequest({ view: 'available', category: 'files', limit: 2.5 }, DEFAULT_BUDGETS), (e) => e.code === 'INVALID_ARGS');
  // 关闭后长查询不被拒
  const long = 'q'.repeat(5000);
  assert.equal(validateSearchRequest({ category: 'files', query: long }, DEFAULT_BUDGETS).query.length, 5000);
  // 显式上限仍然生效
  const capped = resolveBudgets({ maxListLimit: 50, maxSearchLimit: 6, maxQueryCodePoints: 10 });
  assert.throws(() => validateListRequest({ view: 'available', category: 'files', limit: 51 }, capped), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateSearchRequest({ category: 'files', query: 'x', limit: 7 }, capped), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => validateSearchRequest({ category: 'files', query: long }, capped), (e) => e.code === 'INVALID_ARGS');
});

test('O10 关闭后一批可以超过历史 maxLoadBatch=4', () => {
  const names = Array.from({ length: 9 }, (_, i) => `t_${i}`);
  assert.equal(validateLoadRequest({ names }, DEFAULT_BUDGETS).names.length, 9);
  // 显式上限仍然生效
  const capped = resolveBudgets({ maxLoadBatch: 3 });
  assert.throws(() => validateLoadRequest({ names }, capped), (e) => e.code === 'INVALID_ARGS');
});

test('O11 显式上限仍可拒绝：一次 load 一个超大的 schema', async () => {
  const fat = binding({
    name: 'fat_tool', toolId: 't_fat', namespace: 'files',
    params: { type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(60000) } } },
  });
  // 默认：无上限 → 放行
  const open = await makeEngine({ bindings: [...sampleBindings(), fat] });
  assert.equal((await commitLoad(open.engine, SCOPE_A, { names: ['fat_tool'] })).response.ok, true,
    '默认不得因为单个大 schema 就阻断');
  // 显式上限：拒绝，且不截断 schema
  const closed = await makeEngine({
    bindings: [...sampleBindings(), fat],
    engineConfig: { budgets: { maxActiveSchemaBytes: 5000 } },
  });
  const res = await closed.engine.handleLoad({ names: ['fat_tool'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');
  assert.ok(!JSON.stringify(res.response).includes('xxxx'), '错误信息不得泄漏截断后的 schema');
});

test('O12 state 视图在关闭时返回 null（JSON 可表达），不出现 Infinity/NaN', async () => {
  const { engine } = await makeEngine();
  await commitLoad(engine, SCOPE_A, { names: ['glob'] });
  const view = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(view.ok, true);
  assert.equal(view.data.budgets.maxActiveTools, null);
  assert.equal(view.data.budgets.maxActiveSchemaBytes, null);
  const text = JSON.stringify(view.data);
  assert.equal(text.includes('Infinity'), false);
  assert.equal(text.includes('NaN'), false);

  // 显式上限时回显真实数字
  const capped = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 5 } } });
  const cappedView = capped.engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(cappedView.data.budgets.maxActiveTools, 5);
});

test('O13 关闭硬上限不影响会话隔离（预算仍逐会话核算）', async () => {
  const { engine } = await makeEngine({
    bindings: manyBindings(15),
    engineConfig: { budgets: { maxActiveTools: 3 } },
  });
  assert.equal((await commitLoad(engine, SCOPE_B, { names: ['bulk_00', 'bulk_01', 'bulk_02'] })).response.ok, true);
  const over = await engine.handleLoad({ names: ['bulk_03'] }, SCOPE_B, { operationId: nextOpId() });
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');
  const a = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.deepEqual(a.data.selected, [], 'A 会话不受 B 会话的上限影响');
});

test('O14 分页在默认（关闭字节硬上限）下仍按 limit 分页', async () => {
  const many = Array.from({ length: 30 }, (_, i) => binding({
    name: `nav_${String(i).padStart(2, '0')}`, toolId: `t_nav_${i}`, namespace: 'files',
  }));
  const { engine } = await makeEngine({ bindings: many });
  const page1 = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(page1.ok, true);
  assert.equal(page1.data.names.length, 20, '默认每页 20 项（默认输出策略，不受硬上限影响）');
  assert.equal(page1.data.truncated, true);
  assert.ok(page1.data.nextCursor, '必须可翻页');
  const page2 = engine.handleList({ view: 'available', category: 'files', cursor: page1.data.nextCursor }, SCOPE_A);
  assert.equal(page2.data.names.length, 10, '第二页拿完剩余完整项');
  const all = [...page1.data.names, ...page2.data.names];
  assert.equal(new Set(all).size, 30, '无重复、无截断');
});

test('O15 搜索默认仍只返回少量候选（默认输出策略保持有界）', async () => {
  const { engine } = await makeEngine({
    bindings: Array.from({ length: 30 }, (_, i) => binding({
      name: `searchable_${String(i).padStart(2, '0')}`,
      toolId: `t_s_${i}`,
      namespace: 'files',
      description: 'search text inside file contents',
    })),
  });
  const r = engine.handleSearch({ category: 'files', query: 'search' }, SCOPE_A);
  assert.equal(r.ok, true);
  assert.equal(r.data.candidates.length, 5, '默认仍是 5 个候选');
  // 可显式调大
  const more = engine.handleSearch({ category: 'files', query: 'search', limit: 20 }, SCOPE_A);
  assert.equal(more.data.candidates.length, 20, '可配置更大 limit');
});

// ---------------------------------------------------------------------------
// 显式上限必须在"canonical 折叠之前"就真的生效。
//
// 场景：同 scope 连续两次 handleLoad，第一次还没折叠（仍在 pending），第二次只看得到
// 旧的 selected，于是各自都判定"放得下"，合计却突破了显式设置的上限。
// 默认 null 关闭时无所谓，但显式设置必须真的生效。
// ---------------------------------------------------------------------------

test('O16 显式 maxActiveTools=1:同 scope 两个未决 load 不能合计超限', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  // 第一次：预留成功（只 handleLoad，不 commit → 仍在 pending）
  const first = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(first.response.ok, true, `第一次应预留成功：${JSON.stringify(first.response.error)}`);
  assert.equal(engine.getPendingSize(), 1);

  // 第二个**不同**工具：合计已占满，必须被拒
  const second = await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(second.response.ok, false, '未决预留必须占用预算');
  assert.equal(second.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(second.operation, null, '预算失败不得创建 pending');
  assert.equal(engine.getPendingSize(), 1, '被拒的调用不得留下 pending');
});

test('O17 同工具重复预留幂等:不双占预算', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: nextOpId() })).response.ok, true);
  // 同一工具、同一 revision 再来一次 → 幂等，仍是同一个占位
  const again = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(again.response.ok, true, `同工具重复预留必须幂等：${JSON.stringify(again.response.error)}`);
  // 另一个工具仍然超限 → 说明 glob 只被算了一次
  const other = await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(other.response.error.code, 'BUDGET_EXCEEDED', 'glob 不得被双占后才放行 grep');
});

test('O18 默认关闭时同 scope 两次未决 load 都放行（不引入任何默认上限）', async () => {
  const { engine } = await makeEngine({ bindings: sampleBindings() });
  assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: nextOpId() })).response.ok, true);
  assert.equal((await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: nextOpId() })).response.ok, true);
  assert.equal(engine.getPendingSize(), 2);
});

test('O19 未决预算是按会话隔离的:另一 scope 不被扣预算', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: nextOpId() })).response.ok, true);
  // B 会话有自己的一份预算，A 的未决预留不扣 B 的
  const b = await engine.handleLoad({ names: ['grep'] }, SCOPE_B, { operationId: nextOpId() });
  assert.equal(b.response.ok, true, `B 会话不得被 A 的未决预留拖累：${JSON.stringify(b.response.error)}`);
  // A 仍然只允许那一个
  const a2 = await engine.handleLoad({ names: ['read_file'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(a2.response.error.code, 'BUDGET_EXCEEDED');
});

test('O20 取消未决操作会释放其预算预留（沿用既有 cancelOperation）', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  const opId = nextOpId();
  assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: opId })).response.ok, true);
  assert.equal((await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: nextOpId() }))
    .response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(engine.cancelOperation(opId), true);
  const after = await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(after.response.ok, true, `取消后预算必须释放：${JSON.stringify(after.response.error)}`);
});

test('O21 缓存周期重置释放全部未决预留（沿用既有 resetCacheEpoch 清理）', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: nextOpId() })).response.ok, true);
  assert.equal((await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: nextOpId() }))
    .response.error.code, 'BUDGET_EXCEEDED');
  engine.resetCacheEpoch(SCOPE_A, 'compaction-end');
  assert.equal(engine.getPendingSize(), 0, '重置沿用既有 pending 清理');
  const after = await engine.handleLoad({ names: ['grep'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(after.response.ok, true, `重置后预算必须释放：${JSON.stringify(after.response.error)}`);
});
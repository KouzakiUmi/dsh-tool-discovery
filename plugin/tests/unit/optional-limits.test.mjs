// 可选限额（optional limits）：默认关闭的硬上限。
//
// 产品立场：限额可以配置，但**默认不粗暴限制**。默认关闭不等于没有约束 ——
// 默认输出策略（defaultListLimit / defaultSearchLimit）与分页仍然有界；关闭的只是
// 「数量 / 批次 / 字节 / 查询长度」这类**硬上限**。
//
// 编码约定：null = 关闭（JSON 可表达）；显式正整数 = 启用。
// 绝不用 Infinity —— 它进不了协议 JSON，会变成 null 并静默改变语义。
//
// rc.1 重设计后 tool_load 立即提交：旧文件里“未决预留占预算 / cancelOperation 释放 /
// resetCacheEpoch 释放”的用例已删除。等价覆盖改为：已提交的 selected 立即计入预算、
// 幂等重复不双占、tool_unload 是唯一的主动释放路径、invalidate 作废后释放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, loadTools, unloadTools, SCOPE_A, SCOPE_B, binding, sampleBindings } from './helpers.mjs';
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

const namesOf = (engine, scope = SCOPE_A) => [...engine.getState(scope).selected.values()].map((s) => s.name);
const budgetOf = (engine, scope = SCOPE_A) => engine.handleList({ view: 'state' }, scope).data.budgets;

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
  const res = await loadTools(engine, SCOPE_A, { names });
  assert.equal(res.response.ok, true, `默认应允许 6 个一批：${JSON.stringify(res.response.error)}`);
  assert.equal(engine.getState(SCOPE_A).selected.size, 6);
});

test('O04 默认可累计超过历史数量上限 12', async () => {
  const { engine } = await makeEngine({ bindings: manyBindings(15) });
  for (let i = 0; i < 14; i += 5) {
    const names = Array.from({ length: Math.min(5, 14 - i) }, (_, k) => `bulk_${String(i + k).padStart(2, '0')}`);
    const res = await loadTools(engine, SCOPE_A, { names });
    assert.equal(res.response.ok, true, `第 ${i} 批应成功：${JSON.stringify(res.response.error)}`);
  }
  assert.equal(engine.getState(SCOPE_A).selected.size, 14, '默认不得卡在 12');
});

test('O05 默认可累计超过历史 schema 字节上限 49KiB', async () => {
  const { engine } = await makeEngine({ bindings: manyBindings(13) });
  for (let i = 0; i < 10; i += 5) {
    const names = Array.from({ length: 5 }, (_, k) => `bulk_${String(i + k).padStart(2, '0')}`);
    const res = await loadTools(engine, SCOPE_A, { names });
    assert.equal(res.response.ok, true, `第 ${i} 批应成功：${JSON.stringify(res.response.error)}`);
  }
  const catalog = engine.getCatalog();
  const liveBytes = [...engine.getState(SCOPE_A).selected.values()]
    .reduce((sum, s) => sum + catalog.entries.get(s.toolId).wireBytes, 0);
  assert.ok(liveBytes > 49_152, `累计 schema 字节应超过 49KiB，实际 ${liveBytes}`);
});

test('O06 显式小上限仍阻断新增项，且旧选择不受影响', async () => {
  const { engine } = await makeEngine({
    bindings: manyBindings(6),
    engineConfig: { budgets: { maxActiveTools: 3, maxLoadBatch: 2 } },
  });
  const first = ['bulk_00', 'bulk_01'];
  assert.equal((await loadTools(engine, SCOPE_A, { names: first })).response.ok, true);
  assert.deepEqual(namesOf(engine).sort(), first);

  // 批次上限 2 仍然生效
  const tooBig = await loadTools(engine, SCOPE_A, { names: ['bulk_02', 'bulk_03', 'bulk_04'] });
  assert.equal(tooBig.response.ok, false);
  assert.equal(tooBig.response.error.code, 'INVALID_ARGS');
  assert.deepEqual(namesOf(engine).sort(), first, '被拒批次不留下半批');

  // 数量上限 3：再加一个成功，再加一个被拒
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['bulk_02'] })).response.ok, true);
  const over = await loadTools(engine, SCOPE_A, { names: ['bulk_03'] });
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(namesOf(engine).sort(), ['bulk_00', 'bulk_01', 'bulk_02'], '超限只是拒绝新增，不淘汰');
});

test('O07 显式字节上限同样只阻断新增，不动已有选择', async () => {
  const { engine } = await makeEngine({
    bindings: manyBindings(6),
    engineConfig: { budgets: { maxActiveSchemaBytes: 12_000 } },
  });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['bulk_00'] })).response.ok, true);
  const before = namesOf(engine);
  const over = await loadTools(engine, SCOPE_A, { names: ['bulk_03', 'bulk_04', 'bulk_05'] });
  assert.equal(over.response.error.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(namesOf(engine), before, '超限不得触发任何淘汰');
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
  assert.equal((await loadTools(open.engine, SCOPE_A, { names: ['fat_tool'] })).response.ok, true,
    '默认不得因为单个大 schema 就阻断');
  // 显式上限：拒绝，且不截断 schema
  const closed = await makeEngine({
    bindings: [...sampleBindings(), fat],
    engineConfig: { budgets: { maxActiveSchemaBytes: 5000 } },
  });
  const res = await loadTools(closed.engine, SCOPE_A, { names: ['fat_tool'] });
  assert.equal(res.response.ok, false);
  assert.equal(res.response.error.code, 'BUDGET_EXCEEDED');
  assert.ok(!JSON.stringify(res.response).includes('xxxx'), '错误信息不得泄漏截断后的 schema');
});

test('O12 state 视图在关闭时返回 null（JSON 可表达），不出现 Infinity/NaN', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
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
  assert.equal((await loadTools(engine, SCOPE_B, { names: ['bulk_00', 'bulk_01', 'bulk_02'] })).response.ok, true);
  const over = await loadTools(engine, SCOPE_B, { names: ['bulk_03'] });
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
// 显式上限在**提交之前**生效：tool_load 立即提交，因此第一次成功后就占住额度。
// ---------------------------------------------------------------------------

test('O16 显式 maxActiveTools=1:同会话第二个 load 必须被拒', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  const first = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(first.response.ok, true, `第一次应成功：${JSON.stringify(first.response.error)}`);
  assert.equal(budgetOf(engine).activeCount, 1);

  const second = await loadTools(engine, SCOPE_A, { names: ['grep'] });
  assert.equal(second.response.ok, false, '已提交的选择必须占用预算');
  assert.equal(second.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(second.admitted, null, '被拒的调用不得留下 admission');
  assert.deepEqual(namesOf(engine), ['glob'], '被拒调用不得改变选择');
});

test('O17 同工具重复 load 幂等:不双占预算', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  const again = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(again.response.ok, true, `同工具重复 load 必须幂等：${JSON.stringify(again.response.error)}`);
  assert.deepEqual(again.admitted, [], '幂等重复不新增 admission');
  // 另一个工具仍然超限 → 说明 glob 只被算了一次
  const other = await loadTools(engine, SCOPE_A, { names: ['grep'] });
  assert.equal(other.response.error.code, 'BUDGET_EXCEEDED', 'glob 不得被双占后才放行 grep');
  assert.equal(budgetOf(engine).activeCount, 1);
});

test('O18 默认关闭时同会话多次 load 都放行（不引入任何默认上限）', async () => {
  const { engine } = await makeEngine({ bindings: sampleBindings() });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['grep'] })).response.ok, true);
  assert.equal(budgetOf(engine).activeCount, 2);
});

test('O19 预算是按会话隔离的:另一 scope 不被扣预算', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  // B 会话有自己的一份预算，A 的选择不扣 B 的
  const b = await loadTools(engine, SCOPE_B, { names: ['grep'] });
  assert.equal(b.response.ok, true, `B 会话不得被 A 的选择拖累：${JSON.stringify(b.response.error)}`);
  // A 仍然只允许那一个
  const a2 = await loadTools(engine, SCOPE_A, { names: ['read_file'] });
  assert.equal(a2.response.error.code, 'BUDGET_EXCEEDED');
});

test('O20 tool_unload 是主动释放预算的路径', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['grep'] })).response.error.code, 'BUDGET_EXCEEDED');
  assert.equal((await unloadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  const after = await loadTools(engine, SCOPE_A, { names: ['grep'] });
  assert.equal(after.response.ok, true, `卸载后预算必须释放：${JSON.stringify(after.response.error)}`);
  assert.equal(budgetOf(engine).activeCount, 1);
});

test('O21 目录刷新不释放既有选择的预算；只有 unload/invalidate 释放', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  // 无关目录新增：glob 仍然有效，仍占预算。
  engine.refreshCatalog([...sampleBindings(), binding({ name: 'added_later', toolId: 't_added', namespace: 'files' })]);
  assert.equal(budgetOf(engine).activeCount, 1);
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['grep'] })).response.error.code, 'BUDGET_EXCEEDED');
  // invalidate 作废 glob 后才释放。
  engine.invalidate('t_files_glob', 'tool-removed');
  assert.equal(budgetOf(engine).activeCount, 0);
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['grep'] })).response.ok, true);
});

test('O22 已选工具被撤权后可重新加载，不得因重复计费被拒', async () => {
  const { engine } = await makeEngine({
    bindings: sampleBindings(),
    engineConfig: { budgets: { maxActiveTools: 1 } },
  });
  assert.equal((await loadTools(engine, SCOPE_A, { names: ['glob'] })).response.ok, true);
  const entry = engine.getCatalog().byName.get('glob')[0];
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);

  engine.invalidate(entry.toolId, 'temporarily-unavailable');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0, '撤权后执行授权失效');

  const reload = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(reload.response.ok, true, `重新加载必须放行：${JSON.stringify(reload.response.error)}`);
  assert.equal(reload.admitted.length, 1, '重新加载必须恢复 admission');
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  engine.dispose();
});

test('O23 显式页大小上限必须约束默认值（省略 limit 也不例外）', async () => {
  const listEngine = await makeEngine({ engineConfig: { budgets: { maxListLimit: 1 } } });
  const page = listEngine.engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(page.ok, true);
  assert.equal(page.data.names.length, 1, '默认值 20 不得越过显式上限 1');
  assert.equal(page.data.truncated, true, '被上限截断必须如实标记');

  const searchEngine = await makeEngine({ engineConfig: { budgets: { maxSearchLimit: 1 } } });
  const hits = searchEngine.engine.handleSearch({ category: 'files', query: 'file' }, SCOPE_A);
  assert.equal(hits.ok, true);
  assert.equal(hits.data.candidates.length, 1, '默认值 5 不得越过显式上限 1');

  listEngine.engine.dispose();
  searchEngine.engine.dispose();
});

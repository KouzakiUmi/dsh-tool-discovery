// tool_list 四视图、opaque 分页与游标失效测试(F11/F12/F13)。
//
// rc.1 重设计：`advertised` 曝光表、frozen wire 与 restoring 终态已删除；
// `view:"state"` 只投影 selected/invalidated/预算。loaded 视图的“有效 selected”
// 仍要求条目在当前目录里且版本一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, loadTools, SCOPE_A, SCOPE_B, fakeClock, sampleBindings } from './helpers.mjs';
import { binding } from './helpers.mjs';

test('F11 available:只返回完整名称,无描述/schema/revision', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(r.ok, true);
  assert.equal(r.data.view, 'available');
  assert.ok(Array.isArray(r.data.names));
  assert.ok(r.data.names.includes('glob'));
  for (const key of Object.keys(r.data)) {
    assert.ok(['category', 'view', 'names', 'nextCursor', 'truncated'].includes(key), `多余字段 ${key}`);
  }
  // 逐项只有字符串名称
  for (const n of r.data.names) assert.equal(typeof n, 'string');
});

test('F11 available:不预展开 description/schema', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'available', category: 'all' }, SCOPE_A);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('parameters'), '不得出现 schema');
  assert.ok(!text.includes('enumerate file entries'), '不得出现 description');
  assert.ok(!text.includes('r_sha256'), '不得出现 revision');
});

test('F11 available:默认页 20;页大小硬上限默认关闭、显式配置为 20 时生效', async () => {
  const many = Array.from({ length: 40 }, (_, i) => binding({ name: `file_tool_${String(i).padStart(2, '0')}`, toolId: `t_ft_${i}`, namespace: 'files' }));

  // 默认：页大小硬上限关闭 → 可以要更大的一页，默认策略仍是 20
  const open = await makeEngine({ bindings: many });
  const openDef = open.engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(openDef.data.names.length, 20, '默认 20');
  assert.ok(openDef.data.truncated);
  assert.ok(openDef.data.nextCursor);
  const openBig = open.engine.handleList({ view: 'available', category: 'files', limit: 25 }, SCOPE_A);
  assert.equal(openBig.data.names.length, 25, '默认关闭时更大的页被接受');

  // 显式配置 maxListLimit=20：照旧拒绝越界
  const { engine } = await makeEngine({ bindings: many, engineConfig: { budgets: { maxListLimit: 20 } } });
  const def = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(def.data.names.length, 20, '默认 20');
  assert.equal(def.data.truncated, true);
  assert.ok(def.data.nextCursor);
  const over = engine.handleList({ view: 'available', category: 'files', limit: 21 }, SCOPE_A);
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'INVALID_ARGS');
});

test('F11 分页稳定且不自动追完全部页', async () => {
  const many = Array.from({ length: 25 }, (_, i) => binding({ name: `ft_${String(i).padStart(2, '0')}`, toolId: `t_ft_${i}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings: many });
  const p1 = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  assert.equal(p1.data.names.length, 20);
  assert.equal(p1.data.truncated, true);
  const p2 = engine.handleList({ view: 'available', category: 'files', cursor: p1.data.nextCursor }, SCOPE_A);
  assert.equal(p2.data.names.length, 5);
  assert.equal(p2.data.truncated, false);
  assert.equal(p2.data.nextCursor, null);
  const overlap = p1.data.names.filter((n) => p2.data.names.includes(n));
  assert.equal(overlap.length, 0);
  assert.equal(new Set([...p1.data.names, ...p2.data.names]).size, 25);
});

test('F13 游标跨会话被拒', async () => {
  const many = Array.from({ length: 25 }, (_, i) => binding({ name: `ft_${i}`, toolId: `t_ft_${i}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings: many });
  const p1 = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  const r = engine.handleList({ view: 'available', category: 'files', cursor: p1.data.nextCursor }, SCOPE_B);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CURSOR_UNAVAILABLE');
});

test('F13 游标过期被拒', async () => {
  const clock = fakeClock();
  const many = Array.from({ length: 25 }, (_, i) => binding({ name: `ft_${i}`, toolId: `t_ft_${i}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings: many, clock });
  const p1 = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  clock.advance(900_001); // 超过 listCursorTtlMs
  const r = engine.handleList({ view: 'available', category: 'files', cursor: p1.data.nextCursor }, SCOPE_A);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CURSOR_UNAVAILABLE');
});

test('F13 游标在撤权/目录变化后失效', async () => {
  const many = Array.from({ length: 25 }, (_, i) => binding({ name: `ft_${i}`, toolId: `t_ft_${i}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings: many });
  const p1 = engine.handleList({ view: 'available', category: 'files' }, SCOPE_A);
  const reduced = many.filter((b) => b.toolId !== 't_ft_0');
  engine.refreshCatalog(reduced);
  const r = engine.handleList({ view: 'available', category: 'files', cursor: p1.data.nextCursor }, SCOPE_A);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CURSOR_UNAVAILABLE');
});

test('游标是 opaque:伪造的偏移被拒', async () => {
  const many = Array.from({ length: 25 }, (_, i) => binding({ name: `ft_${i}`, toolId: `t_ft_${i}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings: many });
  for (const fake of ['0', '{"offset":20}', 'p_forged', '']) {
    const r = engine.handleList({ view: 'available', category: 'files', cursor: fake }, SCOPE_A);
    assert.equal(r.ok, false, `伪造游标 ${fake} 必须被拒`);
  }
});

test('categories 视图只返回有界卡片,不返回普通工具名', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'categories' }, SCOPE_A);
  assert.equal(r.ok, true);
  assert.ok(r.data.categories.length > 0);
  assert.ok(r.data.categories.length <= 12);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('"glob"'), '类别视图不得枚举普通工具名');
  for (const c of r.data.categories) {
    assert.ok(c.id && c.title && typeof c.capabilitySummary === 'string' && typeof c.eligibleCount === 'number');
  }
});

test('CATEGORY_UNAVAILABLE:不存在或不可见的类别统一报错', async () => {
  const { engine } = await makeEngine();
  for (const cat of ['nope', 'FILES', '']) {
    const r = engine.handleList({ view: 'available', category: cat }, SCOPE_A);
    assert.equal(r.ok, false, `类别 ${cat} 应被拒`);
    assert.equal(r.error.code, cat === '' ? 'INVALID_ARGS' : 'CATEGORY_UNAVAILABLE');
  }
});

test('F12 loaded 视图只列有效 selected', async () => {
  const { engine } = await makeEngine();
  const before = engine.handleList({ view: 'loaded', category: 'files' }, SCOPE_A);
  assert.deepEqual(before.data.names, []);
  const res = await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(res.response.ok, true);
  const after = engine.handleList({ view: 'loaded', category: 'files' }, SCOPE_A);
  assert.deepEqual(after.data.names, ['glob']);
  // 未加载的类别仍为空,不枚举未加载目录
  const shell = engine.handleList({ view: 'loaded', category: 'shell' }, SCOPE_A);
  assert.deepEqual(shell.data.names, []);
});

test('F12b loaded 视图必须尊重 limit/cursor，不得谎报「这就是全部」', async () => {
  const many = Array.from({ length: 25 }, (_, i) => binding({ name: `file_tool_${String(i).padStart(2, '0')}`, toolId: `t_lt_${i}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings: many });
  const names = many.map((b) => b.name);
  const res = await loadTools(engine, SCOPE_A, { names });
  assert.equal(res.response.ok, true, `前置：批量 load 必须成功：${JSON.stringify(res.response.error)}`);

  const first = engine.handleList({ view: 'loaded', category: 'files' }, SCOPE_A);
  assert.equal(first.data.names.length, 20, '默认一页 20：loaded 必须与 available 走同一条分页规则');
  assert.equal(first.data.truncated, true, '还有下一页时必须如实报 truncated');
  assert.equal(typeof first.data.nextCursor, 'string', '必须给出续页游标');

  const second = engine.handleList({ view: 'loaded', category: 'files', cursor: first.data.nextCursor }, SCOPE_A);
  assert.deepEqual(second.data.names, names.slice(20), '续页必须正好返回剩余项，不是重发也不是错位');
  assert.equal(second.data.truncated, false, '最后一页必须报 truncated:false');
  assert.deepEqual([...first.data.names, ...second.data.names], names, '两页并集必须等于全集且不重复');

  const wide = engine.handleList({ view: 'loaded', category: 'files', limit: 25 }, SCOPE_A);
  assert.deepEqual(wide.data.names, names, '显式 limit 必须被尊重（硬上限默认关闭）');
});

test('F12d loaded 游标绑定当时的名单：名单一变，旧游标必须失效', async () => {
  const many = Array.from({ length: 30 }, (_, i) => binding({ name: `file_tool_${String(i).padStart(2, '0')}`, toolId: `t_lc_${i}`, namespace: 'files' }));
  const { engine } = await makeEngine({ bindings: many });
  const all = many.map((b) => b.name);

  const res1 = await loadTools(engine, SCOPE_A, { names: all.slice(0, 25) });
  assert.equal(res1.response.ok, true);
  const first = engine.handleList({ view: 'loaded', category: 'files' }, SCOPE_A);
  assert.equal(first.data.truncated, true, '前置：必须有第二页，否则测不到游标');
  const cursor = first.data.nextCursor;

  // 名单变了：把剩下的 5 个也 load 进来。
  const res2 = await loadTools(engine, SCOPE_A, { names: all.slice(25) });
  assert.equal(res2.response.ok, true);

  const stale = engine.handleList({ view: 'loaded', category: 'files', cursor }, SCOPE_A);
  assert.equal(stale.ok, false, '名单变化后旧游标必须被拒绝，而不是在新名单上按 offset 续读');
  assert.equal(stale.error.code, 'CURSOR_UNAVAILABLE');

  // 正控制：重新翻页必须得到完整且不重复的新名单。
  const page1 = engine.handleList({ view: 'loaded', category: 'files' }, SCOPE_A);
  const page2 = engine.handleList({ view: 'loaded', category: 'files', cursor: page1.data.nextCursor }, SCOPE_A);
  assert.deepEqual([...page1.data.names, ...page2.data.names], all, '重新翻页必须拿到完整、不重复的新名单');
});

test('F12c state 视图必须受 maxListResultBytes 约束，不得被静默绕过', async () => {
  const open = await makeEngine();
  assert.equal(open.engine.handleList({ view: 'state' }, SCOPE_A).ok, true, '默认（上限关闭）必须照常成功');

  const capped = await makeEngine({ engineConfig: { budgets: { maxListResultBytes: 64 } } });
  const r = capped.engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(r.ok, false, '状态响应超过上限时必须明确失败，而不是静默返回超限内容');
  assert.equal(r.error.code, 'BUDGET_EXCEEDED');
  assert.match(String(r.error.message), /\d+ bytes/, '错误消息必须带实测字节数，否则无法定位');
});

test('F12 state 视图返回 selected/invalidated 与预算（不再有 advertised）', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'ready');
  assert.deepEqual(r.data.selected, []);
  assert.deepEqual(r.data.invalidated, []);
  assert.equal('advertised' in r.data, false, 'advertised 曝光表已删除');
  // 默认关闭 → 回显 null（JSON 可表达，不出现 Infinity/NaN）
  assert.equal(r.data.budgets.maxActiveTools, null);
  assert.equal(r.data.budgets.maxActiveSchemaBytes, null);
  assert.equal(r.data.budgets.tokenEstimation, 'estimate');
  assert.equal(JSON.stringify(r.data).includes('Infinity'), false);
  assert.equal(JSON.stringify(r.data).includes('NaN'), false);
  // 不得枚举隐藏目录
  assert.ok(!JSON.stringify(r.data).includes('glob'));

  // 显式配置后回显真实数字
  const capped = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 12, maxActiveSchemaBytes: 49152 } } });
  const cr = capped.engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(cr.data.budgets.maxActiveTools, 12);
  assert.equal(cr.data.budgets.maxActiveSchemaBytes, 49152);
});

test('state 视图不因 selected 变化泄漏 schema', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const r = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.ok(!JSON.stringify(r.data).includes('parameters'));
  assert.equal(r.data.selected.length, 1);
  assert.equal(r.data.selected[0].name, 'glob');
});

test('list 不生成候选 ref、不改变 selected', async () => {
  const { engine } = await makeEngine();
  engine.handleList({ view: 'available', category: 'all' }, SCOPE_A);
  engine.handleList({ view: 'categories' }, SCOPE_A);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 0);
});

test('会话隔离:B 会话看不到 A 的状态', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  const b = engine.handleList({ view: 'state' }, SCOPE_B);
  assert.deepEqual(b.data.selected, []);
  const a = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(a.data.selected.length, 1);
});

test('ENGINE_DISPOSED：disposed 后所有入口明确拒绝而不是伪造空状态', async () => {
  const { engine } = await makeEngine();
  engine.dispose();
  const l = engine.handleList({ view: 'state' }, SCOPE_A);
  const s = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A);
  const ld = await engine.handleLoad({ names: ['glob'] }, SCOPE_A);
  assert.equal(l.error.code, 'ENGINE_DISPOSED');
  assert.equal(s.error.code, 'ENGINE_DISPOSED');
  assert.equal(ld.response.error.code, 'ENGINE_DISPOSED');
});

test('F12e state 视图与 tool_load 门禁使用同一份活跃预算核算', async () => {
  const capped = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 3 } } });
  for (const name of ['glob', 'grep', 'read_file']) {
    assert.equal((await loadTools(capped.engine, SCOPE_A, { names: [name] })).response.ok, true);
  }
  const entries = capped.engine.getCatalog().entries;
  const view = capped.engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(view.ok, true);
  assert.equal(view.data.budgets.activeCount, 3, '有效 selected 必须全部计入');
  assert.equal(
    view.data.budgets.activeSchemaBytes,
    entries.get('t_files_glob').wireBytes + entries.get('t_files_grep').wireBytes + entries.get('t_files_read').wireBytes,
    '字节口径必须与 tool_load 的核算一致',
  );
  const overflow = await loadTools(capped.engine, SCOPE_A, { names: ['web_fetch'] });
  assert.equal(overflow.response.ok, false);
  assert.equal(overflow.response.error.code, 'BUDGET_EXCEEDED');

  // 正控制：同一装配、上限 4 → 同一个 load 成功（证明上面的 3 不是多算出来的）。
  const roomy = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 4 } } });
  for (const name of ['glob', 'grep', 'read_file']) {
    assert.equal((await loadTools(roomy.engine, SCOPE_A, { names: [name] })).response.ok, true);
  }
  const ok = await loadTools(roomy.engine, SCOPE_A, { names: ['web_fetch'] });
  assert.equal(ok.response.ok, true, JSON.stringify(ok.response.error));
});

test('F12f 撤权后选择立即失效并记入 invalidated，不再为已披露 schema 计费', async () => {
  const { engine } = await makeEngine();
  await loadTools(engine, SCOPE_A, { names: ['glob'] });
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  engine.refreshCatalog(sampleBindings().filter((b) => b.toolId !== 't_files_glob'));
  const st = engine.getState(SCOPE_A);
  assert.equal(st.selected.size, 0);
  assert.equal(st.invalidated.get('t_files_glob').reason, 'tool-removed');

  const view = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(view.data.budgets.activeCount, 0, '撤权后的工具不再占预算');
  assert.deepEqual(view.data.selected, []);
  assert.equal(view.data.invalidated.length, 1);
});

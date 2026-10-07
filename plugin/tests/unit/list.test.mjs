// tool_list 四视图、opaque 分页与游标失效测试(F11/F12/F13)
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, SCOPE_B, nextOpId, fakeClock } from './helpers.mjs';
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
  // 无重叠
  const overlap = p1.data.names.filter((n) => p2.data.names.includes(n));
  assert.equal(overlap.length, 0);
  // 全部 25 个只出现一次
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
  // 撤掉一个工具 → 目录变化 → 旧游标不得继续暴露旧资格
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
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  assert.equal(res.response.ok, true);
  engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: op, tool: 'tool_load', input: { names: ['glob'] } },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, SCOPE_A);
  const after = engine.handleList({ view: 'loaded', category: 'files' }, SCOPE_A);
  assert.deepEqual(after.data.names, ['glob']);
  // 未加载的类别仍为空,不枚举未加载目录
  const shell = engine.handleList({ view: 'loaded', category: 'shell' }, SCOPE_A);
  assert.deepEqual(shell.data.names, []);
});

test('F12 state 视图返回 selected/advertised/invalidated 与预算', async () => {
  const { engine } = await makeEngine();
  const r = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(r.ok, true);
  assert.equal(r.data.mode, 'ready');
  assert.deepEqual(r.data.selected, []);
  assert.deepEqual(r.data.advertised, []);
  assert.deepEqual(r.data.invalidated, []);
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
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: op, tool: 'tool_load', input: { names: ['glob'] } },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, SCOPE_A);
  const r = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.ok(!JSON.stringify(r.data).includes('parameters'));
  assert.equal(r.data.selected.length, 1);
  assert.equal(r.data.selected[0].name, 'glob');
});

test('list 不生成候选 ref、不改变 selected', async () => {
  const { engine } = await makeEngine();
  engine.handleList({ view: 'available', category: 'all' }, SCOPE_A);
  engine.handleList({ view: 'categories' }, SCOPE_A);
  const st = engine.getState(SCOPE_A);
  assert.equal(st.selected.size, 0);
  assert.equal(st.advertised.size, 0);
  assert.equal(engine.getPendingSize(), 0);
});

test('会话隔离:B 会话看不到 A 的状态', async () => {
  const { engine } = await makeEngine();
  const op = nextOpId();
  const res = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: op });
  engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: op, tool: 'tool_load', input: { names: ['glob'] } },
    result: { isError: false, ok: true, payload: res.response.data.receipt },
  }, SCOPE_A);
  const b = engine.handleList({ view: 'state' }, SCOPE_B);
  assert.deepEqual(b.data.selected, []);
  const a = engine.handleList({ view: 'state' }, SCOPE_A);
  assert.equal(a.data.selected.length, 1);
});

test('STATE_NOT_READY:恢复未完成的会话不可执行任何入口', async () => {
  const { engine } = await makeEngine({ newSessionMode: 'restoring' });
  const l = engine.handleList({ view: 'state' }, SCOPE_A);
  const s = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A);
  const ld = await engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: nextOpId() });
  assert.equal(l.error.code, 'STATE_NOT_READY');
  assert.equal(s.error.code, 'STATE_NOT_READY');
  assert.equal(ld.response.error.code, 'STATE_NOT_READY');
  const g = engine.evaluateCall(SCOPE_A, { name: 'glob' });
  assert.equal(g.allowed, false);
});

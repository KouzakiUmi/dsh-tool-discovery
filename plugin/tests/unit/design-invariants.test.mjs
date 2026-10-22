// 设计契约回归：执行选择、实际披露与提交顺序必须在跨生命周期时仍然一致。
// 事件与渲染入口为声明式 fixture；不冒称真实 Loader/provider 已验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, SCOPE_A, sampleBindings, binding, commitLoad, fakeClock } from './helpers.mjs';
import { createJournal } from '../../adapters/dsh/journal.mjs';
import { createProjection } from '../../adapters/dsh/projection.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const header = (seq, tools) => ({ seq, type: 'request/header', data: { header: { tools } } });
const call = (seq, id, name) => ({ seq, type: 'tool/call', data: { name: 'tool_load', callId: id, arguments: { names: [name] } } });
const result = (seq, source, response, isError = false) => ({ seq, type: 'tool/result', sourceEventSeqs: [source],
  data: { message: { isError, content: [{ type: 'text', text: JSON.stringify(response) }] } } });
const changedBindings = () => sampleBindings().map((b) => b.name !== 'glob' ? b : { ...b, wire: { ...b.wire,
  parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } });

function journalFor(engine, events = [], extra = {}) {
  const journal = createJournal({ engine, scope: SCOPE_A, session: { id: SCOPE_A.sessionId, inheritedEventCount: 0 },
    query: { readSession: async () => ({ inheritedEventCount: 0, events }) }, ...extra });
  journal.stopBuffering();
  return journal;
}

async function project(engine, journal, bindings) {
  let assemble;
  const agent = { id: 'actor', session: { id: SCOPE_A.sessionId } };
  const runtime = { scope: SCOPE_A, engine, journal, restoring: false, requireTrustedEpoch: false,
    compositionBypass: null, alwaysNameSet: new Set() };
  createProjection({ ctx: { on: (_name, fn) => { assemble = fn; return () => {}; },
    tools: { modeFor: () => 'native', get: () => ({}) } }, lifecycle: { runtimeFor: () => runtime } });
  const assembly = { tools: bindings.map((b) => b.wire) };
  // 此组断言只比较按需段；三入口是始终保留的独立基线。
  return (await assemble(assembly, { agent }, async () => assembly)).tools
    .filter((tool) => !['tool_list', 'tool_search', 'tool_load'].includes(tool.name));
}

async function loadedHistory(t, budgets = {}) {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: 1, ...budgets } } });
  const events = [header(0, [])];
  const journal = journalFor(engine);
  const c = call(1, 'first', 'glob');
  journal.onEvent(c); events.push(c);
  const loaded = await engine.handleLoad(c.data.arguments, SCOPE_A, { operationId: 'op_first' });
  assert.equal(loaded.response.ok, true);
  const r = result(2, 1, loaded.response);
  journal.onEvent(r); events.push(r);
  const entry = engine.getCatalog().entries.get('t_files_glob');
  const h = header(3, [entry.wire]); journal.onEvent(h); events.push(h);
  assert.equal(engine.evaluateCall(SCOPE_A, { name: 'glob', requestId: journal.currentRequestId() }).allowed, true);
  t.after(() => { journal.dispose(); engine.dispose(); });
  return { engine, journal, events, entry };
}

test('DI1 冻结定义冲突必须要求成功压缩，不得返回无法兑现的加载成功', async (t) => {
  const h = await loadedHistory(t);
  h.engine.refreshCatalog(changedBindings());
  const blocked = await h.engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_changed' });
  assert.equal(blocked.response.ok, false);
  assert.equal(blocked.response.error.code, 'COMPACTION_REQUIRED');
  assert.equal(blocked.response.error.recovery, 'wait_for_successful_compaction');
  assert.equal(h.engine.getPendingSize(), 0);
  assert.equal(h.engine.getState(SCOPE_A).selected.size, 0);
  assert.deepEqual(await project(h.engine, h.journal, changedBindings()), [h.entry.wire]);
  h.engine.resetCacheEpoch(SCOPE_A, 'successful-compaction-fixture');
  const after = await h.engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_after' });
  assert.equal(after.response.ok, true);
  assert.equal(h.engine.applyCanonicalPair({ seq: 10, resultSeq: 11,
    call: { operationId: 'op_after', tool: 'tool_load', input: { names: ['glob'] } },
    result: { isError: false, ok: true, payload: after.response.data.receipt } }, SCOPE_A).applied, true);
});

test('DI2 同名更换 toolId 同样不能绕过冻结 schema 冲突检查', async (t) => {
  const h = await loadedHistory(t);
  h.engine.refreshCatalog(changedBindings().map((b) => b.name !== 'glob' ? b : { ...b, toolId: 'replacement::glob' }));
  const out = await h.engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_replaced' });
  assert.equal(out.response.ok, false);
  assert.equal(out.response.error.code, 'COMPACTION_REQUIRED');
});

for (const variant of ['changed', 'removed']) {
  test(`DI3 ${variant}: 冷恢复保留已披露旧 wire，但不恢复已失效的执行资格`, async (t) => {
    const h = await loadedHistory(t);
    const bindings = variant === 'changed' ? changedBindings() : sampleBindings().filter((b) => b.name !== 'glob');
    const { engine } = await makeEngine({ bindings, newSessionMode: 'restoring' });
    const journal = journalFor(engine, h.events);
    t.after(() => { journal.dispose(); engine.dispose(); });
    assert.equal((await journal.restore()).mode, 'ready');
    assert.equal(engine.getState(SCOPE_A).selected.size, 0);
    assert.equal(engine.getState(SCOPE_A).advertised.size, 0);
    assert.equal(engine.getFrozenWire(SCOPE_A).length, 1);
    assert.deepEqual(await project(engine, journal, bindings), [h.entry.wire]);
    assert.equal(engine.evaluateCall(SCOPE_A, { name: 'glob' }).allowed, false);
    assert.equal(engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 1);
  });
}

test('DI4 历史 header 单独不能赋予冻结披露资格；失败回执也不能', async (t) => {
  const h = await loadedHistory(t);
  const events = h.events.map((e) => e.seq === 2 ? result(2, 1, JSON.parse(e.data.message.content[0].text), true) : e);
  const { engine } = await makeEngine({ newSessionMode: 'restoring' });
  const journal = journalFor(engine, events);
  t.after(() => { journal.dispose(); engine.dispose(); });
  await journal.restore();
  assert.equal(engine.getFrozenWire(SCOPE_A).length, 0);
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  assert.deepEqual(await project(engine, journal, sampleBindings()), []);
});

test('DI5 成功压缩前与 fork 继承段的旧披露不得在恢复时复活', async (t) => {
  const h = await loadedHistory(t);
  const events = [...h.events,
    { seq: 4, type: 'compaction/start', data: { compactionId: 'cmp', turn: null } },
    { seq: 5, type: 'compaction/summary', data: { compactionId: 'cmp', turn: null } },
    { seq: 6, type: 'compaction/end', data: { compactionId: 'cmp', turn: null } }];
  for (const boundary of [0, events.length]) {
    const { engine } = await makeEngine({ newSessionMode: 'restoring' });
    const journal = journalFor(engine, events, { session: { id: SCOPE_A.sessionId, inheritedEventCount: boundary },
      query: { readSession: async () => ({ inheritedEventCount: boundary, events }) } });
    t.after(() => { journal.dispose(); engine.dispose(); });
    await journal.restore();
    assert.equal(engine.getFrozenWire(SCOPE_A).length, 0);
    assert.equal(engine.getState(SCOPE_A).selected.size, 0);
  }
});

test('DI6 有效结果逆序提交：热态与同一日志的冷恢复必须一致', async (t) => {
  const { engine } = await makeEngine();
  const journal = journalFor(engine);
  t.after(() => { journal.dispose(); engine.dispose(); });
  const a = call(1, 'a', 'glob'), b = call(2, 'b', 'grep');
  journal.onEvent(a); journal.onEvent(b);
  const ar = await engine.handleLoad(a.data.arguments, SCOPE_A, { operationId: 'op_a' });
  const br = await engine.handleLoad(b.data.arguments, SCOPE_A, { operationId: 'op_b' });
  const rb = result(3, 2, br.response), ra = result(4, 1, ar.response);
  journal.onEvent(rb); journal.onEvent(ra);
  const hot = [...engine.getState(SCOPE_A).selected.values()].map((s) => s.name);
  assert.deepEqual(hot, ['grep', 'glob']);
  const { engine: cold } = await makeEngine({ newSessionMode: 'restoring' });
  const cj = journalFor(cold, [header(0, []), a, b, rb, ra]);
  t.after(() => { cj.dispose(); cold.dispose(); });
  await cj.restore();
  assert.deepEqual([...cold.getState(SCOPE_A).selected.values()].map((s) => s.name), hot);
  assert.equal(engine.getPendingSize(), 0);
  journal.onEvent({ ...ra, seq: 5 });
  assert.deepEqual([...engine.getState(SCOPE_A).selected.values()].map((s) => s.name), hot, '重复 result 不二次认领');
});

test('DI6b 候选 ref 在已接纳 load 等待期间过期：提交与冷恢复仍一致', async (t) => {
  const clock = fakeClock();
  const { engine } = await makeEngine({ clock });
  t.after(() => engine.dispose());
  const candidate = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A).data.candidates[0];
  const input = { candidates: [{ ref: candidate.ref }] };
  const operationId = 'op_candidate_expiry';
  const loaded = await engine.handleLoad(input, SCOPE_A, { operationId });
  assert.equal(loaded.response.ok, true);

  // Ref 的 TTL 限制新的候选请求，不应撤销已经接纳且等待 canonical 回执的操作。
  clock.advance(900_000);
  const retry = await engine.handleLoad(input, SCOPE_A, { operationId: 'op_candidate_expired_retry' });
  assert.equal(retry.response.ok, false);
  assert.equal(retry.response.error.code, 'CANDIDATE_UNAVAILABLE');
  const canonical = {
    seq: 1,
    call: { operationId, tool: 'tool_load', input },
    result: { isError: false, ok: true, payload: loaded.response.data.receipt },
  };
  const hot = engine.applyCanonicalPair(canonical, SCOPE_A);
  assert.equal(hot.applied, true, hot.reason);

  const { engine: cold } = await makeEngine({ newSessionMode: 'restoring' });
  t.after(() => cold.dispose());
  const restored = cold.restore([canonical], SCOPE_A);
  assert.equal(restored.applied, 1);
  assert.deepEqual(
    [...cold.getState(SCOPE_A).selected.values()].map(({ toolId, revision }) => ({ toolId, revision })),
    [...engine.getState(SCOPE_A).selected.values()].map(({ toolId, revision }) => ({ toolId, revision })),
  );
  assert.equal(engine.getState(SCOPE_A).integrity.coldCandidateRestores, 0);
  assert.equal(cold.getState(SCOPE_A).integrity.coldCandidateRestores, 1);
});

test('DI6c 已接纳 operationId 配上不同 canonical candidate input 不得跳过 ref 归属核验', async (t) => {
  const { engine } = await makeEngine();
  t.after(() => engine.dispose());
  const glob = engine.handleSearch({ category: 'files', query: 'glob' }, SCOPE_A).data.candidates[0];
  const grep = engine.handleSearch({ category: 'files', query: 'grep' }, SCOPE_A).data.candidates[0];
  const admittedInput = { candidates: [{ ref: glob.ref }] };
  const operationId = 'op_candidate_input_mismatch';
  const loaded = await engine.handleLoad(admittedInput, SCOPE_A, { operationId });
  assert.equal(loaded.response.ok, true);

  const out = engine.applyCanonicalPair({
    seq: 1,
    call: { operationId, tool: 'tool_load', input: { candidates: [{ ref: grep.ref }] } },
    result: { isError: false, ok: true, payload: loaded.response.data.receipt },
  }, SCOPE_A);
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'selected-not-from-candidate');
  assert.equal(engine.getState(SCOPE_A).selected.size, 0);
});

test('DI7 冻结 schema 不等于已发送新技能：技能换版必须交付并计入技能限额', async (t) => {
  const h = await loadedHistory(t);
  const updated = sampleBindings().map((b) => b.name !== 'glob' ? b : { ...b,
    skill: { skillRevision: 's2', usage: 'new required guidance', limitations: ['new boundary'] } });
  h.engine.refreshCatalog(updated);
  const reload = await h.engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_skill' });
  assert.equal(reload.response.ok, true);
  assert.equal(reload.response.data.skills.length, 1);
  assert.equal(reload.response.data.skills[0].skillRevision, 's2');
  assert.equal(h.engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 1);
});

for (const query of ['create music', '创建音乐']) {
  test(`DI8 category-token 不得单独制造工具命中: ${query}`, async (t) => {
    const { engine } = await makeEngine(); t.after(() => engine.dispose());
    assert.deepEqual(engine.handleSearch({ category: 'documents', query }, SCOPE_A).data.candidates, []);
    assert.ok(engine.handleSearch({ category: 'documents', query: 'write a spreadsheet' }, SCOPE_A).data.candidates.some((c) => c.name === 'xlsx_write'));
  });
}

test('DI9 名称、类别、状态与搜索均以完整成功响应的 UTF-8 字节计量', async (t) => {
  const { engine: tiny } = await makeEngine({ bindings: [binding({ name: 'x', namespace: 'files' })],
    engineConfig: { budgets: { maxListResultBytes: 3, maxSearchResultBytes: 3 } } });
  t.after(() => tiny.dispose());
  for (const response of [tiny.handleList({ category: 'files' }, SCOPE_A), tiny.handleList({}, SCOPE_A),
    tiny.handleList({ view: 'state' }, SCOPE_A), tiny.handleSearch({ category: 'files', query: 'x' }, SCOPE_A),
    tiny.handleSearch({ category: 'files', query: 'zzzzzzzz' }, SCOPE_A)]) {
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'BUDGET_EXCEEDED');
  }
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxListResultBytes: 650, maxSearchResultBytes: 800 } } });
  t.after(() => engine.dispose());
  for (const request of [{ category: 'files' }, {}, { view: 'state' }]) {
    const response = engine.handleList(request, SCOPE_A);
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.ok(bytes(response) <= 650, `${JSON.stringify(request)}: ${bytes(response)}`);
  }
  const response = engine.handleSearch({ category: 'files', query: 'file' }, SCOPE_A);
  assert.equal(response.ok, true);
  assert.ok(bytes(response) <= 800);
});

test('DI10 完整响应预算的边界与分页：刚好装下全页时不得因虚拟游标误拒', async (t) => {
  const bindings = [binding({ name: 'x', namespace: 'files' }), binding({ name: 'y', namespace: 'files' })];
  const { engine: open } = await makeEngine({ bindings }); t.after(() => open.dispose());
  const full = open.handleList({ category: 'files' }, SCOPE_A);
  const { engine: exact } = await makeEngine({ bindings, engineConfig: { budgets: { maxListResultBytes: bytes(full) } } });
  t.after(() => exact.dispose());
  assert.deepEqual(exact.handleList({ category: 'files' }, SCOPE_A), full);
  const { engine: paged } = await makeEngine({ bindings, engineConfig: { budgets: { maxListResultBytes: 500, maxListLimit: 1 } } });
  t.after(() => paged.dispose());
  const first = paged.handleList({ category: 'files' }, SCOPE_A);
  const second = paged.handleList({ category: 'files', cursor: first.data.nextCursor }, SCOPE_A);
  assert.deepEqual([...first.data.names, ...second.data.names], ['x', 'y']);
  assert.ok(bytes(first) <= 500 && bytes(second) <= 500);
});

const permutations = (items) => items.length === 0 ? [[]]
  : items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest]));

for (const ptc of [false, true]) {
  test(`DI11 ${ptc ? 'PTC' : 'native'}: 三项结果的六种排列及混合失败均与重放一致`, async (t) => {
    for (const order of permutations([0, 1, 2])) {
      for (const failed of [-1, 1]) {
        const { engine } = await makeEngine();
        const events = [ptc
          ? { seq: 0, type: 'tool/call', data: { name: 'run_code', callId: 'parent', arguments: {} } }
          : header(0, [])];
        const journal = journalFor(engine, [], { collapsedPresentation: () => ptc });
        journal.onEvent(events[0]);
        const names = ['glob', 'grep', 'read_file'];
        const responses = [];
        for (let i = 0; i < names.length; i++) {
          const c = ptc ? { seq: i + 1, type: 'tool/ptc-dispatch-start', data: {
            name: 'tool_load', parentCallId: 'parent', subCallId: `load${i}`, arguments: { names: [names[i]] },
          } } : call(i + 1, `load${i}`, names[i]);
          journal.onEvent(c); events.push(c);
          responses.push((await engine.handleLoad({ names: [names[i]] }, SCOPE_A, { operationId: `op_load${i}` })).response);
        }
        for (const [position, i] of order.entries()) {
          const r = ptc ? { seq: position + 4, type: 'tool/ptc-dispatch', data: {
            ...events[i + 1].data, isError: i === failed,
            content: [{ type: 'text', text: JSON.stringify(responses[i]) }],
          } } : result(position + 4, i + 1, responses[i], i === failed);
          journal.onEvent(r); events.push(r);
        }
        const view = (e) => [...e.getState(SCOPE_A).selected.values()].map(({ name, seq, revision }) => ({ name, seq, revision }));
        const expected = order.filter((i) => i !== failed).map((i) => names[i]);
        assert.deepEqual(view(engine).map((s) => s.name), expected);
        assert.equal(engine.getPendingSize(), 0);
        if (!ptc) {
          const tools = expected.map((name) => engine.getCatalog().byName.get(name)[0].wire);
          const h = header(7, tools); journal.onEvent(h); events.push(h);
        }
        const { engine: cold } = await makeEngine({ newSessionMode: 'restoring' });
        const cj = journalFor(cold, events, { collapsedPresentation: () => ptc });
        t.after(() => { journal.dispose(); cj.dispose(); engine.dispose(); cold.dispose(); });
        await cj.restore();
        assert.deepEqual(view(cold), view(engine), `order=${order} failed=${failed}`);
        assert.deepEqual(cold.getFrozenWire(SCOPE_A), engine.getFrozenWire(SCOPE_A));
      }
    }
  });
}

test('DI12 同名同 schema 更换绑定仍可恢复调用，冻结槽位和预算只计一次', async (t) => {
  const h = await loadedHistory(t);
  const bindings = sampleBindings().map((b) => b.name !== 'glob' ? b : { ...b, toolId: 'replacement::glob', bindingGeneration: 'gen2' });
  h.engine.refreshCatalog(bindings);
  const c = call(4, 'samewire', 'glob'); h.journal.onEvent(c);
  const loaded = await h.engine.handleLoad(c.data.arguments, SCOPE_A, { operationId: 'op_samewire' });
  assert.equal(loaded.response.ok, true);
  h.journal.onEvent(result(5, 4, loaded.response));
  h.journal.onEvent(header(6, await project(h.engine, h.journal, bindings)));
  assert.equal(h.engine.evaluateCall(SCOPE_A, { name: 'glob', requestId: h.journal.currentRequestId() }).allowed, true);
  assert.equal(h.engine.getFrozenWire(SCOPE_A).length, 1);
  assert.equal(h.engine.handleList({ view: 'state' }, SCOPE_A).data.budgets.activeCount, 1);
});

test('DI13 中英文、空页、loaded 与不同限额下，每份成功外壳都不能越过字节上限', async (t) => {
  for (const locale of ['en', 'zh']) {
    for (const cap of [1, 100, 250, 400, 600, 1000, 2000]) {
      const { engine } = await makeEngine({ engineConfig: { locale, budgets: { maxListResultBytes: cap, maxSearchResultBytes: cap } } });
      t.after(() => engine.dispose());
      await commitLoad(engine, SCOPE_A, { names: ['glob'] });
      for (const request of [{}, { category: 'files' }, { view: 'loaded', category: 'files' },
        { view: 'loaded', category: 'web' }, { view: 'state' }]) {
        const out = engine.handleList(request, SCOPE_A);
        if (out.ok) assert.ok(bytes(out) <= cap, `locale=${locale} cap=${cap} ${JSON.stringify(request)}`);
        else assert.equal(out.error.code, 'BUDGET_EXCEEDED');
      }
      for (const query of ['file', 'zzzzzzzz']) {
        const out = engine.handleSearch({ category: 'files', query }, SCOPE_A);
        if (out.ok) assert.ok(bytes(out) <= cap);
        else assert.equal(out.error.code, 'BUDGET_EXCEEDED');
      }
    }
  }
});

test('DI14 新技能虽然复用冻结 schema，仍必须遵守 maxSkillBytesPerLoad', async (t) => {
  const h = await loadedHistory(t, { maxSkillBytesPerLoad: 500 });
  h.engine.refreshCatalog(sampleBindings().map((b) => b.name !== 'glob' ? b : { ...b,
    skill: { skillRevision: 's2', usage: 'u'.repeat(1000), limitations: [] } }));
  const out = await h.engine.handleLoad({ names: ['glob'] }, SCOPE_A, { operationId: 'op_bigskill' });
  assert.equal(out.response.ok, false);
  assert.equal(out.response.error.code, 'BUDGET_EXCEEDED');
  assert.equal(h.engine.getPendingSize(), 0);
});

test('DI15 错误身份/输入、header 先于提交及无真实 header 均不能恢复披露', async (t) => {
  const h = await loadedHistory(t);
  for (const variant of ['wrong-operation', 'wrong-input', 'wrong-digest', 'before-result', 'no-header']) {
    const events = JSON.parse(JSON.stringify(h.events));
    const shell = JSON.parse(events[2].data.message.content[0].text);
    if (variant === 'wrong-operation') shell.data.receipt.operationId = 'op_other';
    if (variant === 'wrong-input') events[1].data.arguments = { names: ['grep'] };
    if (variant === 'wrong-digest') events[3].data.header.tools[0].description = 'tampered header';
    events[2].data.message.content[0].text = JSON.stringify(shell);
    if (variant === 'before-result') {
      [events[2], events[3]] = [events[3], events[2]]; events[2].seq = 2; events[3].seq = 3;
    }
    if (variant === 'no-header') events.pop();
    const { engine } = await makeEngine({ bindings: changedBindings(), newSessionMode: 'restoring' });
    const journal = journalFor(engine, events); t.after(() => { journal.dispose(); engine.dispose(); });
    await journal.restore();
    assert.equal(engine.getFrozenWire(SCOPE_A).length, 0, variant);
    assert.equal(engine.getState(SCOPE_A).selected.size, 0, variant);
  }
});


test('DI16 live and restored native projections preserve the exact observed JSON bytes', async (t) => {
  const h = await loadedHistory(t);
  const expected = JSON.stringify(h.events[3].data.header.tools);
  assert.equal(JSON.stringify(await project(h.engine, h.journal, sampleBindings())), expected);
  const { engine } = await makeEngine({ newSessionMode: 'restoring' });
  const journal = journalFor(engine, h.events);
  t.after(() => { journal.dispose(); engine.dispose(); });
  await journal.restore();
  assert.equal(JSON.stringify(await project(engine, journal, sampleBindings())), expected);
});

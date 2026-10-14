// 按宿主公开 PTC dispatch 日志契约声明式注入；所有激活/拒绝判据由真实 journal/engine 执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal, foldPairs } from '../../adapters/dsh/journal.mjs';
import { makeEngine, SCOPE_A } from './helpers.mjs';

async function setup(t) {
  const { engine } = await makeEngine();
  const journal = createJournal({ ctx: {}, session: { inheritedEventCount: 0 }, scope: SCOPE_A,
    engine, collapsedPresentation: () => true });
  journal.stopBuffering();
  t.after(() => { journal.dispose(); engine.dispose(); });
  const input = { names: ['glob'] };
  const parent = { seq: 0, type: 'tool/call', data: { callId: 'parent', name: 'run_code', arguments: {} } };
  const start = { seq: 1, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'parent', subCallId: 'child',
    name: 'tool_load', arguments: input } };
  journal.onEvent(parent); journal.onEvent(start);
  const out = await engine.handleLoad(input, SCOPE_A, { operationId: 'op_child' });
  const result = { seq: 2, type: 'tool/ptc-dispatch', data: { ...start.data, isError: false,
    content: [{ type: 'text', text: JSON.stringify(out.response) }] } };
  const end = { seq: 3, type: 'tool/result', sourceEventSeqs: [0], data: { message: { isError: false, content: [] } } };
  return { engine, journal, parent, start, result, end };
}

test('PTC 子调用最终成功才激活；冷恢复可重建 selected，但不反推 SDK 曝光', async (t) => {
  const h = await setup(t);
  h.journal.onEvent(h.result); h.journal.onEvent(h.end);
  assert.equal(h.engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(h.engine.getState(SCOPE_A).advertised.size, 0);
  const events = [h.parent, h.start, h.result, h.end];
  assert.equal(foldPairs(events).length, 1);
  const { engine } = await makeEngine({ newSessionMode: 'restoring' });
  const journal = createJournal({ ctx: {}, session: { inheritedEventCount: 0 }, scope: SCOPE_A, engine,
    query: { readSession: async () => ({ inheritedEventCount: 0, events }) } });
  t.after(() => { journal.dispose(); engine.dispose(); });
  assert.equal((await journal.restore()).applied, 1);
  assert.equal(engine.getState(SCOPE_A).selected.size, 1);
  assert.equal(engine.getState(SCOPE_A).advertised.size, 0);
});

for (const [label, change] of [
  ['父调用不匹配', (result) => { result.data.parentCallId = 'other'; }],
  ['子调用不匹配', (result) => { result.data.subCallId = 'other'; }],
  ['工具名不匹配', (result) => { result.data.name = 'tool_search'; }],
  ['参数被改写', (result) => { result.data.arguments = { names: ['grep'] }; }],
  ['最终错误', (result) => { result.data.isError = true; }],
  ['缺失最终成功标记', (result) => { delete result.data.isError; }],
  ['日志正文被改写', (result) => { result.data.content = [{ type: 'text', text: 'rewritten' }]; }],
]) {
  test(`PTC ${label} 不激活；外层结算后释放残余预留`, async (t) => {
    const h = await setup(t);
    change(h.result);
    h.journal.onEvent(h.result); h.journal.onEvent(h.end);
    assert.equal(h.engine.getState(SCOPE_A).selected.size, 0);
    assert.equal(h.engine.getPendingSize(), 0);
    const { engine: cold } = await makeEngine();
    t.after(() => cold.dispose());
    cold.restore(foldPairs([h.parent, h.start, h.result, h.end]), SCOPE_A);
    assert.equal(cold.getState(SCOPE_A).selected.size, 0);
  });
}

test('缺失 own run_code 父调用、跨 native/ptc 提交面、迟到子结果都不授信', async (t) => {
  const h = await setup(t);
  const mixed = { seq: 2, type: 'tool/result', sourceEventSeqs: [1], data: { message: {
    isError: false, content: h.result.data.content,
  } } };
  h.journal.onEvent(mixed);
  assert.equal(h.engine.getState(SCOPE_A).selected.size, 0);
  assert.equal(foldPairs([h.start, h.result]).length, 0);
  h.journal.onEvent(h.end);
  h.journal.onEvent({ ...h.result, seq: 4 });
  assert.equal(h.engine.getState(SCOPE_A).selected.size, 0);
  assert.equal(h.engine.getPendingSize(), 0);
});

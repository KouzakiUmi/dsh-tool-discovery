// 声明式注入 canonical 事件，只证明产品代码行为；真实宿主路径见组合门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../../adapters/dsh/journal.mjs';
import { makeEngine } from './helpers.mjs';

const scope = { sessionId: 'terminal-result', actorId: 'actor' };
async function setup(t, cap = 1) {
  const { engine } = await makeEngine({ engineConfig: { budgets: { maxActiveTools: cap } } });
  const journal = createJournal({ ctx: {}, session: { inheritedEventCount: 0 }, scope, engine });
  journal.stopBuffering();
  t.after(() => { journal.dispose(); engine.dispose(); });
  let seq = 0;
  const emit = (type, data, sources) => {
    const event = { seq: seq++, type, data, ...(sources ? { sourceEventSeqs: sources } : {}) };
    journal.onEvent(event);
    return event.seq;
  };
  emit('turn/start', { turn: 1 });
  const call = async (id, name) => {
    const input = { names: [name] };
    const callSeq = emit('tool/call', { name: 'tool_load', callId: id, arguments: JSON.stringify(input) });
    const out = await engine.handleLoad(input, scope, { operationId: `op_${id}` });
    assert.equal(out.response.ok, true);
    return { callSeq, response: out.response };
  };
  const result = (sources, text, isError = true) => emit('tool/result', { message: { isError, content: [{ type: 'text', text }] } }, sources);
  return { engine, journal, emit, call, result };
}

for (const [label, text, isError] of [
  ['取消错误文本', 'Error: tool call aborted', true],
  ['post-policy 拒绝', 'blocked by post-policy', true],
  ['非错误但正文被改写', 'rewritten receipt', false],
  ['非协议 JSON', '{"ok":false}', true],
]) {
  test(`terminal: ${label} 释放预留，下一次 load 不被错误占额`, async (t) => {
    const h = await setup(t);
    const first = await h.call('first', 'glob');
    assert.equal(h.engine.getPendingSize(), 1);
    h.result([first.callSeq], text, isError);
    assert.equal(h.engine.getPendingSize(), 0);
    assert.equal(h.engine.getState(scope).selected.size, 0);
    assert.deepEqual([...h.journal.pendingLoadNames()], []);
    await h.call('next', 'grep');
  });
}

test('terminal: 成功结果仍折叠、保持已有预算与授权', async (t) => {
  const h = await setup(t);
  const first = await h.call('first', 'glob');
  h.result([first.callSeq], JSON.stringify(first.response), false);
  assert.equal(h.engine.getPendingSize(), 0);
  assert.equal(h.engine.getState(scope).selected.size, 1);
  const second = await h.engine.handleLoad({ names: ['grep'] }, scope, { operationId: 'op_second' });
  assert.equal(second.response.error.code, 'BUDGET_EXCEEDED');
});

test('terminal: 只取消命中的调用，无关结果/重复结果/迟到结果不授予权限', async (t) => {
  const h = await setup(t, 2);
  const first = await h.call('first', 'glob');
  const other = await h.call('other', 'grep');
  h.result([999], 'unrelated');
  assert.equal(h.engine.getPendingSize(), 2);
  h.result([first.callSeq], 'Error: tool call aborted');
  assert.equal(h.engine.getPendingSize(), 1);
  assert.deepEqual([...h.journal.pendingLoadNames()], ['grep']);
  h.result([first.callSeq], JSON.stringify(first.response), false);
  assert.equal(h.engine.getPendingSize(), 1);
  assert.equal(h.engine.getState(scope).selected.size, 0);
  h.result([other.callSeq], JSON.stringify(other.response), false);
  assert.equal(h.engine.getPendingSize(), 0);
  assert.deepEqual([...h.engine.getState(scope).selected.keys()], ['t_files_grep']);
});

test('terminal: 相同 call seq 的另一会话预留不受影响', async (t) => {
  const h = await setup(t);
  const first = await h.call('first', 'glob');
  const otherScope = { sessionId: 'other-terminal-session', actorId: 'other-actor' };
  const otherJournal = createJournal({ ctx: {}, session: { inheritedEventCount: 0 }, scope: otherScope, engine: h.engine });
  otherJournal.stopBuffering();
  t.after(() => otherJournal.dispose());
  otherJournal.onEvent({ seq: 0, type: 'turn/start', data: { turn: 1 } });
  otherJournal.onEvent({ seq: 1, type: 'tool/call', data: { name: 'tool_load', callId: 'other-session-call', arguments: '{"names":["grep"]}' } });
  const other = await h.engine.handleLoad({ names: ['grep'] }, otherScope, { operationId: 'op_other-session-call' });
  assert.equal(other.response.ok, true);
  assert.equal(h.engine.getPendingSize(), 2);
  h.result([first.callSeq], 'Error: tool call aborted');
  assert.equal(h.engine.getPendingSize(), 1);
  assert.deepEqual([...otherJournal.pendingLoadNames()], ['grep']);
  otherJournal.onEvent({ seq: 2, type: 'tool/result', sourceEventSeqs: [1], data: { message: { isError: false, content: [{ type: 'text', text: JSON.stringify(other.response) }] } } });
  assert.equal(h.engine.getPendingSize(), 0);
  assert.equal(h.engine.getState(scope).selected.size, 0);
  assert.deepEqual([...h.engine.getState(otherScope).selected.keys()], ['t_files_grep']);
});

test('terminal: 可解析的失败/错误回执沿用 reducer，不能激活', async (t) => {
  const h = await setup(t);
  const first = await h.call('first', 'glob');
  h.result([first.callSeq], JSON.stringify(first.response), true);
  assert.equal(h.engine.getPendingSize(), 0);
  assert.equal(h.engine.getState(scope).selected.size, 0);
});

test('terminal: 不改变既有 selected / advertised / frozen', async (t) => {
  const h = await setup(t, 2);
  const first = await h.call('first', 'glob');
  h.result([first.callSeq], JSON.stringify(first.response), false);
  const entry = h.engine.getCatalog().byName.get('glob')[0];
  h.engine.recordAdvertisement(scope, { requestId: 'r1', toolId: entry.toolId, name: entry.name, revision: entry.revision, schemaDigest: entry.schemaDigest, wire: entry.wire });
  const before = structuredClone(h.engine.getState(scope));
  const second = await h.call('second', 'grep');
  h.result([second.callSeq], 'Error: tool call aborted');
  const after = h.engine.getState(scope);
  for (const key of ['selected', 'advertised', 'frozen']) assert.deepEqual(after[key], before[key], key);
  assert.equal(h.engine.getPendingSize(), 0);
});

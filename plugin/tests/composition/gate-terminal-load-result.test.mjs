// 真 Loader、真宿主取消/策略链；provider 是 mock，不代表外部 wire。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';
import { store, queueResponse } from '../../fixtures/mock-store.mjs';
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));

for (const kind of ['success', 'post-block', 'user-cancel-after-body']) {
  test(`terminal real host: ${kind}`, async () => {
    const boot = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools'], adapter: { budgets: { maxActiveTools: 1 } } });
    let handle;
    let bodyObserved = false;
    const remove = boot.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name === 'tool_load' && exec.callId === 'first') {
        const body = JSON.parse(result.content.map(x => x.text ?? '').join(''));
        assert.equal(body.ok, true, '前置：body 真已成功产生预留');
        bodyObserved = true;
        if (kind === 'post-block') return { kind: 'block', feedback: [{ type: 'text', text: 'fixture post-policy rejection' }] };
        if (kind === 'user-cancel-after-body') exec.agent.cancel({ kind: 'user' });
      }
      return next();
    });
    try {
      assert.deepEqual(boot.activationErrors(), []);
      store.reset();
      handle = await boot.ctx.agents.create({ sessionId: `terminal-${kind}`, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
      const followup = async () => {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'terminal gate' }], source: { kind: 'user' } }));
        await handle.agent.whenIdle();
      };
      queueResponse({ toolCalls: [{ id: 'first', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] });
      if (kind !== 'user-cancel-after-body') queueResponse({ text: 'done' });
      await followup();
      assert.equal(bodyObserved, true);
      const runtime = boot.ctx.progressiveDiscovery.sessions.get(handle.agent.session.id);
      assert.ok(runtime);
      assert.equal(runtime.engine.getPendingSize(), 0, '每条终态路径必须释放预留');
      assert.equal(runtime.engine.getState(runtime.scope).selected.size, kind === 'success' ? 1 : 0);
      assert.deepEqual([...runtime.journal.pendingLoadNames()], []);
      const events = (await boot.ctx.sessionQuery.readSession(handle.agent.session.id)).events;
      const call = events.find(e => e.type === 'tool/call' && e.data.callId === 'first');
      assert.ok(call);
      const result = events.find(e => e.type === 'tool/result' && e.sourceEventSeqs?.includes(call.seq));
      const end = events.find(e => e.type === 'turn/end');
      assert.ok(result && end);
      assert.equal(result.data.message.isError === true, kind !== 'success');
      assert.ok(call.seq < result.seq && result.seq < end.seq, 'result 在 turn/end 前');
      if (kind === 'user-cancel-after-body') assert.equal(end.data.reason.kind, 'aborted');
      queueResponse({ toolCalls: [{ id: 'second', name: 'tool_load', arguments: { names: ['fixture_mutating'] } }] });
      queueResponse({ text: 'done' });
      await followup();
      const nextEvents = (await boot.ctx.sessionQuery.readSession(handle.agent.session.id)).events;
      const nextCall = nextEvents.find(e => e.type === 'tool/call' && e.data.callId === 'second');
      assert.ok(nextCall);
      const nextResult = nextEvents.find(e => e.type === 'tool/result' && e.sourceEventSeqs?.includes(nextCall.seq));
      assert.ok(nextResult);
      const shell = JSON.parse(nextResult.data.message.content.map(x => x.text ?? '').join(''));
      assert.equal(shell.ok, kind !== 'success');
      if (kind === 'success') assert.equal(shell.error.code, 'BUDGET_EXCEEDED', '成功选择占额是正控制');
      else assert.ok(runtime.engine.getState(runtime.scope).selected.has('global::fixture_mutating'));
    } finally {
      remove();
      if (handle) await handle.dispose();
      await boot.closeServices();
      boot.dispose();
    }
  });
}

test('list default real host: 空请求导航，省略 view 的类别调用仍列名称', async () => {
  const boot = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools'], adapter: {} });
  let handle;
  try {
    store.reset();
    handle = await boot.ctx.agents.create({ sessionId: 'list-default-host', agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
    queueResponse({ toolCalls: [{ id: 'nav', name: 'tool_list', arguments: {} }, { id: 'names', name: 'tool_list', arguments: { category: 'all' } }] });
    queueResponse({ text: 'done' });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'navigation gate' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    const events = (await boot.ctx.sessionQuery.readSession(handle.agent.session.id)).events;
    for (const [id, view] of [['nav', 'categories'], ['names', 'available']]) {
      const call = events.find(e => e.type === 'tool/call' && e.data.callId === id);
      assert.ok(call);
      const result = events.find(e => e.type === 'tool/result' && e.sourceEventSeqs?.includes(call.seq));
      assert.ok(result);
      const shell = JSON.parse(result.data.message.content.map(x => x.text ?? '').join(''));
      assert.equal(shell.ok, true);
      assert.equal(shell.data.view, view);
    }
  } finally {
    if (handle) await handle.dispose();
    await boot.closeServices();
    boot.dispose();
  }
});

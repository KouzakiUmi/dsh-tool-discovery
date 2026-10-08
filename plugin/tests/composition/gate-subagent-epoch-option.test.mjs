import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';
const { store, queueResponse } = await import('../../fixtures/mock-store.mjs');
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const fixtures = ['mock-provider', 'inherited-tools', 'scope-tools'];
const agentOptions = { provider: 'fixture-mock', model: 'fixture-model' };
const entryOf = boot => boot.loader.entries().find(entry => entry.id === 'progressive-discovery');
const lifeOf = boot => boot.ctx.get('progressiveDiscovery').lifecycle;
async function create(boot, sessionId, parentAgent) {
  return boot.ctx.agents.create({ sessionId, agentOptions, meta: { cwd: boot.tmpRoot }, ...(parentAgent ? { parentAgent } : {}) });
}
async function turn(handle, text = 'Continue.') {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}
async function baseline(boot, handle) {
  const life = lifeOf(boot);
  const runtime = life.ensureRuntime(handle.agent.session, handle.agent);
  await life.whenReady(handle.agent.id);
  return { runtime, baseline: life.baselineOf(handle.agent.id) };
}

test('SE1: 安装后旧子会话默认不需 /compact，主会话严格模式仍拒绝缺记录；恢复子会话保留资格门禁', async () => {
  store.reset(); const boot = await bootAdapterComposition({ fixtures, adapterSchema: true, adapter: { alwaysVisible: [] } });
  let root, child;
  try {
    root = await create(boot, 'se-root'); child = await create(boot, 'se-child', root.agent);
    assert.equal(boot.ctx.agents.isOwnedBy('se-child', root.agent), true, '必须是真实运行时子代理');
    queueResponse({ text: 'old root' }); await turn(root);
    queueResponse({ text: 'old child' }); await turn(child);
    const history = await boot.ctx.sessionQuery.readSession('se-child');
    assert.ok(history.events.some(event => event.type === 'request/header'), '子代理必须已有真实 own 请求历史');
    await child.dispose(); child = undefined;
    const entry = entryOf(boot);
    await entry.update({ config: { ...entry.options.config, requireTrustedEpoch: true } }); await boot.loader.await();
    const rootState = await baseline(boot, root);
    assert.equal(rootState.baseline.reason, 'MISSING_TRUSTED_EPOCH');
    await assert.rejects(boot.ctx.systemPrompt.assemble({ agent: root.agent, scope: root.agent }), /MISSING_TRUSTED_EPOCH/);
    child = await boot.ctx.agents.resume({ resumeSessionId: 'se-child', agentOptions, parentAgent: root.agent });
    assert.equal(boot.ctx.agents.isOwnedBy('se-child', root.agent), true);
    const childState = await baseline(boot, child);
    assert.equal(childState.runtime.requireTrustedEpoch, false);
    assert.equal(childState.baseline.state, 'disabled');
    queueResponse({ toolCalls: [{ id: 'se-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] });
    queueResponse({ toolCalls: [{ id: 'se-use', name: 'fixture_hidden_inherited', arguments: { text: 'ok' } }] });
    queueResponse({ text: 'done' }); await turn(child, 'Continue without compact.');
    assert.equal(store.requests.length, 5);
    assert.equal(store.bodyCount('se-use'), 1);
    const denied = await boot.ctx.tools.execute({ agent: child.agent, name: 'fixture_mutating', callId: 'se-denied', arguments: {}, signal: new AbortController().signal });
    assert.equal(denied.isError, true); assert.equal(store.bodyCount('se-denied'), 0);
    // 用户显式选择对子代理也严格检查，旧子会话仍应拒绝。再关闭不需伪造 compact。
    const oldLife = lifeOf(boot);
    await entry.update({ config: { ...entry.options.config, requireTrustedEpochForSubagents: true } }); await boot.loader.await();
    assert.notEqual(lifeOf(boot), oldLife, '普通严格开关须重新创建 lifecycle；Loader 的行/fiber 身份本身可能复用');
    assert.equal((await baseline(boot, child)).baseline.reason, 'MISSING_TRUSTED_EPOCH');
    await assert.rejects(boot.ctx.systemPrompt.assemble({ agent: child.agent, scope: child.agent }), /MISSING_TRUSTED_EPOCH/);
    await entry.update({ config: { ...entry.options.config, requireTrustedEpochForSubagents: false } }); await boot.loader.await();
    assert.equal((await baseline(boot, child)).baseline.state, 'disabled');
    queueResponse({ text: 'recovered' }); await turn(child);
    assert.equal(store.requests.length, 6);
  } finally { await child?.dispose(); await root?.dispose(); await boot.dispose(); }
});

test('SE3: 真实 fork 带非空继承前缀和旧 own 请求，安装后默认不需要子代理 compact', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures, adapterSchema: true, adapter: { alwaysVisible: [] }, extraServices: [
    { id: 'subagents', name: '@deepseek-ai/dsh-subagent', config: {} },
    { id: 'fork-provider', name: '@deepseek-ai/dsh-subagent-fork-in-process', config: {} },
  ] });
  let root, run;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    root = await create(boot, 'se-real-fork-parent');
    queueResponse({ text: 'parent prefix' }); await turn(root);
    queueResponse({ text: 'legacy child own turn' });
    const subagents = boot.ctx.get('subagents');
    assert.ok(subagents && subagents.getProvider('fork'), '必须已激活真实宿主 fork provider');
    run = await subagents.start('fork', { parent: root.agent, prompt: [{ type: 'text', text: 'Child task.' }], signal: new AbortController().signal });
    assert.notEqual(await run.result, undefined);
    assert.ok(run.localAgent);
    assert.equal(boot.ctx.agents.isOwnedBy(run.id, root.agent), true);
    const history = await boot.ctx.sessionQuery.readSession(run.id);
    assert.ok(history.inheritedEventCount > 0, '禁止新建空子会话冒充真实 fork');
    assert.ok(history.events.some(event => event.seq >= history.inheritedEventCount && event.type === 'request/header'), '子代理有自己的旧请求历史');
    const entry = entryOf(boot);
    await entry.update({ config: { ...entry.options.config, requireTrustedEpoch: true } }); await boot.loader.await();
    assert.equal((await baseline(boot, { agent: run.localAgent })).baseline.state, 'disabled');
    queueResponse({ text: 'continues without compact' }); await turn({ agent: run.localAgent });
    assert.equal(store.requests.length, 3);
    assert.equal(lifeOf(boot).baselineOf(run.id).state, 'disabled');
  } finally { await run?.dispose(); await root?.dispose(); await boot.dispose(); }
});

test('SE4: 主严格模式遇到不可用存储，默认子代理不访问 epoch 存储且仍可请求', async () => {
  store.reset(); const boot = await bootAdapterComposition({ fixtures, adapterSchema: true, omitStorage: true, adapter: { requireTrustedEpoch: true, alwaysVisible: [] } });
  let root, child;
  try {
    root = await create(boot, 'se-unavailable-root'); child = await create(boot, 'se-unavailable-child', root.agent);
    assert.equal((await baseline(boot, root)).baseline.state, 'blocked');
    assert.equal((await baseline(boot, child)).baseline.state, 'disabled');
    queueResponse({ text: 'child without storage' }); await turn(child);
    assert.equal(store.requests.length, 1);
    assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), ['tool_list', 'tool_load', 'tool_search']);
  } finally { await child?.dispose(); await root?.dispose(); await boot.dispose(); }
});

test('SE5: 子代理结束后作为顶层恢复，不沿用旧子代理豁免', async () => {
  store.reset(); const boot = await bootAdapterComposition({ fixtures, adapterSchema: true, adapter: { requireTrustedEpoch: true, alwaysVisible: [] } });
  let parent, child, promoted;
  try {
    parent = await create(boot, 'se-promotion-parent'); child = await create(boot, 'se-promotion-child', parent.agent);
    assert.equal((await baseline(boot, child)).baseline.state, 'disabled');
    queueResponse({ text: 'child history without epoch' }); await turn(child);
    await child.dispose(); child = undefined;
    assert.equal(lifeOf(boot).sessions.has('se-promotion-child'), false, '宿主 session/disposed 必须清理旧 runtime');
    promoted = await boot.ctx.agents.resume({ resumeSessionId: 'se-promotion-child', agentOptions });
    assert.ok(boot.ctx.agents.roots().includes(promoted.agent));
    const promotedState = await baseline(boot, promoted);
    assert.equal(promotedState.runtime.requireTrustedEpoch, true);
    assert.equal(promotedState.baseline.reason, 'MISSING_TRUSTED_EPOCH');
    await assert.rejects(boot.ctx.systemPrompt.assemble({ agent: promoted.agent, scope: promoted.agent }), /MISSING_TRUSTED_EPOCH/);
    assert.equal(store.requests.length, 1, '作为顶层恢复后不可绕过严格屏障新增请求');
  } finally { await promoted?.dispose(); await child?.dispose(); await parent?.dispose(); await boot.dispose(); }
});

for (const mainStrict of [false, true]) for (const childStrict of [false, true]) {
  test(`SE2 matrix: main=${mainStrict}, child=${childStrict} only applies child strict when both switches on`, async () => {
    const boot = await bootAdapterComposition({ fixtures, adapterSchema: true, adapter: { alwaysVisible: [], requireTrustedEpoch: mainStrict, requireTrustedEpochForSubagents: childStrict } });
    let root, child;
    try {
      root = await create(boot, `se-matrix-root-${mainStrict}-${childStrict}`);
      child = await create(boot, `se-matrix-child-${mainStrict}-${childStrict}`, root.agent);
      const rootState = await baseline(boot, root);
      const childState = await baseline(boot, child);
      assert.equal(rootState.runtime.requireTrustedEpoch, mainStrict);
      assert.equal(childState.runtime.requireTrustedEpoch, mainStrict && childStrict);
      assert.equal(rootState.baseline.state, mainStrict ? 'trusted' : 'disabled');
      assert.equal(childState.baseline.state, mainStrict && childStrict ? 'trusted' : 'disabled');
    } finally { await child?.dispose(); await root?.dispose(); await boot.dispose(); }
  });
}

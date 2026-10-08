// 真实 Loader + 宿主 agent + mock provider。只写测试私有目录，不改用户 profile。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';

const HIDDEN = 'fixture_hidden_inherited';
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools'];
const { store, queueResponse } = await import('../../fixtures/mock-store.mjs');
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const namesOf = request => request.tools.map(tool => tool.name);
async function turn(handle, text) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}
async function agent(boot, id) {
  return boot.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: boot.tmpRoot } });
}
function entryOf(boot) { return boot.loader.entries().find(entry => entry.id === 'progressive-discovery'); }

// 初始状态由关闭严格模式的产品产生真实历史，再用真实 Loader 切换开关。
test('OS1: 默认关闭严格校验；存量会话无记录能继续，开启拒绝，关闭恢复且不授信历史隐藏工具', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapterSchema: true, adapter: { alwaysVisible: [HIDDEN] } });
  let handle;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    const entry = entryOf(boot);
    assert.equal(entry.fiber.config.requireTrustedEpoch, false);
    handle = await agent(boot, 'os-legacy');
    queueResponse({ text: 'before toggle' });
    await turn(handle, 'First turn.');
    assert.equal(store.requests.length, 1);
    assert.ok(namesOf(store.requests[0]).includes(HIDDEN));
    const history = await boot.ctx.sessionQuery.readSession('os-legacy');
    assert.ok(history.events.some(event => event.type === 'request/header'), '必须有真实出站历史');
    assert.equal(boot.ctx.get('progressiveDiscovery').lifecycle.baselineOf('os-legacy').state, 'disabled');

    const raw = { ...entry.options.config, requireTrustedEpoch: true };
    await entry.update({ config: raw });
    await boot.loader.await();
    assert.equal(entry.fiber.config.requireTrustedEpoch, true);
    const strict = boot.ctx.get('progressiveDiscovery').lifecycle;
    const strictRuntime = strict.ensureRuntime(handle.agent.session, handle.agent);
    await strict.whenReady('os-legacy');
    assert.equal(strictRuntime.requireTrustedEpoch, true);
    assert.equal(strict.baselineOf('os-legacy').reason, 'MISSING_TRUSTED_EPOCH');
    await assert.rejects(boot.ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent }), /MISSING_TRUSTED_EPOCH/);
    assert.equal(store.requests.length, 1, '严格模式缺记录不能新增出站请求');

    await entry.update({ config: { ...raw, requireTrustedEpoch: false } });
    await boot.loader.await();
    const compatible = boot.ctx.get('progressiveDiscovery').lifecycle;
    const runtime = compatible.ensureRuntime(handle.agent.session, handle.agent);
    assert.equal((await compatible.whenReady('os-legacy')).mode, 'ready');
    assert.equal(compatible.baselineOf('os-legacy').state, 'disabled');
    assert.deepEqual(runtime.alwaysNames, [HIDDEN]);
    queueResponse({ text: 'after toggle' });
    await turn(handle, 'Continue without compact.');
    assert.equal(store.requests.length, 2);
    assert.ok(namesOf(store.requests[1]).includes(HIDDEN));
    const denied = await boot.ctx.tools.execute({ agent: handle.agent, callId: 'os-denied', name: 'fixture_mutating', arguments: {}, signal: new AbortController().signal });
    assert.equal(denied.isError, true, '关闭严格模式不允许猜名执行未加载工具');
    assert.equal(store.bodyCount('os-denied'), 0);
  } finally { await handle?.dispose(); await boot.dispose(); }
});

test('OS2: 无 storageDomain 默认仍能请求；关闭初始注入只留发现入口，加载仍生效', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapterSchema: true, omitStorage: true, adapter: { alwaysVisible: [HIDDEN], initialToolsEnabled: false } });
  let handle;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    handle = await agent(boot, 'os-no-storage');
    queueResponse({ toolCalls: [{ id: 'os-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
    queueResponse({ toolCalls: [{ id: 'os-use', name: HIDDEN, arguments: { text: 'ok' } }] });
    queueResponse({ text: 'done' });
    await turn(handle, 'Load and use a tool.');
    assert.equal(store.requests.length, 3);
    assert.deepEqual(namesOf(store.requests[0]).sort(), ['tool_list', 'tool_load', 'tool_search']);
    assert.ok(namesOf(store.requests[1]).includes(HIDDEN));
    assert.equal(store.bodyCount('os-use'), 1);
    assert.equal(boot.ctx.get('progressiveDiscovery').lifecycle.baselineOf('os-no-storage').state, 'disabled');
  } finally { await handle?.dispose(); await boot.dispose(); }
});

test('OS3: 初始注入开关走 volatile 更新，不改变正在运行的周期；新会话采用新值', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapterSchema: true, omitStorage: true, adapter: { alwaysVisible: [HIDDEN] } });
  const handles = [];
  try {
    const first = await agent(boot, 'os-first'); handles.push(first);
    queueResponse({ text: 'first' }); await turn(first, 'First.');
    const entry = entryOf(boot);
    const originalFiber = entry.fiber;
    await entry.update({ config: { ...entry.options.config, initialToolsEnabled: false } });
    await boot.loader.await();
    assert.equal(entry.fiber, originalFiber, 'volatile 更新不重挂载');
    assert.equal(entry.fiber.config.initialToolsEnabled.get(), false);
    queueResponse({ text: 'same epoch' }); await turn(first, 'Again.');
    assert.ok(namesOf(store.requests[1]).includes(HIDDEN), '旧周期保持已披露名单');
    const second = await agent(boot, 'os-second'); handles.push(second);
    queueResponse({ text: 'new epoch' }); await turn(second, 'New session.');
    assert.equal(namesOf(store.requests[2]).includes(HIDDEN), false);
    assert.ok(namesOf(store.requests[2]).includes('tool_load'));
  } finally { for (const handle of handles.reverse()) await handle.dispose(); await boot.dispose(); }
});

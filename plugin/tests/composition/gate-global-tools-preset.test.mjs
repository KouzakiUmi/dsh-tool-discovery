import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const { store, queueResponse } = await import('../../fixtures/mock-store.mjs');
const TOOL_A = 'fixture_preset_a';
const TOOL_B = 'fixture_preset_b';
const fixture = new URL('./fixtures/preset-tool.mjs', import.meta.url).href;
async function boot(config = {}) {
  const host = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'], adapterSchema: true,
    adapter: { alwaysVisible: [], initialToolsEnabled: false, ...config },
    extraServices: [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'test-a' } }],
  });
  for (const [id, name] of [['test-a', TOOL_A], ['test-b', TOOL_B]]) {
    await host.loader.create({ id, name: '@deepseek-ai/dsh-agent-preset', config: { id, plugins: [{ id: 'preset-tool', name: fixture, config: { name } }] } });
  }
  await host.loader.await();
  assert.deepEqual(host.activationErrors(), []);
  return host;
}
const choicesOf = host => host.loader.entries().find(entry => entry.id === 'progressive-discovery').fiber.runtime.Config.dict.alwaysVisible.meta.initialToolChoices;
async function create(host, id, preset = 'test-a') {
  return host.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: host.tmpRoot }, setup: async ctx => { await host.ctx.agentPresets.mount(ctx, preset); } });
}
async function turn(handle) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise tool visibility.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}

test('GP1: 应用全局目录在没有会话/runtime 时包含已加载 preset 的工具', async () => {
  const host = await boot();
  try {
    assert.equal(host.ctx.get('progressiveDiscovery').sessions.size, 0);
    assert.equal(host.ctx.tools.get(TOOL_A), undefined, 'preset 工具并非 host-global 层注册');
    const choices = choicesOf(host).map(row => row.name);
    assert.ok(choices.includes(TOOL_A), '全局目录不能漏掉预加载 preset A');
    assert.ok(choices.includes(TOOL_B), '全局目录包含所有已登记 preset，不看当前会话');
  } finally { await host.dispose(); }
});

test('GP5: 全局登记状态不受单会话工具屏蔽或发现状态影响，preset 卸载后更新目录', async () => {
  const host = await boot(); let handle;
  try {
    handle = await create(host, 'gp-filtered');
    const life = host.ctx.get('progressiveDiscovery').lifecycle;
    life.ensureRuntime(handle.agent.session, handle.agent); await life.whenReady('gp-filtered');
    handle.agent.ctx.tools.restrict({ deny: ['fixture_hidden_inherited'] });
    assert.equal(host.ctx.tools.get('fixture_hidden_inherited', handle.agent), undefined);
    assert.ok(choicesOf(host).some(row => row.name === 'fixture_hidden_inherited'), '会话限制不改变全局已登记状态');
    const meta = host.loader.entries().find(entry => entry.id === 'progressive-discovery').fiber.runtime.Config.dict.alwaysVisible.meta;
    assert.deepEqual(meta.toolDirectory, { scope: 'application', complete: true });
    await host.loader.entries().find(entry => entry.id === 'test-b').update({ disabled: true });
    await host.loader.await();
    assert.equal(choicesOf(host).some(row => row.name === TOOL_B), false, '卸载无人使用的 preset 后，不保留陈旧 runtime 名单');
    assert.ok(choicesOf(host).some(row => row.name === TOOL_A));
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP2: 默认放行当前绑定 preset，不授予其它 preset 或普通 scoped 工具', async () => {
  store.reset(); const host = await boot(); let handle;
  try {
    handle = await create(host, 'gp-default');
    queueResponse({ toolCalls: [{ id: 'gp-use-a', name: TOOL_A, arguments: { text: 'ok' } }] });
    queueResponse({ text: 'done' }); await turn(handle);
    assert.equal(store.requests.length, 2);
    const names = store.requests[0].tools.map(tool => tool.name);
    assert.ok(names.includes(TOOL_A));
    assert.equal(names.includes(TOOL_B), false);
    assert.equal(names.includes('fixture_hidden_scope'), false, '普通会话工具不是 preset 权威名单');
    assert.equal(store.bodyCount('gp-use-a'), 1);
    assert.deepEqual(host.ctx.get('progressiveDiscovery').sessions.get('gp-default').alwaysNames, [TOOL_A]);
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP6: preset 放行不覆盖原生 deny，也不授予全局目录里的另一 preset', async () => {
  store.reset(); const host = await boot(); let handle;
  try {
    handle = await create(host, 'gp-native-deny');
    handle.agent.ctx.tools.restrict({ deny: [TOOL_A] });
    const life = host.ctx.get('progressiveDiscovery').lifecycle;
    life.ensureRuntime(handle.agent.session, handle.agent); await life.whenReady('gp-native-deny');
    assert.deepEqual(life.baselineOf('gp-native-deny').names, []);
    for (const [name, callId] of [[TOOL_A, 'gp-native-denied'], [TOOL_B, 'gp-foreign-denied']]) {
      const denied = await host.ctx.tools.execute({ agent: handle.agent, name, callId, arguments: { text: 'guess' }, signal: new AbortController().signal });
      assert.equal(denied.isError, true); assert.equal(store.bodyCount(callId), 0);
    }
    assert.ok(choicesOf(host).some(row => row.name === TOOL_A), '原生 deny 不改变全局登记事实');
    queueResponse({ text: 'done' }); await turn(handle);
    assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), ['tool_list', 'tool_load', 'tool_search']);
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP3: 关闭 preset 放行后仍可正常 load/use，未 load 的直连调用拒绝', async () => {
  store.reset(); const host = await boot({ alwaysAllowPresetTools: false }); let handle;
  try {
    handle = await create(host, 'gp-off');
    const life = host.ctx.get('progressiveDiscovery').lifecycle;
    life.ensureRuntime(handle.agent.session, handle.agent); await life.whenReady('gp-off');
    const denied = await host.ctx.tools.execute({ agent: handle.agent, name: TOOL_A, callId: 'gp-denied', arguments: { text: 'guess' }, signal: new AbortController().signal });
    assert.equal(denied.isError, true); assert.equal(store.bodyCount('gp-denied'), 0);
    queueResponse({ toolCalls: [{ id: 'gp-load', name: 'tool_load', arguments: { names: [TOOL_A] } }] });
    queueResponse({ toolCalls: [{ id: 'gp-use-loaded', name: TOOL_A, arguments: { text: 'loaded' } }] });
    queueResponse({ text: 'done' }); await turn(handle);
    assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), ['tool_list', 'tool_load', 'tool_search']);
    assert.equal(store.bodyCount('gp-use-loaded'), 1);
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP4: 严格模式也记录 preset 基线；开关 volatile 更新不改变本周期，新会话采用关闭', async () => {
  store.reset(); const host = await boot({ requireTrustedEpoch: true }); const handles = [];
  try {
    const first = await create(host, 'gp-strict'); handles.push(first);
    queueResponse({ text: 'baseline' }); await turn(first);
    const life = host.ctx.get('progressiveDiscovery').lifecycle;
    assert.equal(life.baselineOf('gp-strict').state, 'trusted');
    assert.deepEqual(life.baselineOf('gp-strict').names, [TOOL_A]);
    const entry = host.loader.entries().find(entry => entry.id === 'progressive-discovery');
    const fiber = entry.fiber;
    await entry.update({ config: { ...entry.options.config, alwaysAllowPresetTools: false } }); await host.loader.await();
    assert.equal(entry.fiber, fiber);
    queueResponse({ text: 'same' }); await turn(first);
    assert.ok(store.requests[1].tools.some(tool => tool.name === TOOL_A));
    const second = await create(host, 'gp-after-off'); handles.push(second);
    queueResponse({ text: 'new' }); await turn(second);
    assert.equal(store.requests[2].tools.some(tool => tool.name === TOOL_A), false);
  } finally { for (const handle of handles.reverse()) await handle.dispose(); await host.dispose(); }
});

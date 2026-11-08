// rc.1 admission + mask：保留应用目录、当前 preset 常驻、原生 deny 和显式 load/use 覆盖。
// 旧 GP4 的可信基线/周期采用没有等价目标（epoch 子系统已删除）；改测 volatile 不重挂载及新会话配置。
// 两条 rc.1 补充分支与 GP6/GP3 同目标，合并而非重复；无 legacy wire/基线断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition, executeToolCall, liveConfigOf } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const { store, queueResponse } = await import('../../fixtures/mock-store.mjs');
const TOOL_A = 'fixture_preset_a';
const TOOL_B = 'fixture_preset_b';
const ENTRIES = ['tool_list', 'tool_load', 'tool_search', 'tool_unload'];
const fixture = new URL('./fixtures/preset-tool.mjs', import.meta.url).href;
async function boot(config = {}) {
  const host = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'], adapterSchema: true,
    adapter: { alwaysVisible: [], initialToolsEnabled: false, ...config },
    extraServices: [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'test-a' } }],
  });
  try {
    assert.deepEqual(host.activationErrors(), []);
    for (const [id, name] of [['test-a', TOOL_A], ['test-b', TOOL_B]]) {
      await host.loader.create({ id, name: '@deepseek-ai/dsh-agent-preset', config: { id, plugins: [{ id: 'preset-tool', name: fixture, config: { name } }] } });
    }
    await host.loader.await();
    assert.deepEqual(host.activationErrors(), []);
    return host;
  } catch (error) { await host.dispose(); throw error; }
}
const entryOf = host => host.loader.entries().find(entry => entry.id === 'progressive-discovery');
const choicesOf = host => entryOf(host).fiber.runtime.Config.dict.alwaysVisible.meta.initialToolChoices;
async function create(host, id, preset = 'test-a') {
  return host.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }, meta: { cwd: host.tmpRoot }, setup: async ctx => { await host.ctx.agentPresets.mount(ctx, preset); } });
}
async function turn(handle) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise tool visibility.' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}
function call(host, handle, name, callId, args = { text: 'guess' }) {
  return executeToolCall(host.ctx, { agent: handle.agent, name, callId, arguments: args, signal: new AbortController().signal });
}
function runtimeFor(host, handle) {
  return host.ctx.get('progressiveDiscovery').lifecycle.runtimeFor(handle.agent.session, handle.agent);
}

test('GP1: 无会话/runtime 时应用目录包含全部已加载 preset 工具', async () => {
  const host = await boot();
  try {
    assert.equal(host.ctx.get('progressiveDiscovery').sessions.size, 0);
    assert.equal(host.ctx.tools.get(TOOL_A), undefined, 'preset 不是 host-global 注册');
    const names = choicesOf(host).map(row => row.name);
    assert.ok(names.includes(TOOL_A));
    assert.ok(names.includes(TOOL_B));
    for (const entry of ENTRIES) assert.equal(names.includes(entry), false);
  } finally { await host.dispose(); }
});

test('GP5: 会话限制/admission 不改变全局登记；preset 卸载更新目录', async () => {
  const host = await boot(); let handle;
  try {
    handle = await create(host, 'gp-filtered');
    runtimeFor(host, handle);
    handle.agent.ctx.tools.restrict({ deny: ['fixture_hidden_inherited'] });
    assert.equal(host.ctx.tools.get('fixture_hidden_inherited', handle.agent), undefined);
    assert.ok(choicesOf(host).some(row => row.name === 'fixture_hidden_inherited'));
    assert.deepEqual(entryOf(host).fiber.runtime.Config.dict.alwaysVisible.meta.toolDirectory, { scope: 'application', complete: true });
    await host.loader.entries().find(entry => entry.id === 'test-b').update({ disabled: true });
    await host.loader.await();
    assert.equal(choicesOf(host).some(row => row.name === TOOL_B), false);
    assert.ok(choicesOf(host).some(row => row.name === TOOL_A));
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP2: 当前 preset 常驻可见可执行；不授予另一 preset 或普通 own-scope 工具', async () => {
  store.reset(); const host = await boot(); let handle;
  try {
    handle = await create(host, 'gp-default');
    runtimeFor(host, handle);
    queueResponse({ toolCalls: [{ id: 'gp-use-a', name: TOOL_A, arguments: { text: 'ok' } }] });
    queueResponse({ text: 'done' }); await turn(handle);
    assert.equal(store.requests.length, 2);
    const names = store.requests[0].tools.map(tool => tool.name);
    assert.ok(names.includes(TOOL_A));
    assert.equal(names.includes(TOOL_B), false);
    assert.ok(names.includes('fixture_hidden_scope'), 'own-scope 是不可掩码的宿主边界');
    for (const entry of ENTRIES) assert.ok(names.includes(entry));
    assert.equal(store.bodyCount('gp-use-a'), 1);
    assert.deepEqual([...runtimeFor(host, handle).alwaysNameSet], [TOOL_A], '仅当前 preset 纳入常驻豁免');
    assert.equal((await call(host, handle, 'fixture_hidden_scope', 'gp-own-unloaded')).isError, true);
    assert.equal(store.bodyCount('gp-own-unloaded'), 0);
    assert.equal((await call(host, handle, TOOL_B, 'gp-foreign-unloaded')).isError, true);
    assert.equal(store.bodyCount('gp-foreign-unloaded'), 0);
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP6: 常驻 preset 不覆盖后来原生 deny，也不授予其它 preset', async () => {
  store.reset(); const host = await boot(); let handle;
  try {
    handle = await create(host, 'gp-native-deny');
    runtimeFor(host, handle);
    queueResponse({ text: 'before deny' }); await turn(handle);
    assert.ok(store.requests[0].tools.some(tool => tool.name === TOOL_A), '限制前确实可见');
    handle.agent.ctx.tools.restrict({ deny: [TOOL_A] });
    for (const [name, id] of [[TOOL_A, 'gp-native-denied'], [TOOL_B, 'gp-foreign-denied']]) {
      assert.equal((await call(host, handle, name, id)).isError, true);
      assert.equal(store.bodyCount(id), 0);
    }
    assert.ok(choicesOf(host).some(row => row.name === TOOL_A));
    queueResponse({ text: 'after deny' }); await turn(handle);
    assert.deepEqual(store.requests[1].tools.map(tool => tool.name).sort(), ['fixture_hidden_scope', ...ENTRIES].sort());
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP3: 关闭 preset 常驻后需 load，下一步 use；普通 own-scope 不随之授权', async () => {
  store.reset(); const host = await boot({ alwaysAllowPresetTools: false }); let handle;
  try {
    handle = await create(host, 'gp-off');
    runtimeFor(host, handle);
    assert.equal((await call(host, handle, TOOL_A, 'gp-denied')).isError, true);
    assert.equal(store.bodyCount('gp-denied'), 0);
    queueResponse({ toolCalls: [{ id: 'gp-load', name: 'tool_load', arguments: { names: [TOOL_A] } }] });
    queueResponse({ toolCalls: [{ id: 'gp-use-loaded', name: TOOL_A, arguments: { text: 'loaded' } }] });
    queueResponse({ text: 'done' }); await turn(handle);
    assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), ['fixture_hidden_scope', ...ENTRIES].sort());
    assert.ok(store.requests[1].tools.some(tool => tool.name === TOOL_A));
    assert.equal(store.bodyCount('gp-use-loaded'), 1);
    assert.equal(host.ctx.get('progressiveDiscovery').tracker.get('gp-off', TOOL_B), undefined);
    assert.equal((await call(host, handle, 'fixture_hidden_scope', 'gp-still-own-denied')).isError, true);
    assert.equal(store.bodyCount('gp-still-own-denied'), 0);
  } finally { await handle?.dispose(); await host.dispose(); }
});

test('GP4: preset 开关 volatile 不重挂载；新会话采用关闭值且仍能显式加载', async () => {
  store.reset(); const host = await boot(); const handles = [];
  try {
    const first = await create(host, 'gp-before-off'); handles.push(first);
    runtimeFor(host, first);
    queueResponse({ text: 'before' }); await turn(first);
    assert.ok(store.requests[0].tools.some(tool => tool.name === TOOL_A));
    const entry = entryOf(host);
    const fiber = entry.fiber;
    await entry.update({ config: { ...entry.options.config, alwaysAllowPresetTools: false } }); await host.loader.await();
    assert.equal(entry.fiber, fiber);
    assert.equal(liveConfigOf(entry).alwaysAllowPresetTools.get(), false);
    const second = await create(host, 'gp-after-off'); handles.push(second);
    runtimeFor(host, second);
    queueResponse({ toolCalls: [{ id: 'gp-new-load', name: 'tool_load', arguments: { names: [TOOL_A] } }] });
    queueResponse({ toolCalls: [{ id: 'gp-new-use', name: TOOL_A, arguments: { text: 'loaded' } }] });
    queueResponse({ text: 'done' }); await turn(second);
    assert.equal(store.requests[1].tools.some(tool => tool.name === TOOL_A), false);
    assert.equal(store.bodyCount('gp-new-use'), 1);
  } finally { for (const handle of handles.reverse()) await handle.dispose(); await host.dispose(); }
});

// rc.1 admission + mask：真实 Loader/agent/provider，存储只写测试私有目录。
// 旧 OS1 严格可信基线开关/缺记录 blocked 没有等价目标：子系统已删除；改测旧键不阻断请求。
// OS2 保留无存储的会话内 load/use，并覆盖第四入口 unload；OS3 保留 volatile 和新会话采用配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition, executeToolCall, liveConfigOf } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';

const HIDDEN = 'fixture_hidden_inherited';
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools'];
const ENTRIES = ['tool_list', 'tool_load', 'tool_search', 'tool_unload'];
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
function call(boot, handle, name, callId, args = {}) {
  return executeToolCall(boot.ctx, { agent: handle.agent, name, callId, arguments: args, signal: new AbortController().signal });
}

for (const requireTrustedEpoch of [false, true]) test(`OS1: 旧严格配置 ${requireTrustedEpoch} 不要求历史凭证、不阻断请求或授予隐藏工具`, async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapterSchema: true,
    adapter: { alwaysVisible: [], requireTrustedEpoch, requireTrustedEpochForSubagents: true } });
  let handle;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    handle = await agent(boot, `os-deprecated-${requireTrustedEpoch}`);
    queueResponse({ text: 'continue without legacy records' });
    await turn(handle, 'Continue.');
    assert.equal(store.requests.length, 1, '旧键不创建请求屏障');
    assert.deepEqual(namesOf(store.requests[0]).sort(), ['fixture_hidden_scope', ...ENTRIES].sort());
    const history = await boot.ctx.sessionQuery.readSession(handle.agent.session.id);
    assert.ok(history.events.some(event => event.type === 'request/header'), '真实出站正控制');
    const life = boot.ctx.get('progressiveDiscovery').lifecycle;
    life.runtimeFor(handle.agent.session, handle.agent);
    const denied = await call(boot, handle, 'fixture_mutating', 'os-denied');
    assert.equal(denied.isError, true);
    assert.equal(store.bodyCount('os-denied'), 0);
    queueResponse({ toolCalls: [{ id: 'os-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
    queueResponse({ toolCalls: [{ id: 'os-use', name: HIDDEN, arguments: { text: 'ok' } }] });
    queueResponse({ text: 'done' });
    await turn(handle, 'Load and use.');
    assert.equal(store.bodyCount('os-use'), 1, '旧配置也不妨碍正常 admission');
  } finally { await handle?.dispose(); await boot.dispose(); }
});

test('OS2: 无 storageDomain 时仍可请求、load/use/unload；own-scope 可见但未加载不可执行', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapterSchema: true, omitStorage: true,
    adapter: { alwaysVisible: [HIDDEN], initialToolsEnabled: false } });
  let handle;
  try {
    assert.deepEqual(boot.activationErrors(), []);
    handle = await agent(boot, 'os-no-storage');
    const service = boot.ctx.get('progressiveDiscovery');
    service.lifecycle.runtimeFor(handle.agent.session, handle.agent);
    const own = await call(boot, handle, 'fixture_hidden_scope', 'os-unloaded-own', { text: 'guess' });
    assert.equal(own.isError, true);
    assert.equal(store.bodyCount('os-unloaded-own'), 0);
    queueResponse({ toolCalls: [{ id: 'os-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
    queueResponse({ toolCalls: [{ id: 'os-use', name: HIDDEN, arguments: { text: 'ok' } }] });
    queueResponse({ toolCalls: [{ id: 'os-unload', name: 'tool_unload', arguments: { names: [HIDDEN] } }] });
    queueResponse({ text: 'done' });
    await turn(handle, 'Load, use, then unload a tool.');
    assert.equal(store.requests.length, 4);
    assert.deepEqual(namesOf(store.requests[0]).sort(), ['fixture_hidden_scope', ...ENTRIES].sort());
    assert.ok(namesOf(store.requests[1]).includes(HIDDEN), '下一步增加声明');
    assert.equal(store.bodyCount('os-use'), 1);
    assert.equal(namesOf(store.requests[3]).includes(HIDDEN), false, 'unload 后新请求无该声明');
    assert.equal(service.tracker.get('os-no-storage', HIDDEN), undefined);
    assert.equal((await call(boot, handle, HIDDEN, 'os-after-unload', { text: 'guess' })).isError, true);
    assert.equal(store.bodyCount('os-after-unload'), 0);
  } finally { await handle?.dispose(); await boot.dispose(); }
});

test('OS3: 初始注入开关 volatile 更新不重挂载；新会话不 seed 关闭的名单', async () => {
  store.reset();
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapterSchema: true, omitStorage: true, adapter: { alwaysVisible: [HIDDEN] } });
  const handles = [];
  try {
    assert.deepEqual(boot.activationErrors(), []);
    const first = await agent(boot, 'os-first'); handles.push(first);
    boot.ctx.get('progressiveDiscovery').lifecycle.runtimeFor(first.agent.session, first.agent);
    queueResponse({ text: 'first' }); await turn(first, 'First.');
    assert.ok(namesOf(store.requests[0]).includes(HIDDEN));
    const entry = entryOf(boot);
    const originalFiber = entry.fiber;
    await entry.update({ config: { ...entry.options.config, initialToolsEnabled: false } });
    await boot.loader.await();
    assert.equal(entry.fiber, originalFiber);
    assert.equal(liveConfigOf(entry).initialToolsEnabled.get(), false);
    assert.deepEqual(liveConfigOf(entry).alwaysVisible.get(), [HIDDEN], '关闭不删除配置名单');
    const second = await agent(boot, 'os-second'); handles.push(second);
    boot.ctx.get('progressiveDiscovery').lifecycle.runtimeFor(second.agent.session, second.agent);
    queueResponse({ text: 'new session' }); await turn(second, 'New session.');
    assert.equal(namesOf(store.requests[1]).includes(HIDDEN), false);
    assert.deepEqual(namesOf(store.requests[1]).sort(), ['fixture_hidden_scope', ...ENTRIES].sort());
    assert.equal(boot.ctx.get('progressiveDiscovery').tracker.get('os-second', HIDDEN), undefined);
    assert.equal((await call(boot, second, HIDDEN, 'os-second-guess', { text: 'guess' })).isError, true);
    assert.equal(store.bodyCount('os-second-guess'), 0);
  } finally { for (const handle of handles.reverse()) await handle.dispose(); await boot.dispose(); }
});

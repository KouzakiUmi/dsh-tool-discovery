// rc.1 设置门禁：真实 Schema + Loader + agent + mock provider，测试私有存储。
// SG1–5 保留配置解析、替换语义、四入口、活目录与新会话采用；SG8–10 保留预算形状/默认值。
// 旧 SG5 frozen wire、SG6/7 canonical/可信周期/压缩换名单无等价目标：这些子系统已删除。
// SG6/7 改测有效目标：真实自动/手动压缩不撤 admission、不阻断主请求、不回写已发送声明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { dshModule } from '../../contracts/install-resolver.mjs';
import { bootAdapterComposition, liveConfigOf, createNativeTestAgent } from './harness.mjs';
import { store, queueResponse } from '../../fixtures/mock-store.mjs';
import { CORE_TOOL_NAMES } from '../../domain/core-tools.mjs';
import { DEFAULT_BUDGETS, OPTIONAL_LIMIT_KEYS, ENTRY_TOOL_NAMES } from '../../domain/index.mjs';

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const HIDDEN = 'fixture_hidden_inherited';
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));
const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'));
function entryOf(comp) { return comp.loader.entries().find(entry => entry.id === 'progressive-discovery'); }
function serviceOf(comp) { return comp.ctx.get('progressiveDiscovery'); }
const ownedHandles = new WeakMap();
async function boot(t, adapter = {}, options = {}, invalid = false) {
  const comp = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'], adapterSchema: true, adapter, ...options });
  const handles = [];
  ownedHandles.set(comp, handles);
  t.after(async () => {
    for (const handle of handles.reverse()) await handle.dispose();
    await comp.closeServices();
    await comp.dispose();
  });
  if (!invalid) assert.deepEqual(comp.activationErrors(), []);
  return comp;
}
async function runtimeFor(t, comp, sessionId) {
  const handle = await createNativeTestAgent(comp, sessionId);
  ownedHandles.get(comp).push(handle);
  const runtime = serviceOf(comp).lifecycle.runtimeFor(handle.agent.session, handle.agent);
  return { handle, runtime };
}
async function turn(handle, text = 'Exercise settings.') {
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
  await handle.agent.whenIdle();
}
function choicesOf(comp) { return entryOf(comp).fiber.runtime.Config.dict.alwaysVisible.meta.initialToolChoices.map(row => row.name); }

test('SG1: Config 在首次解析前存在，alwaysVisible 是 volatile 引用', async t => {
  const comp = await boot(t);
  const entry = entryOf(comp);
  assert.ok(entry.fiber.runtime.Config);
  const live = liveConfigOf(entry).alwaysVisible;
  assert.equal(typeof live.get, 'function');
  assert.deepEqual(live.get(), [...CORE_TOOL_NAMES]);
});

test('SG2/SG3: 默认核心名单为替换语义；显式 [] 保留四入口但不自动授权隐藏工具', async t => {
  store.reset();
  const defaultComp = await boot(t);
  assert.deepEqual(serviceOf(defaultComp).currentAlwaysVisible(), [...CORE_TOOL_NAMES]);
  const comp = await boot(t, { alwaysVisible: [], respectAlwaysVisible: true });
  assert.deepEqual(liveConfigOf(entryOf(comp)).alwaysVisible.get(), []);
  const { handle, runtime } = await runtimeFor(t, comp, 'sg-empty');
  assert.equal(runtime.alwaysNameSet.size, 0);
  assert.equal(serviceOf(comp).tracker.admissionsFor('sg-empty').size, 0);
  queueResponse({ text: 'only entries plus own-scope' }); await turn(handle);
  assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), ['fixture_hidden_scope', ...ENTRY_TOOL_NAMES].sort());
  for (const name of ENTRY_TOOL_NAMES) {
    assert.ok(comp.ctx.tools.get(name, handle.agent));
    assert.equal(runtime.alwaysNameSet.has(name), false, '入口不来自 alwaysVisible');
  }
});

test('SG4: 应用活目录包含真实 global/own 工具，排除四入口并随注册/移除刷新', async t => {
  const comp = await boot(t);
  const names = choicesOf(comp);
  assert.ok(names.includes(HIDDEN));
  assert.ok(names.includes('fixture_mutating'));
  for (const fixed of ENTRY_TOOL_NAMES) assert.equal(names.includes(fixed), false);
  assert.deepEqual(names, [...names].sort());
  assert.ok(comp.ctx.tools.get(HIDDEN), '目录非空的正控制');
  const { handle } = await runtimeFor(t, comp, 'sg-directory');
  assert.ok(comp.ctx.tools.get('fixture_hidden_scope', handle.agent));
  assert.ok(choicesOf(comp).includes('fixture_hidden_scope'));
  const dispose = comp.ctx.tools.register(defineTool({
    name: 'fixture_late_arrival', description: 'Registered after activation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => 'ok',
  }));
  try {
    assert.ok(choicesOf(comp).includes('fixture_late_arrival'));
    assert.ok(choicesOf(comp).includes('fixture_hidden_scope'));
  } finally { dispose(); }
  assert.equal(choicesOf(comp).includes('fixture_late_arrival'), false, '移除不留陈旧目录行');
});

test('SG5: volatile 名单变更不重挂载、不回写历史；新会话采用新名单', async t => {
  store.reset();
  const comp = await boot(t, { alwaysVisible: [HIDDEN], respectAlwaysVisible: true });
  const { handle: first } = await runtimeFor(t, comp, 'sg-live');
  queueResponse({ text: 'first' }); await turn(first);
  assert.ok(store.requests[0].tools.some(tool => tool.name === HIDDEN));
  assert.ok(serviceOf(comp).lifecycle.runtimeFor(first.agent.session, first.agent).alwaysNameSet.has(HIDDEN), '常驻名单直接保留披露/执行资格');
  const sentBefore = JSON.stringify(store.requests[0].tools);
  const entry = entryOf(comp);
  const fiber = entry.fiber;
  await entry.update({ config: { ...entry.options.config, alwaysVisible: ['fixture_mutating'] } });
  await comp.loader.await();
  assert.equal(entry.fiber, fiber);
  assert.deepEqual(liveConfigOf(entry).alwaysVisible.get(), ['fixture_mutating']);
  assert.equal(JSON.stringify(store.requests[0].tools), sentBefore);
  const { handle: second } = await runtimeFor(t, comp, 'sg-next');
  queueResponse({ text: 'new session' }); await turn(second);
  const names = store.requests[1].tools.map(tool => tool.name);
  assert.ok(names.includes('fixture_mutating'));
  assert.equal(names.includes(HIDDEN), false);
  assert.ok(serviceOf(comp).lifecycle.runtimeFor(second.agent.session, second.agent).alwaysNameSet.has('fixture_mutating'));
  assert.equal(serviceOf(comp).tracker.get('sg-next', HIDDEN), undefined);
});

function compactionServices(auto) {
  return [
    { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: {
      auto, thresholdRatio: 0.01, retainTokens: 128, headroomTokens: 1024, maxTokens: 256, compactionRetries: 0,
    } },
  ];
}
test('SG6: 旧 epoch 键不参与压缩；真实自动压缩不撤 admission、不要求重试', async t => {
  store.reset();
  // 旧 profile 里残留的已移除键：宿主非严格合并带过，插件忽略，压缩行为不受影响。
  const comp = await boot(t, { alwaysVisible: [], requireTrustedEpoch: true, requireTrustedEpochForSubagents: true }, {
    fixtures: ['mock-provider', 'inherited-tools'], extraServices: compactionServices(true),
  });
  const { handle } = await runtimeFor(t, comp, 'sg-auto');
  queueResponse({ toolCalls: [{ id: 'sg-auto-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
  queueResponse({ text: 'Earlier inspection. '.repeat(1000), usage: { inputTokens: 1000, outputTokens: 10000 } });
  await turn(handle, 'Inspect the earlier context. '.repeat(100));
  const admission = serviceOf(comp).tracker.get(handle.agent.session.id, HIDDEN);
  assert.ok(admission);
  const offset = store.requests.length;
  queueResponse({ text: 'Earlier inspection summarized.' });
  queueResponse({ text: 'Continue after compaction.' });
  await turn(handle, 'Continue.');
  const after = store.requests.slice(offset);
  assert.ok(after.some(request => request.purpose === 'compaction'), '真实自动压缩正控制');
  const main = after.filter(request => request.purpose !== 'compaction');
  assert.equal(main.length, 1, '压缩后继续主请求，不走旧 epoch 中止重试');
  assert.ok(main[0].tools.some(tool => tool.name === HIDDEN));
  assert.deepEqual(serviceOf(comp).tracker.get(handle.agent.session.id, HIDDEN), admission);
  assert.doesNotMatch(JSON.stringify(handle.agent.session.snapshotEvents()), /TOOL_EPOCH_UPDATED/);
});

test('SG7: 真实手动压缩不回写已发送数组；admission 继续可用', async t => {
  store.reset();
  const comp = await boot(t, { alwaysVisible: [] }, {
    fixtures: ['mock-provider', 'inherited-tools'], extraServices: compactionServices(false),
  });
  const { handle } = await runtimeFor(t, comp, 'sg-sent');
  queueResponse({ toolCalls: [{ id: 'sg-sent-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] });
  queueResponse({ text: 'Earlier inspection. '.repeat(500) });
  await turn(handle, 'Inspect the earlier context. '.repeat(500));
  let sent;
  const stop = comp.ctx.on('llm/stream', (request, next) => {
    if (request.purpose !== 'compaction') sent ??= request.tools;
    return next();
  });
  t.after(stop);
  queueResponse({ text: 'Loaded tool is available.' }); await turn(handle);
  assert.ok(sent.some(tool => tool.name === HIDDEN));
  const before = JSON.stringify(sent);
  const admission = serviceOf(comp).tracker.get('sg-sent', HIDDEN);
  assert.ok(admission);
  queueResponse({ text: 'Inspection summary.' });
  const result = await comp.ctx.get('compaction').compactNow(handle.agent, new AbortController().signal);
  assert.ok(result && result.shadowedSeqs.length > 0, '真实压缩成功且非空');
  assert.equal(JSON.stringify(sent), before);
  queueResponse({ toolCalls: [{ id: 'sg-sent-use', name: HIDDEN, arguments: { text: 'after compact' } }] });
  queueResponse({ text: 'done' }); await turn(handle);
  assert.equal(store.bodyCount('sg-sent-use'), 1);
  assert.deepEqual(serviceOf(comp).tracker.get('sg-sent', HIDDEN), admission);
  assert.equal(JSON.stringify(sent), before, '后续请求也不回写历史');
});

async function budgetsOf(t, adapter, id) {
  const comp = await boot(t, adapter);
  const { runtime } = await runtimeFor(t, comp, id);
  // budgets 已成 volatile（设置页可热改）：活配置上是 `{get()}` 引用，缺省时 .get() 仍是
  // undefined、显式 null 仍是 null。先解包再断言。
  const raw = liveConfigOf(entryOf(comp)).budgets;
  const resolved = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
  return { resolved, budgets: runtime.engine.getBudgets() };
}
test('SG8: 缺省和显式 budgets:null 均激活，硬限额默认关闭', async t => {
  const a = await budgetsOf(t, {}, 'sg-budget-omitted');
  assert.equal(a.resolved, undefined);
  assert.deepEqual(a.budgets, { ...DEFAULT_BUDGETS });
  const b = await budgetsOf(t, { budgets: null }, 'sg-budget-null');
  assert.equal(b.resolved, null);
  assert.deepEqual(b.budgets, { ...DEFAULT_BUDGETS });
  for (const key of OPTIONAL_LIMIT_KEYS) assert.equal(b.budgets[key], null);
});
test('SG9: 显式有效预算生效，其余硬限额仍关闭', async t => {
  const { resolved, budgets } = await budgetsOf(t, { budgets: { maxActiveTools: 3 } }, 'sg-budget-explicit');
  assert.deepEqual(resolved, { maxActiveTools: 3 });
  assert.equal(budgets.maxActiveTools, 3);
  for (const key of OPTIONAL_LIMIT_KEYS.filter(key => key !== 'maxActiveTools')) assert.equal(budgets[key], null);
});
test('SG10: 字符串 budgets 拒绝激活，不留下半激活服务', async t => {
  const comp = await boot(t, { budgets: '8' }, {}, true);
  assert.ok(entryOf(comp).fiber._error);
  assert.match(comp.activationErrors().join('\n'), /budgets|budget/i);
  assert.equal(serviceOf(comp), undefined);
});

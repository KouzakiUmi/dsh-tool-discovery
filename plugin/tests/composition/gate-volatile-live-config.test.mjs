// volatile 配置热改的组合门禁（真实 Loader + mock provider + 测试私有存储）。
//
// 关键不变量：宿主 Loader 的 volatile 写入**不重挂载**插件，只原地更新引用并发
// `loader/volatile-update`；而 `agent/pre-step` 在本步 toolSet 与发给模型的声明**定型之后**
// 才触发（宿主 preStep：tools.resolve → systemPrompt.assemble → waterfall agent/pre-step）。
// 因此插件必须在事件到达时就同步掩码/常驻名单/engine 配置，否则下一个请求会出现
// "声明里有却报 unknown tool、声明里没有又无法换取"的撕裂面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition, executeToolCall, liveConfigOf } from './harness.mjs';
import { dshModule } from '../../contracts/install-resolver.mjs';

const ENTRIES = ['tool_list', 'tool_load', 'tool_search', 'tool_unload'];
const HIDDEN = 'fixture_hidden_inherited';
const OWN = 'fixture_hidden_scope';
const fixture = new URL('./fixtures/preset-tool.mjs', import.meta.url).href;
const { store, queueResponse } = await import('../../fixtures/mock-store.mjs');
const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'));

const namesOf = request => request.tools.map(tool => tool.name);
const entryOf = host => host.loader.entries().find(entry => entry.id === 'progressive-discovery');

async function boot(config = {}) {
  const host = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapterSchema: true,
    adapter: { alwaysVisible: [], initialToolsEnabled: false, ...config },
    extraServices: [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'test-a' } }],
  });
  assert.deepEqual(host.activationErrors(), []);
  await host.loader.create({
    id: 'minimal', name: '@deepseek-ai/dsh-agent-preset',
    config: { id: 'minimal', plugins: [{ id: 'preset-tool', name: fixture, config: { name: 'fixture_preset_minimal' } }] },
  });
  await host.loader.await();
  return host;
}

async function create(host, id, preset = 'minimal') {
  return host.ctx.agents.create({
    sessionId: id,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: host.tmpRoot },
    setup: async ctx => { await host.ctx.agentPresets.mount(ctx, preset); },
  });
}

async function turn(handle) {
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'volatile probe' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
}

const call = (host, handle, name, callId, args = {}) =>
  executeToolCall(host.ctx, { agent: handle.agent, name, callId, arguments: args, signal: new AbortController().signal });

/** 热改一个 volatile 字段：宿主走 `_commitVolatile()`，不重挂载。 */
async function hotChange(host, patch) {
  const entry = entryOf(host);
  const fiber = entry.fiber;
  await entry.update({ config: { ...entry.options.config, ...patch } });
  await host.loader.await();
  assert.equal(entry.fiber, fiber, 'volatile 写入不得重挂载插件');
  return entry;
}

test('VC1: 停用→启用热改后，下一个请求的声明与门禁一致（消撕裂/死锁）', async () => {
  store.reset();
  const host = await boot();
  let handle;
  try {
    handle = await create(host, 'vc1');
    queueResponse({ text: 'inert' });
    await turn(handle);
    assert.equal(namesOf(store.requests[0]).some(n => ENTRIES.includes(n)), false, '初始处于停用场景');

    await hotChange(host, { disabledPresets: [] });

    // 关键：第 1 个请求就必须是新状态。此前 pre-step 才重算，这里仍是旧掩码，
    // 于是模型看到"入口不在声明里 + 未 load 的全局工具却可见"，且两边都调不动。
    queueResponse({ text: 'enabled' });
    await turn(handle);
    const names = namesOf(store.requests[1]);
    for (const entry of ENTRIES) assert.ok(names.includes(entry), `${entry} 应在热改后的第一个请求就披露`);
    assert.equal(names.includes(HIDDEN), false, '停用解除后受控全局工具仍须先 load，不得顺带披露');

    const listed = await call(host, handle, 'tool_list', 'vc1-list', {});
    assert.equal(listed.isError, false, '声明里出现的入口必须可执行（不得 unknown tool）');
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('VC2: 启用→停用热改后，原生工具立即恢复且入口一致消失', async () => {
  store.reset();
  const host = await boot({ disabledPresets: [] });
  let handle;
  try {
    handle = await create(host, 'vc2');
    queueResponse({ text: 'enabled' });
    await turn(handle);
    assert.ok(namesOf(store.requests[0]).includes('tool_list'), '初始为正常发现流程');

    await hotChange(host, { disabledPresets: ['minimal'] });

    queueResponse({ text: 'inert' });
    await turn(handle);
    const names = namesOf(store.requests[1]);
    for (const entry of ENTRIES) assert.equal(names.includes(entry), false, `${entry} 应随停用立即消失`);
    assert.ok(names.includes(HIDDEN), '停用后原生全局工具应恢复可见且可直接调用');

    const inherited = await call(host, handle, HIDDEN, 'vc2-inherited', { text: 'x' });
    assert.equal(inherited.isError, false, '停用场景不得要求 admission');
    assert.equal(store.bodyCount('vc2-inherited'), 1);
    const guessed = await call(host, handle, 'tool_list', 'vc2-list', {});
    assert.equal(guessed.isError, true, '入口在停用场景不可派发');
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('VC3: alwaysVisible 热改在下一个请求生效（既有 volatile 字段同源受益）', async () => {
  store.reset();
  // initialToolsEnabled 必须为真，否则手动常驻名单按设计不生效，测不到热改路径；
  // 同时走正常发现流程（停用场景不遮罩，HIDDEN 本来就可见，测不出名单变化）。
  const host = await boot({ initialToolsEnabled: true, disabledPresets: [] });
  let handle;
  try {
    handle = await create(host, 'vc3');
    queueResponse({ text: 'before' });
    await turn(handle);
    assert.equal(namesOf(store.requests[0]).includes(HIDDEN), false);

    await hotChange(host, { alwaysVisible: [HIDDEN] });
    queueResponse({ text: 'after' });
    await turn(handle);
    assert.ok(namesOf(store.requests[1]).includes(HIDDEN), '常驻名单热改应在下一个请求生效');
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('VC4: gateOwnScopeTools 热改后新建 runtime 采用新值（此前读 apply 期快照，永不生效）', async () => {
  store.reset();
  const host = await boot({ gateOwnScopeTools: false, disabledPresets: [] });
  const handles = [];
  try {
    const before = await create(host, 'vc4-before');
    handles.push(before);
    const runtimeBefore = host.ctx.get('progressiveDiscovery').lifecycle.runtimeFor(before.agent.session, before.agent);
    assert.equal(runtimeBefore.gateOwnScope, false, '初始采用 apply 期配置');

    await hotChange(host, { gateOwnScopeTools: true });
    assert.equal(liveConfigOf(entryOf(host)).gateOwnScopeTools.get(), true, '活配置已更新');

    const after = await create(host, 'vc4-after');
    handles.push(after);
    const runtimeAfter = host.ctx.get('progressiveDiscovery').lifecycle.runtimeFor(after.agent.session, after.agent);
    assert.equal(runtimeAfter.gateOwnScope, true, '新 runtime 必须采用设置页的新值');

    // 开闸方向是安全相关的：新会话里 own-scope 未准入工具必须被拦。
    const denied = await call(host, after, OWN, 'vc4-own');
    assert.equal(denied.isError, true, 'gateOwnScopeTools=true 时 own-scope 未准入工具必须拒绝');
    assert.equal(store.bodyCount('vc4-own'), 0);
  } finally {
    for (const handle of handles.reverse()) await handle?.dispose();
    await host.dispose();
  }
});

test('VC5: locale 热改重建四个入口文案（不需要重载）', async () => {
  const host = await boot({ locale: 'en', disabledPresets: [] });
  let handle;
  try {
    const entry = entryOf(host);
    const before = host.ctx.tools.get('tool_list').description;
    assert.match(before, /[A-Za-z]/, '前置：英文文案');

    await hotChange(host, { locale: 'zh' });
    const after = host.ctx.tools.get('tool_list').description;
    assert.notEqual(after, before, '热改语言必须重建入口 definition 的文案');
    assert.match(after, /[\u4e00-\u9fff]/, '中文文案应已生效');
    assert.ok(entry.fiber !== undefined, '不得重挂载');

    // 重建后入口仍可正常派发（同名重注册未留下坏状态）。
    handle = await create(host, 'vc5');
    const listed = await call(host, handle, 'tool_list', 'vc5-list', {});
    assert.equal(listed.isError, false, '重建后的入口必须可执行');
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('VC6: budgets / categoryConfig 热改进入运行中的 engine', async () => {
  store.reset();
  const host = await boot({ disabledPresets: [] });
  let handle;
  try {
    handle = await create(host, 'vc6');
    const runtime = host.ctx.get('progressiveDiscovery').lifecycle.runtimeFor(handle.agent.session, handle.agent);
    assert.equal(runtime.engine.getBudgets().maxActiveTools, null, '默认硬限额关闭');

    await hotChange(host, { budgets: { maxActiveTools: 1 } });
    assert.equal(runtime.engine.getBudgets().maxActiveTools, 1, '运行中的 engine 必须采纳新预算');

    // 生效验证：超过 maxActiveTools=1 的批量 load 必须被拒。
    queueResponse({ toolCalls: [{ id: 'vc6-load', name: 'tool_load', arguments: { names: [HIDDEN, OWN] } }] });
    queueResponse({ text: 'done' });
    await turn(handle);
    const loaded = await host.ctx.sessionQuery.readSession(handle.agent.session.id);
    const receipt = loaded.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e)).join('\n');
    assert.match(receipt, /BUDGET_EXCEEDED/, '新预算必须在运行中生效');
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

test('VC7: 一个畸形绑定不得毒化目录（新会话仍可创建、注册不被打断）', async () => {
  const host = await boot({ disabledPresets: [] });
  let handle;
  try {
    // 宿主 register() 只校验 name/output/timeoutMs，接受 parameters 为数组的定义；
    // domain 的 validateBinding 会拒绝它。适配层必须在边界处跳过，而不是让它把
    // buildCatalog 打挂（否则全体新会话创建失败）。
    const bad = await import('./fixtures/bad-parameters-tool.mjs');
    const dispose = host.ctx.tools.register(bad.badParametersDefinition());
    try {
      await host.loader.await();
      handle = await create(host, 'vc7');
      assert.ok(handle?.agent !== undefined, '坏绑定不得阻止新会话创建');
      const service = host.ctx.get('progressiveDiscovery');
      assert.ok(service.sessions.has('vc7'), 'runtime 必须正常建立');
      // 适配层只在**插件目录**里跳过它；宿主注册表不是本插件的地盘，不改写。
      const catalog = service.lifecycle.runtimeFor(handle.agent.session, handle.agent).engine.getCatalog();
      const listed = [...(catalog.entries?.keys?.() ?? [])].map(id => catalog.entries.get(id)?.name);
      assert.equal(listed.includes('probe_bad_parameters'), false, '坏绑定不得进入插件目录');
      assert.ok(listed.length > 0, '其余工具仍应正常进入目录');
    } finally { dispose(); }
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
});

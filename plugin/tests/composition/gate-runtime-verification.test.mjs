// plugin/tests/composition/gate-runtime-verification.test.mjs
// 方案 1 集成测试：运行时装载自证（动态识别与验证实际装载的核心工具，解决冲突）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootAdapterComposition } from './harness.mjs';
import { CORE_TOOL_NAMES } from '../../domain/index.mjs';

const handles = [];
after(() => { for (const dispose of handles.reverse()) dispose(); });

async function boot(adapterConfig) {
  const handle = await bootAdapterComposition({
    fixtures: ['inherited-tools', 'scope-tools'],
    adapter: adapterConfig ?? {},
    adapterSchema: true,
  });
  handles.push(handle.dispose);
  return handle;
}

function serviceOf(ctx) {
  return ctx.get('progressiveDiscovery');
}

function fakeSession(id) {
  return { id, seq: 0, inheritedEventCount: 0, header: { cwd: 'C:\\' } };
}

test('RV1: 当配置遗漏核心工具但 scope 实际装载时，运行时自证自动将其识别为常驻', async () => {
  // 模拟配置被修改，仅配置了 bash，遗漏了 subagent
  const { ctx } = await boot({ alwaysVisible: ['bash'] });
  
  // 模拟在 agent scope 上动态挂载 subagent (CORE_TOOL_NAMES 之一)
  const agentScope = { id: 'agent-rv1' };
  ctx.tools.register({
    name: 'subagent',
    description: 'delegate to subagent',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'subagent executed',
  }, agentScope);

  const lifecycle = serviceOf(ctx).lifecycle;
  const runtime = lifecycle.ensureRuntime(fakeSession('s-rv1'), agentScope);
  const settled = await lifecycle.whenReady('s-rv1');
  assert.equal(settled.mode, 'ready');

  // 断言：subagent 必须被运行时装载自证识别并纳入 alwaysNames
  assert.ok(runtime.alwaysNames.includes('subagent'), 'subagent 必须被自动识别并常驻');
  assert.ok(runtime.alwaysNames.includes('bash'), '原配置项 bash 保持常驻');

  // guard 验证：调用 subagent 必须直接放行（返回 undefined，不报 TOOL_NOT_LOADED）
  const callResult = await ctx.tools.execute({
    agent: { id: 'agent-rv1', session: fakeSession('s-rv1') },
    name: 'subagent',
    callId: 'call-subagent-1',
    arguments: {},
    signal: new AbortController().signal,
  });
  assert.equal(callResult.isError, false, '调用 subagent 必须成功，不报 TOOL_NOT_LOADED');
});

test('RV2: 非 CORE_TOOL_NAMES 的第三方工具不被自省补全，保持按需发现', async () => {
  const { ctx } = await boot({ alwaysVisible: ['bash'] });
  const agentScope = { id: 'agent-rv2' };

  // 显式注册到该 scope：`scope-tools` fixture 挂在 agent/created 上，而本用例从不创建真 agent ——
  // 所以过去 `ctx.tools.get('fixture_hidden_scope', agentScope)` 其实是 undefined，
  // "未被补入常驻名单"与"调用被拒"两条断言都因此失去检出力（自省本来就只挑 CORE_TOOL_NAMES）。
  ctx.tools.register({
    name: 'fixture_hidden_scope',
    description: 'non-core fixture',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'hidden executed',
  }, agentScope);

  const lifecycle = serviceOf(ctx).lifecycle;
  const runtime = lifecycle.ensureRuntime(fakeSession('s-rv2'), agentScope);
  await lifecycle.whenReady('s-rv2');

  assert.notEqual(ctx.tools.get('fixture_hidden_scope', agentScope), undefined,
    '前置：非核心 fixture 必须真的注册到该 scope，否则下面的断言全是空转');
  // fixture_hidden_scope 不得被加入 alwaysNames
  assert.ok(!runtime.alwaysNames.includes('fixture_hidden_scope'), '非核心工具不得误入常驻名单');

  // 直接调用未 load 的第三方工具必须被 guard 拦截 (TOOL_NOT_LOADED)
  const denied = await ctx.tools.execute({
    agent: { id: 'agent-rv2', session: fakeSession('s-rv2') },
    name: 'fixture_hidden_scope',
    callId: 'call-denied-1',
    arguments: { text: 'guess' },
    signal: new AbortController().signal,
  });
  assert.equal(denied.isError, true);
  assert.ok(String(denied.error?.message || denied.result).includes('TOOL_NOT_LOADED'));
});

test('RV3: guard 动态自证兜底：核心工具即便由于初始化时机漏进 alwaysNameSet 也予以放行', async () => {
  const { ctx } = await boot({ alwaysVisible: ['bash'] });
  const agentScope = { id: 'agent-rv3' };

  const lifecycle = serviceOf(ctx).lifecycle;
  const runtime = lifecycle.ensureRuntime(fakeSession('s-rv3'), agentScope);
  await lifecycle.whenReady('s-rv3');

  // 在 runtime 创建之后，动态注册 subagent_fork
  ctx.tools.register({
    name: 'subagent_fork',
    description: 'fork agent',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'forked',
  }, agentScope);

  // 此时 runtime.alwaysNameSet 尚无 subagent_fork
  assert.ok(!runtime.alwaysNameSet.has('subagent_fork'));

  // 直接调用 subagent_fork 时，guard 动态自证其为装载的核心工具并放行
  const callResult = await ctx.tools.execute({
    agent: { id: 'agent-rv3', session: fakeSession('s-rv3') },
    name: 'subagent_fork',
    callId: 'call-fork-1',
    arguments: {},
    signal: new AbortController().signal,
  });
  assert.equal(callResult.isError, false, '动态装载的核心工具调用必须直接放行');
  assert.ok(runtime.alwaysNameSet.has('subagent_fork'), '调用后自证并加入 alwaysNameSet');
});

// ---------------------------------------------------------------------------
// 开关 respectAlwaysVisible（默认关闭 = 现状；打开后 alwaysVisible 是**上限**）
//
// 默认模式下 DSH 自带工具会被"运行时装载自证"自动并入常驻名单，且不经 load 即可执行
// （RV1/RV3）。这带来"配置无法收窄核心工具"的语义落差。作者的决策是**做成开关、默认关闭、
// 选择权在用户**，于是 RV4/RV5 钉住开关打开后的另一半语义。
// ---------------------------------------------------------------------------

/** 在给定 scope 上注册若干**核心同名**工具（CORE_TOOL_NAMES 之一），供 RV4/RV5 使用。 */
function registerCoreFixtures(ctx, agentScope, names) {
  for (const name of names) {
    ctx.tools.register({
      name,
      description: `${name} fixture`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => `${name} executed`,
    }, agentScope);
  }
}

test('RV4: respectAlwaysVisible 打开后，未列出的核心工具既不并集也不免披露放行', async () => {
  const { ctx } = await boot({ alwaysVisible: ['bash'], respectAlwaysVisible: true });
  const agentScope = { id: 'agent-rv4' };
  registerCoreFixtures(ctx, agentScope, ['bash', 'subagent']);

  const lifecycle = serviceOf(ctx).lifecycle;
  const runtime = lifecycle.ensureRuntime(fakeSession('s-rv4'), agentScope);
  await lifecycle.whenReady('s-rv4');

  assert.ok(runtime.alwaysNames.includes('bash'), '正控制：配置里列出的核心工具仍然常驻');
  assert.equal(runtime.alwaysNames.includes('subagent'), false,
    '开关打开后，未列出的核心工具不得被自证并入常驻名单');

  const denied = await ctx.tools.execute({
    agent: { id: 'agent-rv4', session: fakeSession('s-rv4') },
    name: 'subagent',
    callId: 'call-rv4-deny',
    arguments: {},
    signal: new AbortController().signal,
  });
  assert.equal(denied.isError, true, '开关打开后，未披露的核心工具也必须先 load');
  assert.match(String(denied.error?.message ?? denied.result), /TOOL_NOT_LOADED/,
    '拒绝理由必须是「未披露」，而不是「核心工具一律拒绝」');

  // 正控制：名单内的核心工具照常放行 —— 收窄的是"未列出的"，不是"核心工具全体"
  const allowed = await ctx.tools.execute({
    agent: { id: 'agent-rv4', session: fakeSession('s-rv4') },
    name: 'bash',
    callId: 'call-rv4-allow',
    arguments: {},
    signal: new AbortController().signal,
  });
  assert.equal(allowed.isError, false, '名单内的核心工具必须照常执行');

  // 解锁闭环：README 承诺"被拒之后模型 load 一次即可"。这条通路必须被测到 —— 否则开关打开后
  // 若 load→折叠→再执行 这条链对核心名有 bug，会**真死锁**而所有门禁依然全绿。
  const op = 'op_call-rv4-load';
  const loaded = await runtime.engine.handleLoad({ names: ['subagent'] }, runtime.scope, { operationId: op });
  assert.equal(loaded.response.ok, true,
    `被拒的核心工具必须能通过普通 tool_load 加载（这是解锁路径的第一段）：${JSON.stringify(loaded.response.error)}`);
  runtime.engine.applyCanonicalPair({
    seq: 1,
    call: { operationId: op, tool: 'tool_load', input: { names: ['subagent'] } },
    result: { isError: false, ok: true, payload: loaded.response.data.receipt },
  }, runtime.scope);

  const engineState = runtime.engine.getState(runtime.scope);
  assert.equal(engineState.selected.size, 1,
    'load 折叠后 subagent 必须进入 selected —— 它是下一轮披露与执行的依据');

  // 诚实边界：完整的"再执行成功"还需要一次**真实出站**把 selected 变成 advertised
  // （`state.mjs` 的 evaluateCall 要求 `advertised.requestId` 匹配当前请求），那需要驱动一个真实
  // agent 轮次。本用例覆盖到 load→折叠这一段；出站披露面由 GP/SG 系列与 gate-adapter 覆盖。
  // 这条边界同时记在 plugin/docs/11-code-review-findings.md。
});

test('RV5: respectAlwaysVisible 打开后，显式空名单对核心工具也是真的', async () => {
  const { ctx } = await boot({ alwaysVisible: [], respectAlwaysVisible: true });
  const agentScope = { id: 'agent-rv5' };
  // 关键：当前 scope **确实装载**了核心工具。默认模式下它们会被自证并入 —— 这正是
  // SG2/SG3 过去无法检验的情形（那两个用例的 fixture 里没有任何核心同名工具，属空转通过）。
  registerCoreFixtures(ctx, agentScope, ['bash', 'write']);

  // 前置：fixture 用的名字必须**仍然**是核心工具名，而且**真的注册到了**这个 scope。
  // 缺了这两条，下面的 deepEqual 会静默空转 —— 变异证据：把 core-tools.mjs 里的
  // 'bash' / 'write' 删掉之后，本用例此前仍然全绿（alwayNames 本来就是空的）。
  assert.ok(CORE_TOOL_NAMES.includes('bash') && CORE_TOOL_NAMES.includes('write'),
    '前置：fixture 的名字必须仍在 CORE_TOOL_NAMES 里，否则本用例恒真');
  assert.notEqual(ctx.tools.get('bash', agentScope), undefined, '前置：fixture 必须真的注册到该 scope');
  assert.notEqual(ctx.tools.get('write', agentScope), undefined, '前置：fixture 必须真的注册到该 scope');

  const lifecycle = serviceOf(ctx).lifecycle;
  const runtime = lifecycle.ensureRuntime(fakeSession('s-rv5'), agentScope);
  await lifecycle.whenReady('s-rv5');

  assert.deepEqual(runtime.alwaysNames, [],
    '开关打开后，显式空名单必须连当前可见的核心工具一起排除（这才是「真的清空」）');

  // 执行层必须单独钉一次：RV5 上面的名单层断言在 **guard 侧**回归时仍然是绿的
  // （变异证据：只去掉 guard 的开关判断，RV5 依旧通过）。空名单 + 开关打开 ⇒ 即使该核心工具
  // 已经注册在这个 scope 上，也必须先 load。
  const denied = await ctx.tools.execute({
    agent: { id: 'agent-rv5', session: fakeSession('s-rv5') },
    name: 'bash',
    callId: 'call-rv5-deny',
    arguments: {},
    signal: new AbortController().signal,
  });
  assert.equal(denied.isError, true, '空名单下，已注册的核心工具也必须先 load 才能执行');
  assert.match(String(denied.error?.message ?? denied.result), /TOOL_NOT_LOADED/);
});

test('RV6: 同一组 fixture 在默认模式下必须被自证并入（RV5 的正控制）', async () => {
  // 没有这条对照，RV5 的"空名单"也可能只是因为 fixture 压根没生效 —— 那正是 SG2/SG3 的事故形态。
  const { ctx } = await boot({ alwaysVisible: [] }); // 不传 respectAlwaysVisible ⇒ 默认 false
  const agentScope = { id: 'agent-rv6' };
  registerCoreFixtures(ctx, agentScope, ['bash', 'write']);

  const lifecycle = serviceOf(ctx).lifecycle;
  const runtime = lifecycle.ensureRuntime(fakeSession('s-rv6'), agentScope);
  await lifecycle.whenReady('s-rv6');

  assert.ok(runtime.alwaysNames.includes('bash') && runtime.alwaysNames.includes('write'),
    '默认模式下，显式空名单仍会被自证并入当前可见的核心工具（这是 RV5 的对照面）');
});

test('RV7: 开关打开时，出站披露的工具集同样只含配置里列出的核心工具', async () => {
  // 投影管线本身不读这个开关（alwaysNames 是唯一数据通道），所以这条是"防止未来在投影层
  // 误加分支"的钉子：三个观测面（名单层 RV4/RV5、执行层 RV4/RV5、**出站披露**）都要被钉住。
  const { ctx } = await boot({ alwaysVisible: ['bash'], respectAlwaysVisible: true });
  const agentScope = { id: 'agent-rv7' };
  registerCoreFixtures(ctx, agentScope, ['bash', 'subagent']);

  const session = fakeSession('s-rv7');
  const lifecycle = serviceOf(ctx).lifecycle;
  lifecycle.ensureRuntime(session, agentScope);
  await lifecycle.whenReady('s-rv7');

  // dsh-agent-loop 注册的 provider/model/cwd 三个 prompt variable 要读 agent.options 与
  // session.header.cwd，走真实 assemble 就必须给全（与 gate-settings 的 assembleContext 同形状）。
  const assembled = await ctx.systemPrompt.assemble({
    agent: { id: 'agent-rv7', session, options: { provider: 'fixture-mock', model: 'fixture-model' } },
    scope: { id: 'agent-rv7' },
  });
  const names = (assembled.tools ?? []).map((t) => t.name);

  assert.ok(names.includes('bash'), `配置里列出的核心工具必须被披露，实际：${JSON.stringify(names)}`);
  assert.equal(names.includes('subagent'), false,
    '未列出的核心工具不得出现在出站工具集里（开关打开 ⇒ 名单就是上限）');
  for (const entry of ['tool_list', 'tool_search', 'tool_load']) {
    assert.ok(names.includes(entry), `${entry} 必须恒在`);
  }
});


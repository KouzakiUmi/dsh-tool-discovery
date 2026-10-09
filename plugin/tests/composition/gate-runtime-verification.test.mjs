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

  // fixture_hidden_scope 已经在 scope-tools fixture 中注册于 scope
  const lifecycle = serviceOf(ctx).lifecycle;
  const runtime = lifecycle.ensureRuntime(fakeSession('s-rv2'), agentScope);
  await lifecycle.whenReady('s-rv2');

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

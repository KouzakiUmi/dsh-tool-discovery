// rc.1 运行时装载自证：保留核心自证/显式常驻上限、执行与真实请求三观测面。
// 旧 canonical 提交与 advertised 凭证无等价目标；改用 await handleLoad +
// commitAdmissions，并用真实下一请求及执行正控制完成解锁闭环。
import test from 'node:test'
import assert from 'node:assert/strict'
import { bootAdapterComposition, executeToolCall, createNativeTestAgent } from './harness.mjs'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { store, queueResponse } from '../../fixtures/mock-store.mjs'
import { CORE_TOOL_NAMES, ENTRY_TOOL_NAMES } from '../../domain/index.mjs'

async function boot(t, adapter = {}, names = []) {
  const comp = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'], adapter, adapterSchema: true })
  t.after(async () => { await comp.closeServices(); comp.dispose() })
  assert.ok(comp.ctx.get('progressiveDiscovery'), comp.activationErrors().join('\n'))
  for (const name of names) register(comp.ctx, name)
  return comp
}
function register(ctx, name) {
  return ctx.tools.register({ name, description: `${name} fixture`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => `${name} executed` })
}
async function create(t, comp, id) {
  const handle = await createNativeTestAgent(comp, id)
  t.after(() => handle.dispose())
  const service = comp.ctx.get('progressiveDiscovery')
  const runtime = service.lifecycle.runtimeFor(handle.agent.session, handle.agent)
  assert.deepEqual(await service.whenReady(id), { mode: 'ready' })
  return { handle, service, runtime }
}
const call = (comp, handle, name, callId) => executeToolCall(comp.ctx, { agent: handle.agent, name, callId, arguments: {}, signal: new AbortController().signal })
const errorText = result => String(result.error?.message ?? result.result ?? result.content?.map(block => block.text ?? '').join(''))
async function turn(handle) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Begin.' }] }))
  await handle.agent.whenIdle()
}

test('RV1: 实际装载的核心工具补入 alwaysNameSet，配置项仍常驻且无需 load', async t => {
  const comp = await boot(t, { alwaysVisible: ['bash'] }, ['bash', 'subagent'])
  assert.ok(CORE_TOOL_NAMES.includes('subagent'))
  const { handle, runtime } = await create(t, comp, 'rv1')
  assert.ok(runtime.alwaysNameSet.has('subagent'))
  assert.ok(runtime.alwaysNameSet.has('bash'))
  assert.equal((await call(comp, handle, 'subagent', 'rv1-use')).isError, false)
})

test('RV2: 非核心 own-scope 工具真实可见但不被自证，未 admission 拒执行', async t => {
  const comp = await boot(t, { alwaysVisible: ['bash'] })
  const { handle, runtime } = await create(t, comp, 'rv2')
  assert.ok(comp.ctx.tools.get('fixture_hidden_scope', handle.agent), 'fixture 必须真实存在')
  assert.ok(comp.ctx.tools.view(handle.agent).visible.has('fixture_hidden_scope'), 'own-scope 声明不可遮')
  assert.equal(runtime.alwaysNameSet.has('fixture_hidden_scope'), false)
  const denied = await executeToolCall(comp.ctx, { agent: handle.agent, name: 'fixture_hidden_scope', callId: 'rv2-deny', arguments: { text: 'guess' }, signal: new AbortController().signal })
  assert.equal(denied.isError, true)
  assert.match(errorText(denied), /not admitted|tool_load/i)
})

test('RV3: runtime 后动态装载核心工具由 guard 自证放行', async t => {
  const comp = await boot(t, { alwaysVisible: ['bash'] })
  const { handle, runtime } = await create(t, comp, 'rv3')
  assert.equal(runtime.alwaysNameSet.has('subagent_fork'), false)
  const dispose = register(handle.agent.ctx, 'subagent_fork')
  t.after(dispose)
  assert.ok(CORE_TOOL_NAMES.includes('subagent_fork'))
  assert.ok(comp.ctx.tools.get('subagent_fork', handle.agent))
  assert.equal((await call(comp, handle, 'subagent_fork', 'rv3-fork')).isError, false)
})

test('RV4: respectAlwaysVisible 收窄核心工具，普通 admission 路径能解除门禁', async t => {
  const comp = await boot(t, { alwaysVisible: ['bash'], respectAlwaysVisible: true }, ['bash', 'subagent'])
  const { handle, service, runtime } = await create(t, comp, 'rv4')
  assert.ok(runtime.alwaysNameSet.has('bash'))
  assert.equal(runtime.alwaysNameSet.has('subagent'), false)
  assert.equal((await call(comp, handle, 'subagent', 'rv4-deny')).isError, true)
  assert.equal((await call(comp, handle, 'bash', 'rv4-allow')).isError, false)
  const loaded = await runtime.engine.handleLoad({ names: ['subagent'] }, runtime.scope)
  assert.equal(loaded.response.ok, true, JSON.stringify(loaded.response))
  assert.deepEqual(loaded.admitted.map(row => row.name), ['subagent'])
  assert.equal(runtime.engine.selectedOf('rv4').size, 1, 'handleLoad 已立即接纳，无回执折叠')
  service.lifecycle.commitAdmissions(runtime, loaded.admitted)
  assert.ok(service.tracker.get('rv4', 'subagent'))
  store.reset(); queueResponse({ text: 'admitted' })
  await turn(handle)
  assert.equal(store.requests.length, 1)
  assert.ok(store.requests[0].tools.some(tool => tool.name === 'subagent'))
  assert.equal((await call(comp, handle, 'subagent', 'rv4-after')).isError, false)
  const unloaded = await runtime.engine.handleUnload({ names: ['subagent'] }, runtime.scope)
  assert.equal(unloaded.response.ok, true)
  service.lifecycle.revokeAdmissions(runtime, unloaded.revoked)
  assert.equal(service.tracker.get('rv4', 'subagent'), undefined)
  assert.equal((await call(comp, handle, 'subagent', 'rv4-revoked')).isError, true)
})

test('RV5: 显式空名单+respectAlwaysVisible 对实际装载核心工具也为空', async t => {
  const comp = await boot(t, { alwaysVisible: [], respectAlwaysVisible: true }, ['bash', 'write'])
  assert.ok(CORE_TOOL_NAMES.includes('bash') && CORE_TOOL_NAMES.includes('write'))
  const { handle, runtime } = await create(t, comp, 'rv5')
  assert.ok(comp.ctx.tools.get('bash'), 'global 注册确实存在，不能对已被掩码的 agent get 作存在性断言')
  assert.ok(comp.ctx.tools.get('write'))
  assert.deepEqual([...runtime.alwaysNameSet], [])
  assert.equal((await call(comp, handle, 'bash', 'rv5-deny')).isError, true)
})

test('RV6: 默认模式下同一核心 fixture 组自证常驻（RV5 正控制）', async t => {
  const comp = await boot(t, { alwaysVisible: [] }, ['bash', 'write'])
  const { handle, runtime } = await create(t, comp, 'rv6')
  assert.ok(runtime.alwaysNameSet.has('bash') && runtime.alwaysNameSet.has('write'))
  assert.equal((await call(comp, handle, 'bash', 'rv6-allow')).isError, false)
})

test('RV7: 真实请求只披露常驻上限内核心工具及四入口，执行面一致', async t => {
  store.reset()
  const comp = await boot(t, { alwaysVisible: ['bash'], respectAlwaysVisible: true }, ['bash', 'subagent'])
  const { handle } = await create(t, comp, 'rv7')
  queueResponse({ text: 'baseline' })
  await turn(handle)
  assert.equal(store.requests.length, 1)
  const names = store.requests[0].tools.map(tool => tool.name)
  assert.ok(names.includes('bash'))
  assert.equal(names.includes('subagent'), false)
  assert.equal(names.includes('fixture_hidden_inherited'), false)
  for (const name of ENTRY_TOOL_NAMES) assert.ok(names.includes(name))
  assert.equal(ENTRY_TOOL_NAMES.length, 4)
  assert.equal((await call(comp, handle, 'subagent', 'rv7-deny')).isError, true)
  assert.equal((await call(comp, handle, 'bash', 'rv7-allow')).isError, false)
})

test('RV8: gateOwnScopeTools=false 时 own-scope 无需 admission，global 仍受门禁', async t => {
  const comp = await boot(t, { alwaysVisible: [], gateOwnScopeTools: false, respectAlwaysVisible: true })
  const { handle, service } = await create(t, comp, 'rv8')
  assert.ok(comp.ctx.tools.view(handle.agent).visible.has('fixture_hidden_scope'))
  assert.equal(service.tracker.admissionsFor('rv8').size, 0)
  const own = await executeToolCall(comp.ctx, { agent: handle.agent, name: 'fixture_hidden_scope', callId: 'rv8-own', arguments: { text: 'opted out' }, signal: new AbortController().signal })
  assert.equal(own.isError, false, '显式关闭 own-scope gate 必须对 catalog 中的 own 工具也生效')
  const global = await executeToolCall(comp.ctx, { agent: handle.agent, name: 'fixture_hidden_inherited', callId: 'rv8-global', arguments: { text: 'still controlled' }, signal: new AbortController().signal })
  assert.equal(global.isError, true, 'own-scope 开关不能放开 global 池')
})

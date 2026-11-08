// rc.1 mask.mjs 等价契约：安装、admitted 披露、撤权遮蔽、第三方限制与会话隔离。
// 已删的逐字冻结 wire、epoch 屏障、SDK/provider 注入拦截无 rc.1 等价目标；
// 宿主拥有声明，本插件只控制 registry 掩码与 admission，不拦截任意 provider 声明。
import test from 'node:test'
import assert from 'node:assert/strict'
import { executeToolCall } from './harness.mjs'
import { setup, agentFor, turn, call, queueResponse, store, namesAt, resultFor, textOf, registerTool, entries } from './rc1-helpers.mjs'

test('rc.1 mask: global 隐藏、own 可见但未 admission 拒绝、load 下一步披露', async t => {
  const boot = await setup(t)
  const agent = await agentFor(t, boot, 'mask-admission')
  queueResponse({ toolCalls: [call('guess-global', 'fixture_hidden_inherited', { text: 'no' }), call('guess-own', 'fixture_hidden_scope', { text: 'no' })] })
  queueResponse({ toolCalls: [call('load-global', 'tool_load', { names: ['fixture_hidden_inherited'] }), call('same-step', 'fixture_hidden_inherited', { text: 'no' })] })
  queueResponse({ toolCalls: [call('next-step', 'fixture_hidden_inherited', { text: 'yes' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(store.requests.length, 4)
  assert.deepEqual(namesAt(0).sort(), [...entries, 'fixture_hidden_scope'].sort())
  assert.equal(namesAt(1).includes('fixture_hidden_inherited'), false)
  assert.equal(namesAt(2).includes('fixture_hidden_inherited'), true)
  for (const id of ['guess-global', 'guess-own', 'same-step']) assert.equal(store.bodyCount(id), 0, id)
  assert.match(textOf(resultFor(agent, 'guess-own')), /not admitted/)
  assert.equal(store.bodyCount('next-step'), 1)
  const discovery = boot.ctx.get('progressiveDiscovery')
  const filters = discovery.mask.filtersFor(agent)
  const installed = [...boot.ctx.tools.layers.peek(agent).restrictions.values()].filter(filter => filters.has(filter))
  assert.equal(installed.length, 1, 'exactly one current owned restriction remains installed after replacement')
  assert.ok(discovery.mask.ownedFilters().includes(installed[0]))
  assert.ok(discovery.tracker.get(agent.session.id, 'fixture_hidden_inherited'))
})

test('rc.1 mask: tool_unload 下一步撤销声明且执行拒绝，重新 load 恢复', async t => {
  const boot = await setup(t)
  const agent = await agentFor(t, boot, 'mask-unload')
  queueResponse({ toolCalls: [call('load', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ toolCalls: [call('before', 'fixture_hidden_inherited', { text: 'yes' }), call('unload', 'tool_unload', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ toolCalls: [call('revoked', 'fixture_hidden_inherited', { text: 'no' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(namesAt(1).includes('fixture_hidden_inherited'), true)
  assert.equal(namesAt(2).includes('fixture_hidden_inherited'), false)
  assert.equal(store.bodyCount('before'), 1)
  assert.equal(store.bodyCount('revoked'), 0)
  assert.equal(boot.ctx.get('progressiveDiscovery').tracker.get(agent.session.id, 'fixture_hidden_inherited'), undefined)
  queueResponse({ toolCalls: [call('reload', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ toolCalls: [call('restored', 'fixture_hidden_inherited', { text: 'yes' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(store.bodyCount('restored'), 1)
})

test('rc.1 in-history: unload 后历史 schema 保留但 admission 已撤销', async t => {
  const boot = await setup(t)
  const agent = await agentFor(t, boot, 'mask-history', 'fixture-in-history')
  queueResponse({ toolCalls: [call('history-load', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ toolCalls: [call('history-before', 'fixture_hidden_inherited', { text: 'yes' }), call('history-unload', 'tool_unload', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ toolCalls: [call('history-after', 'fixture_hidden_inherited', { text: 'no' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(store.bodyCount('history-before'), 1)
  assert.equal(store.bodyCount('history-after'), 0)
  assert.equal(boot.ctx.tools.get('fixture_hidden_inherited', agent), undefined, 'current registry view is masked')
  assert.equal(namesAt(2).includes('fixture_hidden_inherited'), true, 'host route retains historical schema')
  assert.ok(store.requests[2].messages.some(m => JSON.stringify(m.content).includes('tool-removal')))
})

test('rc.1 mask: 外部限制不可绕过，自有掩码替换无反馈环', async t => {
  const boot = await setup(t)
  const agent = await agentFor(t, boot, 'mask-peer')
  const peer = agent.ctx.tools.restrict({ deny: ['fixture_mutating'] })
  t.after(peer)
  const discovery = boot.ctx.get('progressiveDiscovery')
  let changes = 0
  const stop = boot.ctx.on('tools/change', () => { changes++ })
  t.after(stop)
  queueResponse({ toolCalls: [call('load', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ text: 'loaded' })
  await turn(agent)
  assert.ok(changes < 12, `bounded own-mask events: ${changes}`)
  assert.equal(boot.ctx.tools.get('fixture_mutating', agent), undefined)
  const runtime = discovery.sessions.get(agent.session.id)
  assert.ok([...runtime.engine.getCatalog().entries.values()].some(e => e.name === 'fixture_hidden_inherited'), 'catalog ignores owned mask')
  assert.equal([...runtime.engine.getCatalog().entries.values()].some(e => e.name === 'fixture_mutating'), false, 'catalog respects peer restriction')
  await boot.adapterEntryState().fiber.dispose()
  assert.equal(discovery.mask.ownedFilters().length, 0)
  assert.ok(boot.ctx.tools.get('fixture_hidden_inherited', agent))
  assert.equal(boot.ctx.tools.get('fixture_mutating', agent), undefined)
})

test('rc.1 mask: 掩码事件内重入注册仍对齐所有会话目录', async t => {
  const boot = await setup(t)
  const first = await agentFor(t, boot, 'mask-reentrant-first')
  const second = await agentFor(t, boot, 'mask-reentrant-second')
  const { defineTool } = await import('../../contracts/install-resolver.mjs').then(async ({ dshModule }) => import(dshModule('@deepseek-ai/dsh-tools')))
  let remove
  let registered = false
  const stop = boot.ctx.on('tools/change', () => {
    if (registered) return
    registered = true
    remove = boot.ctx.tools.register(defineTool({ name: 'reentrant_target', description: 'registered within mask change', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => 'ok' }))
  })
  t.after(() => { stop(); remove?.() })
  queueResponse({ toolCalls: [call('load', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ text: 'done' })
  await turn(first)
  assert.equal(registered, true)
  const discovery = boot.ctx.get('progressiveDiscovery')
  for (const agent of [first, second]) {
    const runtime = discovery.sessions.get(agent.session.id)
    assert.ok([...runtime.engine.getCatalog().entries.values()].some(e => e.name === 'reentrant_target'))
    assert.equal(boot.ctx.tools.get('reentrant_target', agent), undefined, 'new registration remains masked until load')
  }
})

test('rc.1 mask: admission 按 session 隔离', async t => {
  const boot = await setup(t)
  const first = await agentFor(t, boot, 'mask-first')
  const second = await agentFor(t, boot, 'mask-second')
  queueResponse({ toolCalls: [call('load', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ text: 'loaded' })
  await turn(first)
  const offset = store.requests.length
  queueResponse({ toolCalls: [call('isolated-guess', 'fixture_hidden_inherited', { text: 'no' })] })
  queueResponse({ text: 'done' })
  await turn(second)
  assert.equal(namesAt(offset).includes('fixture_hidden_inherited'), false)
  assert.equal(store.bodyCount('isolated-guess'), 0)
  assert.equal(boot.ctx.get('progressiveDiscovery').tracker.admissionsFor(second.session.id).size, 0)
})

test('rc.1 mask: 换版拒绝旧 admission，重新 load 后下步执行新版', async t => {
  const boot = await setup(t)
  const executed = []
  let remove = await registerTool(boot.ctx, 'reload_target', 'first version', () => { executed.push('v1'); return 'v1' })
  t.after(() => remove())
  const agent = await agentFor(t, boot, 'mask-version')
  queueResponse({ toolCalls: [call('load-v1', 'tool_load', { names: ['reload_target'] })] })
  queueResponse({ toolCalls: [call('use-v1', 'reload_target')] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.deepEqual(executed, ['v1'])
  remove()
  remove = await registerTool(boot.ctx, 'reload_target', 'second version', () => { executed.push('v2'); return 'v2' })
  const offset = store.requests.length
  queueResponse({ toolCalls: [call('guess-v2', 'reload_target'), call('load-v2', 'tool_load', { names: ['reload_target'] })] })
  queueResponse({ toolCalls: [call('use-v2', 'reload_target')] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(namesAt(offset).includes('reload_target'), false)
  assert.deepEqual(executed, ['v1', 'v2'])
  assert.equal(resultFor(agent, 'guess-v2').isError, true)
  assert.equal(store.requests.at(-1).tools.find(t => t.name === 'reload_target').description, 'second version')
})

test('rc.1 guard: 四个 entry 被 own 同名覆盖时均拒绝执行', async t => {
  const boot = await setup(t)
  const agent = await agentFor(t, boot, 'mask-entry-shadow')
  let executions = 0
  for (const name of entries) {
    const remove = await registerTool(agent.ctx, name, 'shadow', () => { executions++; return 'shadow' })
    const result = await executeToolCall(boot.ctx, { agent, name, callId: `shadow-${name}`, arguments: {}, signal: new AbortController().signal })
    assert.equal(result.isError, true, name)
    assert.match(textOf(result), /shadowed/)
    remove()
  }
  assert.equal(executions, 0)
})

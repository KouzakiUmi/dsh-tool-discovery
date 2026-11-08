// rc.1 adapter 主链等价验收：四入口、审批不旁路、冲突整组回滚、白名单与候选。
// 已删 canonical 回执/advertised/journal 与出站 provider 冻结断言无等价目标；
// 两步调用及全局隐藏由 gate-rc1-native-restriction 的真实 toolSet 验证。
import test from 'node:test'
import assert from 'node:assert/strict'
import { bootAdapterComposition } from './harness.mjs'
import { setup, agentFor, turn, call, queueResponse, store, entries, payloadFor, resultFor, textOf } from './rc1-helpers.mjs'

test('adapter: 四个真实 typed entry 注册且不要求 sessionQuery 注入', async t => {
  const boot = await setup(t, { omitSessionQuery: true })
  assert.equal(boot.ctx.get('sessionQuery'), undefined)
  for (const name of entries) assert.ok(boot.ctx.tools.get(name), name)
  const agent = await agentFor(t, boot, 'entry-without-query')
  queueResponse({ toolCalls: [call('list', 'tool_list')] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(payloadFor(agent, 'list').ok, true)
  assert.deepEqual(await boot.ctx.get('progressiveDiscovery').whenReady(agent.session.id), { mode: 'ready' })
})

test('adapter: load 不旁路真实宿主审批', async t => {
  const boot = await setup(t, { fixtures: ['mock-provider', 'inherited-tools', 'approval-policy'] })
  const { queueApproval } = await import('./fixtures/approval-policy.mjs')
  const agent = await agentFor(t, boot, 'adapter-approval')
  queueResponse({ toolCalls: [call('load', 'tool_load', { names: ['fixture_mutating'] })] })
  queueResponse({ toolCalls: [call('approved-body', 'fixture_mutating', { text: 'yes' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(payloadFor(agent, 'load').ok, true)
  assert.equal(store.bodyCount('approved-body'), 1)
  queueApproval('rejected')
  queueResponse({ toolCalls: [call('denied-body', 'fixture_mutating', { text: 'no', triggerApproval: true })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.equal(store.bodyCount('denied-body'), 0)
  assert.equal(resultFor(agent, 'denied-body').isError, true)
  assert.match(textOf(resultFor(agent, 'denied-body')), /rejected/)
  const events = agent.session.snapshotEvents()
  assert.equal(events.filter(e => e.type === 'approval/asked').length, 1)
  assert.equal(events.filter(e => e.type === 'approval/decided' && e.data.outcome === 'rejected').length, 1)
})

test('adapter: 预先存在的 entry 冲突拒绝激活且不留其它入口', async t => {
  const boot = await bootAdapterComposition({ fixtures: ['mock-provider', 'conflict-entry'], adapter: {} })
  t.after(async () => { await boot.closeServices(); boot.dispose() })
  assert.match(boot.activationErrors().join('\n'), /INCOMPATIBLE_COMPOSITION/)
  assert.match(boot.ctx.tools.get('tool_search').description, /Third-party plugin/)
  for (const name of entries.filter(n => n !== 'tool_search')) assert.equal(boot.ctx.tools.get(name), undefined)
  assert.equal(boot.ctx.get('progressiveDiscovery'), undefined)
})

test('adapter: 无效预算激活失败回滚入口及 guard', async t => {
  const boot = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools'], adapter: { budgets: { maxActiveTools: 0 } } })
  t.after(async () => { await boot.closeServices(); boot.dispose() })
  assert.ok(boot.activationErrors().length > 0)
  for (const name of entries) assert.equal(boot.ctx.tools.get(name), undefined)
  const agent = await agentFor(t, boot, 'adapter-rollback')
  store.reset()
  queueResponse({ toolCalls: [call('no-orphan', 'fixture_hidden_inherited', { text: 'yes' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.ok(store.requests[0].tools.some(t => t.name === 'fixture_hidden_inherited'))
  assert.equal(store.bodyCount('no-orphan'), 1)
})

test('adapter: alwaysVisible 可执行且搜索 loaded，非白名单仍能 load', async t => {
  const boot = await setup(t, { adapter: { alwaysVisible: ['fixture_hidden_inherited'], respectAlwaysVisible: true, alwaysAllowPresetTools: false } })
  const agent = await agentFor(t, boot, 'adapter-whitelist')
  queueResponse({ toolCalls: [call('white-search', 'tool_search', { category: 'all', query: 'fixture_hidden_inherited' }), call('white-exec', 'fixture_hidden_inherited', { text: 'yes' })] })
  queueResponse({ toolCalls: [call('other-load', 'tool_load', { names: ['fixture_mutating'] })] })
  queueResponse({ toolCalls: [call('other-exec', 'fixture_mutating', { text: 'yes' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  assert.ok(store.requests[0].tools.some(t => t.name === 'fixture_hidden_inherited'))
  assert.equal(store.requests[0].tools.some(t => t.name === 'fixture_mutating'), false)
  assert.equal(payloadFor(agent, 'white-search').data.candidates.find(c => c.name === 'fixture_hidden_inherited').loaded, true)
  assert.equal(store.bodyCount('white-exec'), 1)
  assert.equal(store.bodyCount('other-exec'), 1)
})

// rc.1 等价替换：load body 成功即提交 admission，不再等待 canonical terminal 回执。
// 已删 pending reservation/journal 的取消回滚断言不适用；post policy 仍能阻止回执，
// 但不能撤销已提交的 admission。下步可见与执行取证替代旧 pending-size 断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, agentFor, turn, call, queueResponse, store, payloadFor } from './rc1-helpers.mjs'

for (const kind of ['success', 'post-block', 'user-cancel-after-body']) {
  test(`terminal rc.1: ${kind} 不回滚已提交 admission`, async t => {
    const boot = await setup(t, { fixtures: ['mock-provider', 'inherited-tools'] })
    const agent = await agentFor(t, boot, `terminal-${kind}`)
    let observed = false
    const remove = boot.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name === 'tool_load' && exec.callId === 'first') {
        assert.equal(JSON.parse(result.content.map(b => b.text ?? '').join('')).ok, true)
        observed = true
        if (kind === 'post-block') return { kind: 'block', feedback: [{ type: 'text', text: 'fixture post-policy rejection' }] }
        if (kind === 'user-cancel-after-body') exec.agent.cancel({ kind: 'user' })
      }
      return next()
    })
    t.after(remove)
    queueResponse({ toolCalls: [call('first', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
    if (kind !== 'user-cancel-after-body') queueResponse({ text: 'done' })
    await turn(agent)
    assert.equal(observed, true)
    const discovery = boot.ctx.get('progressiveDiscovery')
    assert.ok(discovery.tracker.get(agent.session.id, 'fixture_hidden_inherited'))
    assert.equal(discovery.sessions.get(agent.session.id).engine.getState({ sessionId: agent.session.id, actorId: agent.id }).selected.size, 1)
    queueResponse({ toolCalls: [call('next', 'fixture_hidden_inherited', { text: 'yes' })] })
    queueResponse({ text: 'done' })
    await turn(agent)
    assert.equal(store.bodyCount('next'), 1)
  })
}

test('list rc.1: 空请求导航，指定 category 省略 view 仍列工具', async t => {
  const boot = await setup(t)
  const agent = await agentFor(t, boot, 'list-default')
  queueResponse({ toolCalls: [call('navigate', 'tool_list'), call('names', 'tool_list', { category: 'all' })] })
  queueResponse({ text: 'done' })
  await turn(agent)
  const navigation = payloadFor(agent, 'navigate')
  assert.equal(navigation.ok, true)
  assert.ok(navigation.data.categories.length > 0)
  const names = payloadFor(agent, 'names')
  assert.equal(names.ok, true)
  assert.ok(JSON.stringify(names.data).includes('fixture_hidden_inherited'))
})

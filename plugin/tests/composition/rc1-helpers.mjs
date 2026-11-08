// rc.1 组合测试共用的真实宿主调用/事件取证，不伪造 admission。
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition } from './harness.mjs'
import { store, queueResponse } from '../../fixtures/mock-store.mjs'
export { store, queueResponse }
export const entries = ['tool_list', 'tool_search', 'tool_load', 'tool_unload']
export async function setup(t, options = {}) {
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'], adapter: { alwaysVisible: [], respectAlwaysVisible: true, alwaysAllowPresetTools: false }, ...options })
  t.after(async () => { await boot.closeServices(); boot.dispose() })
  assert.deepEqual(boot.activationErrors(), [])
  return boot
}
export async function agentFor(t, boot, sessionId, model = 'fixture-addition-only') {
  const handle = await boot.ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture-mock', model }, meta: { cwd: boot.tmpRoot } })
  t.after(() => handle.dispose())
  return handle.agent
}
export async function turn(agent, text = 'continue') {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
}
export function resultFor(agent, callId) {
  const events = agent.session.snapshotEvents()
  const call = events.find(e => e.type === 'tool/call' && e.data?.callId === callId)
  assert.ok(call, `tool/call ${callId}`)
  const result = events.find(e => e.type === 'tool/result' && e.sourceEventSeqs?.includes(call.seq))
  assert.ok(result, `tool/result ${callId}`)
  return result.data.message
}
export const textOf = message => message.content.map(b => b.text ?? '').join('')
export const payloadFor = (agent, id) => JSON.parse(textOf(resultFor(agent, id)))
export const namesAt = i => store.requests[i].tools.map(t => t.name)
export const call = (id, name, args = {}) => ({ id, name, arguments: args })
export async function registerTool(ctx, name, description, execute) {
  const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))
  return ctx.tools.register(defineTool({ name, description, parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }))
}

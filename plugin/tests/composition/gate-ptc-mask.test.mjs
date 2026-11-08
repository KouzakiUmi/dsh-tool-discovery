// rc.1 PTC 等价：SDK 直接消费宿主 definitions() 的掩码视图，无 ptcCompatibility/自建投影。
// 不执行真实 TS/Python worker；真实 provider PTC transport 不是本用例验收范围。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { setup, agentFor, turn, call, queueResponse } from './rc1-helpers.mjs'

for (const language of ['typescript', 'python']) test(`PTC ${language}: SDK 与 mask 同源，load 披露 unload 遮蔽`, async t => {
  const boot = await setup(t)
  const agent = await agentFor(t, boot, `ptc-mask-${language}`)
  const sdk = await import(dshModule('@deepseek-ai/dsh-tool-executor-ptc'))
  const render = language === 'python' ? sdk.renderToolsSdkPy : sdk.renderToolsSdk
  const sdkText = () => {
    const schemas = boot.ctx.tools.definitions(agent).map(definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters }))
    return JSON.stringify(render(schemas))
  }
  assert.equal(sdkText().includes('fixture_hidden_inherited'), false)
  queueResponse({ toolCalls: [call('load', 'tool_load', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ text: 'loaded' })
  await turn(agent)
  assert.equal(sdkText().includes('fixture_hidden_inherited'), true)
  queueResponse({ toolCalls: [call('unload', 'tool_unload', { names: ['fixture_hidden_inherited'] })] })
  queueResponse({ text: 'unloaded' })
  await turn(agent)
  assert.equal(sdkText().includes('fixture_hidden_inherited'), false)
})

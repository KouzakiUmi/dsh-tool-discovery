// 阶段0 mock LLM provider：只录制最终 LLM 请求（GenerateOptions）并按脚本回放响应。
// 遵守本机 0.2.1 stream 合同：tool-call arguments 保持 raw JSON 字符串；
// usage 在 finish 之前；每个流恰好一个终止 finish；finish 之后无任何事件。
// 录制面是 mock/GenerateOptions，不是外部真实 provider wire（后者未验证）。
import { dshModule } from '../contracts/install-resolver.mjs'
import { store } from './mock-store.mjs'

const { LlmAdapter } = await import(dshModule('@deepseek-ai/dsh-llm'))

function responseToChunks (response) {
  const chunks = []
  let index = 0
  for (const call of response.toolCalls ?? []) {
    const id = call.id ?? `call_${index}`
    const rawArguments = JSON.stringify(call.arguments ?? {})
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    chunks.push({ type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: rawArguments })
    chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: rawArguments } })
    index += 1
  }
  if (response.text !== undefined) {
    chunks.push({ type: 'block-start', index, blockType: 'text' })
    chunks.push({ type: 'text-delta', index, text: response.text })
    chunks.push({ type: 'block-end', index, block: { type: 'text', text: response.text } })
    index += 1
  }
  chunks.push({ type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

class MockAdapter extends LlmAdapter {
  providerInfo (provider) {
    return { id: provider, name: 'stage-0 fixture mock provider' }
  }

  resolveModel (provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 200000 }
    })
  }

  async * stream (options) {
    const { signal, ...rest } = options
    let snapshot
    try {
      snapshot = structuredClone(rest)
    } catch {
      snapshot = JSON.parse(JSON.stringify(rest))
    }
    store.requests.push(snapshot)
    const response = store.script.shift()
    if (response === undefined) throw new Error('mock provider: no scripted response queued')
    for (const chunk of responseToChunks(response)) yield chunk
  }
}

const apply = (ctx, config) => {
  ctx.llm.registerAdapter(['fixture-mock'], new MockAdapter())
}
apply.inject = ['llm']
export default apply

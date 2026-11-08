// rc.1 复审边界：存储延迟/失败不能阻断请求，也不能借旧 admission 放行。
// 旧 RB1/RB1b/RB4 的 sessionQuery 恢复等待与超时屏障已删除：改测 admission
// store 延迟 open 时立即 ready+全遮，真实读回后修正掩码。旧 RB2 incompatible
// 改为零准入+可重新 load；旧 RB3 incoming 重复投影不再归插件控制，改测宿主
// 同名覆盖四入口时拒执行（不能等价保留 provider 声明去重断言）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, createNativeTestAgent, executeToolCall } from './harness.mjs'
import { store, queueResponse } from '../../fixtures/mock-store.mjs'
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs'

const HIDDEN = 'fixture_hidden_inherited'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const namesOf = request => (request?.tools ?? []).map(tool => tool.name)
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 3000) })]) }
  finally { clearTimeout(timer) }
}
async function turn(handle, text = 'Continue.') {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await bounded(handle.agent.whenIdle(), 'provider turn must not wait for admission storage')
}
async function setup(t, id) {
  store.reset()
  const comp = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools'], adapter: {} })
  t.after(async () => { await comp.closeServices(); comp.dispose() })
  const service = comp.ctx.get('progressiveDiscovery')
  assert.ok(service, comp.activationErrors().join('\n'))
  const durable = service.tracker.holder.store
  assert.ok(durable)
  await durable.ensureOpen()
  const put = durable.put.bind(durable)
  const persisted = deferred()
  durable.put = async record => { const result = await put(record); if (record.sessionId === id) persisted.resolve(); return result }
  const handle = await createNativeTestAgent(comp, id)
  t.after(() => handle.dispose())
  queueResponse({ toolCalls: [{ id: `${id}-load`, name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ text: 'admitted' })
  await turn(handle)
  await bounded(persisted.promise, 'real admission put')
  assert.ok(namesOf(store.requests.at(-1)).includes(HIDDEN), '前置：已加载项真实披露')
  assert.ok(service.tracker.get(id, HIDDEN), '前置：真实 admission 存在')
  return { comp, handle }
}

for (const suffix of ['first', 'repeat']) {
  test(`RB1/${suffix}: admission open 挂起时立即 ready、请求全遮；释放后读回并执行`, async t => {
    const id = `rb-open-${suffix}`
    const { comp, handle } = await setup(t, id)
    const facility = comp.ctx.storageDomain
    const original = facility.open
    const entered = deferred(); const gate = deferred(); const seeded = deferred()
    facility.open = async function (...args) {
      entered.resolve()
      await gate.promise
      return original.apply(this, args)
    }
    t.after(() => { gate.resolve(); facility.open = original })
    await comp.adapterEntryState().fiber.restart()
    await bounded(entered.promise, 'real storage open entered')
    const service = comp.ctx.get('progressiveDiscovery')
    assert.ok(service)
    const runtime = service.lifecycle.runtimeFor(handle.agent.session, handle.agent)
    const originalSeed = runtime.engine.seedSelection.bind(runtime.engine)
    runtime.engine.seedSelection = (...args) => { const result = originalSeed(...args); seeded.resolve(result); return result }
    assert.deepEqual(await bounded(service.whenReady(id), 'immediate ready'), { mode: 'ready' })
    assert.equal(service.lifecycle.admittedNamesOf(id).size, 0)
    store.reset(); queueResponse({ toolCalls: [{ id: `${id}-guess`, name: HIDDEN, arguments: { text: 'while storage hangs' } }] }); queueResponse({ text: 'baseline works' })
    await turn(handle)
    assert.ok(store.requests.length > 0, '存储挂起不能变成零请求屏障')
    assert.ok(store.requests.every(request => !namesOf(request).includes(HIDDEN)))
    assert.equal(store.bodyCount(`${id}-guess`), 0)
    gate.resolve()
    const outcome = await bounded(seeded.promise, 'late durable seed')
    assert.deepEqual(outcome.seeded, [HIDDEN])
    facility.open = original
    store.reset(); queueResponse({ toolCalls: [{ id: `${id}-restored`, name: HIDDEN, arguments: { text: 'after read' } }] }); queueResponse({ text: 'restored' })
    await turn(handle)
    assert.ok(namesOf(store.requests[0]).includes(HIDDEN))
    assert.equal(store.bodyCount(`${id}-restored`), 1)
  })
}

test('RB2: admission 读失败退为零准入，ready 请求照发且 load 可恢复', async t => {
  const id = 'rb-read-fail'
  const { comp, handle } = await setup(t, id)
  const facility = comp.ctx.storageDomain
  const original = facility.open
  let failures = 0
  facility.open = async function (...args) {
    const domain = await original.apply(this, args)
    return new Proxy(domain, { get(target, key) {
      if (key === 'table') return (...tableArgs) => {
        const table = target.table(...tableArgs)
        return new Proxy(table, { get(rows, field) {
          if (field === 'get') return requested => { if (requested === id) { failures++; throw new Error('admission read failure') } return rows.get(requested) }
          const value = Reflect.get(rows, field); return typeof value === 'function' ? value.bind(rows) : value
        } })
      }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  t.after(() => { facility.open = original })
  await comp.adapterEntryState().fiber.restart()
  const service = comp.ctx.get('progressiveDiscovery')
  await service.tracker.holder.store.ensureOpen()
  await Promise.resolve()
  assert.ok(failures > 0, '故障必须命中真实 admission 读路径')
  assert.deepEqual(await service.whenReady(id), { mode: 'ready' })
  assert.equal(service.lifecycle.admittedNamesOf(id).size, 0)
  store.reset(); queueResponse({ toolCalls: [{ id: 'rb-failed-guess', name: HIDDEN, arguments: { text: 'guess' } }] }); queueResponse({ text: 'not blocked' })
  await turn(handle)
  assert.ok(store.requests.length > 0)
  assert.ok(store.requests.every(request => !namesOf(request).includes(HIDDEN)))
  assert.equal(store.bodyCount('rb-failed-guess'), 0)
  queueResponse({ toolCalls: [{ id: 'rb-reload', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'rb-reloaded-use', name: HIDDEN, arguments: { text: 're-admitted' } }] })
  queueResponse({ text: 'usable' })
  await turn(handle)
  assert.equal(store.bodyCount('rb-reloaded-use'), 1, '读失败不是永久拒绝，正常 load 解除门禁')
})

for (const entry of ENTRY_TOOL_NAMES) {
  test(`RB3: own-scope 同名覆盖 ${entry} 被拒，去掉覆盖后恢复`, async t => {
    const { comp, handle } = await setup(t, `rb-shadow-${entry}`)
    let bodyCalls = 0
    const dispose = handle.agent.ctx.tools.register({ name: entry, description: 'shadow entry', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => { bodyCalls++; return 'shadow ran' } })
    t.after(dispose)
    const args = entry === 'tool_search' ? { category: 'all', query: 'hidden' } : entry === 'tool_load' || entry === 'tool_unload' ? { names: [HIDDEN] } : {}
    const execute = callId => executeToolCall(comp.ctx, { agent: handle.agent, name: entry, callId, arguments: args, signal: new AbortController().signal })
    assert.equal((await execute('shadow-denied')).isError, true)
    assert.equal(bodyCalls, 0, '覆盖入口 body 不得执行')
    dispose()
    const result = await execute('entry-restored')
    assert.notEqual(result.isError, true)
    const envelope = JSON.parse(result.content.map(block => block.text ?? '').join(''))
    assert.equal(envelope.ok, true, JSON.stringify(envelope))
  })
}

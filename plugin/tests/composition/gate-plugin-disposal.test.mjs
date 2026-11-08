// rc.1 真 Loader/fiber 生命周期：释放 runtime、tracker、mask 和四入口；晚完成的
// storage open/put 不得复活旧 runtime。旧 journal/ledger、恢复请求屏障没有等价
// 子系统，改测 admission 资源与在途 waterfall 释放后不会重建旧 runtime。
// 不要求卸载时取消宿主请求：卸载的契约是解除本插件掩码/guard、恢复宿主默认行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { bootAdapterComposition, executeToolCall, createNativeTestAgent } from './harness.mjs'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { store, queueResponse } from '../../fixtures/mock-store.mjs'
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs'

const HIDDEN = 'fixture_hidden_inherited'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 3000) })]) }
  finally { clearTimeout(timer) }
}
async function boot(t, options = {}) {
  const comp = await bootAdapterComposition({ fixtures: ['mock-provider', 'inherited-tools'], adapter: { alwaysVisible: [], alwaysAllowPresetTools: false }, ...options })
  t.after(async () => { await comp.closeServices(); comp.dispose() })
  assert.ok(comp.ctx.get('progressiveDiscovery'), comp.activationErrors().join('\n'))
  return comp
}
async function create(t, comp, id) {
  const handle = await createNativeTestAgent(comp, id)
  t.after(() => handle.dispose())
  return handle
}
async function turn(handle, text = 'Continue.') {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await handle.agent.whenIdle()
}
function observeDisposal(service, runtime) {
  const calls = { session: 0, tracker: 0, mask: 0 }
  const wrap = (object, name, key) => {
    const original = object[name]
    object[name] = function (...args) { calls[key]++; return original.apply(this, args) }
  }
  wrap(runtime.engine, 'destroySession', 'session')
  wrap(service.tracker, 'dispose', 'tracker')
  wrap(service.mask, 'dispose', 'mask')
  return calls
}
function assertReleased(comp, service, runtime, calls) {
  assert.equal(comp.ctx.get('progressiveDiscovery'), undefined)
  for (const entry of ENTRY_TOOL_NAMES) assert.equal(comp.ctx.tools.get(entry), undefined, `remove ${entry}`)
  assert.equal(service.sessions.size, 0)
  assert.equal(service.tracker.admissionsFor(runtime.scope.sessionId).size, 0)
  assert.equal(runtime.disposedSignal.signal.aborted, true)
  assert.deepEqual(calls, { session: 1, tracker: 1, mask: 1 })
  assert.throws(() => service.lifecycle.runtimeFor(runtime.session, runtime.agentScope), /disposed|卸载/i)
}
async function list(comp, handle, callId) {
  const result = await executeToolCall(comp.ctx, { agent: handle.agent, name: 'tool_list', callId, arguments: {}, signal: new AbortController().signal })
  assert.notEqual(result.isError, true)
  assert.equal(JSON.parse(result.content.map(block => block.text ?? '').join('')).ok, true)
}

test('PD1: fiber dispose 恰好释放自有资源、lift mask/guard，重新挂载可用', async t => {
  store.reset()
  const comp = await boot(t)
  const handle = await create(t, comp, 'pd-ready')
  const service = comp.ctx.get('progressiveDiscovery')
  const runtime = service.lifecycle.runtimeFor(handle.agent.session, handle.agent)
  await list(comp, handle, 'pd-before')
  assert.equal(comp.ctx.tools.view(handle.agent).visible.has(HIDDEN), false)
  const denied = await executeToolCall(comp.ctx, { agent: handle.agent, name: HIDDEN, callId: 'pd-before-guess', arguments: { text: 'no' }, signal: new AbortController().signal })
  assert.equal(denied.isError, true)
  const calls = observeDisposal(service, runtime)
  const entry = comp.adapterEntryState()
  await entry.fiber.dispose()
  await Promise.resolve()
  assertReleased(comp, service, runtime, calls)
  await entry.fiber.dispose(); service.lifecycle.dispose()
  assert.deepEqual(calls, { session: 1, tracker: 1, mask: 1 }, '重复释放幂等')
  assert.equal(comp.ctx.tools.view(handle.agent).visible.has(HIDDEN), true, '插件卸载 lift mask')
  const allowed = await executeToolCall(comp.ctx, { agent: handle.agent, name: HIDDEN, callId: 'pd-after-guess', arguments: { text: 'host default' }, signal: new AbortController().signal })
  assert.equal(allowed.isError, false, '插件 guard 随卸载解除')
  assert.equal(store.bodyCount('pd-after-guess'), 1)
  const spec = comp.specs.find(item => item.id === 'progressive-discovery')
  await comp.loader.create({ ...spec, disabled: false, id: 'pd-remounted' })
  await comp.loader.await()
  const fresh = comp.ctx.get('progressiveDiscovery')
  assert.ok(fresh, comp.activationErrors().join('\n'))
  assert.notEqual(fresh, service)
  await list(comp, handle, 'pd-remounted-list')
  assert.equal(fresh.sessions.size, 1)
  assert.equal(comp.ctx.tools.view(handle.agent).visible.has(HIDDEN), false, '新 activation 独立安装掩码')
})

test('PD2: admission store open 延迟完成时卸载，晚 open 会 close 且不复活 runtime', async t => {
  const comp = await boot(t, { omitStorage: true })
  const handle = await create(t, comp, 'pd-open')
  const service = comp.ctx.get('progressiveDiscovery')
  const runtime = service.lifecycle.runtimeFor(handle.agent.session, handle.agent)
  const entered = deferred(); const gate = deferred(); const closed = deferred()
  let closeCount = 0
  const remove = comp.ctx.provide('storageDomain', { open: async () => {
    entered.resolve(); await gate.promise
    return { table: () => ({ keys: () => [], get: () => undefined }), close: async () => { closeCount++; closed.resolve() } }
  } })
  t.after(() => { gate.resolve(); if (typeof remove === 'function') remove() })
  await bounded(entered.promise, 'storage open entered')
  assert.deepEqual(await service.whenReady('pd-open'), { mode: 'ready' })
  const calls = observeDisposal(service, runtime)
  // 不 await fiber.dispose：Cordis 可以等待自有 store open 的清理，但同步资源应立即释放。
  const disposing = comp.adapterEntryState().fiber.dispose()
  gate.resolve()
  await bounded(disposing, 'fiber disposal after open release')
  await bounded(closed.promise, 'late opened domain closed')
  assert.equal(closeCount, 1)
  assertReleased(comp, service, runtime, calls)
})

test('PD3: 真实 admission put 在途时卸载，完成后不复活授权且 store 关闭', async t => {
  const comp = await boot(t)
  const handle = await create(t, comp, 'pd-put')
  const service = comp.ctx.get('progressiveDiscovery')
  const runtime = service.lifecycle.runtimeFor(handle.agent.session, handle.agent)
  const durable = service.tracker.holder.store
  await durable.ensureOpen()
  const put = durable.put.bind(durable)
  const gate = deferred(); const entered = deferred(); const completed = deferred()
  durable.put = async record => { entered.resolve(); await gate.promise; try { return await put(record) } finally { completed.resolve() } }
  const loaded = await runtime.engine.handleLoad({ names: [HIDDEN] }, runtime.scope)
  assert.equal(loaded.response.ok, true)
  service.lifecycle.commitAdmissions(runtime, loaded.admitted)
  await bounded(entered.promise, 'real store put entered')
  assert.ok(service.tracker.get('pd-put', HIDDEN))
  let trackerCleanup
  const disposeTracker = service.tracker.dispose.bind(service.tracker)
  service.tracker.dispose = () => (trackerCleanup = disposeTracker())
  const calls = observeDisposal(service, runtime)
  const disposing = comp.adapterEntryState().fiber.dispose()
  gate.resolve()
  await bounded(disposing, 'disposal after put release')
  await bounded(completed.promise, 'old put completed')
  await bounded(trackerCleanup, 'tracker cleanup completes after late put')
  assertReleased(comp, service, runtime, calls)
  assert.equal(durable.status, 'closed')
  service.tracker.admit('pd-put', loaded.admitted[0])
  assert.equal(service.tracker.admissionsFor('pd-put').size, 0, '已销毁 tracker 的晚写不复活 admission')
})

for (const seam of ['agent/pre-step', 'system-prompt/assemble']) {
  test(`PD4/5 ${seam}: restart 后释放旧 waterfall 不复活旧 runtime，新 activation 可发请求`, async t => {
    store.reset()
    const comp = await boot(t)
    const handle = await create(t, comp, `pd-seam-${seam}`)
    const old = comp.ctx.get('progressiveDiscovery')
    const entered = deferred(); const gate = deferred()
    const remove = comp.ctx.on(seam, async (...args) => {
      const result = await args.at(-1)()
      entered.resolve(); await gate.promise; return result
    })
    t.after(() => { gate.resolve(); remove() })
    queueResponse({ text: 'host can finish old request' })
    const idle = turn(handle)
    await bounded(entered.promise, 'old waterfall entered')
    assert.equal(store.requests.length, 0)
    assert.equal(old.sessions.size, 1)
    await comp.adapterEntryState().fiber.restart()
    const fresh = comp.ctx.get('progressiveDiscovery')
    assert.ok(fresh)
    assert.notEqual(fresh, old)
    assert.equal(old.sessions.size, 0)
    gate.resolve()
    await bounded(idle, 'old waterfall settles')
    assert.equal(old.sessions.size, 0, '晚完成不得重建旧 runtime')
    remove()
    store.reset(); queueResponse({ text: 'fresh activation works' })
    await bounded(turn(handle), 'fresh request')
    assert.equal(store.requests.length, 1)
    assert.deepEqual(store.requests[0].tools.map(tool => tool.name).sort(), [...ENTRY_TOOL_NAMES].sort())
    assert.equal(fresh.sessions.size, 1)
    assert.equal(old.sessions.size, 0)
  })
}

test('PD6: session dispose 保留 durable record 但释放 runtime，旧 scope 不得自行复活', async t => {
  store.reset()
  const comp = await boot(t)
  const handle = await create(t, comp, 'pd-session')
  const service = comp.ctx.get('progressiveDiscovery')
  const durable = service.tracker.holder.store
  await durable.ensureOpen()
  const realPut = durable.put.bind(durable); const saved = deferred()
  durable.put = async record => { const result = await realPut(record); saved.resolve(); return result }
  queueResponse({ toolCalls: [{ id: 'pd-save', name: 'tool_load', arguments: { names: [HIDDEN] } }] }); queueResponse({ text: 'saved' })
  await turn(handle)
  await bounded(saved.promise, 'durable admission written')
  const runtime = service.sessions.get('pd-session')
  await handle.dispose()
  assert.equal(service.sessions.has('pd-session'), false)
  assert.equal(service.tracker.admissionsFor('pd-session').size, 0)
  assert.ok(durable.get('pd-session').admissions.some(row => row.name === HIDDEN), 'dispose 不删 resume 所需 durable admission')
  assert.equal(runtime.disposedSignal.signal.aborted, true)
  assert.throws(() => service.lifecycle.runtimeFor(runtime.session, runtime.agentScope), /disposed/i)
})

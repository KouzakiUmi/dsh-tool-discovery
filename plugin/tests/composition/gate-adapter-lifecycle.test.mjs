// rc.1 admission 生命周期：候选引用、会话隔离、公开 unload、durable resume。
// 旧「禁止 unload / canonical 回执回放 / 恢复请求屏障」不再有等价契约；
// 分别改测第四入口撤权、admission 持久化恢复与 whenReady 立即 ready。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, createNativeTestAgent, forkServices, startFork } from './harness.mjs'
import { store, queueResponse, holdNextResponse } from '../../fixtures/mock-store.mjs'

const HIDDEN = 'fixture_hidden_inherited'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']
const ENTRIES = ['tool_list', 'tool_load', 'tool_search', 'tool_unload']
const namesOf = request => (request?.tools ?? []).map(tool => tool.name)

async function boot(t, options = {}) {
  const comp = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {}, ...options })
  t.after(async () => { await comp.closeServices(); comp.dispose() })
  assert.ok(comp.ctx.get('progressiveDiscovery'), comp.activationErrors().join('\n'))
  return comp
}
async function create(t, comp, id) {
  const handle = await createNativeTestAgent(comp, id)
  t.after(() => handle.dispose())
  return handle
}
async function turn(handle, text) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
}
async function resultFor(comp, sessionId, callId) {
  const { events } = await comp.ctx.sessionQuery.readSession(sessionId)
  const call = events.find(event => event.type === 'tool/call' && event.data?.callId === callId)
  assert.ok(call, `durable tool/call: ${callId}`)
  const result = events.find(event => event.type === 'tool/result' && event.sourceEventSeqs?.includes(call.seq))
  assert.ok(result, `durable tool/result: ${callId}`)
  return JSON.parse(result.data.message.content.map(block => block.text ?? '').join(''))
}

test('F03c: search 候选 ref+revision 经真实 tool_load 接纳，下一步披露并执行', async t => {
  store.reset()
  const comp = await boot(t)
  const handle = await create(t, comp, 'l-candidate')
  queueResponse({ toolCalls: [{ id: 'search', name: 'tool_search', arguments: { category: 'all', query: 'hidden inherited tool' } }] })
  queueResponse({ text: 'found' })
  await turn(handle, 'Find a hidden tool.')
  const search = await resultFor(comp, 'l-candidate', 'search')
  assert.equal(search.ok, true)
  const hit = search.data.candidates.find(candidate => candidate.name === HIDDEN)
  assert.ok(hit?.ref && hit?.revision, '真实候选必须含 ref+revision')
  assert.equal(namesOf(store.requests[0]).includes(HIDDEN), false)
  for (const entry of ENTRIES) assert.ok(namesOf(store.requests[0]).includes(entry))
  queueResponse({ toolCalls: [{ id: 'candidate-load', name: 'tool_load', arguments: { candidates: [{ ref: hit.ref, revision: hit.revision }] } }] })
  queueResponse({ toolCalls: [{ id: 'candidate-use', name: HIDDEN, arguments: { text: 'loaded' } }] })
  queueResponse({ text: 'used' })
  await turn(handle, 'Load that candidate and use it.')
  assert.equal((await resultFor(comp, 'l-candidate', 'candidate-load')).ok, true)
  assert.equal(store.bodyCount('candidate-use'), 1)
  assert.ok(namesOf(store.requests.at(-1)).includes(HIDDEN))
  assert.ok(comp.ctx.get('progressiveDiscovery').tracker.get('l-candidate', HIDDEN))
})

test('S03c: 跨会话 ref 被拒，A 的 admission 不泄漏到 B', async t => {
  store.reset()
  const comp = await boot(t)
  const a = await create(t, comp, 'l-isolation-a')
  queueResponse({ toolCalls: [{ id: 'search-a', name: 'tool_search', arguments: { category: 'all', query: 'hidden inherited tool' } }] })
  queueResponse({ toolCalls: [{ id: 'load-a', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ text: 'A done' })
  await turn(a, 'Search and load.')
  const hit = (await resultFor(comp, 'l-isolation-a', 'search-a')).data.candidates.find(candidate => candidate.name === HIDDEN)
  assert.ok(hit?.ref && hit?.revision)
  assert.ok(comp.ctx.get('progressiveDiscovery').tracker.get('l-isolation-a', HIDDEN))
  const before = store.requests.length
  const b = await create(t, comp, 'l-isolation-b')
  queueResponse({ toolCalls: [{ id: 'cross-load', name: 'tool_load', arguments: { candidates: [{ ref: hit.ref, revision: hit.revision }] } }] })
  queueResponse({ toolCalls: [{ id: 'cross-guess', name: HIDDEN, arguments: { text: 'guess' } }] })
  queueResponse({ text: 'B done' })
  await turn(b, 'Use another session candidate.')
  const rejected = await resultFor(comp, 'l-isolation-b', 'cross-load')
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'CANDIDATE_UNAVAILABLE')
  assert.equal(store.bodyCount('cross-guess'), 0)
  assert.equal(comp.ctx.get('progressiveDiscovery').tracker.get('l-isolation-b', HIDDEN), undefined)
  assert.ok(store.requests.slice(before).every(request => !namesOf(request).includes(HIDDEN)))
})

test('F08: tool_unload 撤销 admission，下一步重掩码、拒执行，reload 恢复', async t => {
  store.reset()
  const comp = await boot(t)
  const handle = await create(t, comp, 'l-unload')
  queueResponse({ toolCalls: [{ id: 'load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'before-unload', name: HIDDEN, arguments: { text: 'before' } }] })
  queueResponse({ text: 'loaded' })
  await turn(handle, 'Load and use.')
  assert.equal(store.bodyCount('before-unload'), 1)
  const start = store.requests.length
  queueResponse({ toolCalls: [{ id: 'unload', name: 'tool_unload', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'after-unload', name: HIDDEN, arguments: { text: 'after' } }] })
  queueResponse({ text: 'unloaded' })
  await turn(handle, 'Unload then try again.')
  const unloaded = await resultFor(comp, 'l-unload', 'unload')
  assert.equal(unloaded.ok, true)
  assert.deepEqual(unloaded.data.unloaded, [HIDDEN])
  assert.equal(store.bodyCount('after-unload'), 0)
  assert.ok(store.requests.slice(start + 1).every(request => !namesOf(request).includes(HIDDEN)))
  const service = comp.ctx.get('progressiveDiscovery')
  assert.equal(service.tracker.get('l-unload', HIDDEN), undefined)
  assert.equal(service.lifecycle.admittedNamesOf('l-unload').size, 0)
  queueResponse({ toolCalls: [{ id: 'reload', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'after-reload', name: HIDDEN, arguments: { text: 'again' } }] })
  queueResponse({ text: 'reloaded' })
  await turn(handle, 'Reload and use.')
  assert.equal((await resultFor(comp, 'l-unload', 'reload')).ok, true)
  assert.equal(store.bodyCount('after-reload'), 1)
})

test('L01: 真关闭服务后同根 resume，从 admission store 恢复且立即 ready', async t => {
  store.reset()
  const first = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {} })
  let resumed
  let handle2
  t.after(async () => { await handle2?.dispose(); await resumed?.closeServices(); await first.closeServices(); first.dispose() })
  const sessionId = 'l-resume'
  const serviceBefore = first.ctx.get('progressiveDiscovery')
  assert.ok(serviceBefore, first.activationErrors().join('\n'))
  const durable = serviceBefore.tracker.holder.store
  assert.ok(durable, '真实 storageDomain 必须已绑定')
  await durable.ensureOpen()
  const originalPut = durable.put.bind(durable)
  const writes = []
  let finishWrite
  const wrote = new Promise(resolve => { finishWrite = resolve })
  durable.put = async record => {
    const result = await originalPut(record)
    writes.push(structuredClone(record))
    if (record.sessionId === sessionId && record.admissions.some(row => row.name === HIDDEN)) finishWrite()
    return result
  }
  const handle = await createNativeTestAgent(first, sessionId)
  queueResponse({ toolCalls: [{ id: 'persist-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ text: 'persisted' })
  try {
    await turn(handle, 'Load before restart.')
    assert.equal((await resultFor(first, sessionId, 'persist-load')).ok, true)
    assert.ok(namesOf(store.requests.at(-1)).includes(HIDDEN))
    await bounded(wrote, 'real admission store.put')
    assert.ok(writes.some(record => record.sessionId === sessionId && record.admissions.some(row => row.name === HIDDEN && row.schemaDigest)),
      '真实 store.put 完成并带接纳指纹，不能只测内存')
  } finally {
    await handle.dispose()
    await first.closeServices()
  }
  resumed = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {}, tmpRoot: first.tmpRoot })
  handle2 = await resumed.ctx.agents.resume({ resumeSessionId: sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' } })
  const service = resumed.ctx.get('progressiveDiscovery')
  const runtime = service.lifecycle.runtimeFor(handle2.agent.session, handle2.agent)
  assert.deepEqual(await service.whenReady(sessionId), { mode: 'ready' })
  assert.deepEqual([...service.lifecycle.admittedNamesOf(sessionId)], [HIDDEN])
  assert.deepEqual([...runtime.engine.selectedOf(sessionId).values()].map(row => row.name), [HIDDEN])
  store.reset()
  queueResponse({ toolCalls: [{ id: 'resume-use', name: HIDDEN, arguments: { text: 'restored' } },
    { id: 'resume-guess-own', name: 'fixture_hidden_scope', arguments: { text: 'not admitted' } }] })
  queueResponse({ text: 'resumed' })
  await turn(handle2, 'Continue after restart.')
  assert.ok(namesOf(store.requests[0]).includes(HIDDEN), '恢复后首请求含准入项')
  for (const entry of ENTRIES) assert.ok(namesOf(store.requests[0]).includes(entry))
  assert.ok(namesOf(store.requests[0]).includes('fixture_hidden_scope'), 'own-scope 不可遮的宿主边界')
  assert.equal(store.bodyCount('resume-use'), 1)
  assert.equal(store.bodyCount('resume-guess-own'), 0)
})

async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 5000) })]) }
  finally { clearTimeout(timer) }
}

test('L02: 真实 fork 继承父历史但不继承 admission；子会话 resume 仍仅使用自己的准入表', async t => {
  store.reset()
  const comp = await boot(t, { extraServices: forkServices() })
  const parent = await create(t, comp, 'l-fork-parent')
  queueResponse({ toolCalls: [{ id: 'fork-parent-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ text: 'parent admitted' })
  await turn(parent, 'Load for parent.')
  const service = comp.ctx.get('progressiveDiscovery')
  assert.ok(service.tracker.get('l-fork-parent', HIDDEN))
  store.reset()
  const response = holdNextResponse()
  t.after(() => response.release())
  queueResponse({ toolCalls: [{ id: 'fork-child-guess', name: HIDDEN, arguments: { text: 'inherited only' } }] })
  queueResponse({ text: 'child complete' })
  const fork = await bounded(startFork(comp.ctx, parent.agent, 'Try the inherited tool without loading.'), 'real fork start')
  t.after(() => fork.dispose())
  await bounded(response.entered, 'fork request recorded')
  const child = comp.ctx.agents.get(fork.id)
  assert.ok(child, '子 agent 必须真实物化且仍活动')
  assert.ok(child.session.inheritedEventCount > 0, '子会话必须有继承历史，而不是空会话')
  assert.equal(service.tracker.admissionsFor(child.session.id).size, 0)
  assert.equal(service.lifecycle.runtimeFor(child.session, child).engine.selectedOf(child.session.id).size, 0)
  assert.equal(namesOf(store.requests[0]).includes(HIDDEN), false, '父 admission 不得进入 fork 首请求')
  const childId = child.session.id
  response.release()
  await bounded(fork.result, 'child completes')
  assert.equal(store.bodyCount('fork-child-guess'), 0)
  assert.ok(service.tracker.get('l-fork-parent', HIDDEN), '子会话拒绝不影响父 admission')
  const resumed = await comp.ctx.agents.resume({ resumeSessionId: childId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' } })
  t.after(() => resumed.dispose())
  assert.ok(resumed.agent.session.inheritedEventCount > 0)
  assert.deepEqual(await service.whenReady(childId), { mode: 'ready' })
  assert.equal(service.lifecycle.admittedNamesOf(childId).size, 0, 'resume 不从继承的父 load 历史恢复准入')
  store.reset()
  queueResponse({ toolCalls: [{ id: 'fork-resume-guess', name: HIDDEN, arguments: { text: 'still not admitted' } }] })
  queueResponse({ text: 'resumed child' })
  await turn(resumed, 'Continue inherited history.')
  assert.equal(namesOf(store.requests[0]).includes(HIDDEN), false)
  assert.equal(store.bodyCount('fork-resume-guess'), 0)
})

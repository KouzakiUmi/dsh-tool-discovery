// 组合测试补充：恢复×故障 fail-closed（L11）、fork reset（L03，真实宿主 fork seam）、
// unload×恢复（F08×L01）、候选×恢复/引用失效（F03c/S03×L01）、恢复×当前资格重核验（L06×L01）。
// 独立于 gate-adapter.test.mjs / gate-adapter-lifecycle.test.mjs，复用同一 harness。
//
// 断言纪律：每条安全断言配正控制；不做条件式空转。恢复断言一律走
// ctx.get('progressiveDiscovery') + journal.whenRestored()（旧 L01 用 ctx.expose 取空的教训）。
// fork 一律走真实宿主 seam（ctx.subagents + dsh-subagent-fork-in-process 的真实 seeded 子会话），
// 不手搓 seed、不 mock fork；插件与本测试均不得调用 deprecated snapshotEvents/ownEvents/eventAt。
//
// 运行：node --test plugin/tests/composition/gate-adapter-recovery.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule, fixtureFileUrl } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, forkServices, startFork, LOCAL } from './harness.mjs'
import { createJournal, mergeBySeq, foldPairs } from '../../adapters/dsh/journal.mjs'

const handles = []
const cleanup = []

async function storeOf () {
  return import(new URL('../../fixtures/mock-store.mjs', import.meta.url).href)
}

function resultTextOf (event) {
  return (event?.data?.message?.content ?? []).map((block) => block.text ?? '').join('')
}

function toolCallSeq (events, callId) {
  return events.find((event) => event.type === 'tool/call' && event.data?.callId === callId)?.seq
}

function toolResultFor (events, callId) {
  const callSeq = toolCallSeq(events, callId)
  assert.notEqual(callSeq, undefined, `durable tool/call for ${callId}`)
  const result = events.find((event) => event.type === 'tool/result'
    && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(callSeq))
  assert.notEqual(result, undefined, `durable tool/result for ${callId}`)
  return result
}

async function rawEvents (ctx, sessionId) {
  const { events } = await ctx.sessionQuery.readSession(sessionId)
  return events
}

async function drive (ctx, tmpRoot, sessionId) {
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: tmpRoot }
  })
  handles.push(handle)
  return handle
}

async function resumeDrive (ctx, sessionId) {
  const handle = await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }
  })
  handles.push(handle)
  return handle
}

async function userTurn (handle, text) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }))
  await handle.agent.whenIdle()
}

function runtimeOf (ctx, sessionId) {
  const svc = ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery service must be reachable via ctx.get')
  const runtime = svc.sessions.get(sessionId)
  assert.ok(runtime !== undefined, `runtime must exist for ${sessionId}`)
  return runtime
}

function namesOf (request) {
  return (request?.tools ?? []).map((t) => t.name).sort()
}

// ---------------------------------------------------------------------------
// R2 / L11a：sessionQuery 缺失 → 组合**不激活**（宿主工具表原样保留）
// ---------------------------------------------------------------------------
// 契约变更：sessionQuery 现声明在 apply.inject 中，因此该服务不可用时宿主根本
// 不调用 apply。这比"激活后再逐会话 fail closed"更安全——投影从未运行，宿主
// 的工具可见面没有被本插件改动过任何一项，不存在"部分折叠但无法恢复"的中间态。
// 本用例改为断言该 fail-safe 语义；逐会话 fail closed 的分支仍由 journal 保留
// （见 journal.restore() 的 query===undefined 分支）与 L11b 覆盖。
test('L11a: sessionQuery 缺失 → 组合不激活，宿主工具表不被折叠', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    omitSessionQuery: true
  })
  cleanup.push(() => boot.dispose())

  // 组合未激活：本插件的服务不提供
  assert.equal(boot.ctx.get('progressiveDiscovery'), undefined,
    'sessionQuery 缺失时组合必须完全不激活')

  // fail-safe 断言：宿主自己的工具一项都没有被折叠掉
  queueResponse({ toolCalls: [{ id: 'qm-call', name: 'fixture_hidden_inherited', arguments: { text: 'x' } }] })
  queueResponse({ text: 'qm done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'rec-qm-1')
  await userTurn(handle, 'Use the tool.')
  assert.equal(store.bodyCount('qm-call'), 1,
    '插件未激活时宿主工具必须照常可执行，不得被静默折叠')
  const req = store.requests[store.requests.length - 1]
  assert.equal(namesOf(req).includes('fixture_hidden_inherited'), true,
    '插件未激活时宿主工具必须仍然可见')
  assert.equal(namesOf(req).includes('tool_load'), false,
    '插件未激活时不得出现本插件的控制入口')

  // 正控制：同一 mock 面、带 query 的健康 composition 同流程 ready + 可执行
  const bootP = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => bootP.dispose())
  queueResponse({ toolCalls: [{ id: 'qm-pos-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'pos loaded' })
  const handleP = await drive(bootP.ctx, bootP.tmpRoot, 'rec-qm-pos-1')
  await userTurn(handleP, 'Load a hidden tool.')
  const runtimeP = runtimeOf(bootP.ctx, 'rec-qm-pos-1')
  const outcomeP = await runtimeP.journal.whenRestored()
  assert.equal(outcomeP.mode, 'ready', `healthy composition must be ready: ${JSON.stringify(outcomeP)}`)
  queueResponse({ toolCalls: [{ id: 'qm-pos-call', name: 'fixture_hidden_inherited', arguments: { text: 'ok' } }] })
  queueResponse({ text: 'pos done' })
  await userTurn(handleP, 'Call the tool.')
  assert.equal(store.bodyCount('qm-pos-call'), 1, 'positive control must execute exactly once')
})

// ---------------------------------------------------------------------------
// R3 / L11b：readSession 失败 → fail closed（故障注入），同 composition 健康会话正控
// ---------------------------------------------------------------------------
test('L11b: readSession 失败 → fail closed 不降级新会话；同 composition 健康会话正控', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  queueResponse({ toolCalls: [{ id: 'rs-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'rs loaded' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, 'rec-rs-1')
  await userTurn(h1, 'Load a hidden tool.')
  await h1.dispose()

  // 重开 + 故障注入：仅目标会话的 readSession 拒绝（其余委托真实服务）
  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  const query = boot2.ctx.sessionQuery
  const realRead = query.readSession.bind(query)
  query.readSession = (sessionId, ...rest) => (sessionId === 'rec-rs-1'
    ? Promise.reject(new Error('injected readSession failure'))
    : realRead(sessionId, ...rest))

  const h2 = await resumeDrive(boot2.ctx, 'rec-rs-1')
  queueResponse({ text: 'rs pre-recovery' })
  await userTurn(h2, 'Continue after restart.')

  const runtime = runtimeOf(boot2.ctx, 'rec-rs-1')
  const outcome = await runtime.journal.whenRestored()
  assert.equal(outcome.mode, 'incompatible', `readSession failure must fail closed: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.reason, 'readSession-failed')
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'incompatible')

  // 负控制：执行被拒 body=0、不披露
  queueResponse({ toolCalls: [{ id: 'rs-call', name: 'fixture_hidden_inherited', arguments: { text: 'x' } }] })
  queueResponse({ text: 'rs call done' })
  await userTurn(h2, 'Try calling the tool.')
  assert.equal(store.bodyCount('rs-call'), 0, 'fail-closed session must not execute')

  // 正控制：同 composition 中 readSession 正常的会话照常 ready + 可执行
  queueResponse({ toolCalls: [{ id: 'rs-pos-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'pos loaded' })
  const hPos = await drive(boot2.ctx, boot2.tmpRoot, 'rec-rs-pos-1')
  await userTurn(hPos, 'Load a hidden tool.')
  const runtimePos = runtimeOf(boot2.ctx, 'rec-rs-pos-1')
  const outcomePos = await runtimePos.journal.whenRestored()
  assert.equal(outcomePos.mode, 'ready', `healthy session must stay ready: ${JSON.stringify(outcomePos)}`)
  queueResponse({ toolCalls: [{ id: 'rs-pos-call', name: 'fixture_hidden_inherited', arguments: { text: 'ok' } }] })
  queueResponse({ text: 'pos done' })
  await userTurn(hPos, 'Call the tool.')
  assert.equal(store.bodyCount('rs-pos-call'), 1, 'positive control must execute exactly once')
})

// ---------------------------------------------------------------------------
// R4 / L03：fork reset（真实宿主 fork seam：ctx.subagents + fork-in-process seeded 子会话）
// ---------------------------------------------------------------------------
test('L03: 真实 fork → 父 selected 不继承（own-only 折叠），子 own load 可披露/执行', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    extraServices: forkServices()
  })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'subagent composition must converge')
  const subagents = boot.ctx.get('subagents')
  assert.ok(subagents !== undefined && subagents.getProvider('fork') !== undefined,
    'real host fork provider must be registered (否则本场景标记未覆盖，禁止 mock 顶替)')

  // 父：load 并完成一轮（fork seed 取父已完成轮次前缀）
  queueResponse({ toolCalls: [{ id: 'p-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'parent done' })
  const hp = await drive(boot.ctx, boot.tmpRoot, 'rec-fork-parent')
  await userTurn(hp, 'Parent loads a hidden tool.')
  const parentRequestCount = store.requests.length

  // 子：猜父工具（负）→ 自 load（canonical 成功）→ 合法调用（正控）→ 收尾
  queueResponse({ toolCalls: [{ id: 'c-guess', name: 'fixture_hidden_inherited', arguments: { text: 'guess' } }] })
  queueResponse({ toolCalls: [{ id: 'c-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'c-legit', name: 'fixture_hidden_inherited', arguments: { text: 'child own' } }] })
  queueResponse({ text: 'child done' })
  const run = await startFork(boot.ctx, hp.agent)
  const result = await run.result
  assert.notEqual(result, undefined, 'fork run must settle')

  const childEv = await boot.ctx.sessionQuery.readSession(run.id)
  // 真实性判据：子会话必须带非空继承前缀（真实 seeded fork，不是新会话冒充）
  assert.ok(childEv.inheritedEventCount > 0, `real fork must seed a non-empty prefix: ${childEv.inheritedEventCount}`)
  assert.equal(childEv.events[childEv.inheritedEventCount]?.type, 'session/end-seed', 'seed cut must be marked')

  // 策略判据（fork reset 由所有权保证，不靠 revision 碰巧拒绝）：
  const runtime = runtimeOf(boot.ctx, run.id)
  const outcome = await runtime.journal.whenRestored()
  assert.equal(outcome.mode, 'ready', `child restore must settle: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.applied, 0, 'inherited pairs must never be applied (fork reset)')
  assert.equal(outcome.rejected, 0, 'own-only 折叠：继承前缀的对不得进入子折叠管线（含被拒）')
  const eng = runtime.engine.getState(runtime.scope)
  assert.equal(eng.integrity.applied, 1, 'only the child own load may apply (live canonical pair)')
  assert.equal(eng.integrity.rejected, 0, '父对不得以任何形式进入折叠计数')
  assert.equal(eng.selected.size, 1, 'selected 只含子 own load 的结果')
  const [selection] = [...eng.selected.values()]
  assert.equal(selection.operationId, 'op_c-load',
    `selection must bind to the child own canonical op, not the inherited op_p-load: ${selection.operationId}`)

  // 行为判据：子会话任何请求都不得在自 load 前披露父工具
  const childRequests = store.requests.slice(parentRequestCount)
  assert.ok(childRequests.length >= 3, `child must drive its own rounds: ${childRequests.length}`)
  const beforeOwnLoad = childRequests.slice(0, 2).flatMap(namesOf)
  assert.equal(beforeOwnLoad.includes('fixture_hidden_inherited'), false,
    `parent-loaded tool must never be disclosed to the child before its own load: ${beforeOwnLoad}`)
  assert.deepEqual(namesOf(childRequests[0]), ['tool_list', 'tool_load', 'tool_search'],
    'child first request stays at the three control entries')
  // 负控制：猜父工具 body=0；正控制：子 own load 后可披露并执行一次
  assert.equal(store.bodyCount('c-guess'), 0, 'guessed parent tool must not run in the child')
  const guess = toolResultFor(childEv.events, 'c-guess')
  assert.equal(guess.data.message.isError, true, 'guessed parent tool call must be rejected')
  const loadShell = JSON.parse(resultTextOf(toolResultFor(childEv.events, 'c-load')))
  assert.equal(loadShell.ok, true, 'child own load must succeed canonically')
  assert.deepEqual(loadShell.data.receipt.selected.map((s) => s.name), ['fixture_hidden_inherited'])
  assert.ok(namesOf(childRequests[2]).includes('fixture_hidden_inherited'),
    'child own load must be disclosed after its canonical success')
  assert.equal(store.bodyCount('c-legit'), 1, 'child own loaded tool must execute exactly once')
  await run.dispose().catch(() => {})
})

// ---------------------------------------------------------------------------
// R5 / F08×L01：unload×恢复（load A+B → unload A → 重开 → A 不恢复、B 恢复可用）
// ---------------------------------------------------------------------------
test('F08xL01: 模型不得 unload → 冷恢复照旧重放全部 load，两者都恢复且可执行', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  queueResponse({ toolCalls: [{ id: 'u-load-a', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'u-load-b', name: 'tool_load', arguments: { names: ['fixture_mutating'] } }] })
  // unload 已不是模型可用路径：宿主 schema 校验（enum 里没有 unload）会先挡一道
  queueResponse({ toolCalls: [{ id: 'u-unload', name: 'tool_load', arguments: { action: 'unload', toolIds: ['global::fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'u setup done' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, 'rec-unload-1')
  await userTurn(h1, 'Load two tools and try to unload one.')
  // 回执交叉核对：unload 目标 id 与登记事实一致（不盲信硬编码）
  const events1 = await rawEvents(boot1.ctx, 'rec-unload-1')
  const loadAShell = JSON.parse(resultTextOf(toolResultFor(events1, 'u-load-a')))
  assert.equal(loadAShell.data.receipt.selected[0].toolId, 'global::fixture_hidden_inherited')
  assert.equal(toolResultFor(events1, 'u-unload').data.message.isError, true, 'unload 必须被拒')
  await h1.dispose()

  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  const h2 = await resumeDrive(boot2.ctx, 'rec-unload-1')
  queueResponse({ text: 'u pre-recovery' })
  await userTurn(h2, 'Continue after restart.')

  const runtime = runtimeOf(boot2.ctx, 'rec-unload-1')
  const outcome = await runtime.journal.whenRestored()
  assert.equal(outcome.mode, 'ready', `restore must settle: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.applied, 2, 'load A + load B 全部按序重放（unload 未提交，不产生 canonical 对）')
  assert.equal(outcome.rejected, 0, `clean journal must reject nothing: ${JSON.stringify(outcome)}`)
  const eng = runtime.engine.getState(runtime.scope)
  assert.deepEqual([...eng.selected.values()].map((s) => s.name).sort(),
    ['fixture_hidden_inherited', 'fixture_mutating'],
    '没有任何一次成功压缩，两个选择都必须恢复')

  // 历史保留 + 披露/执行正负控制
  const historyEvents = await rawEvents(boot2.ctx, 'rec-unload-1')
  assert.ok(historyEvents.some((e) => e.type === 'tool/result' && resultTextOf(e).includes('"tool_load"')),
    'load 回执必须仍在恢复后的历史中')
  queueResponse({
    toolCalls: [
      { id: 'u-legit', name: 'fixture_mutating', arguments: { text: 'legit' } },
      { id: 'u-legit-2', name: 'fixture_hidden_inherited', arguments: { text: 'legit2' } }
    ]
  })
  queueResponse({ text: 'u done' })
  await userTurn(h2, 'Use the restored tools.')
  const disclosed = namesOf(store.requests[store.requests.length - 1])
  assert.ok(disclosed.includes('fixture_mutating'), `restored selection must be disclosed: ${disclosed}`)
  assert.ok(disclosed.includes('fixture_hidden_inherited'), '未被卸载的第二个选择同样必须恢复')
  assert.equal(store.bodyCount('u-legit'), 1, 'restored tool must execute exactly once（未误伤正控）')
  assert.equal(store.bodyCount('u-legit-2'), 1, '未误伤正控：被拒的 unload 不得牵连另一个选择')
})

// ---------------------------------------------------------------------------
// R6 / F03c×S03×L01：候选 load 恢复 + ref 重启失效 + ref 代次失效
// ---------------------------------------------------------------------------
test('F03cxL01: 候选 load 冷恢复 + 旧 ref 重启后失效（CANDIDATE_UNAVAILABLE）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  // turn 1：search 取 ref（两段式：ref 是运行期产物，不能预写进脚本）
  queueResponse({ toolCalls: [{ id: 'cand-search', name: 'tool_search', arguments: { category: 'all', query: 'hidden inherited tool' } }] })
  queueResponse({ text: 'search done' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, 'rec-cand-1')
  await userTurn(h1, 'Find a hidden tool.')
  const events1 = await rawEvents(boot1.ctx, 'rec-cand-1')
  const searchShell = JSON.parse(resultTextOf(toolResultFor(events1, 'cand-search')))
  assert.equal(searchShell.ok, true)
  const hit = searchShell.data.candidates.find((c) => c.name === 'fixture_hidden_inherited')
  assert.ok(hit?.ref && hit?.revision, 'candidate must carry ref and revision')
  // turn 2：候选 load
  queueResponse({ toolCalls: [{ id: 'cand-load', name: 'tool_load', arguments: { candidates: [{ ref: hit.ref, revision: hit.revision }] } }] })
  queueResponse({ text: 'load done' })
  await userTurn(h1, 'Load that candidate.')
  assert.equal(JSON.parse(resultTextOf(toolResultFor(await rawEvents(boot1.ctx, 'rec-cand-1'), 'cand-load'))).ok, true)
  await h1.dispose()

  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  const h2 = await resumeDrive(boot2.ctx, 'rec-cand-1')
  queueResponse({ text: 'cand pre-recovery' })
  await userTurn(h2, 'Continue after restart.')

  const runtime = runtimeOf(boot2.ctx, 'rec-cand-1')
  const outcome = await runtime.journal.whenRestored()
  assert.equal(outcome.mode, 'ready', `restore must settle: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.applied, 1, 'exactly the candidate-path load pair replays')
  assert.equal(outcome.rejected, 0)
  const eng = runtime.engine.getState(runtime.scope)
  assert.deepEqual([...eng.selected.values()].map((s) => s.name).sort(), ['fixture_hidden_inherited'])
  assert.equal(eng.integrity.coldCandidateRestores, 1, '候选路径冷恢复指纹：cold restore 计数必须为 1')

  // 负控：重启后旧 ref 必须失效（ref 内存态、重启即失效）
  queueResponse({ toolCalls: [{ id: 'cand-stale', name: 'tool_load', arguments: { candidates: [{ ref: hit.ref, revision: hit.revision }] } }] })
  queueResponse({ toolCalls: [{ id: 'cand-legit', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } }] })
  queueResponse({ text: 'cand done' })
  await userTurn(h2, 'Reuse the old candidate ref.')
  const events2 = await rawEvents(boot2.ctx, 'rec-cand-1')
  const staleShell = JSON.parse(resultTextOf(toolResultFor(events2, 'cand-stale')))
  assert.equal(staleShell.ok, false, 'stale ref must be rejected after restart')
  assert.equal(staleShell.error.code, 'CANDIDATE_UNAVAILABLE')
  // 正控：恢复项照常披露并执行
  assert.ok(namesOf(store.requests[store.requests.length - 1]).includes('fixture_hidden_inherited'))
  assert.equal(store.bodyCount('cand-legit'), 1, 'restored candidate must execute exactly once (未误伤正控)')
})

test('S03xL05: tools/change 代次变更后旧 ref 失效（CANDIDATE_UNAVAILABLE），新 load 不受影响', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  queueResponse({ toolCalls: [{ id: 'gen-search', name: 'tool_search', arguments: { category: 'all', query: 'hidden inherited tool' } }] })
  queueResponse({ text: 'search done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'rec-gen-1')
  await userTurn(handle, 'Find a hidden tool.')
  const events = await rawEvents(boot.ctx, 'rec-gen-1')
  const shell = JSON.parse(resultTextOf(toolResultFor(events, 'gen-search')))
  const hit = shell.data.candidates.find((c) => c.name === 'fixture_hidden_inherited')
  assert.ok(hit?.ref && hit?.revision)

  // 真实宿主注册变更 → tools/change → 资格代次 bump、ref 全部失效
  await boot.loader.create({ id: 'fx-registry-churn', name: fixtureFileUrl(LOCAL['registry-churn']), config: {} })
  await boot.loader.await()

  queueResponse({ toolCalls: [{ id: 'gen-stale', name: 'tool_load', arguments: { candidates: [{ ref: hit.ref, revision: hit.revision }] } }] })
  queueResponse({ toolCalls: [{ id: 'gen-name-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'gen-legit', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } }] })
  queueResponse({ text: 'gen done' })
  await userTurn(handle, 'Reuse the old candidate ref after registry churn.')

  const events2 = await rawEvents(boot.ctx, 'rec-gen-1')
  const staleShell = JSON.parse(resultTextOf(toolResultFor(events2, 'gen-stale')))
  assert.equal(staleShell.ok, false, 'old ref must be rejected after generation bump')
  assert.equal(staleShell.error.code, 'CANDIDATE_UNAVAILABLE')
  // 正控：名称路径与执行不受代次 bump 误伤
  assert.equal(JSON.parse(resultTextOf(toolResultFor(events2, 'gen-name-load'))).ok, true, 'name load must keep working')
  assert.equal(store.bodyCount('gen-legit'), 1, 'tool must execute exactly once after churn (未误伤正控)')
})

// ---------------------------------------------------------------------------
// R7 / L06×L01：恢复×当前资格重核验（恢复时已撤工具不恢复、body=0；仍合格项不受误伤）
// ---------------------------------------------------------------------------
test('L06xL01: 恢复与当前资格取交集：已撤工具不恢复且 body=0，仍合格项恢复可执行', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  queueResponse({ toolCalls: [{ id: 'el-load-a', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'el-load-b', name: 'tool_load', arguments: { names: ['fixture_hidden_scope'] } }] })
  queueResponse({ text: 'el loaded' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, 'rec-elig-1')
  await userTurn(h1, 'Load two hidden tools.')
  assert.equal(JSON.parse(resultTextOf(toolResultFor(await rawEvents(boot1.ctx, 'rec-elig-1'), 'el-load-b'))).ok, true)
  await h1.dispose()

  // 重开时不再装配 scope-tools（fixture_hidden_scope 被撤除）→ 恢复必须与当前资格取交集
  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools'],
    adapter: {},
    tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  const h2 = await resumeDrive(boot2.ctx, 'rec-elig-1')
  queueResponse({ text: 'el pre-recovery' })
  await userTurn(h2, 'Continue after restart.')

  const runtime = runtimeOf(boot2.ctx, 'rec-elig-1')
  const outcome = await runtime.journal.whenRestored()
  assert.equal(outcome.mode, 'ready', `restore must settle: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.applied, 1, 'only the still-eligible load pair may apply')
  assert.equal(outcome.rejected, 1, 'the removed tool pair must be rejected (not silently upgraded)')
  const eng = runtime.engine.getState(runtime.scope)
  assert.deepEqual([...eng.selected.values()].map((s) => s.name).sort(), ['fixture_hidden_inherited'],
    'restore must intersect with current eligibility')

  queueResponse({
    toolCalls: [
      { id: 'el-legit', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } },
      { id: 'el-guess', name: 'fixture_hidden_scope', arguments: { text: 'removed' } }
    ]
  })
  queueResponse({ text: 'el done' })
  await userTurn(h2, 'Use the surviving tool.')
  const disclosed = namesOf(store.requests[store.requests.length - 1])
  assert.ok(disclosed.includes('fixture_hidden_inherited'), `eligible tool must disclose: ${disclosed}`)
  assert.equal(disclosed.includes('fixture_hidden_scope'), false, 'removed tool must never be disclosed')
  assert.equal(store.bodyCount('el-legit'), 1, 'eligible tool must execute exactly once (未误伤正控)')
  assert.equal(store.bodyCount('el-guess'), 0, 'removed tool body must not run (负控)')
  const guess = toolResultFor(await rawEvents(boot2.ctx, 'rec-elig-1'), 'el-guess')
  assert.equal(guess.data.message.isError, true, 'removed tool call must be rejected')
})

// ---------------------------------------------------------------------------
// R4b / L03×L01：fork 子 own load 跨重启恢复（真实 seeded 前缀 + own-only 折叠共存）
// ---------------------------------------------------------------------------
test('L03xL01: fork 子 own load 跨重启恢复，继承前缀仍不折叠（真实 host fork）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    extraServices: forkServices()
  })
  cleanup.push(() => boot.dispose())
  queueResponse({ toolCalls: [{ id: 'p2-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'parent done' })
  const hp = await drive(boot.ctx, boot.tmpRoot, 'rec-fork2-parent')
  await userTurn(hp, 'Parent loads a hidden tool.')
  // 子：自 load（own 操作，落在 seed 之后）
  queueResponse({ toolCalls: [{ id: 'c2-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'child done' })
  const run = await startFork(boot.ctx, hp.agent)
  await run.result
  const childId = run.id
  const childBefore = await boot.ctx.sessionQuery.readSession(childId)
  assert.ok(childBefore.inheritedEventCount > 0, 'real fork seed must exist before restart')
  await run.dispose()

  // 跨重启：resume 子会话 → own load 必须恢复，继承前缀仍不得折叠
  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    tmpRoot: boot.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  const h2 = await resumeDrive(boot2.ctx, childId)
  queueResponse({ text: 'c2 pre-recovery' })
  await userTurn(h2, 'Continue after restart.')
  const runtime = runtimeOf(boot2.ctx, childId)
  const outcome = await runtime.journal.whenRestored()
  assert.equal(outcome.mode, 'ready', `child restore must settle: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.applied, 1, 'the child own load must restore across restart')
  assert.equal(outcome.rejected, 0, 'the inherited parent pair must stay excluded (not merely rejected)')
  const eng = runtime.engine.getState(runtime.scope)
  assert.deepEqual([...eng.selected.values()].map((s) => s.name), ['fixture_hidden_inherited'])
  // 边界跨重启存活（query/live 交叉核验不误伤）
  const childAfter = await boot2.ctx.sessionQuery.readSession(childId)
  assert.equal(childAfter.inheritedEventCount, childBefore.inheritedEventCount, 'seed boundary must survive restart')
  queueResponse({ toolCalls: [{ id: 'c2-legit', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } }] })
  queueResponse({ text: 'c2 done' })
  await userTurn(h2, 'Use the restored tool.')
  assert.equal(store.bodyCount('c2-legit'), 1, 'restored own load must execute exactly once (未误伤正控)')
})

// ---------------------------------------------------------------------------
// 边界语义反例（合成事件流 + 真实 domain engine/catalog；性质=合成边界反例，
// 不冒称 host 天然产生同 revision 继承对——host 实况是父子 bindingGeneration 必然不同）
// ---------------------------------------------------------------------------
async function realLoadPairEvents (ctx, sessionId, callId) {
  const events = await rawEvents(ctx, sessionId)
  const call = events.find((e) => e.type === 'tool/call' && e.data?.callId === callId)
  assert.ok(call, `real tool/call ${callId}`)
  const result = events.find((e) => e.type === 'tool/result'
    && Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.includes(call.seq))
  assert.ok(result, `real tool/result ${callId}`)
  return { call, result }
}

function pairAt (call, result, callSeq) {
  return [
    { ...call, seq: callSeq },
    { ...result, seq: callSeq + 1, sourceEventSeqs: [callSeq] }
  ]
}

function streamWith (length, events) {
  const stream = Array.from({ length }, (_, i) => ({ type: 'assistant/message', seq: i, data: {} }))
  for (const e of events) stream[e.seq] = e
  return stream
}

function tamperedResult (result, seq, sourceSeq) {
  const shell = JSON.parse(resultTextOf(result))
  shell.data.receipt.selected[0].schemaDigest = 'sha256:' + 'f'.repeat(64)
  const content = result.data.message.content.map((b, i) => (i === 0 ? { ...b, text: JSON.stringify(shell) } : b))
  return {
    ...result,
    seq,
    sourceEventSeqs: [sourceSeq],
    data: { ...result.data, message: { ...result.data.message, content } }
  }
}

function syntheticJournal (engine, { sessionId, liveBoundary, queryResult }) {
  return createJournal({
    session: { inheritedEventCount: liveBoundary },
    scope: { sessionId, actorId: `actor-${sessionId}` },
    engine,
    query: { readSession: async () => queryResult }
  })
}

let SYN

test('boot SYN: 取真实 engine/catalog 与真实 load 回执（合成反例的材料）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  queueResponse({ toolCalls: [{ id: 'syn-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'syn loaded' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'rec-syn-1')
  await userTurn(handle, 'Load a hidden tool.')
  const { call, result } = await realLoadPairEvents(boot.ctx, 'rec-syn-1', 'syn-load')
  SYN = { boot, call, result, engine: runtimeOf(boot.ctx, 'rec-syn-1').engine }
  assert.deepEqual(boot.activationErrors(), [])
})

test('L03b1: 同 revision 继承对仍被 own-only 排除；同对放 own 位置可折叠（合成反例）', async () => {
  // 合成性质声明：真实 host fork 的父子 bindingGeneration 必然不同（probe 实证 revision-mismatch）；
  // 本反例把**同一 engine/catalog 下的真实回执**放到继承位置，单独证明 own-only 不依赖 revision 差异。
  const [call, result] = pairAt(SYN.call, SYN.result, 3)
  const stream = streamWith(5, [call, result])
  const inherited = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b1-inherited',
    liveBoundary: 5, // 对（seq 3/4）整段位于继承前缀
    queryResult: { inheritedEventCount: 5, events: stream }
  })
  const outInherited = await inherited.restore()
  assert.equal(outInherited.mode, 'ready')
  assert.equal(outInherited.applied, 0, '同 revision 的继承对也必须被 own-only 排除')
  assert.equal(outInherited.rejected, 0)
  assert.equal(SYN.engine.getState({ sessionId: 'syn-b1-inherited', actorId: 'actor-syn-b1-inherited' }).selected.size, 0)
  // 控制组：同对放 own 位置（boundary=0）必须可折叠 → 证明排除来自 own-only 而非对本身无效
  const control = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b1-control',
    liveBoundary: 0,
    queryResult: { inheritedEventCount: 0, events: streamWith(5, [call, result]) }
  })
  const outControl = await control.restore()
  assert.equal(outControl.mode, 'ready')
  assert.equal(outControl.applied, 1, 'own 位置的真实对必须折叠（正控）')
  assert.equal(outControl.rejected, 0)
})

test('L03b2: 零继承全 own 不误拒；跨界 call/result 不成对；不吃 own 首 load；own 坏对仍计 rejected', async () => {
  // 零继承（普通会话）：全 own，不误拒
  const [c0, r0] = pairAt(SYN.call, SYN.result, 3)
  const j0 = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b2-zero', liveBoundary: 0,
    queryResult: { inheritedEventCount: 0, events: streamWith(5, [c0, r0]) }
  })
  const out0 = await j0.restore()
  assert.deepEqual({ mode: out0.mode, applied: out0.applied, rejected: out0.rejected }, { mode: 'ready', applied: 1, rejected: 0 })

  // 混跨边界：call 继承（seq 3 < 5）、result own（seq 4 ≥ 5…按判据构造为 6）→ 残留配对必须为 0
  const [cMixCall] = pairAt(SYN.call, SYN.result, 3)
  const cMixResult = { ...SYN.result, seq: 6, sourceEventSeqs: [3] }
  const jMix = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b2-mixed', liveBoundary: 5,
    queryResult: { inheritedEventCount: 5, events: streamWith(7, [cMixCall, cMixResult]) }
  })
  const outMix = await jMix.restore()
  assert.deepEqual({ mode: outMix.mode, applied: outMix.applied, rejected: outMix.rejected }, { mode: 'ready', applied: 0, rejected: 0 },
    '跨界对不得折叠也不得计数（不能只滤 result 留下残留配对）')
  assert.equal(SYN.engine.getState({ sessionId: 'syn-b2-mixed', actorId: 'actor-syn-b2-mixed' }).selected.size, 0)

  // off-by-one：own 首个合法 load 不得被边界吃掉（两种合法布局）
  const [cExact, rExact] = pairAt(SYN.call, SYN.result, 5) // exact-cut：call 恰在边界
  const jExact = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b2-exact', liveBoundary: 5,
    queryResult: { inheritedEventCount: 5, events: streamWith(7, [cExact, rExact]) }
  })
  const outExact = await jExact.restore()
  assert.equal(outExact.applied, 1, 'exact-cut 布局下 own 首 load 必须折叠')
  const marker = { type: 'session/end-seed', seq: 5, data: { inherited: true } }
  const [cMark, rMark] = pairAt(SYN.call, SYN.result, 6) // 标记布局：marker 占边界位，own 从 +1 起
  const jMark = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b2-marker', liveBoundary: 5,
    queryResult: { inheritedEventCount: 5, events: streamWith(8, [marker, cMark, rMark]) }
  })
  const outMark = await jMark.restore()
  assert.equal(outMark.applied, 1, 'end-seed 标记布局下 own 首 load 必须折叠')

  // own 坏对（回执被改写）必须仍计 rejected：过滤不得吞掉安全判据
  const [cBad] = pairAt(SYN.call, SYN.result, 3)
  const rBad = tamperedResult(SYN.result, 4, 3)
  const jBad = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b2-bad', liveBoundary: 2,
    queryResult: { inheritedEventCount: 2, events: streamWith(5, [cBad, rBad]) }
  })
  const outBad = await jBad.restore()
  assert.equal(outBad.applied, 0)
  assert.equal(outBad.rejected, 1, 'own 坏对必须计 rejected（own-only 过滤不吞安全判据）')
})

test('L03b3: 缺/畸形/越界/冲突 inheritedEventCount 与异常 seq 流 → failClosed', async () => {
  const [c, r] = pairAt(SYN.call, SYN.result, 3)
  const stream = streamWith(5, [c, r])
  const cases = [
    { name: 'count-missing', live: 0, queryResult: { events: stream }, reason: 'inherited-boundary-invalid' },
    { name: 'count-negative', live: -1, queryResult: { inheritedEventCount: -1, events: stream }, reason: 'inherited-boundary-invalid' },
    { name: 'count-fraction', live: 1.5, queryResult: { inheritedEventCount: 1.5, events: stream }, reason: 'inherited-boundary-invalid' },
    { name: 'count-out-of-range', live: 9, queryResult: { inheritedEventCount: 9, events: stream }, reason: 'inherited-boundary-out-of-range' },
    { name: 'count-mismatch', live: 3, queryResult: { inheritedEventCount: 5, events: stream }, reason: 'inherited-boundary-mismatch' },
    { name: 'seq-gap', live: 0, queryResult: { inheritedEventCount: 0, events: streamWith(5, [c, r]).filter((e) => e.seq !== 2) }, reason: 'event-seq-not-contiguous' }
  ]
  for (const cse of cases) {
    const journal = syntheticJournal(SYN.engine, {
      sessionId: `syn-b3-${cse.name}`, liveBoundary: cse.live, queryResult: cse.queryResult
    })
    const outcome = await journal.restore()
    assert.equal(outcome.mode, 'incompatible', `${cse.name}: must fail closed`)
    assert.equal(outcome.reason, cse.reason, `${cse.name}: reason`)
  }
  // live 流：state 相关事件 seq 异常 → failClosed；普通会话（boundary 0）不受影响
  const jLive = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b3-live', liveBoundary: 0,
    queryResult: { inheritedEventCount: 0, events: [] }
  })
  jLive.onEvent({ type: 'tool/call', seq: 'bad', data: { name: 'tool_load', callId: 'x', arguments: '{}' } })
  assert.equal(SYN.engine.getState({ sessionId: 'syn-b3-live', actorId: 'actor-syn-b3-live' }).mode, 'incompatible',
    '异常 seq 的 state 事件必须 failClosed')
})

test('L03b4: query+buffer 同 seq 重复去重不双计', async () => {
  // 纯函数层：同 seq 重叠只保留一份、折叠只成一对
  const [c, r] = pairAt(SYN.call, SYN.result, 3)
  const merged = mergeBySeq(streamWith(5, [c, r]), [{ ...c }, { ...r }])
  assert.equal(merged.length, 5, '重叠事件按 seq 去重')
  assert.equal(foldPairs(merged).length, 1, '重复对不得双计')
  // 端到端：live 已应用 + restore 重放同对 → selected 仍为 1，重复计 duplicatesIgnored 而非二次激活
  const j = syntheticJournal(SYN.engine, {
    sessionId: 'syn-b4', liveBoundary: 0,
    queryResult: { inheritedEventCount: 0, events: streamWith(5, [c, r]) }
  })
  j.onEvent({ ...c })
  j.onEvent({ ...r })
  const outcome = await j.restore()
  const eng = SYN.engine.getState({ sessionId: 'syn-b4', actorId: 'actor-syn-b4' })
  assert.equal(eng.selected.size, 1, '同对不得双计激活')
  assert.equal(eng.integrity.applied, 1, '只激活一次')
  assert.ok(eng.integrity.duplicatesIgnored >= 1, '重放计 duplicatesIgnored')
  assert.equal(eng.integrity.rejected, 0, '去重重放不是安全拒绝')
  assert.ok(outcome !== undefined)
})

after(async () => {
  for (const handle of handles) {
    try { await handle.dispose() } catch { /* already disposed */ }
  }
  for (const dispose of cleanup) {
    try { dispose() } catch { /* already disposed */ }
  }
})

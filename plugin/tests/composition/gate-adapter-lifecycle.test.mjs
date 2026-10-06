// 组合测试补充：恢复链路(L01)、unload(F08)、候选 load 路径(F03 candidates/S03)。
// 独立于 gate-adapter.test.mjs，复用同一 harness。
//
// 运行：node --test progressive-v2/tests/composition/gate-adapter-lifecycle.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition } from './harness.mjs'

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

async function userTurn (handle, text) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }))
  await handle.agent.whenIdle()
}

// ---------------------------------------------------------------------------
// 场景 L：候选 load 路径（tool_search → tool_load(candidates)）
// ---------------------------------------------------------------------------
let L

test('boot L: 真实 Loader + adapter + mock provider（候选 load 场景）', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  L = boot
})

test('F03c: tool_search 命中 → 候选卡含 ref+revision（候选 load 全链由 domain 单测覆盖）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  // 1) search 命中 hidden_inherited
  queueResponse({
    toolCalls: [{ id: 'l-search-1', name: 'tool_search', arguments: { category: 'all', query: 'hidden inherited tool' } }]
  })
  queueResponse({ text: 'L search done' })

  const handle = await drive(L.ctx, L.tmpRoot, 'adapter-l-candidates-1')
  await userTurn(handle, 'Find a hidden tool.')
  // search 回执必须含 ref+revision
  const events = await rawEvents(L.ctx, 'adapter-l-candidates-1')
  const searchResult = toolResultFor(events, 'l-search-1')
  const searchEnvelope = JSON.parse(resultTextOf(searchResult))
  assert.equal(searchEnvelope.ok, true)
  assert.ok(searchEnvelope.data.candidates.length > 0, 'search must return candidates')
  const hit = searchEnvelope.data.candidates.find((c) => c.name === 'fixture_hidden_inherited')
  assert.ok(hit, `candidate for hidden tool: ${JSON.stringify(searchEnvelope.data.candidates.map((c) => c.name))}`)
  assert.ok(hit.ref && hit.revision, 'candidate card must carry ref and revision')
  // 候选 load 全链（search→load(candidates)→折叠）已由 domain 160 单测覆盖
})

test('S03c: 跨会话 ref → CANDIDATE_UNAVAILABLE', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  // 先在 session A 拿 ref
  queueResponse({
    toolCalls: [{ id: 's3-search', name: 'tool_search', arguments: { category: 'all', query: 'hidden inherited tool' } }]
  })
  queueResponse({ text: 'search done' })
  const handleA = await drive(L.ctx, L.tmpRoot, 'adapter-l-session-a')
  await userTurn(handleA, 'Search for hidden tool.')
  const eventsA = await rawEvents(L.ctx, 'adapter-l-session-a')
  const searchResult = toolResultFor(eventsA, 's3-search')
  const searchEnvelope = JSON.parse(resultTextOf(searchResult))
  const ref = searchEnvelope.data.candidates[0]?.ref
  assert.ok(ref, 'must have a ref from session A')

  // 在 session B 用 session A 的 ref
  queueResponse({
    toolCalls: [{ id: 's3-load', name: 'tool_load', arguments: { candidates: [{ ref, revision: searchEnvelope.data.candidates[0].revision }] } }]
  })
  queueResponse({ text: 'cross-session done' })
  const handleB = await drive(L.ctx, L.tmpRoot, 'adapter-l-session-b')
  await userTurn(handleB, 'Load using another session ref.')
  const eventsB = await rawEvents(L.ctx, 'adapter-l-session-b')
  const loadResult = toolResultFor(eventsB, 's3-load')
  const loadEnvelope = JSON.parse(resultTextOf(loadResult))
  assert.equal(loadEnvelope.ok, false, 'cross-session ref must be rejected')
  assert.equal(loadEnvelope.error.code, 'CANDIDATE_UNAVAILABLE')
})

// ---------------------------------------------------------------------------
// 场景 U：unload（F08）
// ---------------------------------------------------------------------------
let U

test('boot U: 真实 Loader + adapter（unload 场景）', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  U = boot
})

test('F08: load → unload → 下一请求移除 + 新调用拒绝 + 历史保留', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  // 1) load hidden_inherited
  queueResponse({ toolCalls: [{ id: 'u-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  // 2) 正控制：加载后合法调用
  queueResponse({ toolCalls: [{ id: 'u-legit', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } }] })
  // 3) unload
  queueResponse({ toolCalls: [{ id: 'u-unload', name: 'tool_load', arguments: { action: 'unload', toolIds: ['global::fixture_hidden_inherited'] } }] })
  // 4) 尝试调用已卸载工具（必须拒）
  queueResponse({ toolCalls: [{ id: 'u-guess', name: 'fixture_hidden_inherited', arguments: { text: 'after unload' } }] })
  queueResponse({ text: 'U done' })

  const handle = await drive(U.ctx, U.tmpRoot, 'adapter-u-unload-1')
  await userTurn(handle, 'Load, use, unload, try again.')

  const events = await rawEvents(U.ctx, 'adapter-u-unload-1')
  // load 成功
  const loadResult = toolResultFor(events, 'u-load')
  assert.equal(JSON.parse(resultTextOf(loadResult)).ok, true)
  // 正控制：合法调用执行
  assert.equal(store.bodyCount('u-legit'), 1)
  // unload 成功
  const unloadResult = toolResultFor(events, 'u-unload')
  const unloadEnvelope = JSON.parse(resultTextOf(unloadResult))
  assert.equal(unloadEnvelope.ok, true, `unload must succeed: ${resultTextOf(unloadResult)}`)
  // 卸载后调用被拒，body=0
  assert.equal(store.bodyCount('u-guess'), 0, 'after unload body must be 0')
  const guessResult = toolResultFor(events, 'u-guess')
  assert.equal(guessResult.data.message.isError, true, 'guess after unload must be rejected')
  // 历史保留：卸载回执仍在 events 中
  assert.ok(events.some((e) => e.type === 'tool/result' && resultTextOf(e).includes('unload')), 'unload receipt must remain in history')
})

// ---------------------------------------------------------------------------
// 场景 R：恢复链路（L01，重开 composition 后冷恢复）
// ---------------------------------------------------------------------------
let R

test('boot R: 真实 Loader + adapter（恢复场景）', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  R = boot
})

test('L01: load 后重开 composition → 从 jsonl 冷恢复 selected（强断言，禁止条件空转）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  // 1) load
  queueResponse({ toolCalls: [{ id: 'r-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'R load done' })
  const handle = await drive(R.ctx, R.tmpRoot, 'adapter-r-restore-1')
  await userTurn(handle, 'Load a hidden tool.')
  // 验证 load 后 selected
  const events = await rawEvents(R.ctx, 'adapter-r-restore-1')
  const loadResult = toolResultFor(events, 'r-load')
  assert.equal(JSON.parse(resultTextOf(loadResult)).ok, true)

  // 2) 关闭 handle（持久化落盘）后重开 composition（同一 tmpRoot；不得删除 jsonl）
  await handle.dispose()
  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    tmpRoot: R.tmpRoot
  })
  cleanup.push(() => boot2.dispose())

  // 3) 用真实宿主 resume API 恢复同 session（不是同 id 冒充新建）
  const handle2 = await boot2.ctx.agents.resume({
    resumeSessionId: 'adapter-r-restore-1',
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }
  })
  handles.push(handle2)

  // 恢复期首请求：restoring 期间刻意只留三入口（fail-safe 正控制），不立即触发执行断言
  queueResponse({ text: 'R pre-recovery turn' })
  await userTurn(handle2, 'Continue after restart.')

  // 4) 强断言：状态必须存在且恢复成功（修复旧断言 ctx.expose 取空 + mode 条件空转）
  const svc = boot2.ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery service must be reachable via ctx.get')
  const state = svc.sessions.get('adapter-r-restore-1')
  assert.ok(state !== undefined, 'session runtime must exist after resume (旧测试 ctx.expose 恒为空)')
  const restored = await state.journal.whenRestored()
  assert.ok(restored !== undefined, 'cold restore must have run (session had history)')
  assert.equal(restored.mode, 'ready', `restore must be ready: ${JSON.stringify(restored)}`)
  assert.equal(restored.applied, 1, 'exactly the one canonical load pair replays')
  assert.equal(restored.rejected, 0, 'no pair may be rejected on a clean journal')
  const engState = state.engine.getState(state.scope)
  assert.equal(engState.mode, 'ready')
  assert.deepEqual([...engState.selected.values()].map((s) => s.name).sort(), ['fixture_hidden_inherited'],
    'restored selected must contain exactly the previously loaded tool')

  // 5) 披露与执行正控制：恢复落定后下一请求披露恢复项，合法调用真的执行一次
  const restoringFirst = (store.requests[2]?.tools ?? []).map((t) => t.name).sort()
  assert.deepEqual(restoringFirst, ['tool_list', 'tool_load', 'tool_search'],
    `restoring-window request must stay at three entries: ${restoringFirst}`)
  queueResponse({
    toolCalls: [
      { id: 'r-legit', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } },
      { id: 'r-guess', name: 'fixture_hidden_scope', arguments: { text: 'guess' } }
    ]
  })
  queueResponse({ text: 'R restore done' })
  await userTurn(handle2, 'Use the restored tool.')
  const resumedRequests = store.requests.slice(2)
  const disclosed = (resumedRequests[1]?.tools ?? []).map((t) => t.name).sort()
  assert.deepEqual(disclosed, ['fixture_hidden_inherited', 'tool_list', 'tool_load', 'tool_search'],
    `post-restore request must disclose exactly the restored tool: ${disclosed}`)
  assert.equal(store.bodyCount('r-legit'), 1, 'restored tool call must run exactly once')
  // 6) 负控制：未 load 的隐藏工具不披露且猜名 body=0
  assert.equal(store.bodyCount('r-guess'), 0, 'never-loaded hidden tool body must not run')
  const guess = toolResultFor(await rawEvents(boot2.ctx, 'adapter-r-restore-1'), 'r-guess')
  assert.equal(guess.data.message.isError, true, 'guess of never-loaded tool must be rejected')
  const allTools = resumedRequests.flatMap((r) => (r.tools ?? []).map((t) => t.name))
  assert.equal(allTools.includes('fixture_hidden_scope'), false, 'never-loaded tool must never be disclosed')
})

after(async () => {
  for (const handle of handles) {
    try { await handle.dispose() } catch { /* already disposed */ }
  }
  for (const dispose of cleanup) {
    try { dispose() } catch { /* already disposed */ }
  }
})

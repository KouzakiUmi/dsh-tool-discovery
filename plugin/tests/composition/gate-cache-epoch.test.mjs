// 组合测试：缓存周期（cache epoch）在**真实 Loader + 真实 DSH 宿主**上的行为。
//
// 产品契约（两次成功上下文压缩之间）：
//   1. 工具加载只增量追加：A 的 wire 严格逐字不变，原序列是新序列的前缀；
//      顺序由**首次披露次序**决定，绝不由宿主字典序决定。
//   2. schema 换版不得静默更新冻结 wire，但 guard 不放宽（执行被拒）。
//   3. 唯一重置源 = 成功压缩（匹配 compaction/start + 无 error 的 compaction/end）；
//      失败 / 取消 / 孤立 end 一律不重置。
//   4. 成功压缩后的冷恢复不得复活压缩前的 load 回执；新 load 仍可正常披露并执行。
//   5. 常驻工具与三入口不随 reset 消失。
//   6. 模型不得自主 unload。
//
// 运行：node --test plugin/tests/composition/gate-cache-epoch.test.mjs
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

/** 出站请求的**有序**工具名序列（mock provider 录到的最终 GenerateOptions）。 */
function namesInOrder (request) {
  return (request?.tools ?? []).map((tool) => tool.name)
}

function toolByName (request, name) {
  return (request?.tools ?? []).find((tool) => tool.name === name)
}

function lastRequest (store) {
  return store.requests[store.requests.length - 1]
}

function runtimeOf (ctx, sessionId) {
  const svc = ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery service must be reachable via ctx.get')
  const runtime = svc.sessions.get(sessionId)
  assert.ok(runtime !== undefined, `runtime must exist for ${sessionId}`)
  return runtime
}

/**
 * 用与 dsh-compaction-basic `compactSurfaceRegion` 完全相同的两步 append 模拟一次压缩。
 * 成功路径 = start + 无 error 的 end；失败路径 = start + 带 error 的 end。
 * 手动 /compact 与自动压缩在宿主里走同一个函数，因此这里一条路径覆盖两者。
 */
function appendCompaction (handle, compactionId, { failed = false, orphanEnd = false, summary = false } = {}) {
  const session = handle.agent.session
  if (!orphanEnd) session.append('compaction/start', { compactionId, turn: null })
  if (summary) {
    // 真实压缩会在 start 与 end 之间落一条 compaction/summary；宿主自己的日志格式
    // 校验据此判定「成功的 end 必须有一次摘要」（dsh-session-format-v3-to-v4:723）。
    session.append('compaction/summary', {
      compactionId,
      summary: 'compacted',
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [],
      shadowedTokenCount: 0
    })
  }
  session.append('compaction/end', failed
    ? { compactionId, turn: null, error: { name: 'SurfaceChangedError', message: 'changed during compaction' } }
    : { compactionId, turn: null })
}

after(() => {
  for (const dispose of cleanup.reverse()) {
    try { dispose() } catch { /* 清理失败不影响结论 */ }
  }
})

// ---------------------------------------------------------------------------
// 场景 CE1：增量追加 + 顺序固化 + 换版不静默更新冻结 wire
// ---------------------------------------------------------------------------
const CE1 = { handle: null, sessionId: 'ce1-append-1' }

test('boot CE1: 真实 Loader + adapter（缓存周期场景）', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  CE1.ctx = boot.ctx
  CE1.tmpRoot = boot.tmpRoot
})

test('CE1: 载 mutating 再载 hidden → 出站序列按加载序追加，mutating 的 wire 逐字不变', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  // 故意先加载字典序靠后的 fixture_mutating：任何"按名字/按宿主 incoming 顺序排"的
  // 实现都会在这里露馅（宿主与字典序都会给出 hidden 在前）。
  queueResponse({ toolCalls: [{ id: 'ce1-load-1', name: 'tool_load', arguments: { names: ['fixture_mutating'] } }] })
  queueResponse({ toolCalls: [{ id: 'ce1-load-2', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  // 正控制：两个工具都能真的执行
  queueResponse({
    toolCalls: [
      { id: 'ce1-use-mut', name: 'fixture_mutating', arguments: { text: 'm' } },
      { id: 'ce1-use-hid', name: 'fixture_hidden_inherited', arguments: { text: 'h' } }
    ]
  })
  queueResponse({ text: 'CE1 done' })

  CE1.handle = await drive(CE1.ctx, CE1.tmpRoot, CE1.sessionId)
  await userTurn(CE1.handle, 'Load mutating first, then hidden.')

  const events = await rawEvents(CE1.ctx, CE1.sessionId)
  assert.equal(JSON.parse(resultTextOf(toolResultFor(events, 'ce1-load-1'))).ok, true)
  assert.equal(JSON.parse(resultTextOf(toolResultFor(events, 'ce1-load-2'))).ok, true)

  const baseline = namesInOrder(store.requests[0])
  assert.deepEqual(baseline, ['tool_list', 'tool_load', 'tool_search'], '首请求只有三入口')

  const afterFirst = namesInOrder(store.requests[1])
  assert.deepEqual(afterFirst, [...baseline, 'fixture_mutating'], '第一次 load 是纯追加')

  const afterSecond = namesInOrder(store.requests[2])
  assert.deepEqual(afterSecond, [...baseline, 'fixture_mutating', 'fixture_hidden_inherited'],
    '第二次 load 必须追加在**加载序**后面，而不是字典序')

  // A 的 wire 严格逐字不变（不是"名字还在"，是定义逐字相同）
  assert.deepEqual(toolByName(store.requests[2], 'fixture_mutating'),
    toolByName(store.requests[1], 'fixture_mutating'),
    '已披露工具的 wire 必须逐字不变')
  // 原序列是新序列的前缀；JSON 也要逐字相同，不能只用 deepEqual 忽略键序变化。
  assert.deepEqual(afterSecond.slice(0, afterFirst.length), afterFirst, '原序列必须是新序列的前缀')
  assert.equal(JSON.stringify(store.requests[2].tools.slice(0, afterFirst.length)),
    JSON.stringify(store.requests[1].tools), '既有工具块的 JSON 字节序列必须不变')
  // 正向判据：确实不是字典序（防止断言被一个恰好同序的 bug 骗过）
  assert.equal([...afterSecond].sort().join(',') === afterSecond.join(','), false,
    '本用例必须在"加载序 ≠ 字典序"的前提下才有判别力')

  // 正控制：执行授权没被缓存固化顺带破坏
  assert.equal(store.bodyCount('ce1-use-mut'), 1)
  assert.equal(store.bodyCount('ce1-use-hid'), 1)
})

test('CE2: 重复 load 幂等 —— 不重复披露、不重排、wire 不变', async () => {
  const { store, queueResponse } = await storeOf()
  const before = namesInOrder(store.requests[2])
  queueResponse({ toolCalls: [{ id: 'ce2-load-again', name: 'tool_load', arguments: { names: ['fixture_mutating'] } }] })
  queueResponse({ text: 'CE2 done' })

  await userTurn(CE1.handle, 'Load mutating again.')

  const events = await rawEvents(CE1.ctx, CE1.sessionId)
  assert.equal(JSON.parse(resultTextOf(toolResultFor(events, 'ce2-load-again'))).ok, true,
    '重复 load 仍返回 ok（幂等）')

  const after = namesInOrder(lastRequest(store))
  assert.deepEqual(after, before, '重复 load 不改变披露序列：不追加、不重排')
  assert.deepEqual(toolByName(lastRequest(store), 'fixture_mutating'),
    toolByName(store.requests[2], 'fixture_mutating'), 'wire 仍逐字不变')
  const count = after.filter((n) => n === 'fixture_mutating').length
  assert.equal(count, 1, '同一工具不得出现两次')
})

test('CE5: schema 换版 → 冻结 wire 不静默更新，但 guard 仍拒绝执行', async () => {
  const { store, queueResponse } = await storeOf()

  queueResponse({ toolCalls: [{ id: 'ce5-load', name: 'tool_load', arguments: { names: ['fixture_hidden_scope'] } }] })
  queueResponse({ toolCalls: [{ id: 'ce5-use-before', name: 'fixture_hidden_scope', arguments: { text: 'ok' } }] })
  queueResponse({ text: 'CE5 baseline' })
  await userTurn(CE1.handle, 'Load the scope-own tool.')
  await userTurn(CE1.handle, 'Use the scope-own tool.')

  const frozenBefore = toolByName(lastRequest(store), 'fixture_hidden_scope')
  assert.ok(frozenBefore !== undefined, 'scope 工具应已披露')
  const disclosed = namesInOrder(lastRequest(store))
  assert.equal(store.bodyCount('ce5-use-before'), 1, '正控制：换版前执行授权有效')

  // 真实换版：宿主就地把同一 definition 实例的 schema 改了（registry 的绑定代次
  // 就是按"实例被就地改"兜底的），wire 与实例随之变化。
  const definition = CE1.ctx.tools.get('fixture_hidden_scope', CE1.handle.agent)
  assert.ok(definition !== undefined, '宿主 registry 必须解析得到该 scope 工具')
  definition.description = 'CHANGED description after an in-place schema change.'
  definition.parameters = { text: { type: 'string', required: true, description: 'Changed payload.' } }
  // 真实的绑定变更一定会广播 tools/change；用一个无关工具的注册/注销来触发它
  // （registry 的 per-binding 代次保证无关变更不会误伤别的 selected）。
  const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))
  const churn = CE1.ctx.tools.register(defineTool({
    name: 'ce5_unrelated_churn',
    description: 'Unrelated tool used only to broadcast a real tools/change.',
    parameters: { x: { type: 'string', description: 'unused' } },
    output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => 'ok'
  }))
  churn()

  // 先出工具调用、再出文本：mock 的 text 响应会结束本轮，工具调用会续跑一步
  queueResponse({ toolCalls: [{ id: 'ce5-try', name: 'fixture_hidden_scope', arguments: { text: 'z' } }] })
  queueResponse({ text: 'CE5 done' })
  await userTurn(CE1.handle, 'Call the tool after it changed.')

  assert.deepEqual(namesInOrder(store.requests[store.requests.length - 2]), disclosed,
    '换版不得改变披露序列')
  const frozenAfter = toolByName(store.requests[store.requests.length - 2], 'fixture_hidden_scope')
  assert.deepEqual(frozenAfter, frozenBefore, '出站 wire 必须仍是首次冻结的那份，不得静默更新')
  assert.equal(JSON.stringify(frozenAfter).includes('CHANGED description'), false,
    '新版本描述不得泄漏进已冻结的披露')

  // 执行面不放宽：换版后 guard 拒绝
  const events = await rawEvents(CE1.ctx, CE1.sessionId)
  const attempt = toolResultFor(events, 'ce5-try')
  assert.equal(attempt.data.message.isError, true, '换版后调用必须被拒')
  assert.match(resultTextOf(attempt), /TOOL_NOT_LOADED/)
})

test('CE6: 模型不得自主 unload —— action=unload 被拒且披露不受影响', async () => {
  const { store, queueResponse } = await storeOf()
  const before = namesInOrder(lastRequest(store))

  queueResponse({
    toolCalls: [{ id: 'ce6-unload', name: 'tool_load', arguments: { action: 'unload', toolIds: ['global::fixture_mutating'] } }]
  })
  queueResponse({ toolCalls: [{ id: 'ce6-still-usable', name: 'fixture_mutating', arguments: { text: 'still' } }] })
  queueResponse({ text: 'CE6 done' })

  await userTurn(CE1.handle, 'Try to unload mutating.')

  const events = await rawEvents(CE1.ctx, CE1.sessionId)
  const unloadResult = toolResultFor(events, 'ce6-unload')
  const unloadText = resultTextOf(unloadResult)
  // enum 里已没有 unload，宿主在参数校验阶段就挡掉了 —— 模型连这条调用都发不出来。
  // （域层同样独立拒绝：见 unit epoch.test.mjs E08 / protocol.test.mjs。）
  assert.equal(unloadResult.data.message.isError, true, 'unload 调用必须被拒')
  assert.match(unloadText, /"action" must be one of \["load"\]/, `实际结果：${unloadText.slice(0, 200)}`)
  assert.deepEqual(namesInOrder(store.requests[store.requests.length - 2]), before,
    '被拒的 unload 不得改变披露序列')
  assert.deepEqual(namesInOrder(lastRequest(store)), before, '披露缓存不受 unload 影响')
  // 执行授权也没被误伤
  assert.equal(store.bodyCount('ce6-still-usable'), 1, '已加载的工具仍可执行')
})

// ---------------------------------------------------------------------------
// 场景 CE3：成功压缩是唯一重置源
// ---------------------------------------------------------------------------
const CE3 = { handle: null, sessionId: 'ce3-reset-1' }

test('boot CE3: 真实 Loader + adapter（压缩重置场景）', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  CE3.ctx = boot.ctx
  CE3.tmpRoot = boot.tmpRoot
})

test('CE3: 失败压缩与孤立 end 不重置；成功压缩才重置', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  queueResponse({ toolCalls: [{ id: 'ce3-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'CE3 loaded' })

  CE3.handle = await drive(CE3.ctx, CE3.tmpRoot, CE3.sessionId)
  await userTurn(CE3.handle, 'Load the hidden tool.')
  const baseline = namesInOrder(store.requests[1])
  assert.deepEqual(baseline, ['tool_list', 'tool_load', 'tool_search', 'fixture_hidden_inherited'])

  // (a) 失败的压缩：有匹配 start，但 end 带 error → 不重置
  queueResponse({ text: 'CE3 after failed compaction' })
  appendCompaction(CE3.handle, 'ce-failed', { failed: true })
  await userTurn(CE3.handle, 'After a failed compaction.')
  assert.deepEqual(namesInOrder(lastRequest(store)), baseline,
    '失败压缩不得清掉已披露 schema（模型上下文原样保留）')

  // (b) 孤立 end：没有匹配 start → 不重置（不能假定那是一次成功压缩）
  queueResponse({ text: 'CE3 after orphan end' })
  appendCompaction(CE3.handle, 'ce-orphan', { orphanEnd: true })
  await userTurn(CE3.handle, 'After an orphan end.')
  assert.deepEqual(namesInOrder(lastRequest(store)), baseline,
    '孤立 compaction/end 不得构成重置')

  // (b2) 有匹配 start 但**没有摘要**的 end：宿主格式校验认为这不是一次成功压缩
  queueResponse({ text: 'CE3 after summary-less end' })
  appendCompaction(CE3.handle, 'ce-nosummary')
  await userTurn(CE3.handle, 'After an end without a summary.')
  assert.deepEqual(namesInOrder(lastRequest(store)), baseline,
    '无摘要的 compaction/end 不得构成重置')

  // (c) 成功压缩：匹配 start + 一次摘要 + 无 error 的 end → 重置
  queueResponse({ text: 'CE3 after successful compaction' })
  appendCompaction(CE3.handle, 'ce-ok', { summary: true })
  await userTurn(CE3.handle, 'After a successful compaction.')
  const afterReset = namesInOrder(lastRequest(store))
  assert.deepEqual(afterReset, ['tool_list', 'tool_load', 'tool_search'],
    '成功压缩后披露缓存清空，只剩常驻基线')

  // (d) 常驻基线（三入口）不因 reset 消失
  for (const name of ['tool_list', 'tool_load', 'tool_search']) {
    assert.ok(afterReset.includes(name), `常驻入口 ${name} 不随 reset 消失`)
  }

  // (e) reset 后执行授权也没了：原工具的调用被拒
  queueResponse({ toolCalls: [{ id: 'ce3-after', name: 'fixture_hidden_inherited', arguments: { text: 'no' } }] })
  queueResponse({ text: 'CE3 done' })
  await userTurn(CE3.handle, 'Call the tool that was compacted away.')
  assert.equal(store.bodyCount('ce3-after'), 0, '成功压缩后旧工具不得执行')
  const events = await rawEvents(CE3.ctx, CE3.sessionId)
  const attempt = toolResultFor(events, 'ce3-after')
  assert.equal(attempt.data.message.isError, true)
  assert.match(resultTextOf(attempt), /TOOL_NOT_LOADED/)
})

test('CE3b: 成功压缩后新 load 可正常披露并执行', async () => {
  const { store, queueResponse } = await storeOf()
  queueResponse({ toolCalls: [{ id: 'ce3b-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'ce3b-use', name: 'fixture_hidden_inherited', arguments: { text: 'again' } }] })
  queueResponse({ text: 'CE3b done' })

  await userTurn(CE3.handle, 'Load it again after compaction.')

  const events = await rawEvents(CE3.ctx, CE3.sessionId)
  assert.equal(JSON.parse(resultTextOf(toolResultFor(events, 'ce3b-load'))).ok, true)
  assert.ok(namesInOrder(store.requests[store.requests.length - 2]).includes('fixture_hidden_inherited'),
    '新周期内重新 load 可正常披露')
  assert.equal(store.bodyCount('ce3b-use'), 1, '新周期内重新 load 可正常执行')
})

// ---------------------------------------------------------------------------
// 场景 CE7：压缩边界在**恢复**路径上的判定（journal 层，确定性事件流）
// ---------------------------------------------------------------------------
// 端到端重启（CE4）依赖宿主 surface 机制，这里直接把同一段事件流喂给真实
// createJournal，断言的是同一份边界代码：压缩前的 load 回执不复活，压缩后的活。
function fakeEngine () {
  const state = { selected: new Map(), frozen: new Map(), epoch: 1, resets: 0, restoreArgs: [] }
  return {
    _state: state,
    getState: () => ({ mode: 'restoring', selected: state.selected, invalidated: new Map() }),
    getCatalog: () => ({ entries: new Map() }),
    failClosed: () => {},
    resetCacheEpoch: () => { state.resets += 1; state.epoch += 1; state.selected.clear(); state.frozen.clear() },
    recordAdvertisement: () => {},
    applyCanonicalPair: () => ({ applied: true }),
    restore: (pairs) => { state.restoreArgs.push(pairs); return { mode: 'ready', applied: pairs.length, rejected: 0 } }
  }
}

/** 顺序构造器：保证 seq 自 0 连续（journal 的 seq 流完整性判据要求 seq === 下标）。 */
function eventStream () {
  const events = []
  return {
    events,
    header () {
      events.push({ type: 'request/header', seq: events.length, data: { header: { tools: [] } } })
      return this
    },
    load (callId, names) {
      const callSeq = events.length
      const receipt = {
        kind: 'tool-discovery.selection',
        version: 2,
        operationId: `op_${callId}`,
        operation: 'load',
        selectionSource: 'name',
        selected: names.map((name) => ({ toolId: `t_${name}`, name, revision: 'r', schemaDigest: 'd', skillRevision: 's' }))
      }
      const shell = { protocolVersion: 2, tool: 'tool_load', ok: true, data: { receipt } }
      events.push({ type: 'tool/call', seq: callSeq, data: { callId, name: 'tool_load', arguments: JSON.stringify({ names }) } })
      events.push({
        type: 'tool/result',
        seq: events.length,
        sourceEventSeqs: [callSeq],
        data: { message: { isError: false, content: [{ type: 'text', text: JSON.stringify(shell) }] } }
      })
      return this
    },
    compaction (compactionId, { summarized = false, failed = false, orphanEnd = false } = {}) {
      if (!orphanEnd) events.push({ type: 'compaction/start', seq: events.length, data: { compactionId, turn: null } })
      if (summarized) events.push({ type: 'compaction/summary', seq: events.length, data: { compactionId, summary: 's' } })
      events.push({
        type: 'compaction/end',
        seq: events.length,
        data: failed ? { compactionId, error: { message: 'x' } } : { compactionId }
      })
      return this
    }
  }
}

/** 用真实 createJournal 跑一遍冷恢复，返回折叠进 engine 的 pair。 */
async function restoreThrough (events, sessionId) {
  const { createJournal } = await import('../../adapters/dsh/journal.mjs')
  const engine = fakeEngine()
  const journal = createJournal({
    ctx: {},
    session: { seq: events.length, inheritedEventCount: 0 },
    scope: { sessionId, actorId: 'a' },
    engine,
    query: { readSession: async () => ({ events, inheritedEventCount: 0 }) }
  })
  const outcome = await journal.restore()
  return { outcome, engine, pairs: engine._state.restoreArgs[0] }
}

test('CE7: 恢复遵守成功压缩边界 —— 压缩前的 load 不复活，压缩后的活', async () => {
  const events = eventStream()
    .header()
    .load('pre-1', ['alpha'])
    .compaction('cx', { summarized: true })
    .load('post-1', ['beta'])
    .events

  const { outcome, engine, pairs } = await restoreThrough(events, 'ce7')
  assert.equal(outcome.mode, 'ready', `restore must be ready: ${JSON.stringify(outcome)}`)

  const loadedNames = pairs.map((p) => p.call.input.names[0])
  assert.deepEqual(loadedNames, ['beta'],
    '只有成功压缩边界之后的 load 回执可被折叠；压缩前的 alpha 不得复活')
  assert.equal(engine._state.resets, 0, '恢复路径只认边界，不在恢复中重置')
})

test('CE7b: 失败压缩 / 孤立 end / 无摘要 的边界下界不被采信', async () => {
  for (const variant of [
    { label: 'failed', opts: { summarized: true, failed: true } },
    { label: 'orphan-end', opts: { summarized: true, orphanEnd: true } },
    { label: 'no-summary', opts: { summarized: false } }
  ]) {
    const events = eventStream()
      .header()
      .load('pre-1', ['alpha'])
      .compaction('cx', variant.opts)
      .load('post-1', ['beta'])
      .events

    const { outcome, pairs } = await restoreThrough(events, `ce7b-${variant.label}`)
    assert.equal(outcome.mode, 'ready')
    const loaded = pairs.map((p) => p.call.input.names[0])
    assert.deepEqual(loaded, ['alpha', 'beta'],
      `${variant.label}: 未构成成功压缩 → 两个周期的 load 都必须可恢复`)
  }
})
// ---------------------------------------------------------------------------
// 场景 CE4：真实重启的冷恢复回归（边界过滤器不得破坏正常恢复）
// ---------------------------------------------------------------------------
// 说明：这里**不**手工构造压缩事件。宿主的持久化读路径会校验 compaction/summary 的
// shadowedSeqs 必须精确命名一段当前 surface（dsh-session-format-v3-to-v4:731），
// 测试无法低成本造出合法的压缩事务。因此「压缩后重启不复活旧工具」由 CE7 在 journal
// 层用同一份边界代码断言；此处守住另一半：没有压缩时，恢复必须照旧把 load 复活
// 并可执行（边界过滤器的负向回归）。
test('CE4: 无压缩的真实重启 → 冷恢复照旧复活此前的 load 并可执行', async () => {
  const boot1 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {}
  })
  cleanup.push(() => boot1.dispose())
  const { store, queueResponse } = await storeOf()
  store.reset()

  const sessionId = 'ce4-restore-1'
  queueResponse({ toolCalls: [{ id: 'ce4-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'CE4 phase1' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, sessionId)
  await userTurn(h1, 'Load the hidden tool.')
  assert.deepEqual(namesInOrder(store.requests[1]),
    ['tool_list', 'tool_load', 'tool_search', 'fixture_hidden_inherited'], 'phase1 已披露')
  await h1.dispose()

  // 重启 composition（同一 tmpRoot → 同一持久化会话），走真实冷恢复
  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())

  queueResponse({ text: 'CE4 restored turn' })
  const h2 = await resumeDrive(boot2.ctx, sessionId)
  // 恢复是异步的：先跑一轮让 runtime 建起来并等恢复完成，再取"恢复之后"的出站序列
  await userTurn(h2, 'Continue after restart.')
  const outcome = await runtimeOf(boot2.ctx, sessionId).journal.whenRestored()
  assert.equal(outcome.mode, 'ready', `cold restore must be ready: ${JSON.stringify(outcome)}`)

  queueResponse({ text: 'CE4 after restore' })
  await userTurn(h2, 'Anything.')

  assert.deepEqual(namesInOrder(lastRequest(store)),
    ['tool_list', 'tool_load', 'tool_search', 'fixture_hidden_inherited'],
    `没有成功压缩时，此前的 load 必须照旧复活（边界过滤器不得误杀）；实际：${namesInOrder(lastRequest(store)).join(', ')}`)

  // 恢复后仍可执行
  queueResponse({ toolCalls: [{ id: 'ce4-use2', name: 'fixture_hidden_inherited', arguments: { text: 'post-restore' } }] })
  queueResponse({ text: 'CE4 done' })
  await userTurn(h2, 'Call the restored tool.')
  assert.equal(store.bodyCount('ce4-use2'), 1, '恢复后的执行授权有效')
})

// 用宿主真正的压缩服务生成合法 summary / shadow / end，不手造压缩事件。
test('CE8: 真实手动压缩事务 → 保存并重启 → 旧工具不复活，新加载仍可执行', async () => {
  const options = {
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    extraServices: [
      { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic',
        config: { auto: false, headroomTokens: 1024, maxTokens: 256, compactionRetries: 0 } }
    ]
  }
  const boot1 = await bootAdapterComposition(options)
  cleanup.push(() => boot1.dispose())
  const { store, queueResponse } = await storeOf()
  store.reset()
  const sessionId = 'ce8-real-compaction'
  queueResponse({ toolCalls: [{ id: 'ce8-load-old', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'Completed the earlier inspection. '.repeat(500) })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, sessionId)
  await userTurn(h1, 'Inspect this context before continuing. '.repeat(500))
  assert.ok(namesInOrder(lastRequest(store)).includes('fixture_hidden_inherited'))
  const compaction = boot1.ctx.get('compaction')
  assert.ok(compaction, '真实压缩服务必须激活')
  queueResponse({ text: 'Continue the inspection task.' })
  const result = await compaction.compactNow(h1.agent, new AbortController().signal)
  assert.ok(result !== null && result.shadowedSeqs.length > 0, '必须真正压缩过历史，禁止 no-op 空转')
  assert.equal(runtimeOf(boot1.ctx, sessionId).engine.getFrozenWire(runtimeOf(boot1.ctx, sessionId).scope).length, 0)
  await h1.dispose()

  const boot2 = await bootAdapterComposition({ ...options, tmpRoot: boot1.tmpRoot })
  cleanup.push(() => boot2.dispose())
  queueResponse({ text: 'Resumed after compaction.' })
  const h2 = await resumeDrive(boot2.ctx, sessionId)
  await userTurn(h2, 'Continue.')
  const runtime = runtimeOf(boot2.ctx, sessionId)
  assert.equal((await runtime.journal.whenRestored()).mode, 'ready')
  queueResponse({ text: 'Check restored tools.' })
  await userTurn(h2, 'Check the new cache epoch.')
  assert.deepEqual(namesInOrder(lastRequest(store)), ['tool_list', 'tool_load', 'tool_search'],
    '真实压缩并重启后不能复活旧工具')
  assert.equal(runtime.engine.getState(runtime.scope).selected.size, 0)
  queueResponse({ toolCalls: [{ id: 'ce8-load-new', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'ce8-use-new', name: 'fixture_hidden_inherited', arguments: { text: 'new epoch' } }] })
  queueResponse({ text: 'Done.' })
  await userTurn(h2, 'Load the tool again.')
  assert.equal(store.bodyCount('ce8-use-new'), 1, '新周期重新加载后可以真正执行')
})

test('CE9: 真实 DSH 压力自动压缩 → 下一请求只保留常驻入口', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'], adapter: {},
    extraServices: [
      { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic',
        config: { auto: true, thresholdRatio: 0.01, retainTokens: 128,
          headroomTokens: 1024, maxTokens: 256, compactionRetries: 0 } }
    ]
  })
  cleanup.push(() => boot.dispose())
  const { store, queueResponse } = await storeOf()
  store.reset()
  const h = await drive(boot.ctx, boot.tmpRoot, 'ce9-auto-compaction')
  queueResponse({ toolCalls: [{ id: 'ce9-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'Earlier inspection details. '.repeat(1000),
    usage: { inputTokens: 1000, outputTokens: 10000 } })
  await userTurn(h, 'Load the tool and inspect the earlier context.')
  assert.ok(namesInOrder(lastRequest(store)).includes('fixture_hidden_inherited'))
  const previousRequests = store.requests.length
  queueResponse({ text: 'Earlier inspection has been summarized.' })
  queueResponse({ text: 'Continue with the compacted context.' })
  await userTurn(h, 'Continue the task.')
  const newRequests = store.requests.slice(previousRequests)
  assert.ok(newRequests.some((request) => request.purpose === 'compaction'),
    '必须由真实自动压力钩子触发摘要请求，禁止手工制造成功事件')
  const compactionEvents = (await rawEvents(boot.ctx, h.agent.session.id))
    .filter((event) => event.type.startsWith('compaction/'))
  assert.ok(compactionEvents.some((event) => event.type === 'compaction/end' && event.data.error === undefined),
    `自动压缩必须真正成功：${JSON.stringify(compactionEvents)}`)
  assert.deepEqual(namesInOrder(lastRequest(store)), ['tool_list', 'tool_load', 'tool_search'],
    `成功自动压缩后不得继续披露旧工具：${JSON.stringify(compactionEvents)}`)
  const runtime = runtimeOf(boot.ctx, h.agent.session.id)
  assert.equal(runtime.engine.getState(runtime.scope).selected.size, 0)
  assert.equal(runtime.engine.getFrozenWire(runtime.scope).length, 0)
})
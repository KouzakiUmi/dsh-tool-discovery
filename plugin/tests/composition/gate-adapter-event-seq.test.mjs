// 组合测试补充：journal live 路径的 canonical tool/result 畸形 seq 门禁
// （PR#1 review r4194293741：isStateAffecting 只认 request/header 与 tool_load call，
//  把"提交 load/unload 的 result"当成非状态事件静默丢弃）。
// 独立于 gate-adapter / gate-adapter-lifecycle / gate-adapter-recovery，复用同一 harness。
//
// 断言纪律：
//   * 真实 Loader composition + 真实 domain engine + **真实宿主产出的事件形状**
//     （call / result / 出站 request/header 全部取自真实 sessionQuery.readSession）。
//   * 故障注入有界：只破坏 result 的 `seq` 字段（外加 callId/回执 operationId 按
//     entries.mjs 的 `op_<callId>` 规则成对改写，使事件对自洽）。不改真实宿主，
//     不伪造"自然宿主不可能产生"的畸形组合。
//   * 只用公开面：engine.ready / getState / evaluateCall / handleLoad / getPendingSize
//     与 journal.onEvent / restore / activeSelectedNames。不靠内部字段名做断言。
//   * 每条安全断言配正控制；不做「取到 undefined 就跳过」式空转。
//   * 结论分三类分别取证：仅没新增授权 / 旧选择残留 / **真实撤销失败**。
//
// 运行：node --test plugin/tests/composition/gate-adapter-event-seq.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition } from './harness.mjs'
import { createJournal } from '../../adapters/dsh/journal.mjs'

const handles = []
const cleanup = []

async function storeOf () {
  return import(new URL('../../fixtures/mock-store.mjs', import.meta.url).href)
}

function textOf (event) {
  return (event?.data?.message?.content ?? []).map((block) => block?.text ?? '').join('')
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

const scopeOf = (sessionId) => ({ sessionId, actorId: `actor-${sessionId}` })
const namesOf = (state) => [...state.selected.values()].map((s) => s.name)

/**
 * 从真实事件派生一对 callId / 回执 operationId 自洽、seq 可指定的 canonical 对。
 * 只改 seq 与 callId↔operationId 这条宿主自身的绑定规则，其余字节保持真实形状。
 */
function makePair (srcCall, srcResult, callId, callSeq, resultSeq) {
  const shell = JSON.parse(textOf(srcResult))
  shell.data.receipt.operationId = `op_${callId}`
  const content = srcResult.data.message.content.map((block, index) =>
    (index === 0 ? { ...block, text: JSON.stringify(shell) } : block))
  return {
    call: { ...srcCall, seq: callSeq, data: { ...srcCall.data, callId } },
    result: {
      ...srcResult,
      seq: resultSeq,
      sourceEventSeqs: [callSeq],
      data: { ...srcResult.data, message: { ...srcResult.data.message, content } },
    },
  }
}

/** 新会话 journal：与 lifecycle 新会话同一条公开接缝（engine.ready）。 */
function freshJournal (engine, sessionId, { boundary = 0, queryEvents = [] } = {}) {
  const journal = createJournal({
    session: { inheritedEventCount: boundary },
    scope: scopeOf(sessionId),
    engine,
    query: { readSession: async () => ({ inheritedEventCount: boundary, events: queryEvents }) },
  })
  engine.ready(scopeOf(sessionId))
  return journal
}

const OMIT = Symbol('omit-seq')
/** 有代表性的畸形 seq 集合（含 Number.isSafeInteger 为真但语义非法的负数）。 */
const MALFORMED_SEQ = [
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['fraction-1.5', 1.5],
  ['negative--1', -1],
  ['unsafe-2^53', Number.MAX_SAFE_INTEGER + 2],
  ['string-"20"', '20'],
  ['missing-key', OMIT],
]

/** 施加畸形 seq：只动 seq 字段本身。 */
function withBadSeq (result, bad) {
  const copy = { ...result, seq: bad }
  if (bad === OMIT) delete copy.seq
  return copy
}

const SYN = {}

// ---------------------------------------------------------------------------
// boot：取真实 engine 与真实事件材料（真实 load 对 / 真实 unload 对 / 出站 header）
// ---------------------------------------------------------------------------
test('boot SEQ: 真实 composition 产出真实 load/unload 对与出站 request/header', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
  })
  cleanup.push(() => boot.dispose())

  queueResponse({ toolCalls: [{ id: 'seq-search', name: 'tool_search', arguments: { category: 'all', query: 'hidden inherited tool' } }] })
  queueResponse({ toolCalls: [{ id: 'seq-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'seq-load-2', name: 'tool_load', arguments: { names: ['fixture_mutating'] } }] })
  queueResponse({ text: 'material done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'seq-mat-1')
  await userTurn(handle, 'Search, then load the hidden tool, then load the mutating tool.')

  const { events } = await boot.ctx.sessionQuery.readSession('seq-mat-1')
  const realCall = (id) => events.find((e) => e.type === 'tool/call' && e.data?.callId === id)
  const realResult = (id) => {
    const call = realCall(id)
    assert.ok(call, `真实宿主 tool/call ${id} 必须存在`)
    return events.find((e) => e.type === 'tool/result'
      && Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.includes(call.seq))
  }

  const searchCall = realCall('seq-search')
  const searchResult = realResult('seq-search')
  const loadCall = realCall('seq-load')
  const loadResult = realResult('seq-load')
  const secondCall = realCall('seq-load-2')
  const secondResult = realResult('seq-load-2')
  const header = events.find((e) => e.type === 'request/header'
    && (e.data?.header?.tools ?? []).some((t) => t.name === 'fixture_hidden_inherited'))
  // 真实的**非 canonical** tool/result：tool_search 的回执外壳 tool !== 'tool_load'
  const ordinaryResult = searchResult

  // 材料真实性：形状取自真实宿主，不允许退化为 undefined 后静默跳过
  for (const [label, material] of [['searchCall', searchCall], ['searchResult', searchResult],
    ['loadCall', loadCall], ['loadResult', loadResult],
    ['secondCall', secondCall], ['secondResult', secondResult],
    ['outboundHeader', header]]) {
    assert.ok(material !== undefined && material !== null, `真实材料 ${label} 必须存在（不得 undefined 跳过）`)
  }
  assert.equal(JSON.parse(textOf(searchResult)).tool, 'tool_search',
    '对照材料必须是真实宿主的非 canonical tool/result（tool_search 回执）')
  assert.equal(JSON.parse(textOf(loadResult)).tool, 'tool_load')
  assert.equal(JSON.parse(textOf(loadResult)).data.receipt.operationId, 'op_seq-load',
    '真实回执 operationId 遵循 entries.mjs 的 op_<callId> 绑定')
  assert.equal(JSON.parse(textOf(secondResult)).data.receipt.operationId, 'op_seq-load-2')
  assert.deepEqual(loadResult.sourceEventSeqs, [loadCall.seq], 'result 必须绑定其 canonical call 的 seq')
  assert.ok(Number.isSafeInteger(loadCall.seq) && loadCall.seq >= 0, '真实事件 seq 是非负安全整数')

  SYN.boot = boot
  SYN.engine = boot.ctx.get('progressiveDiscovery').sessions.get('seq-mat-1').engine
  SYN.search = { call: searchCall, result: searchResult }
  SYN.load = { call: loadCall, result: loadResult }
  SYN.second = { call: secondCall, result: secondResult }
  SYN.header = header
  SYN.ordinaryResult = ordinaryResult
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')
})

/** 真实"第二次提交"失败链：建立 selection → 真实登记 pending load → 喂 call → 喂畸形 result → 下一轮真实 header。
 *  （模型已无 unload 路径，第二次状态提交改用第二个 load；判据——畸形 seq 必须 fail
 *  closed 且不得静默生效，合法 seq 必须照常提交——与操作种类无关，保持原门禁强度。） */
async function revokeChain (sessionId, badSeq) {
  const engine = SYN.engine
  const journal = freshJournal(engine, sessionId)
  const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 10, 11)
  journal.onEvent(load.call)
  journal.onEvent(load.result)
  const established = engine.getState(scopeOf(sessionId))
  assert.deepEqual(namesOf(established), ['fixture_hidden_inherited'],
    `${sessionId}: 畸形注入前必须先建立真实 selection，否则断言会空转`)

  await engine.handleLoad(
    { names: ['fixture_mutating'] },
    scopeOf(sessionId),
    { operationId: `op_${sessionId}-second` },
  )
  const second = makePair(SYN.second.call, SYN.second.result, `${sessionId}-second`, 20, 21)
  journal.onEvent(second.call)
  journal.onEvent(withBadSeq(second.result, badSeq))
  const afterBad = engine.getState(scopeOf(sessionId))

  // 下一轮真实出站 request/header：第二次提交是否真正生效由此判定
  const headerSeq = 30
  journal.onEvent({ ...SYN.header, seq: headerSeq, data: SYN.header.data })
  const verdict = engine.evaluateCall(scopeOf(sessionId), {
    name: 'fixture_mutating',
    requestId: `${sessionId}#${headerSeq}`,
  })
  return { journal, established, afterBad, verdict }
}

// ---------------------------------------------------------------------------
// 1) 畸形 result seq → fail closed，且宿主已确认的第二次提交**不得**静默失效
// ---------------------------------------------------------------------------
test('SEQ1: 畸形 canonical result 的 seq → fail closed，未生效的提交不得被绕过', async () => {
  for (const [label, badSeq] of MALFORMED_SEQ) {
    const sessionId = `seq1-${label}`
    const { established, afterBad, verdict } = await revokeChain(sessionId, badSeq)

    assert.equal(afterBad.mode, 'incompatible',
      `${label}: 状态提交点的 seq 不确定必须 fail closed，不得静默丢弃`)
    assert.equal(afterBad.integrity.rejected, established.integrity.rejected,
      `${label}: fail closed 是"不确定"而非"安全拒绝"，不得伪造 rejected 计数`)
    // 分类取证：既有 selection 确实还在（不是"没新增授权"的空过），但不可执行
    assert.deepEqual(namesOf(afterBad), ['fixture_hidden_inherited'],
      `${label}: 旧 selection 仍留存 —— 证明本断言不是靠"没有授权"空过`)
    assert.equal(verdict.allowed, false,
      `${label}: fail closed 后畸形提交不得被绕过，新工具不可执行`)
    assert.equal(verdict.code, 'TOOL_NOT_LOADED', `${label}: 拒绝码`)
  }

  // 正控制：同一条链，seq 合法 → 必须照常提交、会话保持 ready
  const control = await revokeChain('seq1-control', 21)
  assert.equal(control.afterBad.mode, 'ready', '合法 seq 的提交不得被误 fail closed')
  assert.deepEqual(namesOf(control.afterBad), ['fixture_hidden_inherited', 'fixture_mutating'],
    '合法提交必须真正生效（未被误伤）')
  assert.equal(control.verdict.allowed, false, '这条合成 header 只披露了第一个工具，第二个仍属"已加载未披露"')
  assert.equal(control.verdict.code, 'TOOL_NOT_ADVERTISED', '合法提交后是披露时序问题，不是授权问题')
})

// ---------------------------------------------------------------------------
// 2) pending load + 畸形 result → fail closed；后续重复的有效 result 不得重新激活
// ---------------------------------------------------------------------------
test('SEQ2: pending load 的畸形 result → fail closed，重复有效 result 不得重新激活', async () => {
  for (const [label, badSeq] of MALFORMED_SEQ) {
    const engine = SYN.engine
    const sessionId = `seq2-${label}`
    const journal = freshJournal(engine, sessionId)
    const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 30, 31)
    await engine.handleLoad({ names: ['fixture_hidden_inherited'] }, scopeOf(sessionId), {
      operationId: `op_${sessionId}-load`,
    })
    journal.onEvent(load.call)
    journal.onEvent(withBadSeq(load.result, badSeq))
    const afterBad = engine.getState(scopeOf(sessionId))
    assert.equal(afterBad.mode, 'incompatible', `${label}: pending load 的畸形 result 必须 fail closed`)
    assert.deepEqual(namesOf(afterBad), [], `${label}: 畸形 result 不得提交任何授权`)

    // 同一对的重复投递（seq 合法）不得借残留配对重新激活
    journal.onEvent(load.result)
    const afterReplay = engine.getState(scopeOf(sessionId))
    assert.equal(afterReplay.mode, 'incompatible', `${label}: 重复 result 不得把 fail closed 解除`)
    assert.deepEqual(namesOf(afterReplay), [], `${label}: 重复 result 不得重新激活 selection`)
    assert.equal(engine.evaluateCall(scopeOf(sessionId), { name: 'fixture_hidden_inherited' }).allowed, false,
      `${label}: 重复 result 后仍不可执行`)
  }

  // 正控制：同一对、seq 合法 → 必须正常折叠并可执行（不误伤）
  const engine = SYN.engine
  const sessionId = 'seq2-control'
  const journal = freshJournal(engine, sessionId)
  const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 30, 31)
  await engine.handleLoad({ names: ['fixture_hidden_inherited'] }, scopeOf(sessionId), {
    operationId: `op_${sessionId}-load`,
  })
  journal.onEvent(load.call)
  journal.onEvent(load.result)
  const state = engine.getState(scopeOf(sessionId))
  assert.equal(state.mode, 'ready', '合法 load result 不得被误 fail closed')
  assert.deepEqual(namesOf(state), ['fixture_hidden_inherited'], '合法 load 必须照常折叠（未误伤正控）')
  assert.equal(state.integrity.applied, 1, '合法对只激活一次')
})

// ---------------------------------------------------------------------------
// 3) fail closed 之后的 restore 不得把 incompatible 重新置 ready
// ---------------------------------------------------------------------------
test('SEQ3: fail closed 之后的 restore 不得重新置 ready（原选中原样复活）', async () => {
  const engine = SYN.engine
  const sessionId = 'seq3-restore'
  const journal = freshJournal(engine, sessionId)
  // seq 自 0 连续，使 mergeBySeq 后的合并流合法（排除 event-seq-not-contiguous 干扰）
  journal.onEvent({ type: 'user/message', seq: 0, data: {} })
  const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 1, 2)
  journal.onEvent(load.call)
  journal.onEvent(load.result)
  const beforeSeal = engine.getState(scopeOf(sessionId))
  assert.deepEqual(namesOf(beforeSeal), ['fixture_hidden_inherited'], 'fail closed 前确有真实 selection')

  journal.onEvent({ type: 'request/header', seq: 'bad-seq', data: { header: { tools: [] } } })
  assert.equal(engine.getState(scopeOf(sessionId)).mode, 'incompatible', '畸形 request/header 必须 fail closed')

  const outcome = await journal.restore()
  assert.equal(outcome.mode, 'incompatible', `restore 不得返回 ready：${JSON.stringify(outcome)}`)
  assert.equal(outcome.reason, 'event-seq-invalid', 'restore 跳过必须沿用原 fail closed 原因')
  const after = engine.getState(scopeOf(sessionId))
  assert.equal(after.mode, 'incompatible', 'restore 不得把 incompatible 重新置 ready')
  assert.equal(engine.evaluateCall(scopeOf(sessionId), { name: 'fixture_hidden_inherited' }).allowed, false,
    'restore 之后原 selection 仍不可执行')

  // 正控制：未 fail closed 的同构 journal 仍正常恢复为 ready
  const okJournal = freshJournal(engine, 'seq3-control')
  const okLoad = makePair(SYN.load.call, SYN.load.result, 'seq3-control-load', 1, 2)
  okJournal.onEvent({ type: 'user/message', seq: 0, data: {} })
  okJournal.onEvent(okLoad.call)
  okJournal.onEvent(okLoad.result)
  const okOutcome = await okJournal.restore()
  assert.equal(okOutcome.mode, 'ready', '未 fail closed 的恢复不得被误伤')
})

// ---------------------------------------------------------------------------
// 4) 正控制：普通非状态事件与合法 result 不得被误 fail closed
// ---------------------------------------------------------------------------
test('SEQ4: 非 canonical 的 tool/result 与普通事件不得被误 fail closed', async () => {
  const engine = SYN.engine
  const sessionId = 'seq4-ordinary'
  const journal = freshJournal(engine, sessionId)

  const ordinary = { ...SYN.ordinaryResult, seq: 50 }
  assert.equal(ordinary.sourceEventSeqs.includes(SYN.load.call.seq), false,
    '对照材料不绑定 canonical load call（否则就不是非 canonical 事件）')
  assert.equal(JSON.parse(textOf(SYN.ordinaryResult)).tool, 'tool_search', '前置：对照材料必须是 tool_search 回执')
  journal.onEvent(ordinary)
  assert.equal(engine.getState(scopeOf(sessionId)).mode, 'ready',
    '非 canonical result 的 seq 合法时不得 fail closed（不得把所有 event 一律误判）')

  // 畸形 seq 的非 canonical result 同样不得牵连整个会话
  const other = freshJournal(engine, 'seq4-ordinary-bad')
  other.onEvent(withBadSeq(SYN.ordinaryResult, undefined))
  assert.equal(engine.getState(scopeOf('seq4-ordinary-bad')).mode, 'ready',
    '非 canonical 的畸形 result 不构成状态不确定，不得牵连 fail closed')

  // 普通非状态事件（真实宿主事件类型）不得被误 fail closed
  const plain = freshJournal(engine, 'seq4-plain')
  plain.onEvent({ type: 'user/message', seq: 'bad', data: {} })
  assert.equal(engine.getState(scopeOf('seq4-plain')).mode, 'ready',
    '普通非状态事件的 seq 畸形不得牵连 fail closed')

  // 合法 load 对照常折叠
  const load = makePair(SYN.load.call, SYN.load.result, 'seq4-load', 51, 52)
  journal.onEvent(load.call)
  journal.onEvent(load.result)
  const state = engine.getState(scopeOf(sessionId))
  assert.equal(state.mode, 'ready', '合法 result 不得被误 fail closed')
  assert.deepEqual(namesOf(state), ['fixture_hidden_inherited'], '合法 result 照常生效（未误伤正控）')
  assert.equal(state.integrity.applied, 1)
})

// ---------------------------------------------------------------------------
// 5) own-only 边界：继承前缀内合法 seq 的真实对仍零观察
// ---------------------------------------------------------------------------
test('SEQ5: own-only 边界不因新门禁放宽 —— 继承前缀零观察，own 位置正控可折叠', async () => {
  const engine = SYN.engine
  const pair = makePair(SYN.load.call, SYN.load.result, 'seq5-load', 3, 4)

  const inherited = freshJournal(engine, 'seq5-inherited', { boundary: 5 })
  inherited.onEvent(pair.call)
  inherited.onEvent(pair.result)
  const inheritedState = engine.getState(scopeOf('seq5-inherited'))
  assert.equal(inheritedState.mode, 'ready', '继承前缀内的合法事件不得被误 fail closed')
  assert.equal(inheritedState.selected.size, 0, '继承前缀不得折叠出 selection')
  assert.equal(inheritedState.integrity.applied, 0, '继承前缀零观察')
  assert.equal(inheritedState.integrity.rejected, 0, '继承前缀不得计入 rejected')

  const own = freshJournal(engine, 'seq5-own', { boundary: 0 })
  own.onEvent(pair.call)
  own.onEvent(pair.result)
  const ownState = engine.getState(scopeOf('seq5-own'))
  assert.equal(ownState.integrity.applied, 1, '同一对放 own 位置必须可折叠（正控，证明排除来自 own-only）')
  assert.deepEqual(namesOf(ownState), ['fixture_hidden_inherited'])
})

// ---------------------------------------------------------------------------
// 6) P1：fail closed 后**真实出站**不得再披露隐藏工具 schema
//    （真实 runtime journal + 真实 provider 录制的 GenerateOptions.tools）
// ---------------------------------------------------------------------------

function namesOfRequest (store) {
  const last = store.requests[store.requests.length - 1]
  return (last?.tools ?? []).map((t) => t.name).sort()
}
function toolSchemaOf (store, name) {
  const last = store.requests[store.requests.length - 1]
  return (last?.tools ?? []).find((t) => t.name === name)
}
function runtimeOf (ctx, sessionId) {
  const svc = ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery service 必须可达')
  const runtime = svc.sessions.get(sessionId)
  assert.ok(runtime !== undefined, `真实 runtime 必须存在：${sessionId}`)
  return runtime
}

/** 把真实 sessionQuery.readSession 挂起，用于确定性观察 restoring 中的出站投影。 */
function deferReadSession (query) {
  const real = query.readSession.bind(query)
  const state = { entered: false, released: false, waiters: [] }
  query.readSession = async (sessionId, ...rest) => {
    state.entered = true
    if (!state.released) await new Promise((resolve) => state.waiters.push(resolve))
    return real(sessionId, ...rest)
  }
  return { state, release() { state.released = true; for (const w of state.waiters.splice(0)) w() } }
}

/** 轮询到真实 readSession 确实进入了 await（否则下面几条断言会空过）。 */
async function waitUntilEntered (defer, timeoutMs = 10000) {
  const started = Date.now()
  while (!defer.state.entered) {
    if (Date.now() - started > timeoutMs) throw new Error('等待 readSession 进入 await 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('SEQ6: fail closed / 恢复中 → 真实出站只留三入口、隐藏 schema 不外泄、body=0', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
  })
  cleanup.push(() => boot1.dispose())

  // (a) 正控制：ready + 真实 selection → 下一轮真实出站必须披露隐藏工具完整 schema
  queueResponse({ toolCalls: [{ id: 's6-load', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ text: 'loaded' })
  const handle = await drive(boot1.ctx, boot1.tmpRoot, 'seq6-a')
  await userTurn(handle, 'Load the hidden tool.')
  const runtime = runtimeOf(boot1.ctx, 'seq6-a')
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'ready', '前置：必须先 ready')
  queueResponse({ text: 'still ready' })
  await userTurn(handle, 'Continue.')
  assert.ok(namesOfRequest(store).includes('fixture_hidden_inherited'),
    `正控制：ready 的 selection 必须照常披露（未误伤）：${namesOfRequest(store).join(', ')}`)
  assert.ok(toolSchemaOf(store, 'fixture_hidden_inherited')?.parameters !== undefined,
    '正控制：出站携带的是隐藏工具的完整 schema')

  // (b) fail closed：真实 runtime journal 被 seal → 出站必须只剩三入口
  runtime.journal.onEvent({ type: 'request/header', seq: 'bad-seq', data: { header: { tools: [] } } })
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'incompatible', '前置：真实 journal 必须已 seal')
  assert.deepEqual(namesOf(runtime.engine.getState(runtime.scope)), ['fixture_hidden_inherited'],
    '前置：selected 作为保守残留仍在（披露缺口正由此暴露）')

  queueResponse({ toolCalls: [{ id: 's6-guess', name: 'fixture_hidden_inherited', arguments: { text: 'x' } }] })
  queueResponse({ text: 'after fail closed' })
  await userTurn(handle, 'Try the hidden tool again.')
  assert.deepEqual(namesOfRequest(store), ['tool_list', 'tool_load', 'tool_search'],
    `fail closed 后出站必须只剩三入口：${namesOfRequest(store).join(', ')}`)
  assert.equal(toolSchemaOf(store, 'fixture_hidden_inherited'), undefined,
    'fail closed 后隐藏工具的完整 schema 不得出现在真实出站里')
  assert.equal(store.bodyCount('s6-guess'), 0, 'fail closed 后隐藏工具 body 不得执行')

  // (c) 冷恢复 **pending**：装配挂起，一条请求都不发；落定后照常披露（正控）。
  //     旧断言在这里要求"恢复中发出只留三入口的请求"——那冻结的正是本轮修掉的缺陷
  //     （模型上下文里已披露的工具在这一轮凭空消失）。pending 的语义是**不发**。
  await handle.dispose()
  const boot2 = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: {},
    tmpRoot: boot1.tmpRoot,
  })
  cleanup.push(() => boot2.dispose())
  const defer = deferReadSession(boot2.ctx.sessionQuery)
  const resumed = await boot2.ctx.agents.resume({
    resumeSessionId: 'seq6-a',
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
  })
  handles.push(resumed)
  const beforePending = store.requests.length
  queueResponse({ text: 'during restore' })
  const pendingTurn = userTurn(resumed, 'Continue while restoring.')
  await waitUntilEntered(defer)
  assert.ok(defer.state.entered, 'readSession 必须真实进入 await（否则本用例空过）')
  const restoring = runtimeOf(boot2.ctx, 'seq6-a')
  assert.equal(restoring.restoring, true, '前置：观察点必须落在恢复 pending 的窗口内')
  assert.notEqual(restoring.engine.getState(restoring.scope).mode, 'ready',
    '前置：pending 不得被当成 ready')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(store.requests.length, beforePending,
    `pending 期间不得发出任何请求（更不得发缩水的那一份）；实际：${JSON.stringify(store.requests.slice(beforePending).map((request) => (request.tools ?? []).map((tool) => tool.name)))}`)

  defer.release()
  const outcome = await restoring.journal.whenRestored()
  assert.equal(outcome.mode, 'ready', '恢复完成后会话必须 ready（正控）')
  await pendingTurn
  assert.ok(namesOfRequest(store).includes('fixture_hidden_inherited'),
    `正控：恢复落定后的第一条请求就已披露恢复项：${namesOfRequest(store).join(', ')}`)
  queueResponse({ text: 'after restore' })
  await userTurn(resumed, 'Continue after restore.')
  assert.ok(namesOfRequest(store).includes('fixture_hidden_inherited'),
    `正控：恢复完成后的 selection 必须照常披露：${namesOfRequest(store).join(', ')}`)
})

// ---------------------------------------------------------------------------
// 7) P2：双重损坏（外壳被改 + sourceEventSeqs 被清）下不得再放行撤销失败
// ---------------------------------------------------------------------------

/** 双重损坏：把回执外壳的 tool 改名，并清空 sourceEventSeqs（两处独立损坏）。 */
function doubleCorrupt (result) {
  const shell = JSON.parse(textOf(result))
  shell.tool = 'tool_other'
  const content = result.data.message.content.map((block, index) =>
    (index === 0 ? { ...block, text: JSON.stringify(shell) } : block))
  return {
    ...result,
    sourceEventSeqs: [],
    data: { ...result.data, message: { ...result.data.message, content } },
  }
}

test('SEQ7: 双重损坏的 result → fail closed；已知普通 result 不误封；迟到重复 result 不复活', async () => {
  const engine = SYN.engine

  // (1) 负控：既有真实 selection + pending 第二次提交 + 双重损坏 result → 不得放行
  for (const [label, badSeq] of [['undefined', undefined], ['NaN', Number.NaN], ['negative--1', -1]]) {
    const sessionId = `seq7-second-${label}`
    const journal = freshJournal(engine, sessionId)
    const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 10, 11)
    journal.onEvent(load.call)
    journal.onEvent(load.result)
    assert.deepEqual(namesOf(engine.getState(scopeOf(sessionId))), ['fixture_hidden_inherited'],
      `${label}: 前置必须先建立真实 selection`)

    await engine.handleLoad({ names: ['fixture_mutating'] },
      scopeOf(sessionId), { operationId: `op_${sessionId}-second` })
    const second = makePair(SYN.second.call, SYN.second.result, `${sessionId}-second`, 20, 21)
    journal.onEvent(second.call)
    const corrupted = { ...doubleCorrupt(second.result), seq: badSeq }
    if (badSeq === undefined) delete corrupted.seq
    journal.onEvent(corrupted)

    const after = engine.getState(scopeOf(sessionId))
    assert.equal(after.mode, 'incompatible',
      `${label}: 双重损坏（外壳改名 + sourceEventSeqs 清空）时不得放行失败的提交`)
    assert.deepEqual(namesOf(after), ['fixture_hidden_inherited'], `${label}: 保守残留仍在`)
    assert.equal(engine.evaluateCall(scopeOf(sessionId), { name: 'fixture_hidden_inherited' }).allowed, false,
      `${label}: fail closed 后不得可执行`)

    // 迟到重复的**合法** result 不得让状态复活
    journal.onEvent(second.result)
    journal.onEvent(load.result)
    const revived = engine.getState(scopeOf(sessionId))
    assert.equal(revived.mode, 'incompatible', `${label}: 迟到重复 result 不得解除 fail closed`)
    assert.equal(engine.evaluateCall(scopeOf(sessionId), { name: 'fixture_hidden_inherited' }).allowed, false,
      `${label}: 迟到重复 result 后仍不可执行`)
  }

  // (2) fail-safe 对照：双重损坏的 **load** result 无论 seq 合法与否都不得授予任何授权
  {
    // 2a 畸形 seq：进 seq 门禁 → fail closed
    const sessionId = 'seq7-load-bad'
    const journal = freshJournal(engine, sessionId)
    await engine.handleLoad({ names: ['fixture_hidden_inherited'] }, scopeOf(sessionId), {
      operationId: `op_${sessionId}-load`,
    })
    const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 30, 31)
    journal.onEvent(load.call)
    const badLoad = doubleCorrupt(load.result)
    delete badLoad.seq
    journal.onEvent(badLoad)
    const state = engine.getState(scopeOf(sessionId))
    assert.equal(state.mode, 'incompatible', '双重损坏 + 畸形 seq 的 load result 必须 fail closed')
    assert.deepEqual(namesOf(state), [], 'load 方向必须 fail-safe：不得授予任何 selection')
    assert.equal(engine.evaluateCall(scopeOf(sessionId), { name: 'fixture_hidden_inherited' }).allowed, false)
  }
  {
    // 2b seq 合法：不走 seq 门禁，但 sourceEventSeqs 已清空 → 根本无法构造 canonical pair
    //     → 静默丢弃，**仍不得授予任何授权**（这正是 load 方向天然 fail-safe 的原因）
    const sessionId = 'seq7-load-valid'
    const journal = freshJournal(engine, sessionId)
    await engine.handleLoad({ names: ['fixture_hidden_inherited'] }, scopeOf(sessionId), {
      operationId: `op_${sessionId}-load`,
    })
    const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 30, 31)
    journal.onEvent(load.call)
    journal.onEvent(doubleCorrupt(load.result))
    const state = engine.getState(scopeOf(sessionId))
    assert.deepEqual(namesOf(state), [], 'load 方向 fail-safe：sourceEventSeqs 被清空即无法配对，不得授权')
    assert.equal(state.integrity.applied, 0, '不得计为已激活')
    assert.equal(engine.evaluateCall(scopeOf(sessionId), { name: 'fixture_hidden_inherited' }).allowed, false,
      '未授权的工具不得可执行')
  }

  // (3) 已知普通 result 正控：无未决状态调用时，畸形 seq 的普通 result 不得牵连会话
  {
    const sessionId = 'seq7-ordinary'
    const journal = freshJournal(engine, sessionId)
    journal.onEvent(withBadSeq(SYN.ordinaryResult, undefined))
    assert.equal(engine.getState(scopeOf(sessionId)).mode, 'ready',
      '无未决 tool_load 调用时，普通 result 的畸形 seq 不得 fail closed（可证无关）')
    const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 40, 41)
    journal.onEvent(load.call)
    journal.onEvent(load.result)
    const state = engine.getState(scopeOf(sessionId))
    assert.deepEqual(namesOf(state), ['fixture_hidden_inherited'], '合法 load 照常折叠（正控）')
  }

  // (4) 已知普通 result 正控（seq 合法）：任何时候都不得被误 fail closed
  {
    const sessionId = 'seq7-ordinary-valid'
    const journal = freshJournal(engine, sessionId)
    const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 50, 51)
    journal.onEvent(load.call)
    journal.onEvent({ ...SYN.ordinaryResult, seq: 52 })
    assert.equal(engine.getState(scopeOf(sessionId)).mode, 'ready',
      '状态调用在途时的**合法**普通 result 仍不得 fail closed')
    journal.onEvent(load.result)
    assert.deepEqual(namesOf(engine.getState(scopeOf(sessionId))), ['fixture_hidden_inherited'],
      '合法 load 照常折叠（正控）')
  }

  // (5) 透明记录保守代价：状态调用在途 + 畸形 seq 的普通 result → 保守 fail closed
  //     （不可鉴别：外壳可被改、sourceEventSeqs 合法缺省，无法证明与未决调用无关）
  {
    const sessionId = 'seq7-conservative'
    const journal = freshJournal(engine, sessionId)
    const load = makePair(SYN.load.call, SYN.load.result, `${sessionId}-load`, 60, 61)
    journal.onEvent(load.call)
    journal.onEvent(withBadSeq(SYN.ordinaryResult, 'bad-seq'))
    assert.equal(engine.getState(scopeOf(sessionId)).mode, 'incompatible',
      '状态调用在途时的畸形普通 result 属不可鉴别 → 保守 fail closed（已声明的代价）')
  }
})

after(async () => {
  for (const handle of handles) {
    try { await handle.dispose() } catch { /* already disposed */ }
  }
  for (const dispose of cleanup) {
    try { dispose() } catch { /* already disposed */ }
  }
})
// 可信周期名单（trusted epoch record）门禁 — **反例 TE1**。
//
// 目标（可信官方 storageDomain 记录替代 first-request/header 授信）：
//   冷恢复**不得**用「本周期第一条 request/header 里出现过的工具名」反推本会话的
//   常驻（alwaysVisible）名单。那条推断（journal.mjs:459-493 → onEpochRestore →
//   lifecycle.mjs:121-132）把一份**出站日志**当成了授权事实：只要持久化历史里的
//   某个 request/header 多了一个从未 load 过的工具名，恢复后该名字就进入
//   runtime.alwaysNameSet，而 guard.mjs:32 以 `alwaysNameSet.has(name)` **早退放行**
//   —— 于是模型猜名即可真正执行，从未经过 canonical tool/call→tool/result 折叠，
//   也没有任何可信的持久记录为其背书。
//
// 本例如何取得这份「受污染的历史」（**声明式注入，不是宿主自然发生**）：
//   1. 真实 Loader + 真实 DSH 0.2.1-alpha.1 composition，真实 agents.create 跑一轮，
//      由**真实宿主**产出 request/header（日志材料全部取自 sessionQuery.readSession）。
//   2. 随后用一个**明确的 query 故障包装**（只换 events 数组，不换 inheritedEventCount，
//      其余原样转发）把第一条 request/header 的 tools 追加一个真实 schema 的
//      fixture_hidden_inherited —— 模拟「历史上某一轮有别的 listener 在我们投影之后
//      又把该工具塞进出站并被记进日志」的**最坏可信历史**。
//      真实宿主不会自己产生这条日志；这是为证伪而**声明**的注入，不是对宿主行为的断言。
//   3. 该污染流里**没有**任何 tool_load 的 tool/call，也没有绑定它的 tool/result。
//
// 判据（三条互相独立、互不替代）：
//   TE1x  正控制：可信配置基线（alwaysVisible 显式含该工具）下，**真实
//        ctx.tools.execute** 直连执行必须 body=1、isError=false。
//        —— 证明 exec 这条路径真的能到达 body，TE1 的 body=0 因此有分辨力。
//   TE1   受污染历史（即便仍握有可信 record）下，同一个 ctx.tools.execute
//        必须被拒：isError=true + 明确拒绝理由 + bodyCount=0。
//        —— 用直连执行而不是「模型是否真的发出了那次猜名调用」，是为了排除
//        「请求被整体拦下、猜测根本没发出去，于是 body 恰好是 0」这种空过。
//   TE1r  同一污染历史下，**一条出站请求都不许发出去**（不给缩水 fallback）。
//
// 断言纪律：
//   * 每条前置都有独立断言，禁止「取到 undefined 就跳过」式空转。
//   * 反空过控制（TE1c）单独成例：未污染的同一份历史必须 ready 且 load 后可执行，
//     因此 TE1 的 0 不是靠「一律 block」换来的。
//   * 本文件**不改产品代码**使其变绿；它是一份红色反例证据。
//
// 运行：node --test plugin/tests/composition/gate-trusted-epoch.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule, fixtureFileUrl } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, LOCAL, storageEntries } from './harness.mjs'

const HIDDEN = 'fixture_hidden_inherited'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']
/**
 * alwaysVisible 显式置空：真实常驻基线只剩三个发现入口（entryNames 由 domain 单独保护）。
 * 这样「授权从哪来」在本例里**唯一**的可能来源就是被污染的 request/header，
 * 不会与 Core 默认常驻名单混淆。
 */
const ADAPTER_CONFIG = { alwaysVisible: [] }

const handles = []
const cleanup = []

after(async () => {
  for (const handle of handles.reverse()) {
    try { await handle.dispose() } catch { /* 已释放 */ }
  }
  for (const dispose of cleanup.reverse()) {
    try { dispose() } catch { /* 已释放 */ }
  }
})

async function storeOf () {
  return import(new URL('../../fixtures/mock-store.mjs', import.meta.url).href)
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

function namesOf (request) {
  return (request?.tools ?? []).map((tool) => tool.name)
}

function lastNames (store) {
  return namesOf(store.requests[store.requests.length - 1])
}

function runtimeOf (ctx, sessionId) {
  const svc = ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery 服务必须可达')
  const runtime = svc.sessions.get(sessionId)
  assert.ok(runtime !== undefined, `真实 runtime 必须存在：${sessionId}`)
  return runtime
}

/** 真实宿主为该 fixture 工具定义的出站 schema（取自真实 tools registry，不是手写）。 */
function hiddenSchemaOf (ctx) {
  const definition = ctx.tools.get(HIDDEN)
  assert.ok(definition !== undefined, `真实 registry 必须解析得到 ${HIDDEN}`)
  assert.equal(typeof definition.name, 'string')
  assert.ok(definition.parameters !== undefined, '真实定义必须带 parameters')
  return { name: definition.name, description: definition.description, parameters: definition.parameters }
}

/**
 * 直连真实工具执行管线（`@deepseek-ai/dsh-tools` lib/index.js:3116 `execute(exec)`）。
 *
 * 走的是与模型调用**同一条**完整管线：pre-policy → guards → dispatch → post-policy。
 * 本插件的 guard（adapters/dsh/guard.mjs）就在其中，所以这条路径能独立证明
 * 「执行面是否放行」，不受「模型那一轮到底有没有发出调用」影响。
 */
async function directExec (ctx, agent, name, args, callId) {
  const result = await ctx.tools.execute({
    agent,
    callId,
    name,
    arguments: args,
    signal: new AbortController().signal
  })
  const text = (result?.content ?? []).map((block) => block?.text ?? '').join('')
  return { result, text, isError: result?.isError === true }
}

/**
 * 在**真实** durable 事件流上注入一次声明式污染：把第一条 request/header 的
 * tools 追加一个从未 load 过的工具。只改这一处，其余事件逐字保留、seq 不动
 * （journal.mjs:153-158 要求 seq === 下标，改 seq 会把实验变成另一条路径）。
 */
function polluteFirstHeader (realEvents, hiddenSchema) {
  const index = realEvents.findIndex(
    (event) => event.type === 'request/header' && Array.isArray(event.data?.header?.tools),
  )
  assert.notEqual(index, -1, '前置：真实宿主必须产出至少一条 request/header')
  const events = realEvents.map((event, i) => (i === index
    ? {
      ...event,
      data: {
        ...event.data,
        header: { ...event.data.header, tools: [...event.data.header.tools, hiddenSchema] },
      },
    }
    : event))
  return { events, pollutedSeq: events[index].seq, pollutedTools: events[index].data.header.tools.map((t) => t.name) }
}

/** 污染流的前置自检：确实没有 canonical tool_load 对，污染确实落进了日志。 */
function assertPollutedShape (events, pollutedSeq, pollutedTools) {
  const loadCalls = events.filter((e) => e.type === 'tool/call' && e.data?.name === 'tool_load')
  assert.equal(loadCalls.length, 0, '污染流里不允许出现 tool_load 的 tool/call')
  const header = events.find((e) => e.type === 'request/header' && e.seq === pollutedSeq)
  assert.ok(header !== undefined, '被污染的 request/header 必须在流中')
  assert.ok(header.data.header.tools.some((t) => t.name === HIDDEN),
    `污染必须真的进入那条 header：${JSON.stringify(header.data.header.tools.map((t) => t.name))}`)
  assert.ok(pollutedTools.includes(HIDDEN))
  // 非污染的其它 header 不得已经含该工具，否则「污染」就不是唯一来源。
  for (const event of events) {
    if (event.type !== 'request/header' || event.seq === pollutedSeq) continue
    const names = (event.data?.header?.tools ?? []).map((t) => t.name)
    assert.equal(names.includes(HIDDEN), false, `seq=${event.seq} 的 header 不得含 ${HIDDEN}`)
  }
}

/**
 * 声明式 query 故障包装：只对本会话替换 `events`，`inheritedEventCount` 与其余会话
 * 一律转发真实实现。**这是注入，不是宿主自然行为**——文件头已声明。
 *
 * 保留**原始 own property**（不是 `bind` 后的新函数）并在 finally 里逐字装回，
 * 保证包装不跨用例泄漏。
 */
function serveHistory (query, sessionId, events) {
  const realReadSession = query.readSession
  const state = { calls: 0, inheritedEventCounts: [] }
  query.readSession = async (requested, ...rest) => {
    if (requested !== sessionId) return realReadSession.call(query, requested, ...rest)
    state.calls += 1
    const loaded = await realReadSession.call(query, requested, ...rest)
    state.inheritedEventCounts.push(loaded?.inheritedEventCount)
    return { ...loaded, events }
  }
  return {
    state,
    restore () { query.readSession = realReadSession },
  }
}

/** 在声明的历史下做一次真实冷恢复；无论成败都把 query 逐字装回。 */
async function coldRestoreThrough (svc, query, sessionId, events, session, agent) {
  const served = serveHistory(query, sessionId, events)
  try {
    svc.lifecycle.disposeSession(sessionId)
    const runtime = svc.lifecycle.ensureRuntime(session, agent)
    const outcome = await runtime.journal.whenRestored()
    return { runtime, outcome, served: served.state }
  } finally {
    served.restore()
    assert.equal(query.readSession.name, 'readSession', '包装必须逐字装回真实实现（不得留下 bind 产物）')
  }
}

// ---------------------------------------------------------------------------
// TE0：正控制 —— 同一个 fixture 工具在真实加载路径上确实能执行（body=1）
// ---------------------------------------------------------------------------
const TE0 = { sessionId: 'te-control-1' }

test('TE0: 正控制 —— 经真实 tool_load 折叠后，同一 fixture 工具 body 确实执行 1 次', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())

  queueResponse({ toolCalls: [{ id: 'te0-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'te0-use', name: HIDDEN, arguments: { text: 'control' } }] })
  queueResponse({ text: 'TE0 done' })

  const handle = await drive(boot.ctx, boot.tmpRoot, TE0.sessionId)
  await userTurn(handle, 'Load and then call the hidden fixture tool.')

  const runtime = runtimeOf(boot.ctx, TE0.sessionId)
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'ready', '正控制：会话必须 ready')
  assert.equal(runtime.engine.getState(runtime.scope).selected.size, 1,
    '正控制：真实 tool_load 折叠后确有 selection（本判据证明 selected 是可观测的授权来源）')
  assert.equal(store.bodyCount('te0-use'), 1, '正控制：正常路径 body 执行 1 次')
  assert.ok(lastNames(store).includes(HIDDEN), '正控制：该工具确实被披露过')
  await handle.dispose()
})

// ---------------------------------------------------------------------------
// TE1x：正控制 —— 可信配置基线下，同一条 ctx.tools.execute 直连路径 body 确实执行 1 次
// （证明 TE1 的 body=0 不是「exec 走不到 body」造成的空过）
// ---------------------------------------------------------------------------
test('TE1x: 正控制 —— 可信 alwaysVisible 基线下，直连 ctx.tools.execute body 执行 1 次', async () => {
  const { store } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapter: { alwaysVisible: [HIDDEN] }
  })
  cleanup.push(() => boot.dispose())

  const handle = await drive(boot.ctx, boot.tmpRoot, 'te1x-1')
  const svc = boot.ctx.get('progressiveDiscovery')

  // 首次触达：runtime 由这次 exec 建立，同时（在新实现下）要先把本 epoch 的可信
  // baseline **durable 落定**。落定前拒绝执行是正确行为，所以这一次**不允许**放行。
  const boot1 = await directExec(boot.ctx, handle.agent, HIDDEN, { text: 'bootstrap' }, 'te1x-boot')
  assert.equal(store.bodyCount('te1x-boot'), 0,
    `记录 durable 落定前不得放行执行；实际：${boot1.text.slice(0, 200)}`)

  // 等恢复落定后再发**同一条** direct exec 作为正控制。
  const settled = await svc.lifecycle.whenReady('te1x-1')
  const runtime = runtimeOf(boot.ctx, 'te1x-1')
  assert.equal(runtime.alwaysNameSet.has(HIDDEN), true,
    '正控制前置：可信配置基线确实把该工具放进 alwaysNameSet（runtime 由首次 exec 触达建立）')
  assert.equal(settled.mode, 'ready',
    `可信配置基线的会话必须落 ready（正控制），实际：${JSON.stringify(settled)}`)

  const exec = await directExec(boot.ctx, handle.agent, HIDDEN, { text: 'trusted' }, 'te1x-exec')
  assert.equal(exec.isError, false,
    `正控制：可信基线落定后直连执行不得被拒，实际文本：${exec.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('te1x-exec'), 1,
    '正控制：直连执行必须真的到达 body（这证明 TE1 的 body=0 有分辨力）')

  await handle.dispose()
})

// ---------------------------------------------------------------------------
// TE1c / TE1：污染 vs 未污染
//
// 拆分纪律（**不得**把「ready」前置留在红例里，那会让修复方靠「一律 block」作弊）：
//   TE1c（绿，反空过控制）：完全相同的历史但**没有**那行污染 → 恢复必须 ready，
//          且模型仍能正常 tool_load 后执行。证明 TE1 的 body=0 不是因为一切都停了。
//   TE1 （红，目标判据）  ：只多一行污染 → 猜名调用 body 必须为 0。
// ---------------------------------------------------------------------------
const TE1 = { sessionId: 'te-polluted-1' }

test('TE1c: 反空过控制 —— 未污染的同一份历史仍 ready，且正常 load 后可执行', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')
  const svc = boot.ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery 服务必须可达')

  queueResponse({ text: 'TE phase one' })
  const handle = await drive(boot.ctx, boot.tmpRoot, TE1.sessionId)
  const session = handle.agent.session
  await userTurn(handle, 'Say something so the host emits a real request header.')

  const real = await boot.ctx.sessionQuery.readSession(TE1.sessionId)
  assert.ok(Array.isArray(real.events) && real.events.length > 0, '前置：必须读到真实事件流')
  assert.deepEqual(real.events.map((e) => e.seq), real.events.map((_e, i) => i),
    '前置：真实 durable 流的 seq 自 0 连续')

  // 未污染控制：直接把**真实**事件流交给冷恢复
  const control = await coldRestoreThrough(svc, boot.ctx.sessionQuery, TE1.sessionId, real.events, session, handle.agent)
  assert.ok(control.served.calls > 0, '前置：包装确实被冷恢复读取过')
  assert.equal(control.outcome.mode, 'ready',
    `未污染历史必须照常 ready（若这里也 block，则 TE1 的 body=0 是空过）：${JSON.stringify(control.outcome)}`)
  assert.equal(control.runtime.engine.getState(control.runtime.scope).selected.size, 0,
    '前置：未污染历史里也没有 canonical tool_load 对')

  // 控制还要证明「恢复 ready 之后一切照常」：真实 load + 真实执行
  queueResponse({ toolCalls: [{ id: 'te1c-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'te1c-use', name: HIDDEN, arguments: { text: 'ok' } }] })
  queueResponse({ text: 'TE1c done' })
  await userTurn(handle, 'Load and call the hidden fixture tool.')
  assert.equal(store.bodyCount('te1c-use'), 1,
    '反空过控制：未污染恢复之后必须仍能 load 并执行（否则 TE1 的 0 无分辨力）')

  await handle.dispose()
})

test('TE1: 受污染的 first request/header 不得授信 —— 冷恢复后猜名调用 body 必须为 0', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  // --- 阶段 1：真实 composition 跑一轮，取真实 durable 事件流 -----------------
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')
  const svc = boot.ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery 服务必须可达')

  queueResponse({ text: 'TE1 phase one' })
  const handle = await drive(boot.ctx, boot.tmpRoot, TE1.sessionId)
  const session = handle.agent.session
  await userTurn(handle, 'Say something so the host emits a real request header.')
  assert.equal(session.seq > 0, true, '前置：阶段 1 必须留下非空历史（否则没有冷恢复）')

  const real = await boot.ctx.sessionQuery.readSession(TE1.sessionId)
  assert.ok(Array.isArray(real.events) && real.events.length > 0, '前置：必须读到真实事件流')
  assert.ok(real.events.some((e) => e.type === 'request/header'), '前置：真实宿主必须产出 request/header')
  assert.deepEqual(real.events.map((e) => e.seq), real.events.map((_e, i) => i),
    '前置：真实 durable 流的 seq 自 0 连续（污染不得靠改 seq 混入）')

  const baselineHeaderNames = real.events
    .filter((e) => e.type === 'request/header')
    .flatMap((e) => (e.data?.header?.tools ?? []).map((t) => t.name))
  assert.equal(baselineHeaderNames.includes(HIDDEN), false,
    `前置：真实出站本来就不含 ${HIDDEN}，否则本例不是污染而是正常加载`)
  assert.deepEqual([...new Set(baselineHeaderNames)].sort(), ['tool_list', 'tool_load', 'tool_search'],
    '前置：alwaysVisible:[] 下真实出站基线只有三个发现入口')

  // --- 注入：声明式污染第一条 request/header ---------------------------------
  const { events: polluted, pollutedSeq, pollutedTools } = polluteFirstHeader(real.events, hiddenSchemaOf(boot.ctx))
  assertPollutedShape(polluted, pollutedSeq, pollutedTools)

  // --- 阶段 2：同 composition 内释放 runtime，再用包装过的 query 冷恢复 -------
  // session 仍是真实宿主 Session，guard 与工具 body 路径完全真实；
  // 只把「读盘结果」换成上面那份声明过的污染历史。
  const pollutedRestore = await coldRestoreThrough(svc, boot.ctx.sessionQuery, TE1.sessionId, polluted, session, handle.agent)
  assert.ok(pollutedRestore.served.calls > 0, '前置：污染包装确实被冷恢复读取过')
  assert.equal(pollutedRestore.runtime.engine.getState(pollutedRestore.runtime.scope).selected.size, 0,
    '前置：污染历史里没有任何 canonical tool_load 对，selected 必须是空的（授权不来自 canonical 折叠）')

  // --- 直连执行：真实执行管线，插件 guard 是唯一可能放行的关口 ----------------
  const exec = await directExec(boot.ctx, handle.agent, HIDDEN, { text: 'guessed' }, 'te1-guess')
  assert.equal(store.bodyCount('te1-guess'), 0,
    `受污染的 first request/header 不得成为执行授权：${HIDDEN} 的 body 执行次数必须为 0`)
  assert.equal(exec.isError, true,
    `直连执行必须被拒（isError），实际结果：${JSON.stringify(exec.result)?.slice(0, 400)}`)
  assert.match(exec.text, /TOOL_NOT_LOADED|INCOMPATIBLE_|not admitted|STATE_NOT_READY|never|未/i,
    `拒绝必须带明确理由，实际文本：${exec.text.slice(0, 400)}`)

  await handle.dispose()
})

/**
 * 取产品公开的可信周期常量（`plugin/adapters/dsh/trusted-epoch.mjs`）。
 *
 * 产品尚未提供时**明确报错**，绝不静默降级 —— 否则「记录本来就没写过」会被误当成
 * 「记录被删除」，把 TE2d 变成空过。
 */
async function trustedEpochConstants () {
  try {
    const mod = await import('../../adapters/dsh/trusted-epoch.mjs')
    const domain = mod.TRUSTED_EPOCH_DOMAIN
    const table = mod.TRUSTED_EPOCH_TABLE
    if (typeof domain !== 'string' || typeof table !== 'string') {
      throw new Error(`trusted-epoch.mjs 未导出合法的 TRUSTED_EPOCH_DOMAIN / TRUSTED_EPOCH_TABLE：${JSON.stringify(mod)}`)
    }
    return { domain, table }
  } catch (error) {
    throw new Error(
      '产品尚未提供公开的可信周期常量（adapters/dsh/trusted-epoch.mjs 的 TRUSTED_EPOCH_DOMAIN / TRUSTED_EPOCH_TABLE）；'
      + `TE2d 不能在缺少它时用「记录本来就没写过」冒充「记录被删除」。原始错误：${String(error?.message ?? error)}`,
    )
  }
}

/** 在真实 storageDomain 里定位本会话的那条可信记录，返回 { key, value } 或 null。 */
function findRecordOf (table, sessionId) {
  for (const [key, value] of table.entries()) {
    if (value?.sessionId === sessionId) return { key, value }
  }
  return null
}

/** 在一个**已经存在真实历史**的运行中的 composition 上，挂载产品 adapter。
 *  这是 legacy 的真实构造方式：会话日志里根本没有本插件写过的任何东西，
 *  也就一定没有可信周期记录。（对照：把 record 删掉是故障注入，另立一例。） */
async function mountAdapterLate (boot, config) {
  await boot.loader.create({
    id: 'progressive-discovery',
    name: fixtureFileUrl(LOCAL.adapter),
    config
  })
  await boot.loader.await()
  const entry = boot.loader.entries().find((item) => item.id === 'progressive-discovery')
  assert.ok(entry !== undefined, 'adapter entry 必须已登记')
  return entry
}

/** 观察下一轮真实出站。
 *
 * 纪律（不得靠吞异常或采样窗口假签绿）：
 *   * 窗口只用于**取样**，不当作终态。终态取自两处真实事实：① 出站请求计数；
 *     ② `lifecycle.whenReady(sessionId)` 的**落定结果**（mode + reason）——
 *     被阻止的会话必须在这里给出可断言的终态。
 *   * 不再用「racing timer 赢」冒充 settle：那个 3s 分支赢时那一轮仍在跑。
 *     本函数只**取样并返回**；真正结束这一轮由调用方在 finally 里
 *     `await handle.dispose()` 走宿主取消管线收尾。
 */
async function observeNextTurn (store, queueResponse, handle, sessionId, label, lifecycle, windowMs = 800) {
  // late-mount 的会话在 `handle.agent.session.ctx` 上取不到服务，必须由调用方
  // 显式把 **boot.ctx 上那个** lifecycle 传进来；否则 settled 会是 null，
  // 下游的 `notEqual(settled?.mode,'ready')` 就变成 `notEqual(undefined,'ready')` 的空过。
  assert.ok(lifecycle !== undefined && lifecycle !== null,
    'observeNextTurn 必须显式传入 boot.ctx 上的 lifecycle')
  const ctx = handle.agent.session?.ctx
  const events = []
  const off = ctx?.on?.('session/event', (session, event) => {
    if (session.id === sessionId) events.push(event.type)
  })
  const before = store.requests.length
  queueResponse({ text: `${label} turn` })
  userTurn(handle, 'Continue.').catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  const sent = store.requests.slice(before)
  const settled = await lifecycle.whenReady(sessionId)
  assert.ok(settled !== undefined && settled !== null && typeof settled.mode === 'string',
    `终态必须存在且带明确 mode（不得是 null/undefined）：${JSON.stringify(settled)}`)
  off?.()
  return { sent, events, settled }
}

/** 断言一个被阻止的会话给出了**明确的**非 ready 终态（不能用 undefined 蒙过去）。 */
function assertBlocked (settled, label) {
  assert.ok(settled !== undefined && settled !== null, `${label}: 终态不得缺失`)
  assert.equal(typeof settled.mode, 'string', `${label}: 终态必须带 mode`)
  assert.notEqual(settled.mode, 'ready',
    `${label}: 必须给出真实的非 ready 终态（mode+reason）：${JSON.stringify(settled)}`)
}

// ---------------------------------------------------------------------------
// TE4：真实用户 `/compact` 的迁移触发链
//
// 触发链的五条事件形状**逐行取自安装内实现**，不是猜测：
//   @deepseek-ai/dsh-commands/lib/index.js:334-346
//     command/run  { commandId, name, args, source: { kind: 'user' } }
//     command/done { commandId, kind, text, sourceEventSeq? }
//   @deepseek-ai/dsh-command-compact/lib/index.js:52-59
//     result.sourceEventSeq = result.summarySeq
//   ⇒ `command/done`(success) 的 sourceEventSeq 必须匹配 **compaction/summary 的 seq**，
//     **不是** compaction/end 的 seq。这一点写死成断言。
//   @deepseek-ai/dsh-compaction-basic（compactSurfaceRegion）
//     compaction/start → compaction/summary → compaction/end(无 error)
// ---------------------------------------------------------------------------
const COMPACTION_SERVICES = [
  { id: 'commands', name: '@deepseek-ai/dsh-commands', config: {} },
  { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic',
    config: { auto: false, headroomTokens: 1024, maxTokens: 256, compactionRetries: 0 } },
  { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact', config: {} }
]

test('TE4a: 真实用户 /compact 产生五条迁移触发事件，且 done.sourceEventSeq 匹配 summary 而非 end', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({
    fixtures: FIXTURES, adapter: ADAPTER_CONFIG, extraServices: COMPACTION_SERVICES
  })
  cleanup.push(() => boot.dispose())
  assert.equal(boot.ctx.get('commands') !== undefined, true, '前置：真实 commands 服务必须激活')

  queueResponse({ text: 'Earlier inspection details. '.repeat(500) })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'te4a-manual')
  await userTurn(handle, 'Inspect the earlier context. '.repeat(300))

  // 压缩自己会发一次摘要请求（mock provider 按脚本回放），必须先排队，
  // 否则真实压缩会以 "could not produce a useful summary" 失败。
  queueResponse({ text: 'Continue the inspection task.' })
  const settled = await boot.ctx.commands.execute(handle.agent, '/compact', [], new AbortController().signal)
  assert.ok(settled !== undefined, '前置：/compact 必须被真实 commands 服务受理')
  assert.equal(settled.result.kind, 'success', `压缩必须成功：${JSON.stringify(settled.result)}`)

  const events = (await boot.ctx.sessionQuery.readSession('te4a-manual')).events
  const commandId = settled.commandId
  const run = events.find((e) => e.type === 'command/run' && e.data?.commandId === commandId)
  assert.ok(run !== undefined, '必须记录 command/run')
  assert.equal(run.data.name, 'compact', 'command/run 的 name 必须是 compact')
  assert.equal(run.data.source?.kind, 'user', '迁移只认用户发起的 /compact')

  const start = events.find((e) => e.type === 'compaction/start')
  assert.ok(start !== undefined, '必须记录 compaction/start')
  const summaries = events.filter((e) => e.type === 'compaction/summary'
    && e.data?.compactionId === start.data.compactionId)
  assert.equal(summaries.length, 1, `成功压缩必须恰好一条 compaction/summary，实际 ${summaries.length}`)
  const end = events.find((e) => e.type === 'compaction/end'
    && e.data?.compactionId === start.data.compactionId && e.data?.error === undefined)
  assert.ok(end !== undefined, '必须记录一条无 error 的 compaction/end')

  const done = events.find((e) => e.type === 'command/done' && e.data?.commandId === commandId)
  assert.ok(done !== undefined, '必须记录 command/done')
  assert.equal(done.data.kind, 'success', 'command/done 必须是 success')
  assert.equal(done.data.sourceEventSeq, summaries[0].seq,
    `command/done.success 的 sourceEventSeq 必须匹配 compaction/summary 的 seq（${summaries[0].seq}）`)
  assert.notEqual(done.data.sourceEventSeq, end.seq,
    'command/done.success 的 sourceEventSeq 不得匹配 compaction/end 的 seq')

  await handle.dispose()
})

test('TE4b: legacy 会话（无记录）经一次成功手动 /compact 后必须迁移并恢复可用', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, extraServices: COMPACTION_SERVICES })
  cleanup.push(() => boot.dispose())

  queueResponse({ text: 'Earlier inspection details. '.repeat(500) })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'te4b-migrate')
  await userTurn(handle, 'Inspect the earlier context. '.repeat(300))
  await handle.dispose()
  store.reset()

  const sessionId = 'te4b-migrate'
  try {
    await mountAdapterLate(boot, ADAPTER_CONFIG)
    const svc = boot.ctx.get('progressiveDiscovery')
    const blocked = await resumeDrive(boot.ctx, sessionId)
    const { sent: beforeCompact, settled: beforeSettled } = await observeNextTurn(store, queueResponse, blocked, 'te4b-migrate', 'TE4b-before', svc.lifecycle)
    assert.equal(beforeCompact.length, 0,
      `前置：迁移前 legacy 会话必须已被阻止；实际发出：${JSON.stringify(beforeCompact.map(namesOf))}`)
    assertBlocked(beforeSettled, 'TE4b 迁移前')

    // 迁移必须在一个**确实空闲**的 agent 上发起：compaction 对 busy 直接失败。
    // 用一次真实 dispose + resume 得到确定空闲的句柄，而不是靠采样窗口或超时兜底。
    await blocked.dispose()
    const migrator = await resumeDrive(boot.ctx, sessionId)
    await migrator.agent.whenIdle()

    // 压缩自己会发一次摘要请求（mock provider 按脚本回放）；不预配就会以
    // "could not produce a useful summary" 失败，那不构成一次成功迁移。
    queueResponse({ text: 'Continue the inspection task.' })
    const settled = await boot.ctx.commands.execute(migrator.agent, '/compact', [], new AbortController().signal)
    assert.equal(settled?.result?.kind, 'success',
      `手动 /compact 必须成功，否则不构成迁移：${JSON.stringify(settled)}`)

    store.reset()
    const { sent: after, settled: afterSettled } = await observeNextTurn(store, queueResponse, migrator, 'te4b-migrate', 'TE4b-after', svc.lifecycle)
    assert.ok(after.length > 0,
      '成功手动 /compact 之后 legacy 会话必须迁移为可用并正常出站')
    assert.equal(afterSettled.mode, 'ready',
      `迁移后的会话必须落 ready，实际：${JSON.stringify(afterSettled)}`)
    const runtime = runtimeOf(boot.ctx, sessionId)
    assert.deepEqual([...runtime.alwaysNames], [],
      '迁移后的新 epoch 必须采用当前配置（本例配置为 []）')
  } finally {
    for (const handle of handles.splice(0)) {
      try { await handle.dispose() } catch { /* 已释放 */ }
    }
  }
})
// ---------------------------------------------------------------------------
// TE2：legacy（可信记录从未存在过）—— 明确阻止请求，不采用日志缩水 fallback
//   构造：先在**没有 adapter** 的 composition 里造出真实历史，再挂 adapter。
//   期望：0 出站请求（不是「发一份只带三入口的缩水请求」）。
// ---------------------------------------------------------------------------
test('TE2: legacy 会话（历史早于 adapter，无可信记录）→ 0 出站请求，不发缩水 fallback', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')

  queueResponse({ text: 'TE2 legacy history' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'te2-legacy')
  await userTurn(handle, 'Build some real history before the adapter exists.')
  assert.equal(handle.agent.session.seq > 0, true, '前置：必须先有真实非空历史')
  assert.equal(boot.ctx.get('progressiveDiscovery'), undefined,
    '前置：本轮 adapter 根本不应激活（legacy 靠真实历史构造，不是靠没激活）')

  await handle.dispose()
  store.reset()

  const sessionId = 'te2-legacy'
  try {
    const entry = await mountAdapterLate(boot, ADAPTER_CONFIG)
    assert.equal(entry.fiber?._error, undefined, `adapter 必须激活：${String(entry.fiber?._error)}`)
    const resumed = await resumeDrive(boot.ctx, sessionId)
    const { sent, settled } = await observeNextTurn(store, queueResponse, resumed, sessionId, 'TE2',
      boot.ctx.get('progressiveDiscovery').lifecycle)
    assert.equal(sent.length, 0,
      `legacy 会话不得发出任何出站请求（禁止日志缩水 fallback）；实际发出：${JSON.stringify(sent.map(namesOf))}`)
    assertBlocked(settled, 'TE2 legacy')
  } finally {
    for (const handle of handles.splice(0)) {
      try { await handle.dispose() } catch { /* 已释放 */ }
    }
  }
})

// ---------------------------------------------------------------------------
// TE2p：缺 provider（omitStorage）—— 同样必须阻止请求，而不是静默降级
// ---------------------------------------------------------------------------
test('TE2p: 缺 storageDomain provider → legacy 会话同样 0 出站请求（不得静默降级放行）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, omitStorage: true })
  cleanup.push(() => boot.dispose())
  assert.equal(boot.storageMounted, false, '前置：本 composition 确实没装 storage')
  assert.equal(boot.ctx.get('storageDomain'), undefined, '前置：storageDomain 服务不可达')

  queueResponse({ text: 'TE2p legacy history' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'te2p-legacy')
  await userTurn(handle, 'Build history.')
  await handle.dispose()
  store.reset()

  try {
    const entry = await mountAdapterLate(boot, ADAPTER_CONFIG)
    const resumed = await resumeDrive(boot.ctx, 'te2p-legacy')
    const { sent, settled } = await observeNextTurn(store, queueResponse, resumed, 'te2p-legacy', 'TE2p', boot.ctx.get('progressiveDiscovery').lifecycle)
    assert.equal(sent.length, 0,
      `缺可信存储 provider 时不得发出任何出站请求；实际发出：${JSON.stringify(sent.map(namesOf))}`)
    assertBlocked(settled, 'TE2p 缺 provider')
    void entry
  } finally {
    for (const handle of handles.splice(0)) {
      try { await handle.dispose() } catch { /* 已释放 */ }
    }
  }
})

// ---------------------------------------------------------------------------
// TE9：跨 runtime 恢复 —— 同 epoch 的 settings 必须冻结（不被新配置改写）
//   形态：真实关闭句柄释放会话租约后，**复用同一 root** 起第二个 Loader
//   （不是介质复制；sessions 与可信存储都在同一 root 上）。
// ---------------------------------------------------------------------------
test('TE9: 同 root 重启后，同一 epoch 的常驻基线必须仍是该 epoch 的旧配置', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot1.dispose())

  queueResponse({ text: 'TE9 phase one' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, 'te9-frozen')
  await userTurn(h1, 'Say something.')
  const first = runtimeOf(boot1.ctx, 'te9-frozen')
  assert.deepEqual([...first.alwaysNames], [],
    '前置：第一段 runtime 的基线是显式置空的配置')
  await h1.dispose()

  // **真关闭** boot1 的全部服务（保留 tmpRoot），让第二个 Loader 不是并发开同一物理介质。
  // 句柄必须在关闭**前**取出来，并把「域已打开」钉成强前置；关闭**后**再**无条件**断言句柄
  // 已释放。这里**不允许** `if (probe !== undefined)` 式静默跳过（TER 独立审查 F3）：
  // 那样「storageDomain 不可达」时整段断言会悄悄消失，门禁就测不到「真的关过」。
  const facility = boot1.ctx.get('storageDomain')
  assert.ok(facility !== undefined,
    '前置：真实 storageDomain 服务必须可达（否则「域已释放」这条断言无法成立，不得跳过）')
  const { domain } = await trustedEpochConstants()
  // 断言一律用 **boolean** 表达式：把 Cordis 的 domain 对象直接交给 assert.equal，失败时会先
  // 触发它的 custom inspect，抛出的就不是本判据的 AssertionError，而会遮掉真正要看的差异。
  assert.equal(facility.get(domain) !== undefined, true,
    `前置：第一段必须已打开可信域 ${domain}（否则关闭后的「已释放」是空过）`)
  await boot1.closeServices()
  assert.equal(facility.get(domain) === undefined, true,
    '真关闭后：可信域句柄必须已释放（storageDomain.get 返回 undefined）；否则第二段就是并发打开同一介质')

  // 同一 root 上重启 Loader；配置改成包含 hidden —— 同 epoch 不得被改写。
  const boot2 = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapter: { alwaysVisible: [HIDDEN] },
    tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  store.reset()

  queueResponse({ text: 'TE9 resumed' })
  const h2 = await resumeDrive(boot2.ctx, 'te9-frozen')
  try {
    await userTurn(h2, 'Continue after restart.')
    const second = runtimeOf(boot2.ctx, 'te9-frozen')
    assert.deepEqual([...second.alwaysNames], [],
      '同一 epoch 内设置变更只在下一次周期生效：恢复后的基线必须仍是旧配置（[]），不得被新配置改写')

    // 执行面必须随之冻结：配置里新加的 hidden 在本 epoch 内仍需正常 load 才能用。
    queueResponse({ toolCalls: [{ id: 'te9-guess', name: HIDDEN, arguments: { text: 'x' } }] })
    queueResponse({ text: 'TE9 done' })
    await userTurn(h2, 'Call the hidden fixture tool.')
    assert.equal(store.bodyCount('te9-guess'), 0,
      '同 epoch 内新配置不得提前放行：hidden 仍须先 load')
  } finally {
    await h2.dispose()
  }
})

// ---------------------------------------------------------------------------
// TE2d：record 被删除（测试私有 tmp 内的故障注入）—— 退化为 legacy，不得放行
// ---------------------------------------------------------------------------
test('TE2d: 可信记录被删除后（私有 tmp 故障注入）→ 退化为 legacy，0 出站请求', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot1 = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot1.dispose())

  queueResponse({ text: 'TE2d phase one' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, 'te2d-record')
  await userTurn(h1, 'Say something.')
  await h1.dispose()

  // 必须先用**官方 durable API** 确认这条记录真的存在过 ——
  // 否则「产品本来就没写过记录」会被误当成「记录被删除」，把本例变成空过。
  const { domain: domainName, table: tableName } = await trustedEpochConstants()
  const facility = boot1.ctx.get('storageDomain')
  assert.ok(facility !== undefined, '前置：真实 storageDomain 服务必须可达')
  const domain = facility.get(domainName)
  assert.ok(domain !== undefined, `前置：产品必须已打开可信域 ${domainName}（否则无法证明记录曾存在）`)
  const table = domain.table(tableName)
  const found = findRecordOf(table, 'te2d-record')
  assert.ok(found !== null,
    `前置：会话 te2d-record 的可信记录必须真实存在于 ${domainName}.${tableName}，否则本例是空过`)

  // 故障注入：走**官方 durable 删除接口**删掉这一条（测试私有 tmp 内的介质），
  // 不裸删目录，也不假装没写过。
  await table.delete(found.key)
  assert.equal(table.get(found.key), undefined, '删除正控：get 必须返回 undefined')
  assert.equal(findRecordOf(table, 'te2d-record'), null, '删除正控：entries 里不得再有本会话的记录')

  const boot2 = await bootAdapterComposition({
    fixtures: FIXTURES, adapter: ADAPTER_CONFIG, tmpRoot: boot1.tmpRoot
  })
  cleanup.push(() => boot2.dispose())
  store.reset()

  const h2 = await resumeDrive(boot2.ctx, 'te2d-record')
  try {
    const { sent, settled } = await observeNextTurn(store, queueResponse, h2, 'te2d-record', 'TE2d', boot2.ctx.get('progressiveDiscovery').lifecycle)
    assert.equal(sent.length, 0,
      `记录缺失不得被当作「没有历史」而放行；实际发出：${JSON.stringify(sent.map(namesOf))}`)
    assertBlocked(settled, 'TE2d 记录被删')
  } finally {
    await h2.dispose()
  }
})

// ---------------------------------------------------------------------------
// TE1r（修正）：污染头 **在有可信记录时** 不等于「永不出站」。
//   产品尚未定义历史泄漏审计契约，因此这里**只**钉授权面：direct exec 必被拒、
//   body=0；出站是否继续由产品决定，本用例不做 0 请求断言。
//   0 请求的强制归属是 legacy（TE2/TE2p/TE2d）与 storage 故障/pending 路径。
// ---------------------------------------------------------------------------
test('TE1r: 污染头不得授信 —— 有可信记录时 direct exec 必被拒且 body=0', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())
  const svc = boot.ctx.get('progressiveDiscovery')

  queueResponse({ text: 'TE1r phase one' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'te1r-trusted')
  const session = handle.agent.session
  await userTurn(handle, 'Say something.')
  const real = await boot.ctx.sessionQuery.readSession('te1r-trusted')
  assert.ok(real.events.some((e) => e.type === 'request/header'), '前置：真实宿主必须产出 request/header')

  const { events: polluted } = polluteFirstHeader(real.events, hiddenSchemaOf(boot.ctx))
  try {
    const restored = await coldRestoreThrough(svc, boot.ctx.sessionQuery, 'te1r-trusted', polluted, session, handle.agent)
    const exec = await directExec(boot.ctx, handle.agent, HIDDEN, { text: 'guessed' }, 'te1r-guess')
    assert.equal(exec.isError, true,
      `污染头不得让 direct exec 放行；实际文本：${exec.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('te1r-guess'), 0,
      '有可信记录也救不了被污染的 header：body 必须为 0')
    void restored
  } finally {
    await handle.dispose()
  }
})

// ---------------------------------------------------------------------------
// TE-LM：storage **迟到到位**不得成为 legacy 会话的迁移捷径。
//
// 被证伪的实现（index.mjs `retryStorageUnavailable` → lifecycle `retryBaseline`）：
//   legacy 会话（own 段有真实出站历史、无可信记录）在**存储缺席**时恢复，落成
//   STORAGE_UNAVAILABLE；存储稍后到位 → ctx.inject 回调 → retryBaseline →
//   resolveBootstrapBaseline **不检查 own 出站资格** → ledger.load() 得到 MISSING →
//   直接 `ledger.begin(currentAlwaysNames(),'initial')` 给这条 legacy 会话补建一条
//   初始记录 → TRUSTED → engine.ready。
//
// 这正是 docs/08 §2.4/§2.5 明令禁止的：缺记录的既有会话只能由**本次真实的用户
// `/compact`** 迁移。存储迟到是**时序**，不是授权事实；靠它补建记录，等于把
// 「观察到的存储可用性」当成「用户迁移过」的替身，重新引入本项要移除的那种授信。
//
// 判据（三条互相独立）：
//   前置   legacy 恢复确实落 STORAGE_UNAVAILABLE（不是别的终态冒充）。
//   主判据 迟到 open 之后，本会话**不得**出现任何可信记录（durable 侧的硬证据）。
//   执行   基线仍不可授权、再开一轮仍 0 出站请求（不得发缩水 fallback）。
// ---------------------------------------------------------------------------
test('TE-LM: storage 迟到到位不得给 legacy 会话补建初始记录（绕过用户手动迁移）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, omitStorage: true })
  cleanup.push(() => boot.dispose())
  assert.equal(boot.storageMounted, false, '前置：本 composition 起初没装 storage')

  const sessionId = 'te-lm-legacy'
  queueResponse({ text: 'TE-LM legacy history' })
  const history = await drive(boot.ctx, boot.tmpRoot, sessionId)
  await userTurn(history, 'Build some real history before the adapter exists.')
  assert.equal(history.agent.session.seq > 0, true, '前置：必须先有真实非空历史')
  await history.dispose()
  store.reset()

  // adapter 迟到挂载：恢复时存储缺席 → legacy 落 STORAGE_UNAVAILABLE。
  await mountAdapterLate(boot, ADAPTER_CONFIG)
  const resumed = await resumeDrive(boot.ctx, sessionId)
  const blocked = await observeNextTurn(store, queueResponse, resumed, sessionId, 'TE-LM', boot.ctx.get('progressiveDiscovery').lifecycle)
  assertBlocked(blocked.settled, 'TE-LM 存储缺席')
  const runtime = runtimeOf(boot.ctx, sessionId)
  assert.equal(runtime.journal.hasOwnOutboundHistory(), true,
    '前置：本会话 own 段确有真实出站事实（因此它是 legacy，不是新会话）')
  assert.equal(runtime.ledger.state, 'blocked', `前置：必须是被封住的终态；实际 ${runtime.ledger.state}`)
  assert.equal(runtime.ledger.reason, 'STORAGE_UNAVAILABLE',
    `前置：必须正是存储缺席这一种；实际 ${String(runtime.ledger.reason)}`)

  // ---- storage 迟到到位：index.mjs 的 ctx.inject 回调会在这里触发 retry ----
  for (const spec of storageEntries(boot.tmpRoot)) {
    await boot.loader.create(spec)
  }
  await boot.loader.await()
  assert.ok(boot.ctx.get('storageDomain') !== undefined, '前置：storage 真的到位了')
  const { domain: domainName, table: tableName } = await trustedEpochConstants()
  const facility = boot.ctx.get('storageDomain')
  // ctx.inject 回调与 store 的 open 都是异步的：等域真的被打开，再留出迟到重试的落定窗口。
  let domain = null
  for (let i = 0; i < 40 && domain === null; i += 1) {
    domain = facility.get(domainName) ?? null
    if (domain === null) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(domain !== null, `前置：产品必须已打开可信域 ${domainName}`)
  await new Promise((resolve) => setTimeout(resolve, 800))

  assert.equal(findRecordOf(domain.table(tableName), sessionId), null,
    `迟到到位绝不能给 legacy 会话补建可信记录（${domainName}.${tableName} 中不得出现本会话的记录）：`
    + '那会把它变成"已可信"，而按契约只有本次真实用户 /compact 才能做到')

  assert.equal(runtime.ledger.state !== 'trusted', true,
    `基线仍必须不可授权；实际 state=${runtime.ledger.state} names=${JSON.stringify(runtime.ledger.names)}`)
  assert.equal(runtime.alwaysNames.length, 0,
    `常驻名单必须仍为空；实际 ${JSON.stringify(runtime.alwaysNames)}`)
  assert.equal(runtimeOf(boot.ctx, sessionId).engine.getState(runtimeOf(boot.ctx, sessionId).scope).mode !== 'ready', true,
    '引擎不得被迟到重试置为 ready')

  // 执行面：基线不可授权时 guard 必须在 alwaysNameSet 早退之前就拒绝。
  const exec = await directExec(boot.ctx, resumed.agent, HIDDEN, { text: 'lm-guess' }, 'te-lm-guess')
  assert.equal(exec.isError, true, `legacy 基线未迁移前直连执行必须被拒；实际文本：${exec.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('te-lm-guess'), 0, 'legacy 基线未迁移前 body 必须为 0')

  const after = await observeNextTurn(store, queueResponse, resumed, sessionId, 'TE-LM-after', boot.ctx.get('progressiveDiscovery').lifecycle)
  assert.equal(after.sent.length, 0,
    `迟到到位后仍不得发出任何出站请求；实际发出：${JSON.stringify(after.sent.map(namesOf))}`)
  assertBlocked(after.settled, 'TE-LM 迟到到位后')

  for (const handle of handles.splice(0)) {
    try { await handle.dispose() } catch { /* 已释放 */ }
  }
})

// ---------------------------------------------------------------------------
// TE-R：canonical `tool_load` 回执链仍是按需 selection 的**正向授权源**
//
// 判据（08 §4 的 TE-R 行）：本项（可信周期基线）**不**得把 canonical
// `tool/call`→`tool/result` 回执链移除或降级成「仅披露」的事实。
//
// 为什么这需要**独立**门禁，而不是 TE0 / TE1x 已经覆盖：
//   * TE0  覆盖**新鲜会话**折叠后 selected 可观测、body 执行 1 次；
//   * TE1x 覆盖**常驻名单**（alwaysVisible 显式含该工具 → alwaysNameSet 早退放行）。
//   两者都没有把「授权来自回执链」与「授权来自常驻名单」**拆开**证明 ——
//   TE0 的会话基线虽为空，但它断言的是披露 + selected 可观测，没有断言执行面
//   「只可能」由回执链放行。
//   本组用 `alwaysVisible: []`（基线显式置空）把常驻名单这条面整个拿掉，于是该工具
//   能被执行就**只可能**是因为 canonical 回执链产出了 selection。
//
// 三条判据：
//   TER0 前置：置空基线下真实 `tool_load` 折叠 → selected 含该工具，且该名字既不在
//        alwaysNameSet 也不在 ledger.names 里（不满足则本组是空转，必须先报出来）。
//   TER1 **正向**：跨**真重启**（同 root 真关闭后重开 Loader + resume）冷恢复之后，
//        该工具**仍被授权**：selection 必须由持久日志里的回执链重放重建，直连执行
//        body=1、isError=false。可信基线在此期间**始终为空**，所以授权无处可借。
//   TER2 **不得放宽**（同一冷恢复后的反空过对照）：同一份历史里另一个**从未 load**
//        的隐藏工具（fixture_hidden_scope）必须仍被拒、body=0 ——
//        证明 TER1 不是靠「恢复后一律放行」换来的。
// ---------------------------------------------------------------------------

/** 对照工具：scope-own、从不被 load，用来证明 TER1 不是「恢复后一律放行」。 */
const TER_SCOPE_ONLY = 'fixture_hidden_scope'

/**
 * `engine.selected` 是以**规范 toolId**（`global::x` / scope 前缀）为键的 Map，
 * 而产品自己的授权判据是按 `.name` 过滤（`plugin/domain/state.mjs:429`
 * `Array.from(state.selected.values()).filter((s) => s.name === ctx.name)`）。
 * 因此这里走**同一条**解析路径，而不是假设 Map 的键就是裸工具名。
 * @param {{selected:Map<string,any>}} state
 * @param {string} name
 */
function isSelected (state, name) {
  return Array.from(state.selected.values()).some((entry) => entry.name === name)
}

test('TER0: 置空基线下 canonical tool_load 折叠产出的 selection 是该工具唯一可能的授权来源', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())

  queueResponse({ toolCalls: [{ id: 'ter0-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'ter0-use', name: HIDDEN, arguments: { text: 'control' } }] })
  queueResponse({ text: 'TER0 done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'ter-receipt')
  await userTurn(handle, 'Load the hidden fixture tool, then call it.')

  assert.ok(lastNames(store).includes(HIDDEN),
    `前置：真实折叠后该工具必须已披露，否则本组全是空转；实际出站：${lastNames(store).join(', ')}`)
  assert.equal(store.bodyCount('ter0-use'), 1,
    '前置：原队列里紧接 tool_load 的那次直连调用必须真的执行到 body（证明放行是「执行得下去」而不是「没报错」）')

  const runtime = runtimeOf(boot.ctx, 'ter-receipt')
  const state = runtime.engine.getState(runtime.scope)
  assert.equal(state.mode, 'ready', `前置：会话必须 ready；实际 ${state.mode}`)
  assert.equal(isSelected(state, HIDDEN), true,
    '前置：canonical 回执链折叠必须产出该工具的 selection（这正是 TE-R 要保住的那条授权面）')

  // **两条常驻授权面必须同时为否** —— 否则 TER1 证明不了「授权只能来自回执链」。
  assert.equal(runtime.alwaysNameSet.has(HIDDEN), false,
    `前置：alwaysNameSet 不得含该工具（显式置空基线）；实际 ${JSON.stringify(runtime.alwaysNames)}`)
  assert.equal(runtime.ledger.names?.includes(HIDDEN) ?? false, false,
    `前置：可信记录 names 不得含该工具；实际 ${JSON.stringify(runtime.ledger.names)}`)
  assert.equal(runtime.ledger.state, 'trusted',
    `前置：基线必须已落定为 trusted，否则是另一种终态在起作用；实际 ${runtime.ledger.state}/${runtime.ledger.reason}`)

  await handle.dispose()
})

test('TER1/TER2: 真重启冷恢复后，canonical 回执链重放仍授权按需 selection，且不得放宽到未 load 的工具', async () => {
  const { store, queueResponse } = await storeOf()
  const sessionId = 'ter-cold-reload'
  store.reset()
  const boot1 = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot1.dispose())

  // ---- 第一段：真实加载一次，随后真关闭 ----
  queueResponse({ toolCalls: [{ id: 'ter1-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ toolCalls: [{ id: 'ter1-use', name: HIDDEN, arguments: { text: 'phase one' } }] })
  queueResponse({ text: 'TER1 phase one' })
  const h1 = await drive(boot1.ctx, boot1.tmpRoot, sessionId)
  await userTurn(h1, 'Load the hidden tool, then call it.')
  assert.equal(store.bodyCount('ter1-use'), 1,
    '前置：重启之前该工具必须真的执行过一次（否则后面测的是一条从未生效过的路径）')
  assert.ok(lastNames(store).includes(HIDDEN),
    `前置：重启之前该工具必须已披露；实际 ${lastNames(store).join(', ')}`)
  await h1.dispose()

  // **真关闭**全部服务（保留 tmpRoot）：让第二个 Loader 不是并发开同一物理介质。
  // 这是 TE9 已验证过的形态 —— 只有真关闭，第二个 Loader 才读得到同一份历史。
  // 判据因此必须**自己**钉住「真的关过」，而不是只调用一下 closeServices（TER 独立审查 F1）：
  // 关闭前钉「域已打开」的前置、关闭后无条件断言域句柄已释放。
  const facility1 = boot1.ctx.get('storageDomain')
  assert.ok(facility1 !== undefined,
    '前置：真实 storageDomain 服务必须可达（否则「真重启」无法断言，不得跳过）')
  const { domain: trustedDomain } = await trustedEpochConstants()
  // 同 TE9：断言一律用 **boolean** 表达式，不把 Cordis 的 domain 对象交给 assert.equal
  // （失败格式化会触发它的 custom inspect，把真正的判据差异遮掉）。
  assert.equal(facility1.get(trustedDomain) !== undefined, true,
    `前置：第一段必须已打开可信域 ${trustedDomain}（否则关闭后的「已释放」是空过）`)
  await boot1.closeServices()
  assert.equal(facility1.get(trustedDomain) === undefined, true,
    '真关闭后：可信域句柄必须已释放 —— 否则第二段就是并发打开同一介质，「真重启」不成立')

  // ---- 第二段：同 root 重启。配置与第一段**逐字相同**，基线因此仍是 []。----
  const boot2 = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapter: ADAPTER_CONFIG,
    tmpRoot: boot1.tmpRoot,
  })
  cleanup.push(() => boot2.dispose())
  store.reset()

  const h2 = await resumeDrive(boot2.ctx, sessionId)
  const lifecycle = boot2.ctx.get('progressiveDiscovery').lifecycle
  // runtime 由首次触达建立（`whenReady` 在 runtime 还不存在时只回 unknown）：
  // 先真实跑一轮，让冷恢复在这条链上真正发生，再取终态。形态与 TE9 一致。
  queueResponse({ text: 'TER1 resumed' })
  await userTurn(h2, 'Continue after restart.')
  const settled = await lifecycle.whenReady(sessionId)
  assert.equal(settled.mode, 'ready',
    `前置：冷恢复后必须落 ready（基线可信 + 回执链重放）；实际 ${JSON.stringify(settled)}`)

  const runtime = runtimeOf(boot2.ctx, sessionId)

  // 可信基线在整个过程中**始终为空** —— 这是本判据成立的前提，先钉死。
  assert.equal(runtime.ledger.state, 'trusted',
    `前置：冷恢复后基线必须 trusted；实际 ${runtime.ledger.state}/${runtime.ledger.reason}`)
  assert.equal((runtime.ledger.names ?? []).includes(HIDDEN), false,
    `前置：可信记录仍不得含该工具；实际 ${JSON.stringify(runtime.ledger.names)}`)
  assert.equal(runtime.alwaysNameSet.has(HIDDEN), false,
    `前置：alwaysNameSet 仍不得含该工具；实际 ${JSON.stringify(runtime.alwaysNames)}`)

  // ---- TER1：正向 —— selection 必须由持久日志里的回执链重放重建 ----
  const state = runtime.engine.getState(runtime.scope)
  assert.equal(isSelected(state, HIDDEN), true,
    'TE-R 核心：冷恢复后 canonical tool_load 回执链必须重建该工具的按需 selection'
    + `（这是「回执链仍为正向授权源」的判据）；实际 selected=${JSON.stringify([...state.selected.values()].map((s) => s.name))}`)

  const admitted = await directExec(boot2.ctx, h2.agent, HIDDEN, { text: 'after-cold-reload' }, 'ter1-exec')
  assert.equal(admitted.isError, false,
    `TE-R 核心：冷恢复后该工具必须仍被授权执行；实际文本：${admitted.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('ter1-exec'), 1,
    'TE-R 核心：冷恢复后直连执行必须真的到达 body（证明不是「空放行」）')

  // ---- TER2：反空过对照 —— 从未 load 的同族工具必须仍被拒 ----
  // 前置 + 正控：两个工具都必须**在本 agent scope 内解析得到**。`fixture_hidden_scope` 是
  // agent scope 注册，根 `ctx.tools.get(name)` 返回 undefined，必须带 agent 走同一条解析路径
  // （与 `guard.mjs:55` 的 `registeredInScope` 一致）。缺了这条，「被拒」可能只是宿主解析不到，
  // 而不是本插件的按需授权拒绝 —— 那样 TER2 就证明不了 TER1 的对照关系（TER 独立审查 F2）。
  assert.ok(boot2.ctx.tools.get(TER_SCOPE_ONLY, h2.agent) !== undefined,
    `前置：对照工具必须在本 agent scope 内解析得到（不得退化成宿主解析失败）；实际 ${TER_SCOPE_ONLY}`)
  assert.ok(boot2.ctx.tools.get(HIDDEN, h2.agent) !== undefined,
    '正控：同一解析路径下已被授权的工具也必须解析得到（证明上面那条不是恒真）')

  const denied = await directExec(boot2.ctx, h2.agent, TER_SCOPE_ONLY, { text: 'never-loaded' }, 'ter2-exec')
  assert.equal(denied.isError, true,
    `对照：从未 load 的隐藏工具必须仍被拒（否则 TER1 是靠放宽换来的）；实际文本：${denied.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('ter2-exec'), 0, '对照：从未 load 的工具 body 必须为 0')
  assert.match(denied.text, new RegExp(`${TER_SCOPE_ONLY}: [\\s\\S]*\\(TOOL_NOT_LOADED\\)`),
    `对照：拒绝必须来自本插件 guard 的稳定码 TOOL_NOT_LOADED，而不是「工具根本解析不到」之类的宿主原因；实际文本：${denied.text.slice(0, 300)}`)

  await h2.dispose()
})

// 可信周期名单门禁 —— **own-only fork 隔离**（独立真实 fork 门禁，TF 系列）。
//
// 目标（可信 epoch 持久化的 fork 语义）：
//   一条可信周期记录的身份是 (sessionId, ownSeqStart, epochId, compactionEndSeq)。
//   真实 fork 出来的子会话带一个**非空继承前缀**（inheritedEventCount > 0），但它
//   **没有自己的 own 出站历史**。此时子必须以**此刻的配置**建**自己的**初始记录，
//   而**绝不**继承父的那一份基线/名单。父子的记录因此在同一张表里并存、各自独立；
//   子的授权面里不得出现父的 HIDDEN 常驻名。
//
// 为什么这条门禁独立于 gate-trusted-epoch.test.mjs：
//   那边钉的是「出站日志不得反推授权」与 legacy/迁移/删除/同 root 重启；
//   这边钉的是 **fork 边界的 own-only 隔离**：同 epoch 内父把 alwaysVisible 改成 []，
//   父仍按自己的旧记录（HIDDEN）活着，而**新生的子**按当前配置（[]）建自己的记录。
//   这条路径此前没有任何真实 fork 覆盖。
//
// 真实 seam（全部逐行读自安装内 0.2.1-alpha.1，不猜字段）：
//   * fork：ctx.subagents.start('fork', { parent, prompt, signal })
//     —— @deepseek-ai/dsh-subagent/lib/index.js:3115 `start()` → provider.start()
//     —— @deepseek-ai/dsh-subagent-fork-in-process/lib/index.js:48
//        `completedTurnPrefix(parent)` → startInProcessRun(request, { seed })
//     —— @deepseek-ai/dsh-subagent-in-process-driver/lib/index.js:168/180-189
//        activationBoundary = SessionLogOffset(seed.length)，并把
//        `inheritedEventCount: activationBoundary` 交给 agents.create；
//        run.id === childId === 子会话 id（:219），run.localAgent === 子 Agent。
//   * 记录读回：ctx.storageDomain.get(域名).table(表名).entries()（官方 SDK public）
//   * 设置变更：entry.fiber.config.alwaysVisible[Symbol.for('cosmokit.volatile.write')](…)
//     —— 与 gate-settings.test.mjs SG5/SG6 同一协议（settings 写路径的最终落点）。
//
// 断言纪律：
//   * 每条安全断言都配**正控制**，不做「取到 undefined 就跳过」式空转。
//   * 隔离证明**不靠"碰巧"**：子的拒绝来自它自己那份 [] 记录（names=[] 可直接观测），
//     同一子会话、同一工具、只因为它自己 load 过才 body=1 —— 因此差异来源唯一。
//     同时不依赖 bindingGeneration/revision 差异（那是 domain 折叠层的性质，
//     由 gate-adapter-recovery 的 L03 覆盖；本例只把它当作共存正控观测）。
//   * 不新增任何产品 RPC / 测试钩子 / session 事件；不读 history header 当授权。
//   * 不使用 _fake / _unload；不碰当前桌面真实 host；存储落在本用例私有 tmp/data。
//
// 运行：node --test plugin/tests/composition/gate-trusted-epoch-fork.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, forkServices, startFork } from './harness.mjs'
import {
  TRUSTED_EPOCH_DOMAIN,
  TRUSTED_EPOCH_TABLE,
  INITIAL_EPOCH_ID,
  NO_COMPACTION_SEQ,
} from '../../adapters/dsh/trusted-epoch.mjs'

/** 与既有门禁同一个隐藏目标：真实注册在 global 层、未 load 前对模型不可见。 */
const HIDDEN = 'fixture_hidden_inherited'
/** 父自己 load 的另一个工具：用来证明子的 selected **不**继承父的 own 折叠。 */
const SIBLING = 'fixture_mutating'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']

/** settings 写路径最终落到 schemastery 的 volatile 写协议（gate-settings SG5 同源）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 真实宿主 fork provider（自带 seeded 子会话）。禁止 mock 顶替。
 *  服务集由 harness 统一给出：`@deepseek-ai/dsh-subagent` 自 0.2.1-alpha.2 起硬依赖
 *  `workingDirectory`，只装 subagents 会让它的 fiber 停在 pending —— 见 forkServices 注释。 */
const FORK_SERVICES = forkServices()

/** 本文件所有 composition 的私有 tmp 根（随 after 一并删除，落在 fixture/tmp 之下）。 */
const cleanup = []

after(() => {
  for (const dispose of cleanup.reverse()) {
    try { dispose() } catch { /* 已释放 */ }
  }
})

async function storeOf () {
  return import(new URL('../../fixtures/mock-store.mjs', import.meta.url).href)
}

async function drive (ctx, tmpRoot, sessionId) {
  return ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: tmpRoot }
  })
}

async function resumeDrive (ctx, sessionId) {
  return ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' }
  })
}

async function userTurn (handle, text) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }))
  await handle.agent.whenIdle()
}

function serviceOf (ctx) {
  const svc = ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, '前置：progressiveDiscovery 服务必须可达')
  return svc
}

function runtimeOf (ctx, sessionId) {
  const runtime = serviceOf(ctx).sessions.get(sessionId)
  assert.ok(runtime !== undefined, `前置：真实 runtime 必须存在：${sessionId}`)
  return runtime
}

/**
 * 建立（若尚未建立）该会话的 runtime 并**等它的可信基线落定**。
 *
 * 必须先等再直连执行：guard 是同步的，若基线还在 pending/blocked，它会以
 * STATE_NOT_READY 拒掉一切常驻名 —— 那会把"基线没落定"误读成"记录拒绝授权"。
 * ensureRuntime / whenReady 都是产品服务面的公开只读观测入口
 * （gate-settings / gate-trusted-epoch 已在用），不是测试钩子。
 */
async function settleBaseline (ctx, sessionId, agent) {
  const lifecycle = serviceOf(ctx).lifecycle
  lifecycle.ensureRuntime(agent.session, agent)
  return lifecycle.whenReady(sessionId)
}

/**
 * 直连真实工具执行管线（`ctx.tools.execute(exec)`）：与模型调用同一条完整管线
 * （pre-policy → guards → dispatch），本插件的 guard 就在其中。
 * 用它排除「模型那一轮根本没发出猜名调用，于是 body 恰好是 0」这种空过。
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
 * 从**真实** storageDomain 读回本领域全表，按 sessionId 归并。
 * 只用公开面（facility.get → domain.table → entries），不碰 store 内部状态。
 */
function readRecords (ctx) {
  const facility = ctx.get('storageDomain')
  assert.ok(facility !== undefined, '前置：真实 storageDomain 服务必须可达')
  const domain = facility.get(TRUSTED_EPOCH_DOMAIN)
  assert.ok(domain !== undefined,
    `前置：产品必须已打开可信域 ${TRUSTED_EPOCH_DOMAIN}（否则读不到任何记录，本例是空过）`)
  const table = domain.table(TRUSTED_EPOCH_TABLE)
  const bySession = new Map()
  const all = []
  for (const [key, value] of table.entries()) {
    const record = { key, ...value }
    all.push(record)
    bySession.set(value.sessionId, record)
  }
  return { table, bySession, all }
}

function recordOf (ctx, sessionId) {
  const record = readRecords(ctx).bySession.get(sessionId)
  assert.ok(record !== undefined,
    `前置：${sessionId} 必须在 ${TRUSTED_EPOCH_DOMAIN}.${TRUSTED_EPOCH_TABLE} 里有自己的可信记录；`
    + `现有记录 sessionId：${JSON.stringify(readRecords(ctx).all.map((r) => r.sessionId))}`)
  return record
}

function resultTextOf (event) {
  return (event?.data?.message?.content ?? []).map((block) => block.text ?? '').join('')
}

/** durable 事件流里某次 tool/call 及其绑定的 tool/result（按真实 sourceEventSeqs 关联）。 */
function toolPairOf (events, callId) {
  const call = events.find((event) => event.type === 'tool/call' && event.data?.callId === callId)
  assert.ok(call !== undefined, `前置：durable 流里必须有 ${callId} 的 tool/call（否则"没调用"而不是"被拒"）`)
  const result = events.find((event) => event.type === 'tool/result'
    && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(call.seq))
  assert.ok(result !== undefined, `前置：durable 流里必须有 ${callId} 的 tool/result`)
  return { call, result }
}

/** 真实宿主 fork：子会话必须带非空继承前缀（本门禁的全部前提）。 */
async function forkChild (ctx, parentAgent, promptText = 'Child task.') {
  const subagents = ctx.get('subagents')
  assert.ok(subagents !== undefined && subagents.getProvider('fork') !== undefined,
    '前置：真实宿主 fork provider 必须已注册（禁止 mock 顶替）')
  const run = await startFork(ctx, parentAgent, promptText)
  // run.id === 子会话 id（activation receipt 的 childId），run.localAgent === 子 Agent。
  assert.equal(typeof run.id, 'string', '子 run 必须持有自己的会话 id')
  assert.ok(run.localAgent !== undefined && run.localAgent !== null, '子 run 必须暴露自己的 Agent（直连执行需要）')
  const result = await run.result
  assert.notEqual(result, undefined, 'fork run 必须落定')
  const child = await ctx.sessionQuery.readSession(run.id)
  assert.ok(child.inheritedEventCount > 0,
    `前置：真实 fork 必须 seed 出非空继承前缀，实际 ${child.inheritedEventCount}`)
  assert.equal(child.events[child.inheritedEventCount]?.type, 'session/end-seed', 'seed 切点必须被标记')
  return { run, result, child, childId: run.id, childAgent: run.localAgent }
}

/** 某个子会话「自己的」那条记录：身份必须是 (子会话, 自己的 own 边界)。 */
function assertOwnRecordOf (ctx, childId, inheritedEventCount) {
  const record = recordOf(ctx, childId)
  assert.equal(record.sessionId, childId,
    '子记录必须记在**子自己**的 sessionId 上（不得借用父的 id）')
  assert.equal(record.ownSeqStart, inheritedEventCount,
    `子记录的 ownSeqStart 必须等于 SDK 的继承边界（inheritedEventCount=${inheritedEventCount}），`
    + `实际 ${record.ownSeqStart}`)
  assert.equal(record.epochId, INITIAL_EPOCH_ID, '未压缩的 own-only fork 必须是初始 epoch')
  assert.equal(record.compactionEndSeq, NO_COMPACTION_SEQ, '初始周期没有压缩边界')
  assert.equal(record.trigger, 'initial', 'own-only fork 的初始记录 trigger 必须是 initial')
  return record
}

// ---------------------------------------------------------------------------
// TF0：正控制 —— own-only fork 的记录取的是**当前配置**，且子确实有自己的记录
//
// 这一例是 TF1/TF2 的反空过控制：若"子总是拿到 []"或"子直接复用父那条记录"
// 是产品的真实行为，本例必须红。子此时没有被改成 []，所以它必须拿到 [HIDDEN]。
// ---------------------------------------------------------------------------
test('TF0: 正控制 —— 未改配置的 own-only fork 子按当前配置建自己的记录（[] 不是硬编码）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  const PARENT = 'tf0-parent'
  const boot = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapter: { requireTrustedEpoch: true, requireTrustedEpochForSubagents: true, alwaysVisible: [HIDDEN] },
    adapterSchema: true,
    extraServices: FORK_SERVICES,
  })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')

  const parentHandle = await drive(boot.ctx, boot.tmpRoot, PARENT)
  const openRuns = []
  try {
    queueResponse({ text: 'parent done' })
    await userTurn(parentHandle, 'Say something.')
    assert.deepEqual(recordOf(boot.ctx, PARENT).names, [HIDDEN], '前置：父记录含 HIDDEN')

    queueResponse({ text: 'child quiet done' })
    const forked = await forkChild(boot.ctx, parentHandle.agent, 'Child task.')
    openRuns.push(forked.run)

    const childRecord = assertOwnRecordOf(boot.ctx, forked.childId, forked.child.inheritedEventCount)
    assert.deepEqual(childRecord.names, [HIDDEN],
      `未改配置时子必须按**当前配置**建自己的记录（证明 TF1 的 [] 来自配置而不是硬编码）；实际 ${JSON.stringify(childRecord.names)}`)
    assert.notEqual(childRecord.key, recordOf(boot.ctx, PARENT).key, '子必须是另一条记录，不是父那条的别名')

    // 直连执行正控制：子拿到自己那份含 HIDDEN 的记录后确实能执行
    const settled = await settleBaseline(boot.ctx, forked.childId, forked.childAgent)
    assert.equal(settled.mode, 'ready', `子基线必须 ready：${JSON.stringify(settled)}`)
    const exec = await directExec(boot.ctx, forked.childAgent, HIDDEN, { text: 'child-trusted' }, 'tf0-child-exec')
    assert.equal(exec.isError, false,
      `子按自己的可信记录应能执行：${exec.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('tf0-child-exec'), 1, '正控制：body 必须执行 1 次')
    assert.equal(store.bodyCalls.find((c) => c.callId === 'tf0-child-exec').sessionId, forked.childId,
      'body 证据必须归属子会话')
  } finally {
    for (const run of openRuns.splice(0).reverse()) {
      try { await run.dispose() } catch { /* 已释放 */ }
    }
    try { await parentHandle.dispose() } catch { /* 已释放 */ }
  }
})

// ---------------------------------------------------------------------------
// TF1：同 epoch 内父改配置 → 真实 fork 的子**不**继承父的记录/名单
// ---------------------------------------------------------------------------
test('TF1: 真实 fork 子无 own 出站 → 以当前配置建自己的记录，绝不继承父的 HIDDEN 基线', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  const PARENT = 'tf1-parent'
  const boot = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapter: { requireTrustedEpoch: true, requireTrustedEpochForSubagents: true, alwaysVisible: [HIDDEN] },
    adapterSchema: true,
    extraServices: FORK_SERVICES,
  })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')
  serviceOf(boot.ctx)

  const parentHandle = await drive(boot.ctx, boot.tmpRoot, PARENT)
  const openRuns = []
  try {
    // --- 阶段 1：父先跑一轮（HIDDEN 在可信基线里；另 load 一个 SIBLING 造出父的 own 折叠）---
    queueResponse({ toolCalls: [{ id: 'tf1-parent-load', name: 'tool_load', arguments: { names: [SIBLING] } }] })
    queueResponse({ text: 'parent done' })
    await userTurn(parentHandle, 'Load a sibling tool and finish.')

    const parentRuntime = runtimeOf(boot.ctx, PARENT)
    assert.equal(parentRuntime.engine.getState(parentRuntime.scope).mode, 'ready',
      '前置：父会话必须 ready（它的可信基线已落定）')
    const parentSelected = [...parentRuntime.engine.getState(parentRuntime.scope).selected.values()]
      .map((s) => s.name)
    assert.deepEqual(parentSelected, [SIBLING],
      `前置：父确有一次自己的 canonical load（否则"子不继承父 selected"是空话），实际 ${JSON.stringify(parentSelected)}`)

    // --- 阶段 2：读父的持久记录（配置此时还是 [HIDDEN]） -------------------------
    const parentRecordBefore = recordOf(boot.ctx, PARENT)
    assert.deepEqual(parentRecordBefore.names, [HIDDEN],
      '前置：父的初始记录必须按当时的配置写入 HIDDEN')
    const parentSnapshotBefore = JSON.stringify(parentRecordBefore)

    // 正控制：可信基线含 HIDDEN 时，**直连执行**确实能到 body（证明后面 body=0 有分辨力）
    const parentExecBefore = await directExec(boot.ctx, parentHandle.agent, HIDDEN, { text: 'parent-ok' }, 'tf1-parent-exec-before')
    assert.equal(parentExecBefore.isError, false,
      `正控制：可信基线下的直连执行不得被拒，实际文本：${parentExecBefore.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('tf1-parent-exec-before'), 1, '正控制：直连执行必须真的到达 body')

    // --- 阶段 3：同一父 epoch 内把配置改成 []（settings volatile 写路径） ----------
    const entry = boot.loader.entries().find((item) => item.id === 'progressive-discovery')
    assert.ok(entry !== undefined, '前置：adapter entry 必须已登记')
    assert.equal(entry.fiber._error, undefined, `adapter 必须激活：${String(entry.fiber._error)}`)
    entry.fiber.config.alwaysVisible[VOLATILE_WRITE]([])
    assert.deepEqual(entry.fiber.config.alwaysVisible.get(), [], '正控制：配置确实已经改成 []')
    assert.deepEqual([...parentRuntime.alwaysNames], [HIDDEN],
      '同 epoch 内配置变更不得改写在跑的父 runtime')

    // --- 阶段 4：真实 fork。子没有 own 出站历史 → 必须用**当前**配置建自己的记录 ----
    queueResponse({ toolCalls: [{ id: 'tf1-child-guess', name: HIDDEN, arguments: { text: 'guessed' } }] })
    queueResponse({ toolCalls: [{ id: 'tf1-child-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
    queueResponse({ toolCalls: [{ id: 'tf1-child-legit', name: HIDDEN, arguments: { text: 'child own' } }] })
    queueResponse({ text: 'child done' })
    const forked = await forkChild(boot.ctx, parentHandle.agent, 'Child task.')
    openRuns.push(forked.run)

    const childRecord = assertOwnRecordOf(boot.ctx, forked.childId, forked.child.inheritedEventCount)
    assert.deepEqual(childRecord.names, [],
      `own-only fork 必须以当前配置（[]）建自己的记录，绝不继承父的 ${HIDDEN}；实际 ${JSON.stringify(childRecord.names)}`)
    assert.notEqual(childRecord.key, parentRecordBefore.key,
      '父子必须是两条**不同**的记录（键不同），而不是同一条被覆盖')

    // 运行时观测：子的可信基线确实 trusted 且为 []
    const childBaseline = serviceOf(boot.ctx).lifecycle.baselineOf(forked.childId)
    assert.equal(childBaseline.state, 'trusted', `子基线必须已落定：${JSON.stringify(childBaseline)}`)
    assert.deepEqual(childBaseline.names, [],
      `子运行时基线必须与它自己的记录一致（[]），实际 ${JSON.stringify(childBaseline.names)}`)

    // --- 阶段 5：执行面。子**先猜名**（被拒，body=0），**再自己 load**（body=1） ----
    const childEvents = forked.child.events
    const guess = toolPairOf(childEvents, 'tf1-child-guess')
    assert.equal(guess.call.data.name, HIDDEN, '前置：脚本确实让模型发出了那次猜名调用（排除"没调用"的空过）')
    assert.equal(guess.result.data.message.isError, true,
      `子猜父的常驻名必须被拒：${resultTextOf(guess.result).slice(0, 300)}`)
    assert.match(resultTextOf(guess.result), /not admitted|TOOL_NOT_LOADED|STATE_NOT_READY|INCOMPATIBLE_/,
      `拒绝必须带明确理由：${resultTextOf(guess.result).slice(0, 300)}`)
    assert.equal(store.bodyCount('tf1-child-guess'), 0,
      '子不得凭继承来的父基线执行父的常驻工具：body 必须为 0')

    const load = toolPairOf(childEvents, 'tf1-child-load')
    const loadShell = JSON.parse(resultTextOf(load.result))
    assert.equal(loadShell.ok, true, '子自己的 load 必须 canonical 成功')
    assert.deepEqual(loadShell.data.receipt.selected.map((s) => s.name), [HIDDEN])
    const legit = toolPairOf(childEvents, 'tf1-child-legit')
    assert.equal(legit.result.data.message.isError, false,
      `子自己 load 之后必须能正常调用：${resultTextOf(legit.result).slice(0, 300)}`)
    assert.equal(store.bodyCount('tf1-child-legit'), 1,
      '正控制（同一子会话、同一工具、唯一差别是它自己的 load）：body 必须执行 1 次')

    // body 证据必须记在**子**会话上，不是父
    const legitBody = store.bodyCalls.find((call) => call.callId === 'tf1-child-legit')
    assert.equal(legitBody.sessionId, forked.childId, 'body 证据必须归属子会话')

    // --- 阶段 6：与既有 domain fork「selected 不继承」正控共存 -----------------
    const childRuntime = runtimeOf(boot.ctx, forked.childId)
    const outcome = await childRuntime.journal.whenRestored()
    assert.equal(outcome.mode, 'ready', `子恢复必须落定：${JSON.stringify(outcome)}`)
    assert.equal(outcome.applied, 0, '继承前缀里的对不得进入子的折叠管线')
    assert.equal(outcome.rejected, 0, '继承前缀不是"被拒"，而是根本不参与（own-only）')
    const childState = childRuntime.engine.getState(childRuntime.scope)
    const childSelected = [...childState.selected.values()]
    assert.deepEqual(childSelected.map((s) => s.name), [HIDDEN],
      `子的 selected 只能来自它自己的 load，实际 ${JSON.stringify(childSelected.map((s) => s.name))}`)
    assert.equal(childSelected[0].operationId, 'op_tf1-child-load',
      `selection 必须绑定子自己的 canonical op，实际 ${childSelected[0].operationId}`)
    assert.equal(childSelected.some((s) => s.name === SIBLING), false,
      '父自己 load 出来的 SIBLING 不得进入子的 selected')

    // --- 阶段 7：父的 runtime / 记录都不被子覆盖 --------------------------------
    assert.deepEqual([...runtimeOf(boot.ctx, PARENT).alwaysNames], [HIDDEN],
      '父 runtime 的基线不得被子改写')
    const parentRecordAfter = recordOf(boot.ctx, PARENT)
    assert.equal(JSON.stringify(parentRecordAfter), parentSnapshotBefore,
      '父的持久记录必须逐字未变（names/writtenAt/epochId 全部保持）')
    assert.deepEqual(parentRecordAfter.names, [HIDDEN], '父记录仍按旧配置保留 HIDDEN')
    const parentExecAfter = await directExec(boot.ctx, parentHandle.agent, HIDDEN, { text: 'parent-still-ok' }, 'tf1-parent-exec-after')
    assert.equal(parentExecAfter.isError, false,
      `父在同 epoch 内仍按自己的旧记录放行：${parentExecAfter.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('tf1-parent-exec-after'), 1,
      '父的执行面不得被子污染：body 仍执行 1 次')
  } finally {
    for (const run of openRuns.splice(0).reverse()) {
      try { await run.dispose() } catch { /* 已释放 */ }
    }
    try { await parentHandle.dispose() } catch { /* 已释放 */ }
  }
})

// ---------------------------------------------------------------------------
// TF2：直连执行判据 + 同 root 重启后 own-only 记录仍是权威
//
// 配置在这里被**改回** [HIDDEN] 再重启：如果子错误地落回"当前配置"，
// 它就会被放行 —— 所以本例同时钉住"记录优先于配置"与"own-only 身份跨重启稳定"。
// ---------------------------------------------------------------------------
test('TF2: 直连 ctx.tools.execute 猜父常驻名 → body=0；同 root 重启后子仍只认自己的 [] 记录', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  const PARENT = 'tf2-parent'
  const boot1 = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapter: { requireTrustedEpoch: true, requireTrustedEpochForSubagents: true, alwaysVisible: [HIDDEN] },
    adapterSchema: true,
    extraServices: FORK_SERVICES,
  })
  cleanup.push(() => boot1.dispose())
  assert.deepEqual(boot1.activationErrors(), [], 'composition 必须收敛')

  const parentHandle = await drive(boot1.ctx, boot1.tmpRoot, PARENT)
  const openRuns = []
  let boot2 = null
  let resumedParent = null
  let resumedChild = null
  let childId = null
  let childBoundary = null
  try {
    queueResponse({ text: 'parent done' })
    await userTurn(parentHandle, 'Say something.')
    assert.deepEqual(recordOf(boot1.ctx, PARENT).names, [HIDDEN], '前置：父记录含 HIDDEN')

    // 同 epoch 改配置为 []（与 TF1 同一协议），子必须拿到 [] 而不是父的 [HIDDEN]
    const entry1 = boot1.loader.entries().find((item) => item.id === 'progressive-discovery')
    entry1.fiber.config.alwaysVisible[VOLATILE_WRITE]([])
    assert.deepEqual(entry1.fiber.config.alwaysVisible.get(), [], '正控制：配置确为 []')

    // 子不发出任何工具调用（因此它没有 own 的 canonical 操作，只有继承前缀）
    queueResponse({ text: 'child quiet done' })
    const forked = await forkChild(boot1.ctx, parentHandle.agent, 'Child task.')
    openRuns.push(forked.run)
    childId = forked.childId
    childBoundary = forked.child.inheritedEventCount
    assertOwnRecordOf(boot1.ctx, childId, childBoundary)
    assert.deepEqual(recordOf(boot1.ctx, childId).names, [], '前置：子记录为 []')

    // 判据：子**直连执行**父的常驻名 → 被拒且 body=0（这里调用确实发出去了，不是"没调用"）
    const childGuess = await directExec(boot1.ctx, forked.childAgent, HIDDEN, { text: 'guessed' }, 'tf2-child-direct')
    assert.equal(childGuess.isError, true,
      `子直连猜父常驻名必须被拒，实际文本：${childGuess.text.slice(0, 300)}`)
    assert.match(childGuess.text, /not admitted|TOOL_NOT_LOADED|STATE_NOT_READY|INCOMPATIBLE_/,
      `拒绝必须带明确理由：${childGuess.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('tf2-child-direct'), 0, 'body 必须为 0')

    const parentBefore = recordOf(boot1.ctx, PARENT)
    const childBefore = recordOf(boot1.ctx, childId)

    // --- 真关闭 boot1 的全部服务（保留 tmpRoot），再在同一 root 上重启 ----------
    for (const run of openRuns.splice(0).reverse()) {
      try { await run.dispose() } catch { /* 已释放 */ }
    }
    try { await parentHandle.dispose() } catch { /* 已释放 */ }
    await boot1.closeServices()
    const probe = boot1.ctx.get('storageDomain')
    if (probe !== undefined) {
      assert.equal(probe.get(TRUSTED_EPOCH_DOMAIN), undefined, '真关闭后可信域必须已释放')
    }

    boot2 = await bootAdapterComposition({
      fixtures: FIXTURES,
      // 故意改回 [HIDDEN]：子若落回"当前配置"就会被放行，本例因此才有分辨力。
      adapter: { requireTrustedEpoch: true, requireTrustedEpochForSubagents: true, alwaysVisible: [HIDDEN] },
      adapterSchema: true,
      tmpRoot: boot1.tmpRoot,
    })
    cleanup.push(() => boot2.dispose())
    assert.deepEqual(boot2.activationErrors(), [], '重启后的 composition 必须收敛')
    store.reset()

    // --- 父：仍按自己的旧记录放行 ------------------------------------------------
    resumedParent = await resumeDrive(boot2.ctx, PARENT)
    const parentReady = await settleBaseline(boot2.ctx, PARENT, resumedParent.agent)
    assert.equal(parentReady.mode, 'ready', `父必须 ready：${JSON.stringify(parentReady)}`)
    const parentExec = await directExec(boot2.ctx, resumedParent.agent, HIDDEN, { text: 'parent-after-restart' }, 'tf2-parent-exec')
    assert.equal(parentExec.isError, false,
      `父按自己的记录放行：${parentExec.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('tf2-parent-exec'), 1, '父 body 必须执行 1 次')

    // --- 子：只认自己那份 [] 记录（当前配置是 [HIDDEN]，不得被它替换）------------
    resumedChild = await resumeDrive(boot2.ctx, childId)
    const childReady = await settleBaseline(boot2.ctx, childId, resumedChild.agent)
    assert.equal(childReady.mode, 'ready', `子必须 ready（读到自己的记录），实际 ${JSON.stringify(childReady)}`)
    const childBaseline = serviceOf(boot2.ctx).lifecycle.baselineOf(childId)
    assert.equal(childBaseline.state, 'trusted', `子基线必须 trusted：${JSON.stringify(childBaseline)}`)
    assert.deepEqual(childBaseline.names, [],
      `子必须只读自己那份 [] 记录，不得被重启后的当前配置 [${HIDDEN}] 替换`)

    const childAfter = readRecords(boot2.ctx).bySession.get(childId)
    assert.equal(childAfter.ownSeqStart, childBoundary,
      '子记录的 own 边界必须跨重启稳定（会话身份的一部分）')
    assert.deepEqual(childAfter.names, [], '子记录名单跨重启仍是 []')
    assert.equal(JSON.stringify(recordOf(boot2.ctx, PARENT)), JSON.stringify(parentBefore), '父记录跨重启逐字未变')
    assert.equal(JSON.stringify(childAfter), JSON.stringify(childBefore), '子记录跨重启逐字未变（没有用新配置重写）')

    const childGuessAfter = await directExec(boot2.ctx, resumedChild.agent, HIDDEN, { text: 'guessed again' }, 'tf2-child-exec-after')
    assert.equal(childGuessAfter.isError, true,
      `重启后子仍不得执行父的常驻名：${childGuessAfter.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('tf2-child-exec-after'), 0, '重启后 body 仍必须为 0')

    // 正控制（反空过）：子自己 load 之后，同一个子会话、同一个工具必须 body=1
    queueResponse({ toolCalls: [{ id: 'tf2-child-load', name: 'tool_load', arguments: { names: [HIDDEN] } }] })
    queueResponse({ toolCalls: [{ id: 'tf2-child-legit', name: HIDDEN, arguments: { text: 'child own' } }] })
    queueResponse({ text: 'child after restart done' })
    await userTurn(resumedChild, 'Load and call the hidden tool.')
    const events2 = (await boot2.ctx.sessionQuery.readSession(childId)).events
    const loadShell2 = JSON.parse(resultTextOf(toolPairOf(events2, 'tf2-child-load').result))
    assert.equal(loadShell2.ok, true, '子自己 load 必须 canonical 成功')
    assert.equal(store.bodyCount('tf2-child-legit'), 1,
      '正控制：子自己 load 之后 body 必须执行 1 次（证明前面的 0 不是"一切都停了"）')
  } finally {
    for (const run of openRuns.splice(0).reverse()) {
      try { await run.dispose() } catch { /* 已释放 */ }
    }
    for (const handle of [resumedChild, resumedParent].filter((h) => h !== null && h !== undefined)) {
      try { await handle.dispose() } catch { /* 已释放 */ }
    }
  }
})
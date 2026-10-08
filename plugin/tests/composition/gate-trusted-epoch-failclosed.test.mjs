// 会话终态 `failed-closed` 门禁 —— 契约 **08 §2.4b** 的第二行（`SESSION_FAILED_CLOSED`）
// 与 08 §4 的 **TE-FC**。
//
// 它钉的是什么（逐条对应 08 §2.4b / TE-FC，不多钉一条）：
//   §2.4b 行 2  会话因**与可信周期无关**的既有原因 fail closed（journal 自身封死 /
//                `readSession` 失败 / 严重 seq 不连续）时：**请求照发，只带基线**，
//                引擎仍 incompatible，既有 fail-closed 语义原样保留。
//   §2.4b 末段  落到这一态时它在账本里是**独立的第四态 `failed-closed`**：既不是三种
//                可信基线终态（`STORAGE_UNAVAILABLE` / `MISSING` / `INVALID`，那三条是
//                0 request），也**不是** `TRUSTED`（那是谎称名单已可信）。
//   §2.4b 末段  投影侧照常放行这一次请求，guard 侧仍按 `baseline !== TRUSTED` 拒绝每一次
//                非入口调用——**出站与执行两侧的既有判据都原样保留**。
//   TE-FC       同 composition 里一个**健康**会话仍必须正常 ready 且工具可执行（证明这份门禁
//                不是靠「一律 block」作弊）。
//
// 故障注入纪律（08 §4「受污染材料必须是声明式注入，不得表述为宿主自然产生」）：
//   本文件**不**改产品源码、不加产品 fault hook。它只在**公开面**
//   `ctx.sessionQuery.readSession` 上包一层，材料是**声明**出来的：
//     FC1  只对**目标会话**抛错（其余会话逐字委托真实实现）——真实宿主不会自己读盘失败。
//     FC2  只对**目标会话**把真实事件的 `seq` 整体平移，制造一条**声明的** seq 断流——
//           真实宿主写出的 durable 流按契约必然自 0 连续（journal.mjs:150-159），所以
//           这条断流是**注入**，不是对宿主行为的断言。
//   两处都在 finally 里把**原始 own property 逐字装回**（不是 `bind` 出来的新函数，
//   那会留下 `bound readSession` 产物），并当场自证装回是真的：①装回后仍名为
//   `readSession` 的函数（`bind` 产物名字会变，任何残留包装也会露馅——宿主把
//   `readSession` 暴露为访问器，每次读取都重新包装，所以**对象恒等**不成立，与既有
//   门禁 gate-trusted-epoch 的同一判据一致）；②目标会话的读盘**真的恢复**为非空的
//   真实连续事件流（这才是「包装没有跨用例泄漏」的硬证据）。
//
// 断言纪律：
//   * 每条前置都有**独立**断言；禁止「取到 undefined 就跳过」式空转。`baselineOf` /
//     `whenReady` 的取值都被断言为非 null 且带合法字段。
//   * 每条安全断言都配**正控制**：FC1 / FC2 各自在**同一 composition** 内再跑一个健康会话
//     （baseline `trusted` + 引擎 `ready` + 直连执行 body=1）；FC0 额外独立证明
//     `ctx.tools.execute` 直连确实能到达 body。
//   * 执行面一律用 **`ctx.tools.execute` 直连**断言，而不是「模型这一轮有没有真的发出
//     那次猜名调用」——否则 body=0 可能只是请求根本没发出去造成的空过。
//   * 证据边界：`store.requests` 录的是 mock provider 看到的**最终 GenerateOptions**，
//     **不是**真实 provider wire；`store.bodyCount` 录的是 fixture 工具 body 的真实执行次数。
//
// 运行：node --test plugin/tests/composition/gate-trusted-epoch-failclosed.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { makeTmpRoot, removeTmpRoot } from '../../contracts/harness.mjs'
import { bootAdapterComposition } from './harness.mjs'
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs'
import {
  BASELINE_STATE, SESSION_FAILED_CLOSED, TRUSTED_EPOCH_REASONS,
} from '../../adapters/dsh/trusted-epoch.mjs'

const HIDDEN = 'fixture_hidden_inherited'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']
/**
 * alwaysVisible 显式置空：真实常驻基线只剩三个发现入口（ENTRY_TOOL_NAMES）。
 * 这样「只带基线」在出站面是一个**逐字可断言的精确集合**（`tool_list` / `tool_load` /
 * `tool_search`），而不会被 Core 默认常驻名单（config.mjs:33 DEFAULT_ALWAYS_VISIBLE）稀释。
 * 同时它也保证「基线里没有 HIDDEN」：目标会话此前加载过的工具**只**可能来自 canonical
 * `tool_load` 折叠，所以「不携带此前加载的任何工具」是本例唯一、且真的被检验的排他项。
 */
const ADAPTER_CONFIG = { requireTrustedEpoch: true, alwaysVisible: [] }
const BASELINE_NAMES = [...ENTRY_TOOL_NAMES].sort()

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

// ---------------------------------------------------------------------------
// 通用工具（结构照抄既有门禁，行为未改）
// ---------------------------------------------------------------------------
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

function svcOf (ctx) {
  const svc = ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, 'progressiveDiscovery 服务必须可达')
  return svc
}

function runtimeOf (ctx, sessionId) {
  const runtime = svcOf(ctx).sessions.get(sessionId)
  assert.ok(runtime !== undefined, `真实 runtime 必须存在：${sessionId}`)
  return runtime
}

/** 产品的只读观测面；返回 null 一律当场报错，绝不"取不到就跳过"。 */
function baselineOf (ctx, sessionId, label) {
  const baseline = svcOf(ctx).trustedBaseline(sessionId)
  assert.ok(baseline !== null && baseline !== undefined,
    `${label}: 可信基线观测面必须给出本会话的账本，不得为 null/undefined`)
  assert.equal(typeof baseline.state, 'string', `${label}: 账本必须带 state 字段`)
  return baseline
}

function namesOf (request) {
  return (request?.tools ?? []).map((tool) => tool.name)
}

function lastNames (store) {
  return namesOf(store.requests[store.requests.length - 1])
}

function resultTextOf (event) {
  return (event?.data?.message?.content ?? []).map((block) => block?.text ?? '').join('')
}

/**
 * durable 流里与 callId 配对的 `tool/result`。
 * 配对走 `sourceEventSeqs`（真实实现的绑定关系），**不**按数组顺序猜。
 */
function toolResultFor (events, callId) {
  const call = events.find((event) => event.type === 'tool/call' && event.data?.callId === callId)
  assert.ok(call !== undefined, `前置：durable 流里必须有 ${callId} 的 tool/call`)
  const result = events.find((event) => event.type === 'tool/result'
    && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(call.seq))
  assert.ok(result !== undefined, `前置：durable 流里必须有 ${callId} 的 tool/result`)
  return result
}

/**
 * 真实 `tool_load` 回执里 canonical 选中的工具名。
 * `tool_load` 是本插件自己的控制工具，**不经过 fixture body**，所以
 * `store.bodyCount(tool_load 的 callId)` 恒为 0 —— 判它"有没有真的加载成功"必须读
 * canonical `call → result` 回执链（也就是 §2.4b 认定的唯一按需授权事实）。
 */
function loadReceiptNames (events, callId) {
  const result = toolResultFor(events, callId)
  assert.notEqual(result.data?.message?.isError, true,
    `前置：${callId} 的 tool/result 不得是错误：${resultTextOf(result).slice(0, 200)}`)
  const shell = JSON.parse(resultTextOf(result))
  assert.equal(shell.ok, true, `前置：tool_load 回执必须 ok：${resultTextOf(result).slice(0, 200)}`)
  return (shell.data?.receipt?.selected ?? []).map((item) => item.name)
}

/**
 * 直连真实工具执行管线（`ctx.tools.execute`），与模型调用**同一条**完整管线：
 * pre-policy → guards → dispatch → post-policy。本插件的 guard 就在其中。
 * 因此这条路径能独立证明「执行面是否放行」，不受「模型这一轮到底有没有发出调用」影响。
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

/** 真实介质证据：逐字读出存储根下的文件（不是「SDK 说它落了」）。 */
function durableFilesUnder (root) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push({ file: full, text: fs.readFileSync(full, 'utf8') })
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

/**
 * 复制一份已持久化的会话根，让冷恢复读**同一份历史**但持有独立的写租约。
 * 宿主会话写入租约是内核文件锁，同一目录被两个活跃 composition 打开会直接
 * SessionAlreadyOwnedError（见 gate-review-boundaries 的同款说明）。
 */
function cloneTmpRoot (source, label) {
  const target = makeTmpRoot(label)
  fs.cpSync(source, target, { recursive: true })
  cleanup.push(() => removeTmpRoot(target))
  return target
}

// ---------------------------------------------------------------------------
// 故障注入：只包一层公开 `readSession`，finally 里逐字装回原始 own property
// ---------------------------------------------------------------------------

/** 声明的 seq 断流平移量：够大到不与任何真实 seq / 缓冲区 seq 相邻。 */
const SEQ_OFFSET = 1000

/**
 * 声明式注入①：只让**目标会话**的读盘失败，其余会话逐字委托真实实现。
 * 这是**注入**，不是宿主自然行为（文件头已声明）。保留原始 own property 而不是
 * `bind` 出来的新函数，finally 里逐字装回，保证不跨用例泄漏。
 */
function failReadSession (query, sessionId, reason) {
  const realReadSession = query.readSession
  const state = { calls: 0, targetCalls: 0 }
  query.readSession = async function (requested, ...rest) {
    state.calls += 1
    if (requested === sessionId) {
      state.targetCalls += 1
      throw new Error(reason)
    }
    return realReadSession.call(query, requested, ...rest)
  }
  return {
    state,
    /**
     * 逐字装回原始 own property，并**当场自证**故障已完全撤除。
     *
     * 断言分两层（都比「认一个函数对象」更有意义）：
     *   1. 形状：装回后仍是名为 `readSession` 的函数 —— `bind` 产物会叫
     *      `bound readSession`，任何残留包装也不会叫这个名字（宿主把 `readSession`
     *      暴露为访问器，每次读取都会重新包装，所以**对象恒等**在这里不成立，
     *      与既有门禁 `gate-trusted-epoch` 的同一判据一致）。
     *   2. 行为：装回后目标会话的读盘**真的恢复**（非空真实事件流）。
     *      这一条才是「包装没有跨用例泄漏」的硬证据。
     */
    async restoreAndVerify () {
      query.readSession = realReadSession
      const restored = query.readSession
      assert.equal(typeof restored, 'function', '装回后 readSession 必须仍是函数')
      assert.equal(restored.name, 'readSession',
        '必须逐字装回真实实现（不得留下 bind 产物或残留包装）')
      const loaded = await restored.call(query, sessionId)
      assert.ok(Array.isArray(loaded?.events) && loaded.events.length > 0,
        '装回真实实现后目标会话必须能读到非空真实历史（故障包装已完全撤除）')
    },
  }
}

/**
 * 声明式注入②：只对**目标会话**把真实事件的 `seq` 整体平移 `SEQ_OFFSET`，制造一条
 * **声明的** seq 断流（真实 durable 流按契约必然自 0 连续，所以断流只能是注入）。
 * `inheritedEventCount` 与其余字段逐字沿用真实读盘结果——不动它是为了让实验仍然停在
 * 「seq 断流」这一条路径上，而不是滑到「own 边界不可信」那条（journal.mjs:565-572）。
 */
function serveBrokenSeqStream (query, sessionId) {
  const realReadSession = query.readSession
  const state = { calls: 0, targetCalls: 0, delivered: null }
  query.readSession = async function (requested, ...rest) {
    state.calls += 1
    const loaded = await realReadSession.call(query, requested, ...rest)
    if (requested !== sessionId) return loaded
    state.targetCalls += 1
    assert.ok(Array.isArray(loaded?.events) && loaded.events.length > 0,
      '前置：真实读盘必须给出非空事件流（本注入只在真实材料上改 seq）')
    assert.deepEqual(loaded.events.map((event) => event.seq), loaded.events.map((_e, i) => i),
      '前置：真实 durable 流的 seq 自 0 连续（因此断流只能是注入，不是宿主行为）')
    const events = loaded.events.map((event, i) => ({ ...event, seq: i + SEQ_OFFSET }))
    state.delivered = events
    return { ...loaded, events }
  }
  return {
    state,
    /** 装回与自证的口径同注入①（见 failReadSession.restoreAndVerify 的注释）。 */
    async restoreAndVerify () {
      query.readSession = realReadSession
      const restored = query.readSession
      assert.equal(typeof restored, 'function', '装回后 readSession 必须仍是函数')
      assert.equal(restored.name, 'readSession',
        '必须逐字装回真实实现（不得留下 bind 产物或残留包装）')
      const loaded = await restored.call(query, sessionId)
      assert.ok(Array.isArray(loaded?.events) && loaded.events.length > 0,
        '装回真实实现后目标会话必须能读到非空真实历史（断流注入已完全撤除）')
      assert.deepEqual(loaded.events.map((event) => event.seq), loaded.events.map((_e, i) => i),
        '装回后必须拿到真实连续的 durable 流（断流确实只存在于注入里）')
    },
  }
}

// ---------------------------------------------------------------------------
// 共享流程：真实种一段「已经 canonical 加载过 HIDDEN」的历史
// ---------------------------------------------------------------------------
/**
 * 阶段 1：在真实 composition 里跑一轮真实 `tool_load`，让该会话**真的**拥有
 * ①own 出站历史、②canonical tool_load 对、③一条落在真实介质上的可信周期记录。
 * 全部由真实宿主产出，不注入任何东西。
 */
async function seedLoadedHistory (sessionId) {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')

  const loadId = `${sessionId}-load`
  queueResponse({ toolCalls: [{ id: loadId, name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ text: 'phase one done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, sessionId)
  await userTurn(handle, 'Load the hidden fixture tool.')

  // --- 阶段 1 的独立前置断言（每条都是「没有它后面全是空转」） -----------------
  assert.equal(handle.agent.session.seq > 0, true,
    '前置：阶段 1 必须留下非空 own 历史（否则没有冷恢复可言）')
  const durable = (await boot.ctx.sessionQuery.readSession(sessionId)).events
  assert.ok(Array.isArray(durable) && durable.length > 0, '前置：必须读到真实 durable 事件流')
  assert.deepEqual(loadReceiptNames(durable, loadId), [HIDDEN],
    `前置：canonical tool_load 回执必须选中 ${HIDDEN}（否则「此前加载过」是空转）`)
  assert.ok(lastNames(store).includes(HIDDEN),
    `前置：阶段 1 的出站必须已披露 ${HIDDEN}，否则「不携带此前加载的工具」是空转：${lastNames(store).join(', ')}`)
  assert.equal(baselineOf(boot.ctx, sessionId, '阶段 1').state, BASELINE_STATE.TRUSTED,
    '前置：阶段 1 的初始记录必须已落定为 trusted（它就是本会话持久的授权事实）')
  assert.equal(runtimeOf(boot.ctx, sessionId).engine.getState(
    runtimeOf(boot.ctx, sessionId).scope).mode, 'ready', '前置：阶段 1 的引擎必须 ready')
  assert.ok(durableFilesUnder(boot.storageRoot).some((entry) => entry.text.includes(sessionId)),
    `前置：真实存储根 ${boot.storageRoot} 下必须有本会话的介质记录`)

  await handle.dispose()
  return { tmpRoot: boot.tmpRoot, storageRoot: boot.storageRoot }
}

/**
 * 目标判据（FC1 / FC2 共用）：`failed-closed` 第四态的**全部**语义，逐条独立断言。
 * @param {{ctx:any, sessionId:string, agent:any, store:any, expectedReason:string,
 *          expectedRestoreReason:string, sealed:boolean, label:string}} spec
 */
async function assertFailedClosedTerminal (spec) {
  const { ctx, sessionId, agent, store, expectedReason, expectedRestoreReason, sealed, label } = spec

  // --- 判据 1：引擎停在 incompatible（§2.4b「引擎仍 incompatible」）--------------
  const runtime = runtimeOf(ctx, sessionId)
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'incompatible',
    `${label}: 引擎必须停在 incompatible`)
  if (sealed) {
    // 分支 B 的独立前置：journal **自身**封死了（不是可信基线把它挡下的）。
    assert.equal(runtime.journal.isSealed(), true,
      `${label}: 注入的是 journal 自身封死（严重 seq 断流），journal 必须报 sealed`)
    assert.equal(runtime.journal.sealedReason(), 'event-seq-not-contiguous',
      `${label}: 归因必须是声明的那条注入路径：${runtime.journal.sealedReason()}`)
  } else {
    // 分支 A 的独立前置：readSession 失败**不**封死 journal（live /compact 仍要能迁移）。
    assert.equal(runtime.journal.isSealed(), false,
      `${label}: readSession 失败不得封死 journal（否则本次 live 的用户 /compact 永远无法迁移）`)
  }

  // --- 判据 2：账本是独立的第四态 `failed-closed`（§2.4b 末段）-----------------
  const baseline = baselineOf(ctx, sessionId, label)
  assert.equal(baseline.state, BASELINE_STATE.FAILED_CLOSED,
    `${label}: 账本必须是第四态 failed-closed，实际：${JSON.stringify(baseline)}`)
  assert.equal(baseline.state, 'failed-closed', `${label}: 第四态的字面值必须钉住`)
  // 逐一排除另外三态：不是「尚未落定」、不是可信基线终态、更不是 trusted。
  assert.notEqual(baseline.state, BASELINE_STATE.PENDING,
    `${label}: 不得留在 pending（那会被投影当成「尚未落定」而整轮不发请求 → 会话挂死）`)
  assert.notEqual(baseline.state, BASELINE_STATE.BLOCKED,
    `${label}: 不得并进 blocked（那会凭空多出一条「请求不得发出」的新规则）`)
  assert.notEqual(baseline.state, BASELINE_STATE.TRUSTED,
    `${label}: 不得谎称 trusted（此刻没有任何名单为它背书）`)
  assert.deepEqual(baseline.names, null, `${label}: failed-closed 从不授予任何名单`)
  assert.equal(String(baseline.reason).startsWith(`${SESSION_FAILED_CLOSED}:`), true,
    `${label}: reason 必须带独立前缀，实际：${JSON.stringify(baseline.reason)}`)
  assert.equal(baseline.reason, expectedReason, `${label}: reason 必须带明确归因`)
  for (const reason of Object.values(TRUSTED_EPOCH_REASONS)) {
    assert.notEqual(baseline.reason, reason,
      `${label}: reason 不得冒充可信基线终态 ${reason}`)
  }

  // --- 判据 3：请求**照发**、只带基线（§2.4b「请求照发，只带基线」）------------
  // 这里必须先证明恢复已经落定（restoring 归 false），否则「0 请求」会被读成「还在等」。
  assert.equal(runtime.restoring, false,
    `${label}: 已决失败后 runtime 必须落定，不得继续被当作 pending`)
  const settled = await svcOf(ctx).lifecycle.whenReady(sessionId)
  assert.ok(settled !== undefined && settled !== null && typeof settled.mode === 'string',
    `${label}: whenReady 必须给出带 mode 的终态，不得为 null/undefined`)
  assert.equal(settled.mode, 'incompatible', `${label}: 终态必须是 incompatible`)
  // 归因取自 journal 的恢复终态（whenReady 在 runtime 落定后只回 mode、不回 reason）。
  const restored = await runtime.journal.whenRestored()
  assert.equal(restored?.mode, 'incompatible', `${label}: journal 恢复终态必须是 incompatible`)
  assert.equal(restored.reason, expectedRestoreReason,
    `${label}: 恢复终态必须带 journal 自己的归因，实际：${JSON.stringify(restored.reason)}`)
  assert.ok(store.requests.length > 0,
    `${label}: 请求**照发**（0 request 只属于 MISSING/INVALID/UNAVAILABLE，不是这一态）`)
  const sent = lastNames(store)
  assert.deepEqual([...new Set(sent)].sort(), BASELINE_NAMES,
    `${label}: 出站必须只带基线（三个发现入口），实际：${sent.join(', ')}`)
  assert.equal(sent.includes(HIDDEN), false,
    `${label}: 不得携带此前加载的任何工具：${sent.join(', ')}`)

  // --- 判据 4：执行面照拒，且是**直连**断言（不是「模型没发出去」）-------------
  const guessId = `${label}-direct-guess`
  const exec = await directExec(ctx, agent, HIDDEN, { text: 'guessed' }, guessId)
  assert.equal(exec.isError, true,
    `${label}: 直连执行必须被拒（isError），实际结果：${JSON.stringify(exec.result)?.slice(0, 400)}`)
  assert.equal(store.bodyCount(guessId), 0,
    `${label}: 直连执行的 body 执行次数必须为 0（正控制见下方，证明这不是空过）`)
  assert.match(exec.text, new RegExp(SESSION_FAILED_CLOSED),
    `${label}: 拒绝理由必须暴露这是第四态而不是 pending，实际文本：${exec.text.slice(0, 300)}`)
}

/**
 * 同 composition 正控制（TE-FC 的「不能靠一律 block 作弊」那一半）：
 * 一个**没有**被注入的健康会话必须照常落 trusted、引擎 ready，并能把 HIDDEN load 后直连执行。
 */
async function assertHealthyControl (spec) {
  const { ctx, tmpRoot, store, queueResponse, label } = spec
  const sessionId = `${label}-control-1`

  const loadId = `${sessionId}-load`
  queueResponse({ toolCalls: [{ id: loadId, name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ text: 'control loaded' })
  const handle = await drive(ctx, tmpRoot, sessionId)
  await userTurn(handle, 'Load the hidden fixture tool.')

  const runtime = runtimeOf(ctx, sessionId)
  assert.equal((await runtime.journal.whenRestored()).mode, 'ready',
    `${label} 正控制：健康会话必须 ready`)
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'ready',
    `${label} 正控制：健康会话的引擎必须 ready`)
  assert.equal(baselineOf(ctx, sessionId, `${label} 正控制`).state, BASELINE_STATE.TRUSTED,
    `${label} 正控制：健康会话的基线必须落 trusted`)
  assert.ok(lastNames(store).includes(HIDDEN),
    `${label} 正控制：canonical load 之后该工具必须已披露：${lastNames(store).join(', ')}`)

  // 同一会话、同一工具、同一执行方法：必须真的到达 body。
  const execId = `${sessionId}-exec`
  const exec = await directExec(ctx, handle.agent, HIDDEN, { text: 'control' }, execId)
  assert.equal(exec.isError, false,
    `${label} 正控制：直连执行不得被拒，实际文本：${exec.text.slice(0, 300)}`)
  assert.equal(store.bodyCount(execId), 1,
    `${label} 正控制：直连执行必须真的到达 body（这证明目标判据的 body=0 有分辨力）`)

  await handle.dispose()
}

// ---------------------------------------------------------------------------
// FC0：正控制 —— 直连执行在健康会话上确实能到达 body
// ---------------------------------------------------------------------------
test('FC0: 正控制 —— 健康会话直连 ctx.tools.execute body 执行 1 次', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')

  const loadId = 'fc0-load'
  queueResponse({ toolCalls: [{ id: loadId, name: 'tool_load', arguments: { names: [HIDDEN] } }] })
  queueResponse({ text: 'FC0 loaded' })
  const handle = await drive(boot.ctx, boot.tmpRoot, 'fc0-control-1')
  await userTurn(handle, 'Load the hidden fixture tool.')

  const runtime = runtimeOf(boot.ctx, 'fc0-control-1')
  assert.equal((await runtime.journal.whenRestored()).mode, 'ready', 'FC0: 会话必须 ready')
  assert.ok(lastNames(store).includes(HIDDEN),
    `FC0: canonical load 之后该工具必须已披露：${lastNames(store).join(', ')}`)

  const execId = 'fc0-exec'
  const exec = await directExec(boot.ctx, handle.agent, HIDDEN, { text: 'control' }, execId)
  assert.equal(exec.isError, false, `FC0: 正控制不得被拒，实际文本：${exec.text.slice(0, 300)}`)
  assert.equal(store.bodyCount(execId), 1,
    'FC0: 直连执行必须到达 body —— 否则 FC1/FC2 的 body=0 可能只是「exec 走不到 body」')
  await handle.dispose()
})

// ---------------------------------------------------------------------------
// FC1：`readSession` 失败 → 第四态 failed-closed（08 §2.4b 行 2 / TE-FC）
// ---------------------------------------------------------------------------
const FC1 = { sessionId: 'fcf-read-1' }

test('FC1: readSession 失败 → failed-closed 第四态：请求照发只带基线、执行照拒（正控制同 composition）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  // --- 阶段 1：真实历史 + 真实介质记录 -----------------------------------------
  const seed = await seedLoadedHistory(FC1.sessionId)

  // --- 阶段 2：同 root 的新 composition + 声明式注入① ------------------------
  const root = cloneTmpRoot(seed.tmpRoot, 'fcf-read-1')
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG, tmpRoot: root })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')

  // 独立前置：克隆根里确实带着阶段 1 落下的那份**可信记录**。
  // 这一条是「记录明明在却仍不 trusted」这句话的承载面；没有它，那句话就是空的。
  assert.ok(durableFilesUnder(boot.storageRoot).some((entry) => entry.text.includes(FC1.sessionId)),
    `FC1 前置：克隆根 ${boot.storageRoot} 下必须仍带着阶段 1 的可信记录`)

  const injected = failReadSession(boot.ctx.sessionQuery, FC1.sessionId, 'injected readSession failure')
  try {
    store.reset()
    const handle = await resumeDrive(boot.ctx, FC1.sessionId)
    queueResponse({ text: 'FC1 turn' })
    await userTurn(handle, 'Continue after the injected read failure.')

    // 独立前置：注入确实在目标会话上被调用过（否则下面全是对健康会话的空断言）。
    assert.ok(injected.state.targetCalls > 0,
      `FC1 前置：故障包装必须在目标会话上被调用过（calls=${injected.state.calls}）`)

    await assertFailedClosedTerminal({
      ctx: boot.ctx,
      sessionId: FC1.sessionId,
      agent: handle.agent,
      store,
      expectedReason: `${SESSION_FAILED_CLOSED}:readSession-failed`,
      expectedRestoreReason: 'readSession-failed',
      sealed: false,
      label: 'FC1',
    })

    await assertHealthyControl({
      ctx: boot.ctx, tmpRoot: boot.tmpRoot, store, queueResponse, label: 'FC1',
    })
    await handle.dispose()
  } finally {
    await injected.restoreAndVerify()
  }
})

// ---------------------------------------------------------------------------
// FC2：journal 自身封死（声明式 seq 断流）→ 第四态 failed-closed（08 §2.4b 行 2）
// ---------------------------------------------------------------------------
const FC2 = { sessionId: 'fcf-seal-1' }

test('FC2: journal 自身封死（严重 seq 断流）→ failed-closed 第四态：请求照发只带基线、执行照拒（正控制同 composition）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  const seed = await seedLoadedHistory(FC2.sessionId)

  const root = cloneTmpRoot(seed.tmpRoot, 'fcf-seal-1')
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG, tmpRoot: root })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'composition 必须收敛')

  const injected = serveBrokenSeqStream(boot.ctx.sessionQuery, FC2.sessionId)
  try {
    store.reset()
    const handle = await resumeDrive(boot.ctx, FC2.sessionId)
    queueResponse({ text: 'FC2 turn' })
    await userTurn(handle, 'Continue after the declared seq break.')

    // 独立前置：注入确实被调用，且交付的确实是那条**声明的**断流。
    assert.ok(injected.state.targetCalls > 0,
      `FC2 前置：故障包装必须在目标会话上被调用过（calls=${injected.state.calls}）`)
    assert.ok(Array.isArray(injected.state.delivered) && injected.state.delivered.length > 0,
      'FC2 前置：必须真的交付了一条非空的断流事件数组')
    assert.deepEqual(injected.state.delivered.map((event) => event.seq),
      injected.state.delivered.map((_e, i) => i + SEQ_OFFSET),
      'FC2 前置：交付的流必须逐条平移了 seq（断流是注入，不是宿主行为）')

    await assertFailedClosedTerminal({
      ctx: boot.ctx,
      sessionId: FC2.sessionId,
      agent: handle.agent,
      store,
      expectedReason: `${SESSION_FAILED_CLOSED}:journal-sealed:event-seq-not-contiguous`,
      expectedRestoreReason: 'event-seq-not-contiguous',
      sealed: true,
      label: 'FC2',
    })

    await assertHealthyControl({
      ctx: boot.ctx, tmpRoot: boot.tmpRoot, store, queueResponse, label: 'FC2',
    })
    await handle.dispose()
  } finally {
    await injected.restoreAndVerify()
  }
})

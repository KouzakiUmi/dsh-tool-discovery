// 可信周期名单的 **IO 门禁**（gate-trusted-epoch-io）—— 独立于 gate-trusted-epoch 的
// 一组"真实 Loader + 真实 DSH 0.2.1-alpha.1 + 真实 storageDomain"的 I/O 时序反例。
//
// 与 gate-trusted-epoch.test.mjs 的分工：那份文件钉的是**授权面**（污染头 / 缺记录 /
// 缺 provider / 手动 /compact 迁移 / 同 root 重启冻结）。本文件只钉一件事：
// **可信记录的那一次真实 `table.put` 在时间轴上的位置**，以及它 hung / 失败 / 被 dispose
// 时会话必须落成什么终态。四类：
//
//   IO1  新会话的**初始** put 被挂住
//        → provider 请求 0 条、guard 直连执行 body 0（不是"猜名没发"式的空过：
//          同一会话、同一工具、同一执行方法在放行后 body=1）；
//        → 放行后**首请求**就是完整基线，且真实记录落到了真实 storageDomain 与真实介质。
//   IO2  可信会话的**真实自动压缩**（assemble 之后、pre-step 之内）→ 新 epoch 的 put 被挂住
//        → 挂住期间最终 GenerateOptions **零增量**（压缩自己的摘要请求除外，且必须真的发生）；
//        → 释放后那一轮带的是**新名单**（采最新 config），旧 selected/frozen 按成功压缩重置；
//        → 覆盖 post-next 的 pre-step 屏障：压缩已经发生，put 还没 durable，请求就发不出去。
//   IO3  put 被拒（声明式注入）/ SDK 不可用（omitStorage 显式负向）
//        → 确定的 blocked 终态 + 0 请求 + **不沿用旧授权**；guard 的基线判据必须排在
//          alwaysNameSet 早退之前（否则一个 STORAGE_UNAVAILABLE 的会话能被猜名执行）。
//   IO4  pending put 期间 runtime / 插件 fiber 被释放 → 释放闸门后**不得复活授权**。
//   IO5  legacy（缺可信记录）会话上的**真实自动**压缩**不得**迁移（只认本次 live 的用户 /compact）。
//
// 注入纪律（全部是**公开面**上的最小包装，不改产品源码、不加产品 fault hook）：
//   * 只包装**真实** `storageDomain.open` 与**真实** domain 的 `table.put`（只认目标
//     domain/table，其余逐字转发）；闸门只是"在真实 put 之前 await 一下 / 或直接抛错"，
//     **从不伪造任何存储完成**：放行后调用的是 SDK 自己的 `KvTableImpl.put`。
//   * 目标判据按 record 内容（sessionId / epochId）选，不按调用顺序选。
//   * finally 里逐字还原真实方法（own property 原样装回 / 原本没有则 delete），
//     释放所有闸门，await 真实在途 turn，再走 `boot.closeServices()` 真关闭 → `boot.dispose()`。
//   * `mode: 'reject'` 是**声明式故障注入**：抛错且**不**调用真实 put，所以"记录没落盘"
//     是事实而不是假象；文件头与断言里都写明了这一点。
//
// 证据边界（不得夸大）：
//   * `store.requests` 录的是 mock provider 看到的**最终 GenerateOptions**（插件/fixtures/
//     mock-provider.mjs 自述如此），**不是**真实 provider wire，也不据此声称任何 wire 层性能。
//   * 0 请求判据取自 provider 录制计数 + 会话终态（mode/reason）+ 真实记录面，三处互相独立。
//   * 挂死保护用的是**测试层**的 bounded wait / deadline（超时报错），产品侧不加任何超时。
//
// 运行：node --test plugin/tests/composition/gate-trusted-epoch-io.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dshModule, fixtureFileUrl } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, LOCAL } from './harness.mjs'
import {
  INITIAL_EPOCH_ID, TRUSTED_EPOCH_DOMAIN, TRUSTED_EPOCH_TABLE,
} from '../../adapters/dsh/trusted-epoch.mjs'

const HIDDEN = 'fixture_hidden_inherited'
const SCOPE = 'fixture_hidden_scope'
const MUTATING = 'fixture_mutating'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']
/** 设置面板写入最终落到 schemastery 的方式（与 gate-settings 同一协议）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
/** 真实自动压缩（CE9 同款配置：极低阈值，压力一上来就真的压）。 */
const AUTO_COMPACTION = [
  { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
  {
    id: 'compaction-basic',
    name: '@deepseek-ai/dsh-compaction-basic',
    config: {
      auto: true, thresholdRatio: 0.01, retainTokens: 128,
      headroomTokens: 1024, maxTokens: 256, compactionRetries: 0,
    },
  },
]

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

async function storeOf () {
  return import(new URL('../../fixtures/mock-store.mjs', import.meta.url).href)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** bounded wait：超时**报错**（诊断失败），绝不"绿空过"。 */
async function waitFor (probe, ms, what) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`[诊断超时] ${ms}ms 内未等到：${what}`)
    await sleep(25)
  }
}

/** 测试层 deadline：只约束"本用例等多久"，不改变产品的任何超时语义。 */
function withDeadline (promise, ms, what) {
  let timer
  const guarded = promise.then(
    (value) => { clearTimeout(timer); return value },
    (error) => { clearTimeout(timer); throw error },
  )
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`[诊断超时] ${ms}ms 内未落定：${what}`)), ms)
  })
  return Promise.race([guarded, timeout])
}

function namesOf (request) {
  return (request?.tools ?? []).map((tool) => tool.name)
}

function nameSet (request) {
  return [...new Set(namesOf(request))].sort()
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

function baselineOf (ctx, sessionId) {
  return svcOf(ctx).trustedBaseline(sessionId)
}

function adapterEntry (boot) {
  const entry = boot.loader.entries().find((item) => item.id === 'progressive-discovery')
  assert.ok(entry !== undefined, 'adapter entry 必须已登记')
  return entry
}

async function rawEvents (ctx, sessionId) {
  return (await ctx.sessionQuery.readSession(sessionId)).events
}

/**
 * 直连真实工具执行管线（`ctx.tools.execute`），与模型调用同一条完整管线：
 * pre-policy → guards → dispatch → post-policy。本插件的 guard 就在其中。
 */
async function directExec (ctx, agent, name, args, callId) {
  const result = await ctx.tools.execute({
    agent,
    callId,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  const text = (result?.content ?? []).map((block) => block?.text ?? '').join('')
  return { result, text, isError: result?.isError === true }
}

/** 真实 SDK public 读：facility.get(domain).table(table) 的 entries。 */
function recordsOf (ctx) {
  const facility = ctx.get('storageDomain')
  if (facility === undefined) return null
  const domain = facility.get(TRUSTED_EPOCH_DOMAIN)
  if (domain === undefined) return null
  return [...domain.table(TRUSTED_EPOCH_TABLE).entries()].map(([key, value]) => ({ key, value }))
}

function recordsFor (ctx, sessionId) {
  return (recordsOf(ctx) ?? []).filter((item) => item.value?.sessionId === sessionId)
}

/** 真实介质证据：tmpRoot/data 下逐字读出记录（不是"SDK 说它落了"）。 */
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
 * 逐字替换一个方法，并给出**逐字还原**的句柄。
 * 原型上的方法 → 用 own property 遮蔽，还原时 delete；本来就是 own 的 → 原 descriptor 装回。
 */
function shimMethod (target, key, factory, label) {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key)
  const ownDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(target, key) : null
  const original = target[key]
  assert.equal(typeof original, 'function', `前置：${label}.${key} 必须是函数`)
  Object.defineProperty(target, key, {
    value: factory(original),
    writable: true,
    enumerable: hadOwn ? ownDescriptor.enumerable : false,
    configurable: true,
  })
  return function restore () {
    if (hadOwn) Object.defineProperty(target, key, ownDescriptor)
    else delete target[key]
    assert.equal(target[key], original, `${label}.${key} 必须逐字还原为真实实现`)
  }
}

/**
 * 在**真实** storageDomain 上给可信记录表挂一道闸门。
 *
 * 安装点与时序（这一段是本文件最容易装错的地方，故写死）：
 *   * adapter 激活时就会 `store.ensureOpen()`，**真实** `facility.open(spec)` 往往在
 *     `bootAdapterComposition` 返回**之前**就发起、之后才 resolve。此刻
 *     `facility.get(domain)` 还是 undefined，而事后再包 `facility.open` 也截不到
 *     那个**已在途**的调用 —— 于是 `table.put` 从头到尾没被包住，闸门永不通知。
 *   * 因此顺序必须是：① 先包 `open`（覆盖"稍后才 open"的 late mount 场景），
 *     ② **显式等到真实域出现**，③ 再包 `domain.table(TABLE)`。SDK 的
 *     `table(name)` 返回的是**稳定句柄**（同一实例），所以这一次包住就够。
 *   * 包完立刻自证（`installed`）：拦截没装上就是测试自己坏了，必须当场失败，
 *     不能让它伪装成"产品没写记录"。
 *
 * mode：
 *   'hold'    进入即 await 一个由测试释放的 Promise（IO1 / IO2 / IO4）
 *   'reject'  立刻抛错且**不**调用真实 put（IO3a；声明式故障注入）
 *   'observe' 只计数并逐字转发（IO5：证明"根本没写过"而不是"写了但我看不见"）
 */
async function installEpochPutGate (ctx, { match, mode = 'hold', label = 'gate', waitForDomain = true }) {
  const facility = ctx.get('storageDomain')
  assert.ok(facility !== undefined && typeof facility.open === 'function',
    '前置：真实 storageDomain 服务必须可达')
  const restores = []
  const wrapped = new Set()
  const seen = []
  let notify = () => {}
  const entered = new Promise((resolve) => { notify = resolve })

  function wrapTable (table) {
    if (wrapped.has(table)) return
    wrapped.add(table)
    restores.push(shimMethod(table, 'put', (realPut) => async function gatedPut (key, value) {
      if (!match(value)) return await realPut.call(table, key, value)
      const item = { key, record: value, released: false }
      seen.push(item)
      if (mode === 'observe') return await realPut.call(table, key, value)
      if (mode === 'reject') {
        notify(item)
        // 声明式注入：真实 put **没有被调用**，因此"没落盘"是事实。
        throw new Error(`${label}: 声明式注入的可信记录写失败（真实 table.put 未被调用）`)
      }
      item.waiting = new Promise((resolve) => {
        item.release = () => { item.released = true; resolve() }
      })
      notify(item)
      await item.waiting
      return await realPut.call(table, key, value)
    }, `${label}:${TRUSTED_EPOCH_TABLE}`))
    assert.ok(Object.prototype.hasOwnProperty.call(table, 'put'),
      `${label}: 闸门必须真的装在这张真实 table 的 put 上`)
  }

  // ① 先包 open：late mount（本用例里 IO5 的 adapter 后挂）时由它接管。
  restores.push(shimMethod(facility, 'open', (realOpen) => async function gatedOpen (spec) {
    const domain = await realOpen.call(facility, spec)
    if (spec?.name === TRUSTED_EPOCH_DOMAIN) wrapTable(domain.table(TRUSTED_EPOCH_TABLE))
    return domain
  }, 'storageDomain.open'))
  // ② ③ 等真实域出现后包那张稳定句柄。
  if (waitForDomain === true) {
    const domain = await waitFor(() => facility.get(TRUSTED_EPOCH_DOMAIN) ?? null, 20000,
      `${label}: 产品打开真实可信域 ${TRUSTED_EPOCH_DOMAIN}`)
    wrapTable(domain.table(TRUSTED_EPOCH_TABLE))
  }

  return {
    label,
    mode,
    seen,
    entered,
    // 必须是 **getter**：waitForDomain:false 的那一例是在 open 之后才装上的。
    get installed () { return wrapped.size > 0 },
    putCount: () => seen.length,
    releaseAll () {
      for (const item of seen) {
        if (typeof item.release === 'function' && !item.released) item.release()
      }
    },
    restore () {
      while (restores.length > 0) restores.pop()()
    },
  }
}

/** 每个用例一套 composition + 一套确定性清理。 */
async function openLab (options = {}) {
  const boot = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapterSchema: true,
    ...options,
  })
  const lab = {
    boot,
    ctx: boot.ctx,
    gates: [],
    turns: new Set(),
    handles: new Set(),
    unhandled: [],
  }
  const onUnhandled = (reason) => { lab.unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)

  lab.gate = async (config) => {
    const gate = await installEpochPutGate(boot.ctx, config)
    // waitForDomain:false 的那一例（IO5）此时域还没打开，由 open 包装稍后接管，
    // 那里改为在挂载 adapter 之后断言 installed。
    if (config.waitForDomain !== false) {
      assert.equal(gate.installed, true,
        `${config.label ?? 'gate'}: 闸门没装上（测试自身故障，不得据此推断产品行为）`)
    }
    lab.gates.push(gate)
    return gate
  }
  lab.drive = async (sessionId) => {
    const handle = await boot.ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
      meta: { cwd: boot.tmpRoot },
    })
    lab.handles.add(handle)
    return handle
  }
  lab.resume = async (sessionId) => {
    const handle = await boot.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    })
    lab.handles.add(handle)
    return handle
  }
  lab.startTurn = (handle, text) => {
    const task = (async () => {
      const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
    })()
    task.catch(() => {})
    lab.turns.add(task)
    return task
  }
  /** 观察"这一轮怎么结束的"：成功/失败都只作记录，事实由各自的终态断言给出。 */
  lab.settleTurn = (task, ms, what) => withDeadline(task.then(
    (value) => `resolved:${String(value)}`,
    (error) => `rejected:${String(error?.message ?? error).slice(0, 240)}`,
  ), ms, what)
  lab.dispose = async () => {
    process.off('unhandledRejection', onUnhandled)
    for (const gate of lab.gates) gate.releaseAll()
    for (const task of lab.turns) {
      try { await withDeadline(task, 20000, '清理时等待真实在途 turn') } catch { /* 已尽力 */ }
    }
    for (const handle of lab.handles) {
      try { await handle.dispose() } catch { /* 已释放 */ }
    }
    for (const gate of lab.gates) gate.restore()
    const errors = []
    try { await boot.closeServices() } catch (error) { errors.push(error) }
    try { boot.dispose() } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'lab teardown 未完成')
  }
  return lab
}

// ---------------------------------------------------------------------------
// IO0：正控制 —— 可信基线落定后，同一条直连执行路径确实能到达 body
// （IO1/IO3 的 body=0 因此有分辨力，不是"这条路径根本走不到 body"）
// ---------------------------------------------------------------------------
test('IO0: 正控制 —— 可信 alwaysVisible 基线下，直连 ctx.tools.execute 的 body 执行 1 次', { timeout: 120000 }, async () => {
  const lab = await openLab({ adapter: { alwaysVisible: [HIDDEN] } })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()
    assert.deepEqual(lab.boot.activationErrors(), [], 'composition 必须收敛')

    const handle = await lab.drive('io0-trusted')
    queueResponse({ text: 'IO0 baseline turn' })
    await withDeadline(lab.startTurn(handle, 'Say something.'), 40000, 'IO0 第一轮')

    assert.equal(baselineOf(lab.ctx, 'io0-trusted').state, 'trusted',
      '正控制前置：可信记录必须已落定')
    const exec = await directExec(lab.ctx, handle.agent, HIDDEN, { text: 'io0' }, 'io0-exec')
    assert.equal(exec.isError, false, `正控制：不得被拒；实际文本：${exec.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('io0-exec'), 1, '正控制：直连执行必须真的到达 body')
  } finally {
    await lab.dispose()
  }
})

// ---------------------------------------------------------------------------
// IO1：新会话的初始可信记录未 durable 之前
// ---------------------------------------------------------------------------
test('IO1: 初始 put 未 durable 前 → 0 出站请求 + guard 直连 body 0；放行后首请求是完整基线且真实记录已落盘', { timeout: 180000 }, async () => {
  const lab = await openLab({ adapter: { alwaysVisible: [HIDDEN] } })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()
    assert.deepEqual(lab.boot.activationErrors(), [], 'composition 必须收敛')
    const sessionId = 'io1-initial-put'
    const gate = await lab.gate({
      label: 'IO1',
      mode: 'hold',
      match: (record) => record?.sessionId === sessionId && record?.epochId === INITIAL_EPOCH_ID,
    })

    const handle = await lab.drive(sessionId)
    queueResponse({ text: 'IO1 first turn' })
    const turn = lab.startTurn(handle, 'Hello.')

    // --- 闸门确实挂在**真实** put 上，且记录在第一次 await 之前就定死 -----------
    const item = await withDeadline(gate.entered, 30000, 'IO1 初始 put 进入闸门')
    assert.equal(gate.putCount(), 1, '前置：闸门必须真的截住了这一次目标记录写')
    assert.equal(item.record.sessionId, sessionId)
    assert.equal(item.record.epochId, INITIAL_EPOCH_ID)
    assert.deepEqual(item.record.names, [HIDDEN], '初始名单必须在写入前同步捕获自配置')
    assert.equal(item.record.trigger, 'initial')
    assert.deepEqual(recordsFor(lab.ctx, sessionId), [], '挂住期间不得已经有任何记录')

    // --- pending 期间：0 请求 / guard 拒绝 / 名单为空 ------------------------
    await sleep(800)
    assert.equal(store.requests.length, 0,
      `put 挂住期间不得发出任何出站请求；实际 ${store.requests.length} 条`)
    const pending = baselineOf(lab.ctx, sessionId)
    // 初始 bootstrap 期间 ledger 暴露的是**写入之前**那个 MISSING 终态（同样不可授权）；
    // 契约只要求"落定之前不可授权"，所以这里刻意只钉不可授权 + 名单为空，
    // 而不是去规定产品把这段叫 pending 还是 blocked。
    assert.notEqual(pending.state, 'trusted',
      `初始记录落定之前不得进入 trusted：${JSON.stringify(pending)}`)
    assert.equal(pending.names, null, '初始记录落定之前不得有任何常驻名单')
    assert.deepEqual(runtimeOf(lab.ctx, sessionId).alwaysNames, [], 'pending 期间 runtime 不得有任何常驻名')

    const denied = await directExec(lab.ctx, handle.agent, HIDDEN, { text: 'io1' }, 'io1-exec-pending')
    assert.equal(denied.isError, true,
      `pending 期间直连执行必须被拒；实际文本：${denied.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('io1-exec-pending'), 0, 'pending 期间 body 必须为 0')
    assert.match(denied.text, /STATE_NOT_READY|not admitted|TRUSTED_EPOCH/i,
      `拒绝必须带明确理由；实际文本：${denied.text.slice(0, 300)}`)
    assert.equal(store.requests.length, 0, '直连执行不得顺带发出 provider 请求')

    // --- 放行：首请求 = 完整基线 ---------------------------------------------
    gate.releaseAll()
    await withDeadline(turn, 40000, 'IO1 放行后的那一轮')
    const first = store.requests[0]
    assert.ok(first !== undefined, '放行后必须真的发出一次出站请求')
    assert.deepEqual(nameSet(first), [HIDDEN, 'tool_list', 'tool_load', 'tool_search'].sort(),
      `放行后首请求必须是完整基线（三入口 + 可信常驻），实际：${JSON.stringify(namesOf(first))}`)
    const settled = baselineOf(lab.ctx, sessionId)
    assert.equal(settled.state, 'trusted', `落定后基线必须是 trusted：${JSON.stringify(settled)}`)

    // --- 真实记录落盘（SDK public 读 + 真实介质） -----------------------------
    const records = recordsFor(lab.ctx, sessionId)
    assert.equal(records.length, 1, `可信域里必须恰好一条本会话记录，实际 ${records.length}`)
    assert.deepEqual(records[0].value.names, [HIDDEN])
    assert.equal(records[0].value.epochId, INITIAL_EPOCH_ID)
    assert.equal(records[0].key, JSON.stringify([sessionId, records[0].value.ownSeqStart, INITIAL_EPOCH_ID, -1]))

    // --- 同一方法、同一会话、同一工具的正控制：放行后 body=1 --------------------
    const allowed = await directExec(lab.ctx, handle.agent, HIDDEN, { text: 'io1' }, 'io1-exec-trusted')
    assert.equal(allowed.isError, false,
      `同一条执行路径在基线可信后必须放行；实际文本：${allowed.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('io1-exec-trusted'), 1,
      '这才是 IO1 的分辨力来源：pending 时 body=0 不是因为 exec 走不到 body')

    const files = durableFilesUnder(lab.boot.storageRoot)
    assert.ok(files.length > 0, '真实存储根下必须有介质文件')
    assert.ok(files.some((entry) => entry.text.includes(sessionId) && entry.text.includes(INITIAL_EPOCH_ID)),
      '可信记录必须真的写在 tmpRoot/data 的介质里（不是只在内存表里）')
  } finally {
    await lab.dispose()
  }
})

// ---------------------------------------------------------------------------
// IO2：可信会话的真实自动压缩 → 新 epoch put 挂住 → post-next pre-step 屏障
// ---------------------------------------------------------------------------

/** 造一个"可信基线 + 真实 selected + 已披露缓存"的第一轮，并留下压力。 */
async function primeTrustedEpochTurn (lab, sessionId) {
  const { store, queueResponse } = await storeOf()
  queueResponse({ toolCalls: [{ id: `${sessionId}-load`, name: 'tool_load', arguments: { names: [SCOPE] } }] })
  queueResponse({ toolCalls: [{ id: `${sessionId}-use`, name: SCOPE, arguments: { text: 'prime' } }] })
  queueResponse({
    text: 'Earlier inspection details. '.repeat(1000),
    usage: { inputTokens: 1000, outputTokens: 10000 },
  })
  const handle = await lab.drive(sessionId)
  await withDeadline(lab.startTurn(handle, 'Load the scope tool and keep inspecting the earlier context.'),
    60000, `${sessionId} 第一轮`)
  const runtime = runtimeOf(lab.ctx, sessionId)
  assert.equal(baselineOf(lab.ctx, sessionId).state, 'trusted', '前置：可信基线必须先落定')
  const state = runtime.engine.getState(runtime.scope)
  assert.equal(state.selected.size, 1, '前置：必须有真实的旧 selected（否则"重置"是空断言）')
  assert.ok(runtime.engine.getFrozenWire(runtime.scope).length >= 1, '前置：必须有真实的旧披露缓存')
  assert.equal(store.bodyCount(`${sessionId}-use`), 1, '前置：旧 selected 真的执行过')
  const agentRequests = store.requests.filter((request) => request.purpose !== 'compaction').length
  assert.equal(store.requests.some((request) => request.purpose === 'compaction'), false,
    '前置：第一轮里不得已经发生过压缩（否则第二轮不再由本用例的闸门观察）')
  return { handle, agentRequests }
}

test('IO2: 自动压缩已发生但新 epoch 的 put 未 durable → 最终 GenerateOptions 零增量；释放后是新名单且旧 selected/frozen 已重置', { timeout: 240000 }, async () => {
  const lab = await openLab({ adapter: { alwaysVisible: [HIDDEN] }, extraServices: AUTO_COMPACTION })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()
    assert.deepEqual(lab.boot.activationErrors(), [], 'composition 必须收敛')
    const sessionId = 'io2-auto-compaction'
    const gate = await lab.gate({
      label: 'IO2',
      mode: 'hold',
      match: (record) => record?.sessionId === sessionId && record?.epochId !== INITIAL_EPOCH_ID,
    })

    const { handle, agentRequests } = await primeTrustedEpochTurn(lab, sessionId)

    // 周期中途改配置：新周期必须采**最新** config（周期中途本身不得改动在跑的 epoch）
    const entry = adapterEntry(lab.boot)
    entry.fiber.config.alwaysVisible[VOLATILE_WRITE]([MUTATING])
    assert.deepEqual(entry.fiber.config.alwaysVisible.get(), [MUTATING], '正控制：配置确实已经变了')
    assert.deepEqual(runtimeOf(lab.ctx, sessionId).alwaysNames, [HIDDEN], '周期中途的配置变更不得改动在跑的周期')

    // 第二轮：真实自动压力压缩 → 新 epoch 的 put 挂住
    queueResponse({ text: 'Earlier inspection has been summarized.' })
    queueResponse({ text: 'Continue with the compacted context.' })
    const turn = lab.startTurn(handle, 'Continue the task.')
    const item = await withDeadline(gate.entered, 90000, 'IO2 新 epoch put 进入闸门')
    assert.equal(gate.putCount(), 1, '前置：闸门必须真的截住了这一次新 epoch 的记录写')
    assert.equal(item.record.sessionId, sessionId)

    // 前置：压缩**真的**发生了（不是我们造的事件）
    assert.ok(store.requests.some((request) => request.purpose === 'compaction'),
      '必须由真实自动压力钩子发出摘要请求')
    const events = await rawEvents(lab.ctx, sessionId)
    const ends = events.filter((event) => event.type === 'compaction/end' && event.data?.error === undefined)
    assert.equal(ends.length, 1, `必须恰好一次无 error 的 compaction/end，实际 ${ends.length}`)
    assert.equal(item.record.trigger, 'auto', 'auto 压缩的可信记录 trigger 必须是 auto')
    assert.deepEqual(item.record.names, [MUTATING], 'auto 压缩必须采压缩那一刻的最新配置')

    // --- put 未 durable 期间：最终 GenerateOptions 零增量 ---------------------
    await sleep(1200)
    const during = store.requests.filter((request) => request.purpose !== 'compaction')
    assert.equal(during.length, agentRequests,
      `put 挂住期间不得有任何 agent 出站增量；实际多出 ${during.length - agentRequests} 条`)
    assert.equal(baselineOf(lab.ctx, sessionId).state, 'pending',
      '压缩已经换 epoch，但记录还没 durable —— 基线必须仍是 pending（不可授权）')
    // 屏障位置证据：成功压缩已经清掉了 selected/frozen（journal 同步做的），请求却还发不出去
    const runtime = runtimeOf(lab.ctx, sessionId)
    assert.equal(runtime.engine.getState(runtime.scope).selected.size, 0, '成功压缩已重置 selected')
    assert.equal(runtime.engine.getFrozenWire(runtime.scope).length, 0, '成功压缩已重置披露缓存')

    // --- 释放：那一轮带的是新名单 --------------------------------------------
    gate.releaseAll()
    await withDeadline(turn, 60000, 'IO2 释放后的那一轮')
    const sent = store.requests.filter((request) => request.purpose !== 'compaction').slice(agentRequests)
    assert.equal(sent.length, 1, `释放后应恰好补发一次出站；实际 ${sent.length} 条`)
    assert.deepEqual(nameSet(sent[0]), [MUTATING, 'tool_list', 'tool_load', 'tool_search'].sort(),
      `释放后那一轮必须带新名单且不含旧常驻/旧 selected；实际：${JSON.stringify(namesOf(sent[0]))}`)
    assert.equal(sent[0].tools.some((tool) => tool.name === SCOPE), false, '旧 selected 不得复活')

    // 终态与记录面
    assert.equal(baselineOf(lab.ctx, sessionId).state, 'trusted', '落定后基线必须 trusted')
    assert.equal(runtime.engine.getState(runtime.scope).selected.size, 0, 'selected 必须保持重置')
    assert.equal(runtime.engine.getFrozenWire(runtime.scope).length, 0, '披露缓存必须保持重置')
    assert.deepEqual(runtimeOf(lab.ctx, sessionId).alwaysNames, [MUTATING])

    const records = recordsFor(lab.ctx, sessionId)
    const compacted = records.filter((item) => item.value.epochId !== INITIAL_EPOCH_ID)
    assert.equal(compacted.length, 1, `必须恰好一条新 epoch 记录，实际 ${compacted.length}`)
    assert.equal(compacted[0].value.trigger, 'auto')
    assert.deepEqual(compacted[0].value.names, [MUTATING])
    assert.equal(compacted[0].value.epochId, `${ends[0].data.compactionId}@${ends[0].seq}`,
      'epoch 身份必须来自真实压缩边界（compactionId@endSeq），不是配置 hash')
    assert.equal(records.length, 2, '初始记录必须仍在（不得被新周期覆盖）')
  } finally {
    await lab.dispose()
  }
})

// ---------------------------------------------------------------------------
// IO3a：新 epoch 的可信写被拒（声明式注入）
// ---------------------------------------------------------------------------
test('IO3a: put 被拒 → 确定 blocked 终态 + 0 请求 + 不沿用旧授权，guard 不得从 alwaysNameSet 早退', { timeout: 240000 }, async () => {
  const lab = await openLab({ adapter: { alwaysVisible: [HIDDEN] }, extraServices: AUTO_COMPACTION })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()
    const sessionId = 'io3a-put-rejected'
    const gate = await lab.gate({
      label: 'IO3a',
      mode: 'reject',
      match: (record) => record?.sessionId === sessionId && record?.epochId !== INITIAL_EPOCH_ID,
    })

    const { handle, agentRequests } = await primeTrustedEpochTurn(lab, sessionId)
    const entry = adapterEntry(lab.boot)
    entry.fiber.config.alwaysVisible[VOLATILE_WRITE]([MUTATING])
    assert.deepEqual(entry.fiber.config.alwaysVisible.get(), [MUTATING], '正控制：配置确实已经变了')

    queueResponse({ text: 'Earlier inspection has been summarized.' })
    queueResponse({ text: '这一条永远不该被发出去' })
    const turn = lab.startTurn(handle, 'Continue the task.')
    await lab.settleTurn(turn, 2000, 'IO3a 观察窗')

    await waitFor(() => baselineOf(lab.ctx, sessionId)?.state === 'blocked', 60000, 'IO3a blocked 终态')
    const blocked = baselineOf(lab.ctx, sessionId)
    assert.equal(blocked.state, 'blocked', `必须是确定的 blocked 终态：${JSON.stringify(blocked)}`)
    assert.equal(blocked.reason, 'STORAGE_UNAVAILABLE', `reason 必须明确：${JSON.stringify(blocked)}`)
    assert.equal(gate.putCount(), 1, `必须真的尝试过一次新 epoch 写；实际 ${gate.putCount()} 次`)
    assert.equal(typeof gate.seen[0].release, 'undefined',
      'reject 模式下不得拿到过放行句柄（真实 table.put 未被调用，这是"没落盘"的原因）')
    assert.equal(store.requests.filter((request) => request.purpose !== 'compaction').length, agentRequests,
      '可信写失败后不得发出任何 agent 出站增量')

    // 不沿用旧授权：旧 epoch 的常驻名不得继续生效。
    // 观察（不写成断言，属于产品内部表示，不是授权面）：写失败后 runtime.alwaysNames
    // 仍可能留着**新**配置捕获的那份名单（lifecycle 的 adopt().then 在 outcome.ok!==true
    // 时早退，没走到 blockBaseline）。它不构成授权 —— guard 的基线判据排在 alwaysNameSet
    // 早退之前，下面那条直连执行就是它的直接证据；是否要在失败分支也 blockBaseline 由产品决定。
    const runtime = runtimeOf(lab.ctx, sessionId)
    assert.equal(runtime.alwaysNameSet.has(HIDDEN), false,
      `blocked 之后不得保留**旧**授权：${JSON.stringify([...runtime.alwaysNames])}`)
    assert.equal(runtime.engine.getState(runtime.scope).selected.size, 0,
      '成功压缩已重置 selected；blocked 之后更不得靠 selected 复活授权')

    // guard 的基线判据必须排在 alwaysNameSet 早退之前
    const denied = await directExec(lab.ctx, handle.agent, HIDDEN, { text: 'io3a' }, 'io3a-guess')
    assert.equal(denied.isError, true, `blocked 之后直连执行必须被拒；实际文本：${denied.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('io3a-guess'), 0, 'blocked 之后 body 必须为 0')
    assert.match(denied.text, /STATE_NOT_READY|STORAGE_UNAVAILABLE|not admitted/i,
      `拒绝理由必须指向基线不可授权；实际文本：${denied.text.slice(0, 300)}`)

    // 记录面：旧记录仍在，新记录确实没落盘
    const records = recordsFor(lab.ctx, sessionId)
    assert.equal(records.length, 1, `只应有初始那一条；实际 ${JSON.stringify(records.map((r) => r.value.epochId))}`)
    assert.equal(records[0].value.epochId, INITIAL_EPOCH_ID)
    assert.deepEqual(lab.unhandled, [], `写失败不得逃成未处理拒绝：${JSON.stringify(lab.unhandled.map(String))}`)
  } finally {
    await lab.dispose()
  }
})

// ---------------------------------------------------------------------------
// IO3b：SDK 不可用（omitStorage 显式负向装配）
// ---------------------------------------------------------------------------
test('IO3b: 宿主没有 storageDomain（omitStorage）→ 确定 STORAGE_UNAVAILABLE、0 请求、配置里的常驻名也不得放行', { timeout: 180000 }, async () => {
  const lab = await openLab({ adapter: { alwaysVisible: [HIDDEN] }, omitStorage: true })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()
    assert.equal(lab.boot.storageMounted, false, '前置：本 composition 确实没装 storage 三件套')
    assert.equal(lab.boot.ctx.get('storageDomain'), undefined, '前置：storageDomain 服务不可达')
    const sessionId = 'io3b-no-provider'

    const handle = await lab.drive(sessionId)
    queueResponse({ text: 'IO3b turn' })
    const turn = lab.startTurn(handle, 'Hello.')
    await lab.settleTurn(turn, 2000, 'IO3b 观察窗')

    const blocked = baselineOf(lab.ctx, sessionId)
    assert.equal(blocked.state, 'blocked', `缺 provider 必须是确定的 blocked 终态：${JSON.stringify(blocked)}`)
    assert.equal(blocked.reason, 'STORAGE_UNAVAILABLE', `reason 必须明确：${JSON.stringify(blocked)}`)
    assert.equal(store.requests.length, 0, `缺 provider 时不得发出任何出站请求；实际 ${store.requests.length} 条`)

    const runtime = runtimeOf(lab.ctx, sessionId)
    assert.deepEqual(runtime.alwaysNames, [], '缺 provider 时不得拿当前配置当常驻名单')

    const denied = await directExec(lab.ctx, handle.agent, HIDDEN, { text: 'io3b' }, 'io3b-guess')
    assert.equal(denied.isError, true, `缺 provider 时直连执行必须被拒；实际文本：${denied.text.slice(0, 300)}`)
    assert.equal(store.bodyCount('io3b-guess'), 0, '缺 provider 时 body 必须为 0')
    assert.match(denied.text, /STATE_NOT_READY|STORAGE_UNAVAILABLE|not admitted/i,
      `拒绝理由必须指向存储不可用；实际文本：${denied.text.slice(0, 300)}`)
    assert.deepEqual(lab.unhandled, [], '缺 provider 不得逃成未处理拒绝')
  } finally {
    await lab.dispose()
  }
})

// ---------------------------------------------------------------------------
// IO4：pending put 期间释放 runtime / 插件 fiber
// ---------------------------------------------------------------------------

// 说明（合成边界，必须照实说）：宿主在本 composition 里没有可达的"整会话 dispose"公开入口
// （dsh-session 的 detachEntered 需要内部 entry）。产品侧 session/disposed 的处理与
// lifecycle.disposeSession 是**同一个函数**（adapters/dsh/index.mjs 的
// `ctx.on('session/disposed', (session) => lifecycle.disposeSession(session.id))`），
// 因此 IO4a 走的就是那条真实代码路径，而不是给产品造了一个新的释放语义。
test('IO4a: pending put 期间 runtime 被释放 → 释放闸门后不得复活授权、不得发出请求', { timeout: 180000 }, async () => {
  const lab = await openLab({ adapter: { alwaysVisible: [HIDDEN] } })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()
    const sessionId = 'io4a-runtime-dispose'
    const gate = await lab.gate({
      label: 'IO4a',
      mode: 'hold',
      match: (record) => record?.sessionId === sessionId,
    })

    const handle = await lab.drive(sessionId)
    queueResponse({ text: 'IO4a turn' })
    const turn = lab.startTurn(handle, 'Hello.')
    await withDeadline(gate.entered, 30000, 'IO4a 初始 put 进入闸门')
    assert.equal(gate.putCount(), 1, '前置：闸门必须真的截住了这一次目标记录写')

    const svc = svcOf(lab.ctx)
    svc.lifecycle.disposeSession(sessionId)
    assert.equal(svc.sessions.get(sessionId), undefined, '前置：runtime 确实已从会话表移除')

    gate.releaseAll()
    await withDeadline(turn, 40000, 'IO4a 释放后的那一轮')
    await sleep(600)

    assert.equal(store.requests.length, 0, `runtime 已释放后不得发出任何出站请求；实际 ${store.requests.length} 条`)
    assert.equal(svcOf(lab.ctx).sessions.get(sessionId), undefined,
      '释放后的在途写不得把 runtime 放回会话表（不得复活）')
    assert.equal(svcOf(lab.ctx).trustedBaseline(sessionId), null,
      '已释放的会话不得重新拿到一份 trusted 基线')
    assert.deepEqual(lab.unhandled, [], `释放闸门不得逃成未处理拒绝：${JSON.stringify(lab.unhandled.map(String))}`)
    // 透明说明：闸门位于**真实 put 内部**（产品的 disposed 自检发生在它之前），
    // 所以记录可能真的落了盘 —— 本例钉的契约是"不复活授权、不发请求"，不是"不许落盘"。
  } finally {
    await lab.dispose()
  }
})

test('IO4b: pending put 期间插件 fiber 被释放 → 域随插件关闭，释放闸门不复活也不抛出', { timeout: 180000 }, async () => {
  const lab = await openLab({ adapter: { alwaysVisible: [HIDDEN] } })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()
    const sessionId = 'io4b-fiber-dispose'
    const gate = await lab.gate({
      label: 'IO4b',
      mode: 'hold',
      match: (record) => record?.sessionId === sessionId,
    })

    const handle = await lab.drive(sessionId)
    queueResponse({ text: 'IO4b turn' })
    const turn = lab.startTurn(handle, 'Hello.')
    await withDeadline(gate.entered, 30000, 'IO4b 初始 put 进入闸门')
    assert.equal(gate.putCount(), 1, '前置：闸门必须真的截住了这一次目标记录写')

    const entry = adapterEntry(lab.boot)
    await entry.fiber.dispose()
    assert.equal(lab.ctx.get('progressiveDiscovery'), undefined, '前置：插件 fiber 确实已卸载')
    const facility = lab.ctx.get('storageDomain')
    assert.equal(facility.get(TRUSTED_EPOCH_DOMAIN), undefined,
      '插件卸载必须把它自己打开的可信域一并关掉')

    gate.releaseAll()
    await withDeadline(turn, 40000, 'IO4b 释放后的那一轮')
    await sleep(600)

    assert.deepEqual(lab.unhandled, [],
      `已关闭域上的迟到写必须被吞成确定终态，不得逃成未处理拒绝：${JSON.stringify(lab.unhandled.map(String))}`)
    // 插件已卸载之后的出站不再受可信基线约束（超出本门禁范围，因此不断言请求条数）。
  } finally {
    await lab.dispose()
  }
})

// IO5 用更小的 retainTokens：程序化 compactNow 的可压缩区必须足够大，
// 否则宿主会因 "summary is not smaller than the shadowed content" 直接失败（那是脚本尺寸问题）。
const IO5_COMPACTION = [
  { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
  {
    id: 'compaction-basic',
    name: '@deepseek-ai/dsh-compaction-basic',
    config: {
      auto: true, thresholdRatio: 0.01, retainTokens: 16,
      headroomTokens: 1024, maxTokens: 256, compactionRetries: 0,
    },
  },
]

// ---------------------------------------------------------------------------
// IO5：legacy（缺可信记录）会话上的压缩**不得**成为迁移
//
// 分层声明（不合成、不冒称宿主自然行为）：
//   层一（真实宿主的一次普通轮）：legacy 会话被明确 blocked、0 出站请求、0 条记录。
//     这里**不断言**"自动压力钩子有没有跑"：结构性事实是 legacy 在 assemble 阶段
//     就被挡住，宿主根本走不到 pre-step 的 auto 钩子，所以"auto 迁移"在真实轮里
//     没有发生的机会 —— 把它断言成"必须发生"就是逼测试伪造自然事件，故不这么做。
//   层二（真实压缩，但不是用户命令）：用宿主**真实**的 `compaction.compactNow`
//     在同一个 blocked 会话上跑一次真压缩（真摘要请求、真 canonical 三段、真成功）。
//     它没有 command/run，因此代表"程序/自动发起的压缩"这一类；这一层证明的是
//     **分类器**：一次成功的非用户压缩不得写出可信记录、不得给出授权。
//   用户 `/compact` 的迁移链由 gate-trusted-epoch 的 TE4a/TE4b 覆盖，本文件不重复。
// ---------------------------------------------------------------------------

/** 在已有真实历史的 composition 上挂载产品 adapter（legacy 的真实构造方式）。 */
async function mountAdapterLate (boot, config) {
  await boot.loader.create({
    id: 'progressive-discovery',
    name: fixtureFileUrl(LOCAL['adapter-schema']),
    config,
  })
  await boot.loader.await()
  const entry = adapterEntry(boot)
  assert.equal(entry.fiber?._error, undefined, `adapter 必须激活：${String(entry.fiber?._error)}`)
  return entry
}

test('IO5: legacy 会话上的压缩不得迁移 —— 真实普通轮 0 请求 0 记录，真实非用户压缩成功后仍然 0 记录 0 授权', { timeout: 240000 }, async () => {
  const lab = await openLab({ adapter: null, extraServices: IO5_COMPACTION })
  try {
    const { store, queueResponse } = await storeOf()
    store.reset()

    // 阶段一：**没有 adapter** 的 composition 里造出真实历史（这才是 legacy 的由来）。
    // 两轮长回复：可压缩区必须足够大，否则压缩会因"摘要不够小"失败。
    const seed = await lab.drive('io5-legacy')
    queueResponse({ text: 'Alpha details. '.repeat(800) })
    await withDeadline(lab.startTurn(seed, 'First inspection pass.'), 60000, 'IO5 阶段一第一轮')
    queueResponse({ text: 'Beta findings. '.repeat(800) })
    await withDeadline(lab.startTurn(seed, 'Second inspection pass.'), 60000, 'IO5 阶段一第二轮')
    assert.ok(seed.agent.session.seq > 0, '前置：阶段一必须留下真实非空历史')
    assert.equal(lab.ctx.get('progressiveDiscovery'), undefined, '前置：本阶段 adapter 尚未挂载')
    await seed.dispose()
    lab.handles.delete(seed)
    store.reset()

    // 阶段二：挂载 adapter（此时会话是 legacy：可信记录从未存在过），并挂只读闸门。
    // 此处产品还没打开域（adapter 尚未挂载），所以由 open 包装接管 —— 不等真实域出现。
    const gate = await lab.gate({
      label: 'IO5',
      mode: 'observe',
      waitForDomain: false,
      match: (record) => record?.sessionId === 'io5-legacy',
    })
    await mountAdapterLate(lab.boot, { alwaysVisible: [] })
    await waitFor(() => gate.installed, 20000, 'IO5: 产品打开域时闸门装到那张真实 table 上')
    const resumed = await lab.resume('io5-legacy')

    // --- 层一：真实宿主的一次普通轮 -----------------------------------------
    queueResponse({ text: '这一条永远不该被发出去' })
    const turn = lab.startTurn(resumed, 'Continue the task.')
    const outcome = await lab.settleTurn(turn, 3000, 'IO5 层一观察窗')
    await sleep(500)
    assert.equal(store.requests.length, 0,
      `legacy 会话在普通轮里不得发出任何出站请求；实际 ${store.requests.length} 条（该轮结局：${outcome}）`)
    assert.equal(baselineOf(lab.ctx, 'io5-legacy').state, 'blocked', 'legacy 必须被明确阻止')
    assert.equal(gate.putCount(), 0, '层一不得写出任何可信记录')

    // --- 层二：真实压缩，但不是用户命令 --------------------------------------
    // 层一排队的"永远不该被发出去"仍在脚本队列里；清空它，免得被层二的摘要请求消费掉
    // （mock provider 是 FIFO 消费，被误消费会让压缩因"摘要不够小"失败 —— 那是测试脚本错，不是产品行为）。
    store.reset()
    const compaction = lab.ctx.get('compaction')
    assert.ok(compaction !== undefined, '前置：真实压缩服务必须激活')
    // 摘要必须真的比被遮蔽的内容更短，否则宿主会以 "could not produce a smaller summary" 失败
    queueResponse({ text: 'Summary of earlier passes.' })
    const result = await withDeadline(
      compaction.compactNow(resumed.agent, new AbortController().signal), 60000, 'IO5 层二真实压缩')
    assert.ok(result !== null && result.shadowedSeqs.length > 0,
      `前置：必须真的压缩了历史（禁止 no-op 空转）：${JSON.stringify(result)}`)
    const events = await rawEvents(lab.ctx, 'io5-legacy')
    const ends = events.filter((event) => event.type === 'compaction/end' && event.data?.error === undefined)
    assert.equal(ends.length, 1, `前置：真实压缩必须成功一次；实际 ${ends.length}`)
    assert.ok(store.requests.some((request) => request.purpose === 'compaction'),
      '前置：摘要请求必须真的由宿主压缩服务发出')
    // 没有 command/run：所以这条压缩**不是**用户 /compact
    assert.equal(events.some((event) => event.type === 'command/run'), false,
      '前置：程序化压缩不得伴随任何 command/run（它不是用户 /compact）')

    // 但它**不得**成为迁移
    assert.equal(gate.putCount(), 0, `非用户压缩不得写任何可信记录；实际写了 ${gate.putCount()} 条`)
    assert.deepEqual(recordsFor(lab.ctx, 'io5-legacy'), [], 'legacy 会话不得拥有任何可信记录')
    const blocked = baselineOf(lab.ctx, 'io5-legacy')
    assert.equal(blocked.state, 'blocked', `成功压缩后 legacy 仍必须是 blocked：${JSON.stringify(blocked)}`)
    assert.equal(blocked.reason, 'MISSING_TRUSTED_EPOCH', `reason 必须明确区分 missing：${JSON.stringify(blocked)}`)
    assert.equal(store.requests.filter((request) => request.purpose !== 'compaction').length, 0,
      '成功压缩之后 legacy 仍然不得发出任何 agent 出站请求')
  } finally {
    await lab.dispose()
  }
})
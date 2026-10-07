// 可信周期基线「pending 结算」门禁 —— **独立真实 Loader composition 门禁（TS 系列）**。
//
// 目标（已修 F3 的结算契约）：
//   当**恢复/引导收尾**正在裁决基线、而此刻账本处于 PENDING 且**原因是又来了一次正在
//   成功的迁移写**（live 用户 `/compact` 的 `ledger.adopt`）时，收尾**不得**把这个
//   PENDING 当成一次已决失败：不得提前落终态、不得提前把 `restoring` 归 false、
//   不得发请求、不得给出任何常驻名单。释放那次**最新 manual 写**之后，会话必须落
//   ready / trusted，且权威名单、epoch 身份与 journal 报告的周期边界、durable 记录
//   三方一致。
//
// 修之前的判法（`resolveBootstrapBaseline` 旧裁决）是：
//   const loaded = await ledger.load(); … await ledger.begin(…);
//   if (ledger.state !== TRUSTED) { blockBaseline(runtime, ledger.reason); … }
// `begin()` 自己的 await 窗口里抵达的那次 adopt 推进了 revision，于是它返回
// `{state: PENDING, reason: null}`；旧代码把「又来了一次正在成功的迁移写」当成
// 「确定失败」，把归因写成 null、把名单清空、把 restoring 提前归 false。
//
// 本门禁的接线（全部真实，无 `createLifecycle` fake、无 mock apply）：
//   * **真实 Cordis Loader entry 树**（composition/harness.mjs）：真实 services、
//     真实 storage 三件套、真实 compaction/commands 公共服务、真实 mock LLM provider。
//   * **真实 storageDomain**、真实 adapter（adapters/dsh/index.mjs 装配的产品插件）。
//   * **真实 runtime / engine / journal / ledger**：`lifecycle.ensureRuntime` 是产品
//     服务面的公开入口（gate-trusted-epoch-fork.test.mjs 已在用）。
//   * **真实 agent**：父会话两轮真实出站；子会话由 `agents.create({seed,
//     inheritedEventCount})` 走宿主**真实种子继承**路径（own 段为空）；子 agent 创建后
//     **先保持空闲**以运行真实手动 `/compact`，随后**驱动一条真实 pending 用户轮**
//     （窗口内它卡在 pre-step 屏障上，释放后补发恰好一次出站）。
//   * **canonical 链与压缩边界**：`compaction/start · compaction/summary · compaction/end`
//     与 `command/run · command/done` 全部由真实 compactNow + 真实 commands 执行产生，
//     迁移写由产品的 `onUserCompactionComplete` → `ledger.adopt` 真实发起。
//
// **声明式注入面按用例分列**（全部在测试侧、都不改产品语义）：
//   * **TS1 —— 唯一注入：storage 写屏障**。在真实 `storageDomain.open` 返回的域上代理
//     `table().put`，逐条按测试指定顺序放行。
//   * **TS2 —— 三处注入**：① **opening 闸门**（**先等待测试闸门、后调用真实
//     `facility.open()`**；此刻域**尚未打开**）；② 真实域打开**之后**的 `table().put`
//     写屏障；③ `ledger.load` 的**只观察**旁路订阅（调用原函数、返回**同一个原始
//     promise 对象**，仅旁路记录 `state` / `reason`，不改值、不抛断言、不 async 包装，
//     用完逐字装回）。第 ③ 项是 test instrumentation，**不是** fake store / fake ledger。
// 屏障存在的唯一目的，是把「写尚未落盘 / 这次 open 尚未发生」这段窗口**撑开**，好让门禁
// 在窗口内部断言。因此：
//   * 本文件证明的是「**在上述注入之下**，结算契约成立」，即防回归；
//   * 它**不**证明真实宿主会自然产生这两条 pending-settlement 窗口，也**不**声称这是
//     线上可达性证据。窗口的自然可达性仍未验证（见交接 checkpoint 的未完成项）。
//
// 判据（互相独立，缺一即空过）：
//   TS1p  强前置 —— 屏障确实拦下了**两条**写：被 supersede 的初始记录，与**最新**的
//         manual 迁移记录；后者的 epoch 必须是本次真实压缩的 compactionId@endSeq。
//   TS1a  窗口内不得提前终态：ledger 仍是 pending（不是 blocked/failed-closed）、
//         reason 仍是 null、restoring 仍为 true、**真实 `whenReady` 的 promise 未落定**、
//         那条 pending 用户轮仍未 idle。
//   TS1b  窗口内不得授权：常驻名单为空、名单快照为 null、直连执行被 STATE_NOT_READY
//         拒且 body=0。
//   TS1c  窗口内不得发**对话**出站请求：`purpose !== 'compaction'` 的请求一条都没有；
//         压缩摘要自己的 provider 调用按 purpose 明确区分，不算对话出站。这一条由
//         **真实 pending 用户轮**驱动（窗口内确有一次对话在等基线），不是「没驱动过」。
//   TS1d  释放**最新 manual 写**之后：ready / trusted / 名单 = 压缩边界捕获的那份 /
//         epoch 与 journal、durable compaction/end、durable 记录四方一致。
//   TS1e  反空过控制：窗口里那条**同一条** pending 用户轮在释放后真的补发一次出站
//         （带 BOUNDARY 名单里的工具、不带初始名单里的工具）并 idle，直连执行 body=1。
//
// 断言纪律：每条前置都有独立硬断言，不存在「取到 undefined 就跳过」的空转路径；
// 窗口内的观察全部取自**同步可读的真实事实**（restoring / ledger state / 名单 /
// durable 表 / agent.status / 出站记录），`whenReady` 未落定只是**辅助**观察，
// 终态一律取自真实落定值，不靠超时判终态。
//
// **变异口径（务必按此读，不要外推）**
//   本文件两个用例钉住**两个不同的裁决点**，交叉实测（各自在**全新私有副本**上做，
//   产品源码零插桩；私有回退只改副本里的 `lifecycle.mjs`）：
//   * **M1 = 回退 `resolveBootstrapBaseline` 的第二裁决点**（`begin()` 之后的结算，
//     `await gate.begun` 之后那一段）到修复前的「只判一次 `state !== TRUSTED` 就
//     `blockBaseline(reason)`」→ **TS1 红、TS2 绿**。实测红在 TS1a 的 `restoring`
//     断言上：`收尾未落定前 restoring 必须仍为 true`。
//   * **M2b = 回退 `settleRestoreBaseline` 里「有 own 出站历史」那条 legacy 恢复收尾
//     入口**到修复前的**忠实**形态（**只 `load()` 一次、只判一次终态**）→
//     **TS2 红、TS1 绿**，同样红在 `restoring` 那句。
//   * **旧 M2（弱反例，不能作决定性证据）**：把那一入口回退成**连 `load()` 都不再调用**
//     的粗改形态时，TS2 红在 **TS2p 的前置**（观察器根本取不到那次 `load` 的返回值），
//     而不是红在行为断言上。它只说明「门禁会拒绝在没读到 load 的情况下自证」，
//     **不**说明结算契约被它检出；决定性证据是上面的 **M2b**。
//   两条互为对照：任一裁决点回退都只让**它自己那条**用例红。
//
// 运行：node --test plugin/tests/composition/gate-trusted-epoch-settlement.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule, fixtureFileUrl } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, LOCAL } from './harness.mjs'
import { TRUSTED_EPOCH_DOMAIN, TRUSTED_EPOCH_TABLE } from '../../adapters/dsh/trusted-epoch.mjs'

/** 与既有门禁同一对隐藏目标：都是 global 层注册的 fixture 工具。 */
const HIDDEN = 'fixture_hidden_inherited'
const MUTATING = 'fixture_mutating'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']

/**
 * 三份**互不相同**的常驻名单，用来让「名单断言」真的有辨别力：
 *   * `INITIAL_NAMES` —— 迟到挂载时的配置；子会话的**初始**记录捕获它。
 *   * `BOUNDARY_NAMES` —— 真实 `/compact` 边界那一刻的配置；**迁移**记录捕获它。
 *     终态权威必须是它：既不是初始记录那份，也不是后来的当前配置。
 *   * `LATE_NAMES` —— 迁移写仍被屏障按住期间改成的当前配置；它**不得**渗进终态。
 * 三者两两不同，且都是全局注册的真实工具（不是编出来的名字）。
 */
const INITIAL_NAMES = [HIDDEN]
const BOUNDARY_NAMES = [MUTATING]
const LATE_NAMES = []

/** settings 写路径最终落到 schemastery 的 volatile 写协议（与 gate-trusted-epoch-io 同源）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 真实 `/compact` 需要的那四个安装内公共服务（与 gate-trusted-epoch 的 TE4 同源）。 */
const COMPACTION_SERVICES = [
  { id: 'commands', name: '@deepseek-ai/dsh-commands', config: {} },
  { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter', config: {} },
  { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic',
    config: { auto: false, headroomTokens: 1024, maxTokens: 256, compactionRetries: 0 } },
  { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact', config: {} }
]

const PARENT = 'ts1-parent'
const CHILD = 'ts1-child'

/**
 * 收尾是**失败安全**的，顺序是硬要求：
 *   1. 先释放所有写屏障（红断言时 manual 写仍被按住；不释放就会把未落盘的写留给
 *      closeServices，随后删目录时产生游离 IO/ENOENT，把一次红掩盖成另一种失败）；
 *   2. 再 await 释放真实 agent 句柄（会话持久化还在 flush）；
 *   3. 再 `closeServices()` **真关闭** composition 的 entry fiber（让 adapter 释放它
 *      打开的 storage domain），而不是只删目录；
 *   4. 最后才删 tmpRoot。
 * 关闭失败**不吞**：全部收集起来，在 after 末尾聚合成一个错误抛出（否则「关不掉」
 * 会被读成「门禁通过」）。
 */
const barriers = []
const agentDisposals = []
const serviceClosers = []
const cleanup = []

after(async () => {
  for (const release of barriers.reverse()) {
    try { release() } catch { /* 已尽力释放 */ }
  }
  for (const dispose of agentDisposals.reverse()) {
    try { await dispose() } catch { /* 已释放 */ }
  }
  const closeErrors = []
  for (const close of serviceClosers.reverse()) {
    try { await close() } catch (error) { closeErrors.push(String(error?.message ?? error)) }
  }
  for (const dispose of cleanup.reverse()) {
    try { dispose() } catch { /* 已释放 */ }
  }
  if (closeErrors.length > 0) {
    throw new Error(`TS1 收尾：composition 未被真关闭（不得吞掉）：${closeErrors.join(' | ')}`)
  }
})

async function storeOf () {
  return import(new URL('../../fixtures/mock-store.mjs', import.meta.url).href)
}

/** 等一个**真实条件**成立；超时即抛（绝不用采样窗口冒充终态）。 */
async function until (probe, what, timeoutMs = 20000) {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function namesOf (request) {
  return (request?.tools ?? []).map((tool) => tool.name)
}

/** 直连真实执行管线（与模型调用同一条），guard 是唯一可能放行的关口。 */
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

/**
 * **声明式 storage 写屏障**（本文件唯一的注入）。
 *
 * 装在真实 `storageDomain` 服务的 `open` 上：域被打开后，`table().put` 被代理成
 * 「先登记成一条 held 写，等测试按**指定顺序**逐条放行，再走真实 put」。
 * 其余一切（open / get / close / 真实 JSON backend）逐字转发。
 *
 * 必须**早于**产品 adapter 的第一次 `ensureOpen`：`adapters/dsh/index.mjs` 在 apply 期
 * 就 `store.ensureOpen()`，域只开一次。所以本门禁在**不**装配 adapter 的 composition
 * 里装屏障，再用与 TE2/TE4b 相同的迟到挂载方式把产品 adapter 装上。
 *
 * @returns {{held:{key:string,value:any,released:boolean,release:()=>void}[],
 *            releaseNext:()=>object, releaseAll:()=>void, restore:()=>void}}
 */
function installTrustedEpochWriteBarrier (ctx) {
  const facility = ctx.get('storageDomain')
  assert.ok(facility !== undefined, '前置：真实 storageDomain 服务必须可达（否则屏障无处可装）')
  assert.equal(typeof facility.open, 'function', '前置：真实 facility 必须有官方 open 接口')
  const realOpen = facility.open
  const held = []

  facility.open = async function (spec, ...rest) {
    const opened = await realOpen.call(this, spec, ...rest)
    const realTable = opened.table.bind(opened)
    const proxied = Object.create(opened)
    proxied.table = (name) => {
      const table = realTable(name)
      const realPut = table.put.bind(table)
      return new Proxy(table, {
        get (target, prop, receiver) {
          if (prop !== 'put') return Reflect.get(target, prop, receiver)
          return async (key, value, ...more) => {
            const ticket = { key, value, released: false, resolve: null }
            held.push(ticket)
            await new Promise((resolve) => { ticket.resolve = resolve })
            return realPut(key, value, ...more)
          }
        },
      })
    }
    return proxied
  }

  return {
    held,
    /** 放行**下一条**尚未落盘的写（顺序完全由测试决定，不依赖计时器）。 */
    releaseNext () {
      const next = held.find((ticket) => !ticket.released)
      assert.ok(next !== undefined, '没有待放行的写可放行（屏障状态与前提不符）')
      next.released = true
      next.resolve()
      return next
    },
    releaseAll () {
      for (const ticket of held) {
        if (ticket.released) continue
        ticket.released = true
        ticket.resolve()
      }
    },
    /** 逐字装回真实 open（不得留下代理产物跨用例泄漏）。 */
    restore () { facility.open = realOpen },
  }
}

/** 迟到挂载产品 adapter（与 TE2/TE4b/TE-LM 同一真实构造方式）。 */
async function mountAdapterLate (boot, config, { adapterSchema = false } = {}) {
  await boot.loader.create({
    id: 'progressive-discovery',
    name: fixtureFileUrl(adapterSchema ? LOCAL['adapter-schema'] : LOCAL.adapter),
    config
  })
  await boot.loader.await()
  const entry = boot.loader.entries().find((item) => item.id === 'progressive-discovery')
  assert.ok(entry !== undefined, 'adapter entry 必须已登记')
  assert.equal(entry.fiber?._error, undefined, `adapter 必须激活：${String(entry.fiber?._error)}`)
  return entry
}

/**
 * 经**真实的 schemastery volatile 写协议**改当前配置（与 gate-trusted-epoch-io 的
 * `entry.fiber.config.alwaysVisible[VOLATILE_WRITE]` 同一入口）。
 * 只写配置，不碰 runtime 状态，也没有任何测试钩子。
 * @returns {readonly string[]} 写入后的真实配置值
 */
function setCurrentAlwaysVisible (boot, names) {
  const entry = boot.loader.entries().find((item) => item.id === 'progressive-discovery')
  assert.ok(entry !== undefined, '前置：adapter entry 必须已登记')
  const field = entry.fiber?.config?.alwaysVisible
  assert.ok(field !== undefined && typeof field[VOLATILE_WRITE] === 'function',
    '前置：adapter 必须带 volatile 的 alwaysVisible Config（否则改不了「当前配置」这个量）')
  field[VOLATILE_WRITE]([...names])
  const current = field.get()
  assert.deepEqual([...current], [...names], `正控制：当前配置必须真的变成 ${JSON.stringify([...names])}`)
  return [...current]
}

/** 真实 storageDomain 里的全表快照（只用公开面）。 */
function readRecords (ctx) {
  const facility = ctx.get('storageDomain')
  assert.ok(facility !== undefined, '前置：真实 storageDomain 服务必须可达')
  const domain = facility.get(TRUSTED_EPOCH_DOMAIN)
  assert.ok(domain !== undefined, `前置：产品必须已打开可信域 ${TRUSTED_EPOCH_DOMAIN}`)
  const table = domain.table(TRUSTED_EPOCH_TABLE)
  return [...table.entries()].map(([key, value]) => ({ key, ...value }))
}

async function userTurn (handle, text) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }))
  return handle.agent.whenIdle()
}

// ---------------------------------------------------------------------------
// TS1：pending 结算门禁
// ---------------------------------------------------------------------------
test('TS1: 迁移写 PENDING 期间收尾不得提前终态，释放最新 manual 写后 ready/trusted 且 epoch 与 journal 一致', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  // ===================== 段一：真实父会话历史 ==============================
  const boot1 = await bootAdapterComposition({
    fixtures: FIXTURES,
    adapter: { alwaysVisible: [HIDDEN] },
    extraServices: COMPACTION_SERVICES,
  })
  cleanup.push(() => boot1.dispose())
  serviceClosers.push(() => boot1.closeServices())
  assert.deepEqual(boot1.activationErrors(), [], '段一 composition 必须收敛')

  const parent = await boot1.ctx.agents.create({
    sessionId: PARENT,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: boot1.tmpRoot }
  })
  queueResponse({ text: `Parent first answer ${'detail '.repeat(40)}` })
  await userTurn(parent, 'Explain the earlier context in detail.')
  queueResponse({ text: `Parent second answer ${'detail '.repeat(40)}` })
  await userTurn(parent, 'And continue with the follow-up details.')
  assert.equal(store.requests.length >= 2, true,
    `前置：父会话必须真的出过站（否则子会话继承不到任何 surface）；实际 ${store.requests.length}`)
  assert.equal(parent.agent.session.seq > 4, true, '前置：父会话必须留下多条真实 durable 事件')

  // 父句柄必须在真关闭**之前**释放（先 await 句柄，再关 entry fiber）。
  await parent.dispose()

  // **真关闭**段一的全部服务（保留 tmpRoot）：段二因此不是并发开同一物理介质，
  // 子会话读到的父历史来自**落盘**的 durable 流，而不是同一进程内的活对象。
  const facility1 = boot1.ctx.get('storageDomain')
  assert.equal(facility1.get(TRUSTED_EPOCH_DOMAIN) !== undefined, true,
    '前置：段一必须已打开可信域（否则「真关闭」无法断言）')
  await boot1.closeServices()
  assert.equal(facility1.get(TRUSTED_EPOCH_DOMAIN) === undefined, true,
    '真关闭后：可信域句柄必须已释放')

  // ===================== 段二：写屏障 + 迟到 adapter ======================
  store.reset()
  const boot2 = await bootAdapterComposition({
    fixtures: FIXTURES,
    extraServices: COMPACTION_SERVICES,
    tmpRoot: boot1.tmpRoot,
  })
  cleanup.push(() => boot2.dispose())
  serviceClosers.push(() => boot2.closeServices())
  assert.deepEqual(boot2.activationErrors(), [], '段二 composition 必须收敛')
  assert.equal(boot2.ctx.get('progressiveDiscovery'), undefined,
    '前置：段二起初不装配 adapter（写屏障必须早于产品的第一次 ensureOpen）')

  const barrier = installTrustedEpochWriteBarrier(boot2.ctx)
  // 注册**释放动作**，不是屏障对象：`after` 里统一调用 `release()`，注册对象会在 TS1
  // 变红时抛 TypeError 并被 `catch` 吞掉 → 屏障不被释放，真实 put 永远停在半路，收尾
  // 退化成另一种失败，把一次红掩盖掉。这里注册 `() => barrier.releaseAll()`，语义与
  // TS2 的注册一致（TS2 注册的本来就是释放闭包）。
  barriers.push(() => barrier.releaseAll())
  cleanup.push(() => barrier.restore())
  await mountAdapterLate(boot2, { alwaysVisible: INITIAL_NAMES }, { adapterSchema: true })
  const svc = boot2.ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, '前置：产品 adapter 必须已激活')

  // 真实种子继承：own 段为空的子会话（因此基线走引导路径，收尾在途）。
  const persisted = await boot2.ctx.sessionQuery.readSession(PARENT)
  assert.ok(Array.isArray(persisted.events) && persisted.events.length > 4,
    '前置：段二必须能从 durable 流读回父会话的真实历史')
  const child = await boot2.ctx.agents.create({
    sessionId: CHILD,
    seed: persisted.events,
    inheritedEventCount: persisted.events.length,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: boot2.tmpRoot, isSeeded: true },
  })
  agentDisposals.push(() => child.dispose())
  assert.equal(child.agent.session.inheritedEventCount, persisted.events.length,
    '前置：子会话必须带非空继承前缀（own 段为空）')
  assert.ok(boot2.ctx.tools.get(HIDDEN, child.agent) !== undefined,
    `前置：目标工具必须在本 agent scope 内解析得到（不得退化成宿主解析失败）；${HIDDEN}`)
  assert.ok(boot2.ctx.tools.get(MUTATING, child.agent) !== undefined,
    `前置：边界名单里的工具同样必须在本 agent scope 内解析得到；${MUTATING}`)

  const runtime = svc.lifecycle.ensureRuntime(child.agent.session, child.agent)
  assert.ok(runtime !== undefined, '前置：真实 runtime 必须建立')

  // 屏障拦下第一条写：引导路径的**初始**记录。
  const initialTicket = await until(() => barrier.held.find((t) => !t.released), '被屏障拦下的初始记录写')
  assert.equal(initialTicket.value.sessionId, CHILD, '前置：初始记录必须记在子会话自己名下')
  assert.equal(initialTicket.value.trigger, 'initial', '前置：第一条写必须是 initial 触发')
  assert.deepEqual(initialTicket.value.names, INITIAL_NAMES,
    `前置：初始记录取的是挂载时的配置；实际 ${JSON.stringify(initialTicket.value.names)}`)
  await until(() => runtime.restoring === true && runtime.ledger.state === 'pending',
    '引导收尾在途且基线 pending')
  assert.equal(store.requests.filter((r) => r.purpose !== 'compaction').length, 0,
    '前置：基线落定前不得发出任何对话出站请求')

  // 真实改当前配置（B）：**在压缩边界之前**。迁移记录必须捕获边界那一刻的这份。
  setCurrentAlwaysVisible(boot2, BOUNDARY_NAMES)

  // 真实用户 `/compact`：迁移写由产品自己发起（journal 边界 + command/done 成功链）。
  queueResponse({ text: 'Summary of the inherited context for the compaction.' })
  const compacted = await boot2.ctx.commands.execute(child.agent, '/compact', [], new AbortController().signal)
  assert.equal(compacted?.result?.kind, 'success',
    `前置：真实手动 /compact 必须成功，否则不构成一次真实迁移；实际 ${JSON.stringify(compacted?.result)}`)

  // ---- TS1p：强前置 —— 两条 held 写，第二条就是最新 manual 迁移写 ----
  await until(() => barrier.held.filter((t) => !t.released).length >= 2, '第二条被拦下的写')
  const [, manualTicket] = barrier.held
  assert.equal(manualTicket.value.sessionId, CHILD, '前置：迁移写必须记在子会话自己名下')
  assert.equal(manualTicket.value.trigger, 'manual',
    `前置：第二条写必须来自真实用户 /compact 的迁移（trigger=manual）；实际 ${String(manualTicket.value.trigger)}`)
  assert.deepEqual(manualTicket.value.names, BOUNDARY_NAMES,
    `前置：迁移写捕获的必须是压缩边界那一刻的常驻名单 ${JSON.stringify(BOUNDARY_NAMES)}；`
    + `实际 ${JSON.stringify(manualTicket.value.names)}`)
  assert.equal(JSON.stringify(manualTicket.value.names) !== JSON.stringify(INITIAL_NAMES), true,
    '前置：边界名单必须与初始记录那份不同（否则名单断言没有辨别力）')
  assert.equal(manualTicket.value.ownSeqStart, persisted.events.length,
    `前置：迁移记录的 ownSeqStart 必须等于继承边界；实际 ${manualTicket.value.ownSeqStart}`)

  const childEvents = (await boot2.ctx.sessionQuery.readSession(CHILD)).events
  const compactionEnd = childEvents.find(
    (event) => event.type === 'compaction/end' && event.data?.error === undefined)
  assert.ok(compactionEnd !== undefined, '前置：durable 流里必须有一条无 error 的 compaction/end')
  const summary = childEvents.find((event) => event.type === 'compaction/summary'
    && event.data?.compactionId === compactionEnd.data.compactionId)
  assert.ok(summary !== undefined, '前置：必须有一条 compaction/summary 与该 end 同属一次压缩')
  const manualEpochId = `${compactionEnd.data.compactionId}@${compactionEnd.seq}`
  assert.equal(manualTicket.value.epochId, manualEpochId,
    `前置：迁移写的 epoch 必须是本次真实压缩边界；期望 ${manualEpochId}，实际 ${manualTicket.value.epochId}`)
  assert.equal(manualTicket.value.compactionEndSeq, compactionEnd.seq,
    '前置：迁移记录的 compactionEndSeq 必须等于 durable compaction/end 的 seq')
  // 账本确实被**更新的一次写**推进过：load → begin → adopt 三次 revision。
  assert.equal(runtime.ledger.revision >= 3, true,
    `前置：引导写必须已被 adopt supersede（revision 至少三次）；实际 ${runtime.ledger.revision}`)

  // ---- 放行**被 supersede 的那条**初始写，让收尾真正走到裁决点 ----
  barrier.releaseNext()
  assert.equal(initialTicket.released, true, '前置：被 supersede 的初始写必须先放行')
  await until(() => runtime.ledger.revision >= 3 && runtime.ledger.inFlight === true,
    '收尾抵达裁决点且最新 manual 写仍在途')

  // ---- 真实 pending 用户轮：窗口内必须有**真的**一次对话在等基线 ----
  // 这一轮在 `/compact` 成功、manual 写被按住之后发起：压缩已经完成（不再需要 agent
  // 空闲），而 pre-step 屏障（index.mjs 的 `agent/pre-step` → `awaitEpochRecord`）必须
  // 因为基线未落定而**不放行**。没有这一轮，「窗口内 0 条对话出站」就只是
  // 「本轮根本没驱动过对话」，证明不了投影/pre-step 真的挡住了什么。
  // pending 用户轮一旦被放行就会真的向 provider 发一次请求：先排队，否则它会以
  // "mock provider: no scripted response queued" 失败，把 TS1e 的正控变成假失败。
  queueResponse({ text: 'Child answer sent right after the migration settled.' })
  let pendingTurnFailed = null
  const pendingTurn = userTurn(child, 'Answer while the epoch record is still pending.')
    .catch((error) => { pendingTurnFailed = String(error?.message ?? error) })
  // 真实 `whenReady` 的 promise：窗口内观察它**未落定**，释放后再 await 同一条 promise。
  let readySettled = null
  const readyProbe = svc.lifecycle.whenReady(CHILD).then((value) => {
    readySettled = value ?? null
    return readySettled
  })
  // 前置：这一轮真的启动了（离开 idle）。若它在窗口内就回到 idle，说明 pre-step 屏障
  // 把它放行、请求已经发出——那本身就是本门禁要否定的行为，等同于判据失败。
  await until(() => child.agent.status !== 'idle',
    'pending 用户轮进入运行态（若它没能停住，说明 pre-step 屏障提前放行了）', 5000)
  // 给收尾与 pre-step 屏障一次确定的机会在窗口内落一个（错误的）终态/放行。
  await new Promise((resolve) => setTimeout(resolve, 400))

  // ---- TS1a：窗口内不得提前终态 ----
  assert.equal(runtime.ledger.state, 'pending',
    `迁移写仍在途时基线必须仍是 pending（提前 block 就是 F3 复发）；实际 ${runtime.ledger.state}/${runtime.ledger.reason}`)
  assert.equal(runtime.ledger.reason, null,
    `pending 不许带归因；实际 ${String(runtime.ledger.reason)}`)
  assert.equal(runtime.restoring, true,
    '收尾未落定前 restoring 必须仍为 true（提前归 false 会让投影把这一轮当已就绪）')
  assert.equal(readySettled, null,
    `真实 whenReady 的 promise 在窗口内不得落定；实际落定为 ${JSON.stringify(readySettled)}`)
  assert.equal(pendingTurnFailed, null,
    `pending 用户轮在窗口内不得以失败告终；实际 ${String(pendingTurnFailed)}`)
  assert.notEqual(child.agent.status, 'idle',
    `pending 用户轮在窗口内必须仍卡在 pre-step 屏障（不得已经 idle = 请求已发出）；实际 status=${child.agent.status}`)
  const baseline = svc.lifecycle.baselineOf(CHILD)
  assert.equal(baseline.state, 'pending', `公开观测面同样不得提前终态；实际 ${baseline.state}/${baseline.reason}`)
  assert.equal(baseline.epochId, manualEpochId,
    `前置/判据：账本身份必须已经推进到最新一次迁移的 epoch；实际 ${baseline.epochId}`)
  assert.equal(readRecords(boot2.ctx).some((r) => r.epochId === manualEpochId), false,
    '前置：窗口内那条迁移记录必须**尚未** durable（写确实还在途）')

  // ---- TS1b：窗口内不得授权 ----
  assert.deepEqual(runtime.alwaysNames, [], `窗口内常驻名单必须为空；实际 ${JSON.stringify(runtime.alwaysNames)}`)
  assert.equal(runtime.ledger.names, null, `窗口内名单快照必须仍是 null；实际 ${JSON.stringify(runtime.ledger.names)}`)
  const denied = await directExec(boot2.ctx, child.agent, HIDDEN, { text: 'mid-window' }, 'ts1-mid-exec')
  assert.equal(denied.isError, true,
    `基线未落定前直连执行必须被拒；实际文本：${denied.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('ts1-mid-exec'), 0, '基线未落定前 body 必须为 0')
  assert.match(denied.text, /STATE_NOT_READY|TRUSTED_EPOCH/,
    `拒绝必须来自本插件的稳定基线判据；实际文本：${denied.text.slice(0, 300)}`)

  // ---- TS1c：窗口内不得发对话出站请求（压缩摘要按 purpose 单独区分）----
  const conversation = store.requests.filter((request) => request.purpose !== 'compaction')
  assert.equal(conversation.length, 0,
    `窗口内不得发出任何对话出站请求（pending 用户轮必须被 pre-step 挡住）；实际 ${JSON.stringify(conversation.map(namesOf))}`)
  assert.equal(store.requests.filter((request) => request.purpose === 'compaction').length, 1,
    '前置：窗口内只允许那一次压缩摘要请求（证明断言不是「provider 从未被调用」）')

  // 迁移写仍被按住期间，把**当前配置**改成第三份（C）。终态权威必须仍是边界那份（B）：
  // 既不能退回初始记录那份（A），也不能被后来的当前配置（C）改写。
  setCurrentAlwaysVisible(boot2, LATE_NAMES)

  // ---- 释放**最新 manual 写** ----
  barrier.releaseAll()
  assert.equal(manualTicket.released, true, '最新 manual 写必须被放行')
  const settled = await readyProbe
  assert.equal(settled.mode, 'ready', `释放后必须落 ready；实际 ${JSON.stringify(settled)}`)

  // ---- TS1d：落定后的权威事实 ----
  assert.equal(runtime.restoring, false, '落定后 restoring 必须归 false')
  assert.equal(runtime.ledger.state, 'trusted', `落定后基线必须 trusted；实际 ${runtime.ledger.state}/${runtime.ledger.reason}`)
  assert.equal(runtime.ledger.reason, null, 'trusted 不许带归因')
  assert.deepEqual(runtime.ledger.names, BOUNDARY_NAMES,
    `名单必须等于压缩边界捕获的那份 ${JSON.stringify(BOUNDARY_NAMES)}；实际 ${JSON.stringify(runtime.ledger.names)}`)
  assert.deepEqual([...runtime.alwaysNames], BOUNDARY_NAMES,
    `runtime 上的常驻名单必须同步换上去；实际 ${JSON.stringify(runtime.alwaysNames)}`)
  assert.equal(JSON.stringify(runtime.alwaysNames) === JSON.stringify(INITIAL_NAMES), false,
    '终态不得退回初始记录那份名单（那说明迁移写被忽略/被 supersede 掉了）')
  assert.equal(JSON.stringify(runtime.alwaysNames) === JSON.stringify(LATE_NAMES), false,
    '终态不得被边界之后改成的当前配置改写（配置只影响下一个周期）')
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'ready',
    `落定后引擎必须 ready；实际 ${runtime.engine.getState(runtime.scope).mode}`)

  assert.deepEqual(runtime.ledger.identity, { epochId: manualEpochId, compactionEndSeq: compactionEnd.seq },
    `账本身份必须就是那条迁移记录的 epoch；实际 ${JSON.stringify(runtime.ledger.identity)}`)
  assert.deepEqual(runtime.journal.currentEpoch(), runtime.ledger.identity,
    `epoch 与 journal 报告的当前周期必须一致；journal=${JSON.stringify(runtime.journal.currentEpoch())}`)
  assert.equal(runtime.ledger.identity.compactionEndSeq >= persisted.events.length, true,
    'epoch 边界必须落在子会话自己的 own 段上')

  const settledRecord = readRecords(boot2.ctx).find((record) => record.epochId === manualEpochId)
  assert.ok(settledRecord !== undefined,
    '释放后 durable 表里必须真的有那条 manual 记录（否则「落定」只是内存状态）')
  assert.equal(settledRecord.sessionId, CHILD, 'durable 记录必须记在子会话自己名下')
  assert.equal(settledRecord.trigger, 'manual', 'durable 记录必须保留 manual 触发')
  assert.deepEqual(settledRecord.names, BOUNDARY_NAMES,
    `durable 名单必须与账本一致；实际 ${JSON.stringify(settledRecord.names)}`)
  assert.equal(settledRecord.ownSeqStart, persisted.events.length, 'durable 记录的 ownSeqStart 必须是继承边界')
  assert.equal(settledRecord.key, manualTicket.key, 'durable 记录的键必须就是那条被拦下的迁移写的键')

  // ---- TS1e：反空过控制 —— 窗口里那条 pending 用户轮必须真的补发出站并 idle ----
  // 这不是新的一轮：就是 TS1c 里被挡下的那一条。它必须**恰好**补发一次对话请求。
  await pendingTurn
  assert.equal(pendingTurnFailed, null,
    `释放后那条 pending 用户轮必须正常完成；实际失败原因 ${String(pendingTurnFailed)}`)
  assert.equal(child.agent.status, 'idle',
    `释放后那条用户轮必须真的 idle（不得仍卡在屏障上）；实际 status=${child.agent.status}`)
  assert.equal(store.requests.filter((request) => request.purpose !== 'compaction').length, 1,
    `释放后必须恰好补发一条对话请求；实际 ${JSON.stringify(store.requests.filter((r) => r.purpose !== 'compaction').map(namesOf))}`)
  const outbound = store.requests.find((request) => request.purpose !== 'compaction')
  assert.equal(namesOf(outbound).includes(MUTATING), true,
    `补发出的请求必须带上边界授权的那个工具；实际 ${namesOf(outbound).join(', ')}`)
  assert.equal(namesOf(outbound).includes(HIDDEN), false,
    `初始名单里的工具不得随迁移复活；实际 ${namesOf(outbound).join(', ')}`)
  const admitted = await directExec(boot2.ctx, child.agent, MUTATING, { text: 'after-settle' }, 'ts1-post-exec')
  assert.equal(admitted.isError, false,
    `落定后直连执行必须放行；实际文本：${admitted.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('ts1-post-exec'), 1, '落定后 body 必须执行 1 次（不是「空放行」）')

  const stale = await directExec(boot2.ctx, child.agent, HIDDEN, { text: 'after-settle-stale' }, 'ts1-post-stale')
  assert.equal(stale.isError, true,
    `初始名单里的工具在本 epoch 不得仍被授权；实际文本：${stale.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('ts1-post-stale'), 0, '未被授权的工具 body 必须为 0')

  barrier.releaseAll()
})

// ===========================================================================
// TS2：**legacy（有 own 出站历史、无可信记录）冷恢复**的 pending 结算
//
// 与 TS1 的差别（必须分清，否则会拿 TS1 的变异结果冒充 TS2 的覆盖）：
//   TS1 走 `resolveBootstrapBaseline` 的第二裁决点（`begin()` 之后）；
//   TS2 走 `settleRestoreBaseline` 里「有 own 出站历史」那条 **legacy 恢复收尾入口**，
//        被 supersede 的是**冷恢复那一次 `ledger.load()`**（返回 PENDING/null），
//        而不是 `begin()`。私有回退这一入口 → **TS2 必红、TS1 保持绿**（已实测）。
//
// 接线（全部真实，无 createLifecycle/store fake，也**不是** query fake）：
//   * 段一在**不装配 adapter** 的 composition 里跑出真实 own 出站历史（legacy 的来源
//     不是「注入故障」，而是「插件根本还没挂上」），随后 `closeServices()` 真关闭；
//   * 段二同 root 重开，迟到挂载产品 adapter，并装 **SDK 屏障**：
//       ① **共用 opening 闸门**：**先等待测试闸门、后调用真实 `facility.open()`** —— 闸门
//          在真实 open **调用之前**，此刻域**尚未打开**（不是"已打开、只按住返回"）。
//          产品侧仍复用**同一个** opening promise：adapter 在 apply 期 fire-and-forget 的
//          `ensureOpen()` 与随后 `ledger.load()`、adopt 写 await 的是**同一次** open 调用，
//          于是冷恢复的读 await 窗口被撑开到足以让一次真实 `/compact` 抵达。这不是 query
//          包装，也不改 SDK 语义。
//       ② **写屏障**：真实域**打开之后**，`table().put` 逐条按测试指定顺序放行。
//   * 迁移写由产品 `onUserCompactionComplete → ledger.adopt` 真实发起；
//     压缩边界与 command/done 链全部由真实 compactNow + 真实 commands 产生。
//
// **TS2 的全部注入面只有三处**，三处都在测试侧、都不改产品语义：
//   ① **共用 opening 闸门**（在真实 `open` 调用**之前**）、② **put 写屏障**（真实域打开之后）、
//      ③ **`ledger.load` 的只观察旁路订阅**（test instrumentation：调用原函数、返回同一个
//      原始 promise 对象，仅旁路记录 state/reason，不改值不抛断言，finally 逐字装回）。
//   它不是 fake store / fake ledger，但它确实是 instrumentation —— 因此本门禁
//   **只**证明「在这三道注入之下 SDK 与结算契约成立」，**不**声称真实宿主会自然产生
//   这条窗口；观察到的微任务时序也不作为自然宿主证据。
//
// 判据：
//   TS2p 强前置 —— 旧 load **确实**返回了 PENDING/null（观察包装只转发不改语义）；
//        durable 表里本会话**一条记录都没有**（真 legacy）；own 出站历史为真。
//   TS2a 窗口内不得提前终态：pending / reason=null / restoring=true / whenReady 未落定。
//   TS2b 窗口内不得授权：常驻名单空、名单快照 null、直连执行被 STATE_NOT_READY 拒。
//   TS2c 窗口内不得发**对话**出站请求——由真实 pending 用户轮驱动（它必须仍卡在
//        pre-step 屏障、status 非 idle、未失败）。
//   TS2d 放行 manual put 后：ready / trusted / 名单 = 压缩边界那份（既非初始配置那份，
//        也非边界之后改成的当前配置）/ epoch 与 journal 当前 identity、SDK 记录一致。
//   TS2e 反空过控制：窗口里那条同一条用户轮在放行后恰好补发一次出站并 idle。
// ===========================================================================

const TS2_SESSION = 'ts2-legacy'
const TS2_INITIAL_NAMES = [HIDDEN]
const TS2_BOUNDARY_NAMES = [MUTATING]
const TS2_LATE_NAMES = []

/**
 * SDK 屏障（TS2 专用）：**共用 opening 闸门** + 逐条 put 写屏障。
 *
 * 装在真实 storageDomain 服务的 `open` 上。**闸门在调用真实 open 之前**：先等测试放行，
 * 再逐字调用真实 `open`，其后的面逐字转发。因此只 hold 两处：
 *   * `open()` **调用本身**（此刻域**尚未打开**，不是「SDK 已打开、只按住返回」）—— 让
 *     adapter 在 apply 期 fire-and-forget 的 `ensureOpen()` 与随后 `ledger.load()` /
 *     adopt 写 await 的**同一次** open 停在半路；
 *   * `table().put`（真实域打开**之后**）—— 让迁移写的落盘停在半路。
 *
 * 必须**早于**迟到挂载 adapter：apply 期就会第一次 ensureOpen，晚装就拦不到。
 */
function installTrustedEpochSdkBarrier (ctx) {
  const facility = ctx.get('storageDomain')
  assert.ok(facility !== undefined, '前置：真实 storageDomain 服务必须可达（否则屏障无处可装）')
  assert.equal(typeof facility.open, 'function', '前置：真实 facility 必须有官方 open 接口')
  const realOpen = facility.open
  const held = []
  const openWaiters = []
  let openingReleased = false

  facility.open = async function (spec, ...rest) {
    if (openingReleased === false) {
      await new Promise((resolve) => { openWaiters.push(resolve) })
    }
    const opened = await realOpen.call(this, spec, ...rest)
    const realTable = opened.table.bind(opened)
    const proxied = Object.create(opened)
    proxied.table = (name) => {
      const table = realTable(name)
      const realPut = table.put.bind(table)
      return new Proxy(table, {
        get (target, prop, receiver) {
          if (prop !== 'put') return Reflect.get(target, prop, receiver)
          return async (key, value, ...more) => {
            const ticket = { key, value, released: false, resolve: null }
            held.push(ticket)
            await new Promise((resolve) => { ticket.resolve = resolve })
            return realPut(key, value, ...more)
          }
        },
      })
    }
    return proxied
  }

  return {
    held,
    /** 放行那一次**共用** opening（此后新 open 不再被拦）。 */
    releaseOpening () {
      openingReleased = true
      for (const resolve of openWaiters.splice(0)) resolve()
    },
    releaseAllPuts () {
      for (const ticket of held) {
        if (ticket.released) continue
        ticket.released = true
        ticket.resolve()
      }
    },
    restore () { facility.open = realOpen },
  }
}

/**
 * **只观察、不改语义**地旁路订阅 `ledger.load()` 的返回值（test instrumentation）。
 *
 * 纪律（逐条都必须成立，否则它就不再是「观察」而是「改造」）：
 *   * 调用**原函数**并把它的 **同一个原始 promise 对象**原样返回 —— 绝不 async/await
 *     包装（那会凭空多出一个 await 窗口，改变被观察对象本身的时序）；
 *   * 只用 `.then` **旁路**订阅记录 `{state, reason}`：不改值、不抛断言、不吞错；
 *   * finally / after 里逐字装回原 `load`，不跨用例泄漏。
 * 它不是 fake store、也不是 fake ledger，但**它确实是 test instrumentation**，
 * 与 opening/写屏障一起构成 TS2 的全部注入面；它观测到的微任务时序**不**作为
 * 「自然宿主可达」的证据。
 * @returns {{verdicts:{state:string|null, reason:string|null}[], restore:()=>void}}
 */
function observeLedgerLoadVerdicts (ledger) {
  const realLoad = ledger.load
  const verdicts = []
  assert.equal(typeof realLoad, 'function', '前置：真实 ledger 必须有官方 load 接口')
  ledger.load = function (...args) {
    const pending = realLoad.apply(this, args)
    pending.then(
      (verdict) => { verdicts.push({ state: verdict?.state ?? null, reason: verdict?.reason ?? null }) },
      () => { /* 真实 load 永不 reject；这里只是不吞也不造断言 */ },
    )
    return pending
  }
  return { verdicts, restore () { ledger.load = realLoad } }
}

test('TS2: legacy 冷恢复的 load 被迁移写 supersede 后不得提前终态，放行 manual put 后 ready/trusted 且与 journal、SDK 记录一致', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()

  // ===================== 段一：adapter 不存在的真实历史 ====================
  const boot1 = await bootAdapterComposition({
    fixtures: FIXTURES,
    extraServices: COMPACTION_SERVICES,
  })
  cleanup.push(() => boot1.dispose())
  serviceClosers.push(() => boot1.closeServices())
  assert.deepEqual(boot1.activationErrors(), [], '段一 composition 必须收敛')

  const legacy = await boot1.ctx.agents.create({
    sessionId: TS2_SESSION,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: boot1.tmpRoot },
  })
  queueResponse({ text: `Legacy first answer ${'detail '.repeat(40)}` })
  await userTurn(legacy, 'Build some real history before the adapter exists.')
  queueResponse({ text: `Legacy second answer ${'detail '.repeat(40)}` })
  await userTurn(legacy, 'And continue with the follow-up details.')
  assert.equal(store.requests.length >= 2, true,
    `前置：段一必须真的出过站（否则不是 legacy，只是一个空会话）；实际 ${store.requests.length}`)
  assert.equal(boot1.ctx.get('progressiveDiscovery'), undefined,
    '前置：段一根本没有 adapter（legacy 靠真实历史构造，不是靠注入故障）')
  assert.equal(legacy.agent.session.seq > 4, true, '前置：段一必须留下多条真实 durable 事件')
  await legacy.dispose()
  await boot1.closeServices()

  // ===================== 段二：同 root 重开 + SDK 屏障 + 迟到 adapter =========
  store.reset()
  const boot2 = await bootAdapterComposition({
    fixtures: FIXTURES,
    extraServices: COMPACTION_SERVICES,
    tmpRoot: boot1.tmpRoot,
  })
  cleanup.push(() => boot2.dispose())
  serviceClosers.push(() => boot2.closeServices())
  assert.deepEqual(boot2.activationErrors(), [], '段二 composition 必须收敛')
  assert.equal(boot2.ctx.get('progressiveDiscovery'), undefined,
    '前置：段二起初不装配 adapter（SDK 屏障必须早于它的第一次 ensureOpen）')

  const sdkBarrier = installTrustedEpochSdkBarrier(boot2.ctx)
  barriers.push(() => { sdkBarrier.releaseOpening(); sdkBarrier.releaseAllPuts() })
  cleanup.push(() => sdkBarrier.restore())
  await mountAdapterLate(boot2, { alwaysVisible: TS2_INITIAL_NAMES }, { adapterSchema: true })
  const svc = boot2.ctx.get('progressiveDiscovery')
  assert.ok(svc !== undefined, '前置：产品 adapter 必须已激活')
  assert.equal(sdkBarrier.held.length, 0,
    '前置：adapter 的 fire-and-forget ensureOpen 此刻仍停在 opening 上（没有任何 put 发生）')

  const resumed = await boot2.ctx.agents.resume({
    resumeSessionId: TS2_SESSION,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
  })
  agentDisposals.push(() => resumed.dispose())
  const runtime = svc.lifecycle.ensureRuntime(resumed.agent.session, resumed.agent)
  assert.ok(runtime !== undefined, '前置：真实 runtime 必须建立')
  const observed = observeLedgerLoadVerdicts(runtime.ledger)
  cleanup.push(() => observed.restore())

  await until(() => runtime.restoring === true && runtime.ledger.state === 'pending',
    'legacy 冷恢复收尾在途且基线 pending（load 停在共用 opening 上）')

  // 真实用户 `/compact`：迁移写会推进 revision，把这一次 load 变成 superseded。
  setCurrentAlwaysVisible(boot2, TS2_BOUNDARY_NAMES)
  queueResponse({ text: 'Summary of the legacy context for the compaction.' })
  const compacted = await boot2.ctx.commands.execute(resumed.agent, '/compact', [], new AbortController().signal)
  assert.equal(compacted?.result?.kind, 'success',
    `前置：真实手动 /compact 必须成功，否则不构成一次真实迁移；实际 ${JSON.stringify(compacted?.result)}`)

  // ---- 放行 opening：manual put 仍然关闭 ----
  sdkBarrier.releaseOpening()
  const manualTicket = await until(() => sdkBarrier.held.find((ticket) => !ticket.released),
    '迁移写停在 put 屏障上')
  assert.equal(manualTicket.value.sessionId, TS2_SESSION, '前置：迁移写必须记在该会话自己名下')
  assert.equal(manualTicket.value.trigger, 'manual',
    `前置：这条写必须来自真实用户 /compact；实际 ${String(manualTicket.value.trigger)}`)
  assert.deepEqual(manualTicket.value.names, TS2_BOUNDARY_NAMES,
    `前置：迁移写捕获的必须是压缩边界那一刻的名单；实际 ${JSON.stringify(manualTicket.value.names)}`)

  const legacyEvents = (await boot2.ctx.sessionQuery.readSession(TS2_SESSION)).events
  // ---- 真实用户 `/compact` 的五条触发事件与 sourceEventSeq 匹配 ----
  // `trigger:'manual'` **不是**独立的迁移来源判据（onEpochBoundary 在用户发起时也写
  // manual），所以迁移来源必须由这条命令链本身钉死：compact 必须是**用户**发起、
  // 成功、且 done.sourceEventSeq 匹配 **compaction/summary 的 seq**（不是 end 的 seq）。
  const compactionStart = legacyEvents.find((event) => event.type === 'compaction/start')
  assert.ok(compactionStart !== undefined, '前置：durable 流里必须记录 compaction/start')
  const summaries = legacyEvents.filter((event) => event.type === 'compaction/summary'
    && event.data?.compactionId === compactionStart.data.compactionId)
  assert.equal(summaries.length, 1,
    `成功压缩必须恰好一条 compaction/summary，实际 ${summaries.length}`)
  const compactionEnd = legacyEvents.find(
    (event) => event.type === 'compaction/end'
      && event.data?.compactionId === compactionStart.data.compactionId && event.data?.error === undefined)
  assert.ok(compactionEnd !== undefined, '前置：必须记录一条无 error 的 compaction/end')
  const commandRun = legacyEvents.find((event) => event.type === 'command/run'
    && event.data?.name === 'compact' && event.data?.source?.kind === 'user')
  assert.ok(commandRun !== undefined, '前置：迁移只认用户发起的 /compact（command/run.source.kind=user）')
  const commandDone = legacyEvents.find((event) => event.type === 'command/done'
    && event.data?.commandId === commandRun.data.commandId && event.data?.kind === 'success')
  assert.ok(commandDone !== undefined, '前置：必须有 command/done success')
  assert.equal(commandDone.data.sourceEventSeq, summaries[0].seq,
    `command/done.success 的 sourceEventSeq 必须匹配 compaction/summary 的 seq（${summaries[0].seq}）`)
  assert.notEqual(commandDone.data.sourceEventSeq, compactionEnd.seq,
    'command/done.success 的 sourceEventSeq 不得匹配 compaction/end 的 seq')
  const manualEpochId = `${compactionEnd.data.compactionId}@${compactionEnd.seq}`
  assert.equal(manualTicket.value.epochId, manualEpochId,
    `前置：迁移写的 epoch 必须是本次真实压缩边界；期望 ${manualEpochId}，实际 ${manualTicket.value.epochId}`)
  assert.equal(manualTicket.value.compactionEndSeq, compactionEnd.seq,
    '前置：迁移记录的 compactionEndSeq 必须等于 durable compaction/end 的 seq')

  // ---- 真实 pending 用户轮（窗口内必须有真的对话在等基线）----
  queueResponse({ text: 'Legacy turn sent right after the settlement.' })
  let readySettled = null
  const readyProbe = svc.lifecycle.whenReady(TS2_SESSION).then((value) => {
    readySettled = value ?? null
    return readySettled
  })
  let pendingTurnFailed = null
  const pendingTurn = userTurn(resumed, 'Answer while the epoch record is still pending.')
    .catch((error) => { pendingTurnFailed = String(error?.message ?? error) })
  await until(() => resumed.agent.status !== 'idle',
    'pending 用户轮进入运行态（若它没能停住，说明 pre-step 屏障提前放行了）', 5000)
  await new Promise((resolve) => setTimeout(resolve, 400))

  // ---- TS2p：强前置 —— 旧 load 已返回 PENDING/null，且本会话真 legacy ----
  assert.ok(observed.verdicts.length >= 1,
    '前置：必须观察到冷恢复那一次 load 的真实返回值（否则 TS2p 无从取证）')
  const lastVerdict = observed.verdicts[observed.verdicts.length - 1]
  assert.equal(lastVerdict.state, 'pending',
    `前置：被 adopt supersede 的那次 load 必须返回 pending；实际 ${JSON.stringify(lastVerdict)}`)
  assert.equal(lastVerdict.reason, null,
    `前置：那次 load 不得带归因（reason=null 表示"又来了一次正在成功的写"，不是失败）；`
    + `实际 ${JSON.stringify(lastVerdict)}`)
  assert.equal(runtime.journal.hasOwnOutboundHistory(), true,
    '前置：该会话 own 段确有真实出站事实（因此走 legacy 恢复收尾入口）')
  // 记录一律按**完整键**（sessionId + ownSeqStart + epochId + compactionEndSeq）限定，
  // 绝不按 epochId 单字段找（那会在同 root 表里混进别的会话/epoch 而空过）。
  const ownBoundary = runtime.ledger.ownSeqStart
  const legacyKey = JSON.stringify([TS2_SESSION, ownBoundary, manualEpochId, compactionEnd.seq])
  assert.deepEqual(readRecords(boot2.ctx).filter((record) => record.sessionId === TS2_SESSION), [],
    '前置：窗口内本会话在 SDK 表里必须一条记录都没有（真 legacy：缺记录，不是坏记录）')
  assert.equal(readRecords(boot2.ctx).some((record) => record.key === legacyKey), false,
    `前置：那条迁移记录此刻必须尚未 durable（完整键 ${legacyKey}）`)

  // ---- TS2a：窗口内不得提前终态 ----
  assert.equal(runtime.ledger.state, 'pending',
    `迁移写仍在途时基线必须仍是 pending；实际 ${runtime.ledger.state}/${runtime.ledger.reason}`)
  assert.equal(runtime.ledger.reason, null, `pending 不许带归因；实际 ${String(runtime.ledger.reason)}`)
  assert.equal(runtime.restoring, true,
    '收尾未落定前 restoring 必须仍为 true（提前归 false 会让投影把这一轮当已就绪）')
  assert.equal(readySettled, null,
    `真实 whenReady 的 promise 在窗口内不得落定；实际落定为 ${JSON.stringify(readySettled)}`)
  // 产品路径取证：公开观测面上，账本身份已被那次真实 adopt 推进到压缩边界 epoch，
  // 但状态仍是 pending —— 即「迁移写确实由产品发起，且此刻仍未落定」。
  const windowBaseline = svc.lifecycle.baselineOf(TS2_SESSION)
  assert.equal(windowBaseline.epochId, manualEpochId,
    `产品路径 capture：账本身份必须已推进到本次压缩边界；实际 ${windowBaseline.epochId}`)
  assert.equal(windowBaseline.state, 'pending',
    `产品路径 capture：推进身份的同时状态必须仍是 pending；实际 ${windowBaseline.state}/${windowBaseline.reason}`)
  assert.equal(pendingTurnFailed, null,
    `pending 用户轮在窗口内不得以失败告终；实际 ${String(pendingTurnFailed)}`)
  assert.notEqual(resumed.agent.status, 'idle',
    `pending 用户轮在窗口内必须仍卡在 pre-step 屏障；实际 status=${resumed.agent.status}`)

  // ---- TS2b：窗口内不得授权 ----
  assert.deepEqual(runtime.alwaysNames, [], `窗口内常驻名单必须为空；实际 ${JSON.stringify(runtime.alwaysNames)}`)
  assert.equal(runtime.ledger.names, null, `窗口内名单快照必须仍是 null；实际 ${JSON.stringify(runtime.ledger.names)}`)
  const denied = await directExec(boot2.ctx, resumed.agent, HIDDEN, { text: 'ts2-mid-window' }, 'ts2-mid-exec')
  assert.equal(denied.isError, true,
    `基线未落定前直连执行必须被拒；实际文本：${denied.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('ts2-mid-exec'), 0, '基线未落定前 body 必须为 0')
  assert.match(denied.text, /STATE_NOT_READY|TRUSTED_EPOCH/,
    `拒绝必须来自本插件的稳定基线判据；实际文本：${denied.text.slice(0, 300)}`)

  // ---- TS2c：窗口内不得发对话出站请求 ----
  const conversation = store.requests.filter((request) => request.purpose !== 'compaction')
  assert.equal(conversation.length, 0,
    `窗口内不得发出任何对话出站请求（pending 用户轮必须被 pre-step 挡住）；实际 ${JSON.stringify(conversation.map(namesOf))}`)
  assert.equal(store.requests.filter((request) => request.purpose === 'compaction').length, 1,
    '前置：窗口内只允许那一次压缩摘要请求（证明断言不是「provider 从未被调用」）')

  // 迁移写仍被按住期间把当前配置改成第三份，终态权威必须仍是边界那份。
  setCurrentAlwaysVisible(boot2, TS2_LATE_NAMES)

  // ---- 放行 manual put ----
  sdkBarrier.releaseAllPuts()
  assert.equal(manualTicket.released, true, '迁移写必须被放行')
  const settled = await readyProbe
  assert.equal(settled.mode, 'ready', `释放后必须落 ready；实际 ${JSON.stringify(settled)}`)

  // ---- TS2d：落定后的权威事实 ----
  assert.equal(runtime.restoring, false, '落定后 restoring 必须归 false')
  assert.equal(runtime.ledger.state, 'trusted',
    `落定后基线必须 trusted；实际 ${runtime.ledger.state}/${runtime.ledger.reason}`)
  assert.equal(runtime.ledger.reason, null, 'trusted 不许带归因')
  assert.deepEqual(runtime.ledger.names, TS2_BOUNDARY_NAMES,
    `名单必须等于压缩边界捕获的那份；实际 ${JSON.stringify(runtime.ledger.names)}`)
  assert.deepEqual([...runtime.alwaysNames], TS2_BOUNDARY_NAMES,
    `runtime 常驻名单必须同步换上去；实际 ${JSON.stringify(runtime.alwaysNames)}`)
  assert.equal(JSON.stringify(runtime.alwaysNames) === JSON.stringify(TS2_INITIAL_NAMES), false,
    '终态不得退回初始配置那份名单')
  assert.equal(JSON.stringify(runtime.alwaysNames) === JSON.stringify(TS2_LATE_NAMES), false,
    '终态不得被边界之后改成的当前配置改写（配置只影响下一个周期）')
  assert.deepEqual(runtime.ledger.identity, { epochId: manualEpochId, compactionEndSeq: compactionEnd.seq },
    `账本身份必须就是那条迁移记录的 epoch；实际 ${JSON.stringify(runtime.ledger.identity)}`)
  assert.deepEqual(runtime.journal.currentEpoch(), runtime.ledger.identity,
    `epoch 与 journal 当前 identity 必须一致；journal=${JSON.stringify(runtime.journal.currentEpoch())}`)

  const settledRecord = readRecords(boot2.ctx).find((record) => record.key === legacyKey)
  assert.ok(settledRecord !== undefined,
    `释放后 SDK 表里必须真的有那条 manual 记录（完整键 ${legacyKey}），否则「落定」只是内存状态`)
  assert.equal(settledRecord.sessionId, TS2_SESSION, 'SDK 记录必须记在该会话自己名下')
  assert.equal(settledRecord.ownSeqStart, ownBoundary, 'SDK 记录的 ownSeqStart 必须等于账本的 own 边界')
  assert.equal(settledRecord.epochId, manualEpochId, 'SDK 记录的 epochId 必须是本次压缩边界')
  assert.equal(settledRecord.compactionEndSeq, compactionEnd.seq, 'SDK 记录的 compactionEndSeq 必须等于 compaction/end 的 seq')
  assert.equal(settledRecord.trigger, 'manual', 'SDK 记录必须保留 manual 触发')
  assert.deepEqual(settledRecord.names, TS2_BOUNDARY_NAMES,
    `SDK 名单必须与账本一致；实际 ${JSON.stringify(settledRecord.names)}`)
  assert.equal(settledRecord.ownSeqStart, 0, '非 fork 会话的 ownSeqStart 必须是 0')
  assert.equal(settledRecord.key, manualTicket.key, 'SDK 记录的键必须就是那条被拦下的迁移写的键')

  // ---- TS2e：反空过控制 —— 窗口里那条同一条用户轮在放行后补发出站并 idle ----
  await pendingTurn
  assert.equal(pendingTurnFailed, null,
    `释放后那条 pending 用户轮必须正常完成；实际失败原因 ${String(pendingTurnFailed)}`)
  assert.equal(resumed.agent.status, 'idle',
    `释放后那条用户轮必须真的 idle；实际 status=${resumed.agent.status}`)
  assert.equal(store.requests.filter((request) => request.purpose !== 'compaction').length, 1,
    `释放后必须恰好补发一条对话请求；实际 ${store.requests.filter((r) => r.purpose !== 'compaction').length} 条`)
  const outbound = store.requests.find((request) => request.purpose !== 'compaction')
  assert.equal(namesOf(outbound).includes(MUTATING), true,
    `补发出的请求必须带上边界授权的那个工具；实际 ${namesOf(outbound).join(', ')}`)
  assert.equal(namesOf(outbound).includes(HIDDEN), false,
    `初始名单里的工具不得随迁移复活；实际 ${namesOf(outbound).join(', ')}`)
  const admitted = await directExec(boot2.ctx, resumed.agent, MUTATING, { text: 'ts2-after' }, 'ts2-post-exec')
  assert.equal(admitted.isError, false,
    `落定后直连执行必须放行；实际文本：${admitted.text.slice(0, 300)}`)
  assert.equal(store.bodyCount('ts2-post-exec'), 1, '落定后 body 必须执行 1 次（不是「空放行」）')

  observed.restore()
  sdkBarrier.releaseAllPuts()
})
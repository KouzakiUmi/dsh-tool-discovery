// 复审边界门禁：两条**独立于既有套件**的反例，钉死本轮两处最小修复。
//
//   RB0  前置：真实 load 之后该工具确实在出站里（没有它，下面几条都是空转）。
//   RB1  冷恢复**未完成**时，`system-prompt/assemble` 必须挂起等公开的
//        `lifecycle.whenReady(sessionId)`，而不是发出一份缩水的 tools 请求。
//        断言方式：人为把**真实** `sessionQuery.readSession` 挂起（IO 时机受控，
//        业务 result 仍是真实读盘的结果），挂起期间**一条请求都不许发出去**；
//        释放后第一条请求必须包含崩溃前成功加载的工具。
//   RB1b 第二次冷恢复同理（证明这不是"第一次恰好通过"）。
//   RB2  `readSession` 失败 → 既有 fail closed 不得因为"多了一次 await"变成放行：
//        请求仍要发出，但**不得**携带此前加载的工具，引擎必须停在 incompatible，
//        猜名调用 body=0。
//   RB3  P6：真实 assemble 的 `incoming` 数组里出现同名重复定义（第二个
//        systemPrompt tool provider 注入）时必须报 INCOMPATIBLE_COMPOSITION；
//        配一条"只有一份定义"的正控制，证明拒绝确实由重复触发。
//
// 运行：node --test plugin/tests/composition/gate-review-boundaries.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { makeTmpRoot } from '../../contracts/harness.mjs'
import { bootAdapterComposition } from './harness.mjs'

const handles = []
const cleanup = []
const LOADED = 'fixture_hidden_inherited'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']

after(() => {
  for (const handle of handles.reverse()) {
    try { handle.dispose() } catch { /* 已释放 */ }
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

/** 真实 agent-loop 的装配上下文形状（dsh-agent assembleContextFor）。 */
function assembleContextFor (agent) {
  return { agent, scope: agent }
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

async function waitUntil (probe, timeoutMs, what) {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * 把**真实** `sessionQuery.readSession` 挂起：只推迟 await 的完成时机，
 * 放行后返回的仍是宿主自己读出来的真实结果（不是伪造的业务结果）。
 */
function deferReadSession (query) {
  const real = query.readSession.bind(query)
  const state = { entered: false, released: false, waiters: [] }
  query.readSession = async (sessionId, ...rest) => {
    state.entered = true
    if (!state.released) await new Promise((resolve) => state.waiters.push(resolve))
    return real(sessionId, ...rest)
  }
  return {
    state,
    release () {
      state.released = true
      for (const waiter of state.waiters.splice(0)) waiter()
    }
  }
}

/** 让目标会话的真实读盘失败（故障注入，只包一层 reject）。 */
function failReadSession (query, sessionId, reason) {
  const real = query.readSession.bind(query)
  const state = { calls: 0 }
  query.readSession = async (requested, ...rest) => {
    state.calls += 1
    if (requested === sessionId) throw new Error(reason)
    return real(requested, ...rest)
  }
  return state
}

// ---------------------------------------------------------------------------
// RB0：前置 —— 真实 load 之后该工具确实在出站里
// ---------------------------------------------------------------------------
const RB0 = { tmpRoot: null, sessionId: 'rb-restore-1' }

test('RB0: 真实 load 之后此前加载的工具确实在出站请求里', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {} })
  cleanup.push(() => boot.dispose())
  RB0.tmpRoot = boot.tmpRoot

  queueResponse({ toolCalls: [{ id: 'rb-load', name: 'tool_load', arguments: { names: [LOADED] } }] })
  queueResponse({ text: 'loaded' })
  const handle = await drive(boot.ctx, boot.tmpRoot, RB0.sessionId)
  await userTurn(handle, 'Load the hidden tool.')

  assert.ok(lastNames(store).includes(LOADED),
    `前置：崩溃前该工具必须已披露，否则后面全是空转：${lastNames(store).join(', ')}`)
  const runtime = runtimeOf(boot.ctx, RB0.sessionId)
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'ready')
  await handle.dispose()
})

/**
 * 复制一份已持久化的会话根，让下一次冷恢复读**同一份历史**但持有独立的写租约。
 * 宿主的会话写入租约是内核文件锁（dsh-session-persistence-jsonl SessionWriteLease），
 * 同一目录被两个活跃 composition 打开会直接 SessionAlreadyOwnedError —— 那是宿主
 * 的正确行为，本文件因此对每条冷恢复链路各持一份根，而不是在同一个根上叠三次恢复。
 */
function cloneTmpRoot (label) {
  const target = makeTmpRoot(label)
  fs.cpSync(RB0.tmpRoot, target, { recursive: true })
  return target
}

// ---------------------------------------------------------------------------
// RB1 / RB1b：冷恢复未完成前挂起，而不是发出缩水的 tools 请求
// ---------------------------------------------------------------------------
/**
 * 一次完整的"挂起读盘 → 观察挂起 → 释放 → 断言首请求"流程。
 * @param {{ctx:any, tmpRoot:string, sessionId:string, store:any, queueResponse:Function, label:string}} spec
 */
async function coldRestoreMustWait (spec) {
  const { ctx, tmpRoot, sessionId, store, queueResponse, label } = spec
  const defer = deferReadSession(ctx.sessionQuery)
  store.reset()

  const handle = await resumeDrive(ctx, sessionId)
  queueResponse({ text: `${label} done` })

  const before = store.requests.length
  const turn = userTurn(handle, 'Continue after restart.')
  await waitUntil(() => defer.state.entered, 10000, `${label}: readSession 进入 await`)

  const runtime = runtimeOf(ctx, sessionId)
  assert.equal(runtime.restoring, true, `${label}: 观察点必须落在恢复未完成的窗口内`)
  assert.notEqual(runtime.engine.getState(runtime.scope).mode, 'ready',
    `${label}: 恢复未完成不得被当成 ready`)

  // 关键判据：挂起期间**一条请求都没有发出去**。
  // 旧行为会在这里发出一份只剩三入口的缩水请求。
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(store.requests.length, before,
    `${label}: 恢复未完成前必须挂起，不得发出缩水的 tools 请求；实际发出：${JSON.stringify(store.requests.slice(before).map(namesOf))}`)

  defer.release()
  await turn

  const after = lastNames(store)
  assert.ok(after.includes(LOADED),
    `${label}: 释放后第一条请求必须包含崩溃前成功加载的工具：${after.join(', ')}`)
  assert.equal(after.filter((name) => name === LOADED).length, 1,
    `${label}: 同一工具不得重复出现`)
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'ready')
  assert.equal(runtime.restoring, false)
  await handle.dispose()
}

test('RB1: 冷恢复未完成前 assemble 挂起；释放后首请求带齐此前加载的工具', async () => {
  const { store, queueResponse } = await storeOf()
  const root = cloneTmpRoot('rb-restore-1a')
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {}, tmpRoot: root })
  cleanup.push(() => boot.dispose())
  await coldRestoreMustWait({
    ctx: boot.ctx, tmpRoot: root, sessionId: RB0.sessionId, store, queueResponse, label: 'RB1'
  })
})

test('RB1b: 同一份历史的第二次冷恢复同样挂起并带齐工具（不是偶然通过）', async () => {
  const { store, queueResponse } = await storeOf()
  const root = cloneTmpRoot('rb-restore-1b')
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {}, tmpRoot: root })
  cleanup.push(() => boot.dispose())
  await coldRestoreMustWait({
    ctx: boot.ctx, tmpRoot: root, sessionId: RB0.sessionId, store, queueResponse, label: 'RB1b'
  })
})

// ---------------------------------------------------------------------------
// RB4：pending 超过原 5 秒仍然 0 请求（证明没有任何"等够久就发缩水"的兜底）
//
// 计时口径：`performance.now()`（单调钟）+ **循环复查**，不用"一次 setTimeout(剩余)
// 就假定到位"。上一版用 `Date.now()` 差值做零容差 `>= mark` 比较，只取一次样本，
// 在 `--test-isolation=none`（全量共用一个事件循环）下于 RB4 的 1000ms 刻度失败。
// 本版不缩短刻度（1s/3s/6s），业务断言（pending / 0 请求 / 释放后首请求带齐）不变。
// ---------------------------------------------------------------------------

/** 单调钟等到真正到达 mark 为止：分段小睡 + 复查，不假定一次定时器就到位。 */
async function waitUntilMonotonic (start, mark) {
  for (;;) {
    const elapsed = performance.now() - start;
    if (elapsed >= mark) return elapsed;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(1, Math.ceil(mark - elapsed)), 25)));
  }
}

test('RB4: 恢复 pending 持续 6 秒以上仍然 0 请求；释放后才发出带齐工具的首请求', async () => {
  const { store, queueResponse } = await storeOf()
  const root = cloneTmpRoot('rb-restore-1d')
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {}, tmpRoot: root })
  cleanup.push(() => boot.dispose())
  const query = boot.ctx.sessionQuery
  const originalReadSession = query.readSession
  const defer = deferReadSession(query)
  store.reset()

  const handle = await resumeDrive(boot.ctx, RB0.sessionId)
  queueResponse({ text: 'RB4 done' })
  const before = store.requests.length
  const turn = userTurn(handle, 'Continue after restart.')
  try {
    await waitUntil(() => defer.state.entered, 10000, 'RB4: readSession 进入 await')
    const runtime = runtimeOf(boot.ctx, RB0.sessionId)
    assert.equal(runtime.restoring, true, 'RB4 前置：观察点必须落在 pending 窗口内')

    // 真实单调钟走满 6 秒：期间反复确认"一条请求都没发"。
    // 业务结果未被伪造 —— 只是把真实读盘的 await 完成时刻推后。
    const startedAt = performance.now();
    for (const mark of [1000, 3000, 6000]) {
      const elapsed = await waitUntilMonotonic(startedAt, mark);
      assert.ok(elapsed >= mark, `RB4: 单调钟未走到 ${mark}ms（实际 ${elapsed.toFixed(3)}ms）`);
      assert.equal(runtime.restoring, true, `RB4: ${mark}ms 时仍在 pending`);
      assert.equal(store.requests.length, before,
        `RB4: ${mark}ms 时仍不得发出任何请求；实际：${JSON.stringify(store.requests.slice(before).map(namesOf))}`);
    }

    defer.release();
    await turn;
    const after = lastNames(store);
    assert.ok(after.includes(LOADED),
      `RB4: 释放后首请求必须带齐此前加载的工具：${after.join(', ')}`);
    assert.equal(runtime.engine.getState(runtime.scope).mode, 'ready');
  } finally {
    // 任何断言失败都要收尾，且不得掩盖上面的原始断言：
    // 放行挂起的真实读盘（幂等）、把真实 readSession 装回去、把 pending 的 turn 收完。
    defer.release();
    query.readSession = originalReadSession;
    try { await turn } catch { /* 清理失败不掩盖原始断言 */ }
    try { await handle.dispose() } catch { /* 已释放 */ }
  }
})

// ---------------------------------------------------------------------------
// RB2：读盘失败时，await 不得把既有 fail closed 变成放行
// ---------------------------------------------------------------------------
test('RB2: readSession 失败 → 仍 fail closed：请求照发但不携带已加载工具，引擎停 incompatible', async () => {
  const { store, queueResponse } = await storeOf()
  const root = cloneTmpRoot('rb-restore-1c')
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {}, tmpRoot: root })
  cleanup.push(() => boot.dispose())
  const failures = failReadSession(boot.ctx.sessionQuery, RB0.sessionId, 'rb2 read disk failure')
  store.reset()

  const handle = await resumeDrive(boot.ctx, RB0.sessionId)
  queueResponse({ text: 'RB2 turn' })
  await userTurn(handle, 'Continue after restart.')
  assert.ok(failures.calls > 0, '前置：目标会话的读盘必须真的被调用过')

  const runtime = runtimeOf(boot.ctx, RB0.sessionId)
  assert.equal(runtime.engine.getState(runtime.scope).mode, 'incompatible',
    '读盘失败必须停在 incompatible（await 不得把它变成 ready）')
  // 「已决失败」必须与「仍在 pending」可区分：runtime 已落定（restoring 归 false），
  // 而不是伪装成还在恢复。
  assert.equal(runtime.restoring, false,
    '已决失败后 runtime 必须落定，不得继续被当作 pending')
  assert.equal((await boot.ctx.get('progressiveDiscovery').lifecycle.whenReady(RB0.sessionId)).mode,
    'incompatible', 'whenReady 必须报告已决的 incompatible，而不是 restoring')
  assert.ok(store.requests.length > 0, 'fail closed 下请求仍然要发出去（不能挂死）')
  assert.ok(!lastNames(store).includes(LOADED),
    `fail closed 时不得携带此前加载的工具：${lastNames(store).join(', ')}`)

  // 执行面同样不放行
  queueResponse({ toolCalls: [{ id: 'rb2-guess', name: LOADED, arguments: { text: 'x' } }] })
  queueResponse({ text: 'RB2 done' })
  await userTurn(handle, 'Try the hidden tool again.')
  assert.equal(store.bodyCount('rb2-guess'), 0, 'fail closed 后该工具 body 不得执行')
  assert.ok(!lastNames(store).includes(LOADED), 'fail closed 后也不得披露')
  await handle.dispose()
})

// ---------------------------------------------------------------------------
// RB3：incoming 里的同名重复定义必须被拒（基线段与已加载段同等）
// ---------------------------------------------------------------------------
test('RB3: 真实 assemble 的 incoming 出现同名重复定义 → INCOMPATIBLE_COMPOSITION（正控制：单份定义通过）', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: {} })
  cleanup.push(() => boot.dispose())
  const sessionId = 'rb-duplicate-1'

  queueResponse({ toolCalls: [{ id: 'rb3-load', name: 'tool_load', arguments: { names: [LOADED] } }] })
  queueResponse({ text: 'loaded' })
  const handle = await drive(boot.ctx, boot.tmpRoot, sessionId)
  await userTurn(handle, 'Load the hidden tool.')
  assert.ok(lastNames(store).includes(LOADED), '前置：该工具必须已加载并披露')

  const agent = handle.agent

  // 正控制：只有一份定义时，真实 assemble 正常通过且该工具恰好出现一次
  const ok = await boot.ctx.systemPrompt.assemble(assembleContextFor(agent))
  const okNames = namesOf(ok)
  assert.equal(okNames.filter((name) => name === LOADED).length, 1,
    `正控制：单份定义下该工具恰好一次：${okNames.join(', ')}`)

  // 第二个 systemPrompt tool provider 注入同名、异义定义 → incoming 出现重复
  const disposeDuplicate = boot.ctx.systemPrompt.tools(() => ({
    schemas: [{
      name: LOADED,
      description: 'DUPLICATE definition injected by a second tool provider.',
      parameters: { text: { type: 'string', description: 'Duplicate payload.' } }
    }]
  }))
  try {
    await assert.rejects(
      () => boot.ctx.systemPrompt.assemble(assembleContextFor(agent)),
      (error) => {
        const text = String(error?.message ?? error)
        assert.match(text, /INCOMPATIBLE_COMPOSITION|duplicate/i,
          `必须报 INCOMPATIBLE_COMPOSITION，实际：${text}`)
        return true
      },
      '同名重复定义必须被拒绝，不得静默取最后一个'
    )
  } finally {
    disposeDuplicate()
  }

  // 反证：撤掉重复来源后必须恢复通过（证明拒绝确实由重复触发）
  const after = await boot.ctx.systemPrompt.assemble(assembleContextFor(agent))
  assert.equal(namesOf(after).filter((name) => name === LOADED).length, 1,
    '撤掉重复 provider 后必须恢复通过')
  await handle.dispose()
})
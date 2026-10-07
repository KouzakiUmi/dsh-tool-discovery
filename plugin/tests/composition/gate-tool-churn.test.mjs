// 工具**减少**面的缓存一致性门禁（TC）。
//
// 为什么单独一份：既有的 registry-churn fixture 只会**增加**工具（S03xL05 覆盖 ref 失效），
// unit/registry.test.mjs 的 R5 只覆盖**代次**在移除→重加时不复用。整条「真实移除一个
// 已经 selected 的工具」的运行时链路 —— selected / advertised / frozen / 执行面 / 旧 ref ——
// 此前**没有任何组合门禁**。而生产上确实发生过减少（见 .probe/unload-diagnosis-handoff.md
// 的实测 header 28 → 26），它是真实形态，不是构造出来的边角。
//
// 本门禁钉的语义（全部来自代码既有设计，不是新发明）：
//   移除  → 该工具的 selected 作废（reason: tool-removed）、advertised 清除、
//           执行面按未加载处理（body=0）、按名 load 不再命中；
//           **frozen 披露缓存不清**（设计如此：已披露的 wire 定义在 epoch 内继续披露，
//           由 guard 另行拒绝执行）；
//   重加  → 拿到**新绑定代次**，旧选择**不得**复活，必须重新 load；
//   无关工具不被误伤（正控制）。
//
// 运行：node --test plugin/tests/composition/gate-tool-churn.test.mjs
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule, fixtureFileUrl } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition, LOCAL } from './harness.mjs'

const REMOVABLE = 'fixture_removable'
/** 永不消失的对照工具：证明本门禁不是靠「一律失效/一律拒绝」换来的。 */
const STABLE = 'fixture_hidden_inherited'
const FIXTURES = ['mock-provider', 'inherited-tools', 'scope-tools']
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
    meta: { cwd: tmpRoot },
  })
  handles.push(handle)
  return handle
}

async function userTurn (handle, text) {
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
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

async function rawEvents (ctx, sessionId) {
  return (await ctx.sessionQuery.readSession(sessionId)).events ?? []
}

function toolCallSeq (events, callId) {
  return events.find((event) => event.type === 'tool/call' && event.data?.callId === callId)?.seq
}

/**
 * 按 callId 定位 durable 的 tool/result。
 *
 * **禁止**「找不到就退回最后一条 result」：那会把别的工具（比如 fixture_removable 自己
 * 的执行回执）当成断言对象，让 JSON.parse 报出一个与本判据无关的 SyntaxError。
 * 定位不到就是硬失败。
 */
function toolResultFor (events, callId) {
  const callSeq = toolCallSeq(events, callId)
  assert.notEqual(callSeq, undefined, `durable tool/call for ${callId}`)
  const result = events.find((event) => event.type === 'tool/result'
    && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(callSeq))
  assert.notEqual(result, undefined, `durable tool/result for ${callId}`)
  return result
}

function resultTextOf (resultEvent) {
  const blocks = resultEvent?.data?.message?.content ?? []
  return blocks.map((b) => b?.text ?? '').join('')
}

/** 真实移除：dispose 该 entry 的 fiber，让它注册的工具从宿主 view() 里消失。 */
async function removeEntry (boot, id) {
  const entry = boot.loader.entries().find((item) => item.id === id)
  assert.ok(entry !== undefined, `fixture entry ${id} 必须已装配`)
  await entry.fiber.dispose()
  await boot.loader.await()
}

/** 真实重加：同一个 id 再装一次（拿到新的绑定代次）。 */
async function addEntry (boot, id) {
  await boot.loader.create({ id, name: fixtureFileUrl(LOCAL['removable-tool']), config: {} })
  await boot.loader.await()
}

// ---------------------------------------------------------------------------
// TC1：移除一个已 selected 的工具 —— 执行被拒、旧 ref 失效、无关工具不受影响
// ---------------------------------------------------------------------------
test('TC1: 真实移除已 selected 的工具 → 执行 body=0、旧 ref 失效、无关工具不受影响', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())

  await addEntry(boot, 'fx-removable')
  const sessionId = 'tc1-removal'
  queueResponse({ toolCalls: [{ id: 'tc1-search', name: 'tool_search', arguments: { category: 'all', query: 'removable fixture tool' } }] })
  queueResponse({ toolCalls: [{ id: 'tc1-load', name: 'tool_load', arguments: { names: [REMOVABLE] } }] })
  queueResponse({ toolCalls: [{ id: 'tc1-use', name: REMOVABLE, arguments: { text: 'before removal' } }] })
  queueResponse({ text: 'TC1 phase one' })
  const handle = await drive(boot.ctx, boot.tmpRoot, sessionId)
  await userTurn(handle, 'Search, load and call the removable tool.')

  // ---- 前置：移除之前它必须真的可用、真的被选中、真的披露过 ----
  assert.equal(store.bodyCount('tc1-use'), 1,
    `前置：移除前该工具必须能真正执行 body 一次；实际 ${store.bodyCount('tc1-use')}`)
  let runtime = runtimeOf(boot.ctx, sessionId)
  assert.equal(runtime.engine.getState(runtime.scope).selected.size, 1,
    '前置：移除前它必须处于 selected')
  assert.equal(lastNames(store).includes(REMOVABLE), true,
    `前置：移除前它必须已被披露；实际 ${lastNames(store).join(', ')}`)

  const before = await rawEvents(boot.ctx, sessionId)
  const searchShell = JSON.parse(resultTextOf(toolResultFor(before, 'tc1-search')))
  const hit = searchShell.data.candidates.find((c) => c.name === REMOVABLE)
  assert.ok(hit?.ref && hit?.revision, '前置：必须拿到一条真实候选 ref')

  // ---- 真实移除 ----
  await removeEntry(boot, 'fx-removable')

  queueResponse({ toolCalls: [{ id: 'tc1-stale-ref', name: 'tool_load', arguments: { candidates: [{ ref: hit.ref, revision: hit.revision }] } }] })
  queueResponse({ toolCalls: [{ id: 'tc1-guess', name: REMOVABLE, arguments: { text: 'after removal' } }] })
  queueResponse({ text: 'TC1 phase two' })
  await userTurn(handle, 'Now call the tool that is gone.')

  runtime = runtimeOf(boot.ctx, sessionId)
  const state = runtime.engine.getState(runtime.scope)
  assert.equal(state.selected.size, 0, '移除后该工具不得仍留在 selected')
  assert.equal(state.invalidated.has('global::fixture_removable'), true,
    '移除必须在 invalidated 里留痕')
  assert.equal(store.bodyCount('tc1-guess'), 0,
    '移除后按名猜调用必须 body=0（它已不在宿主工具表里）')

  const after = await rawEvents(boot.ctx, sessionId)
  const staleShell = JSON.parse(resultTextOf(toolResultFor(after, 'tc1-stale-ref')))
  assert.equal(staleShell.ok, false, '移除前的旧 ref 必须失效')
  assert.equal(staleShell.error.code, 'CANDIDATE_UNAVAILABLE')

  // ---- 正控制：无关工具完全不受影响 ----
  queueResponse({ toolCalls: [{ id: 'tc1-stable-load', name: 'tool_load', arguments: { names: [STABLE] } }] })
  queueResponse({ toolCalls: [{ id: 'tc1-stable-use', name: STABLE, arguments: { text: 'still fine' } }] })
  queueResponse({ text: 'TC1 phase three' })
  await userTurn(handle, 'Load and call an unrelated tool.')
  assert.equal(JSON.parse(resultTextOf(toolResultFor(await rawEvents(boot.ctx, sessionId), 'tc1-stable-load'))).ok, true,
    '正控：无关工具的 load 必须照常成功')
  assert.equal(store.bodyCount('tc1-stable-use'), 1,
    '正控：无关工具必须照常执行（证明上面的拒绝不是「一律拒绝」）')
})

// ---------------------------------------------------------------------------
// TC2：移除 → 重加 —— 旧选择不得复活，必须重新 load
// ---------------------------------------------------------------------------
test('TC2: 移除后重加的工具不得凭旧选择复活，必须重新 load 才能执行', async () => {
  const { store, queueResponse } = await storeOf()
  store.reset()
  const boot = await bootAdapterComposition({ fixtures: FIXTURES, adapter: ADAPTER_CONFIG })
  cleanup.push(() => boot.dispose())

  await addEntry(boot, 'fx-removable')
  const sessionId = 'tc2-readd'
  queueResponse({ toolCalls: [{ id: 'tc2-load', name: 'tool_load', arguments: { names: [REMOVABLE] } }] })
  queueResponse({ toolCalls: [{ id: 'tc2-use-before', name: REMOVABLE, arguments: { text: 'first' } }] })
  queueResponse({ text: 'TC2 phase one' })
  const handle = await drive(boot.ctx, boot.tmpRoot, sessionId)
  await userTurn(handle, 'Load and call the removable tool.')
  assert.equal(store.bodyCount('tc2-use-before'), 1, '前置：移除前必须真的执行过')

  await removeEntry(boot, 'fx-removable')
  // 重加：同一个工具回来了
  await addEntry(boot, 'fx-removable')

  // 关键断言：**不加 load** 直接调用 —— 旧选择绝不能复活
  queueResponse({ toolCalls: [{ id: 'tc2-guess', name: REMOVABLE, arguments: { text: 'revived?' } }] })
  queueResponse({ text: 'TC2 phase two' })
  await userTurn(handle, 'Call the tool again without loading it.')
  assert.equal(store.bodyCount('tc2-guess'), 0,
    '移除→重加后旧选择不得复活：未经 load 直接调用必须 body=0')
  const runtime = runtimeOf(boot.ctx, sessionId)
  assert.equal(runtime.engine.getState(runtime.scope).selected.size, 0,
    '重加后 selected 仍应为空（必须重新 load）')

  // 正控：重新 load 之后它照常可用
  queueResponse({ toolCalls: [{ id: 'tc2-reload', name: 'tool_load', arguments: { names: [REMOVABLE] } }] })
  queueResponse({ toolCalls: [{ id: 'tc2-use-after', name: REMOVABLE, arguments: { text: 'second' } }] })
  queueResponse({ text: 'TC2 phase three' })
  await userTurn(handle, 'Load it again and call it.')
  assert.equal(JSON.parse(resultTextOf(toolResultFor(await rawEvents(boot.ctx, sessionId), 'tc2-reload'))).ok, true,
    '正控：重加后重新 load 必须成功')
  assert.equal(store.bodyCount('tc2-use-after'), 1,
    '正控：重新 load 后必须真的能执行（证明上面不是「永久拉黑」）')
})
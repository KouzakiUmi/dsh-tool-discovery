// 组合测试：真实 Cordis Loader + 安装内 0.2.1-alpha.1 服务 + mock provider
// + **产品 adapters/dsh**。
//
// 运行：node --test progressive-v2/tests/composition/gate-adapter.test.mjs
//
// 覆盖（03 §8 中 adapter 相关项）：
//   F01 首请求只有三个入口；S01 猜 inherited 工具名 body=0；
//   S02 猜 scope-own 工具名 body=0；S06 已加载工具仍被原审批链拒绝；
//   S08 同响应 load + 猜测调用被拒；L09 部分注册失败整组回滚；
//   入口名冲突（F20/S11）；外加返回值的 INCOMPATIBLE_COMPOSITION 组合拒绝。
//
// 断言纪律：每条安全断言都配**正控制**（真值必须成立一次），不做近恒真析取、
// 不做条件式空转。mock 录制面是最终 GenerateOptions，不是外部真实 provider wire。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition } from './harness.mjs'

const results = []
const cleanup = []
const handles = []
/** 各场景的 composition 句柄与录制结果。 */
const state = {}

function record (id, criterion, ok, detail) {
  results.push({ id, criterion, status: ok ? 'pass' : 'fail', detail: detail ?? null })
}

function gate (id, criterion, fn) {
  test(`${id}: ${criterion}`, async () => {
    try {
      await fn()
      record(id, criterion, true)
    } catch (error) {
      record(id, criterion, false, String(error?.stack ?? error))
      throw error
    }
  })
}

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

async function drive (ctx, tmpRoot, { sessionId, provider = 'fixture-mock', model = 'fixture-model' }) {
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider, model },
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
  return handle.agent.whenIdle()
}

// ---------------------------------------------------------------------------
// 场景 A：主链路（F01 / S01 / S02 / S06 / S08）
// ---------------------------------------------------------------------------

test('boot A: 真实 Loader composition（服务 + fixture + 产品 adapter）收敛', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools', 'approval-policy'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  state.A = boot
  const adapterEntry = boot.adapterEntryState()
  assert.notEqual(adapterEntry, null, 'adapter entry exists in the loader tree')
  assert.equal(adapterEntry?.fiber?.state, 2, `adapter fiber must be active, got ${adapterEntry?.fiber?.state}`)
  assert.deepEqual(boot.activationErrors(), [], 'no activation errors')
  for (const name of ['tool_list', 'tool_search', 'tool_load']) {
    assert.notEqual(boot.ctx.tools.get(name), undefined, `adapter registered ${name}`)
  }
})

test('drive A: load + 同响应猜测 → 未加载猜测 → 合法调用 → load 第二项 → 原审批拒绝 → 收尾', async () => {
  const boot = state.A
  const { store, queueResponse } = await storeOf()
  const { queueApproval } = await import(new URL('./fixtures/approval-policy.mjs', import.meta.url).href)
  store.reset()
  // 1) 同响应：load 一个 inherited 工具 + 猜它（S08）+ 猜从未加载的 scope-own 工具（S02）
  queueResponse({
    toolCalls: [
      { id: 'a-load-1', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } },
      { id: 'guess-inherited-1', name: 'fixture_hidden_inherited', arguments: { text: 'x' } },
      { id: 'guess-scope-1', name: 'fixture_hidden_scope', arguments: { text: 'y' } }
    ]
  })
  // 2) 猜一个**从未加载**的 inherited（global 注册）工具（S01）+ 一个 scope 里根本不存在的名字（F1 存在性）
  queueResponse({
    toolCalls: [
      { id: 'guess-global-1', name: 'fixture_mutating', arguments: { text: 'g' } },
      { id: 'guess-unknown-1', name: 'fixture_never_registered', arguments: { text: 'u' } },
      { id: 'legit-1', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } }
    ]
  })
  // 3) 加载第二个工具后再触发原审批链（S06）
  queueResponse({ toolCalls: [{ id: 'a-load-2', name: 'tool_load', arguments: { names: ['fixture_mutating'] } }] })
  queueApproval('rejected')
  queueResponse({ toolCalls: [{ id: 'approval-1', name: 'fixture_mutating', arguments: { text: 'w', triggerApproval: true } }] })
  queueResponse({ text: 'scenario A done' })

  const handle = await drive(boot.ctx, boot.tmpRoot, { sessionId: 'adapter-a-main-1' })
  await userTurn(handle, 'Run the adapter fixture task.')
  state.AHandle = handle
  state.AStore = store
  assert.equal(store.requests.length, 5, 'five final requests recorded by the mock provider')
})

gate('F01', '冷启动首请求只有三个控制入口，无任何普通工具名/描述/schema', async () => {
  const first = state.AStore.requests[0]
  const names = (first.tools ?? []).map((tool) => tool.name).sort()
  assert.deepEqual(names, ['tool_list', 'tool_load', 'tool_search'], `first request tools: ${names.join(', ')}`)
  for (const tool of first.tools ?? []) {
    assert.equal('execute' in tool, false, `${tool.name} must not expose execute`)
    assert.ok('parameters' in tool, `${tool.name} keeps parameters`)
    assert.ok('description' in tool, `${tool.name} keeps description`)
  }
  const raw = JSON.stringify(first)
  assert.equal(raw.includes('fixture_hidden_inherited'), false, 'no hidden tool name leaks into the first request')
  assert.equal(raw.includes('fixture_hidden_scope'), false, 'no scope-own tool name leaks into the first request')
  assert.equal(raw.includes('fixture_mutating'), false, 'no second hidden tool name leaks into the first request')
})

gate('S01', '猜从未加载的 inherited（global 注册）工具名：body 计数 0，拒绝发生在 body 前', async () => {
  assert.equal(state.AStore.bodyCount('guess-global-1'), 0, 'never-loaded inherited body must not run')
  const events = await rawEvents(state.A.ctx, 'adapter-a-main-1')
  const result = toolResultFor(events, 'guess-global-1')
  assert.equal(result.data.message.isError, true, 'guessed inherited call rejected')
  assert.match(resultTextOf(result), /TOOL_NOT_LOADED/, 'rejection cites TOOL_NOT_LOADED (guard, not UNKNOWN_TOOL)')
  assert.equal(/UNKNOWN_TOOL/.test(resultTextOf(result)), false, 'must not impersonate the host UNKNOWN_TOOL semantic')
})

gate('S02', '猜隐藏的 scope-own 工具名：同样 body=0，restrict 豁免不被绕过', async () => {
  assert.equal(state.AStore.bodyCount('guess-scope-1'), 0, 'scope-own hidden body must not run')
  const events = await rawEvents(state.A.ctx, 'adapter-a-main-1')
  const result = toolResultFor(events, 'guess-scope-1')
  assert.equal(result.data.message.isError, true, 'guessed scope-own call rejected')
  assert.match(resultTextOf(result), /TOOL_NOT_LOADED/, 'scope-own guess cites TOOL_NOT_LOADED')
  // F1：visibility（hidden / unknown-to-scope）之间对外文案必须逐字一致，且不泄漏诊断字段
  const strip = (text) => text.replace(/^Error:\s*/, '').replace(/^fixture_[a-z_]+:\s*/, '')
  const scopeText = strip(resultTextOf(result))
  const globalText = strip(resultTextOf(toolResultFor(events, 'guess-global-1')))
  const unknownText = strip(resultTextOf(toolResultFor(events, 'guess-unknown-1')))
  assert.equal(scopeText, globalText, `uniform reason required (scope-own vs global-hidden); got:\n${scopeText}\n${globalText}`)
  assert.equal(scopeText, unknownText, `调用面不区分存在性：registered 与 never-registered 文案必须一致；got:\n${scopeText}\n${unknownText}`)
  assert.equal(/hidden|unknown-to-scope|visibility/.test(scopeText), false, 'diagnostic visibility must not reach the model')
  assert.equal(state.AStore.bodyCount('guess-unknown-1'), 0, 'never-registered name body count is 0')
})

gate('S08', '同响应 load 成功后，同响应的猜测调用仍被拒（旧 request 未曝光）', async () => {
  const events = await rawEvents(state.A.ctx, 'adapter-a-main-1')
  const loadShell = JSON.parse(resultTextOf(toolResultFor(events, 'a-load-1')))
  assert.equal(loadShell.ok, true, 'the same-response load itself succeeded')
  assert.equal(loadShell.data.receipt.operationId, 'op_a-load-1', 'receipt binds to the canonical call')
  assert.deepEqual(
    loadShell.data.receipt.selected.map((item) => item.name),
    ['fixture_hidden_inherited'],
    'receipt covers exactly the requested names'
  )
  assert.equal(state.AStore.bodyCount('guess-inherited-1'), 0, 'same-response guess body must not run')
  const guess = toolResultFor(events, 'guess-inherited-1')
  assert.match(resultTextOf(guess), /TOOL_NOT_ADVERTISED/, 'loaded-but-not-advertised guess cites TOOL_NOT_ADVERTISED')
})

gate('F03pos', '正控制：load 生效后下一请求披露该工具、未加载的不披露、合法调用真的执行一次', async () => {
  const second = state.AStore.requests[1]
  const names = (second.tools ?? []).map((tool) => tool.name)
  assert.ok(names.includes('fixture_hidden_inherited'), `second request discloses the loaded tool: ${names.join(', ')}`)
  assert.equal(names.includes('fixture_hidden_scope'), false, 'still-hidden scope-own tool stays undisclosed')
  assert.equal(names.includes('fixture_mutating'), false, 'not-yet-loaded global tool stays undisclosed')
  assert.equal(state.AStore.bodyCount('legit-1'), 1, 'legit call of the loaded tool ran exactly once')
  // 第二个 load 之后，第三个工具才被披露（资格逐次生效）
  const fourth = state.AStore.requests[3]
  assert.ok((fourth.tools ?? []).map((tool) => tool.name).includes('fixture_mutating'),
    'the second load discloses the second tool')
})

gate('S06', '已加载工具仍被原审批链拒绝，body=0（adapter 不提供旁路授权）', async () => {
  assert.equal(state.AStore.bodyCount('approval-1'), 0, 'approval-rejected body must not run')
  const events = await rawEvents(state.A.ctx, 'adapter-a-main-1')
  const result = toolResultFor(events, 'approval-1')
  assert.equal(result.data.message.isError, true, 'approval denial rejected the call')
  assert.match(resultTextOf(result), /rejected/, 'host denial reason reaches the model')
  const asked = events.filter((event) => event.type === 'approval/asked')
  const decided = events.filter((event) => event.type === 'approval/decided')
  assert.equal(asked.length, 1, 'host ApprovalService wrote approval/asked')
  assert.equal(decided.length, 1, 'host ApprovalService wrote approval/decided')
  assert.equal(decided[0].data.outcome, 'rejected', 'outcome recorded as rejected')
})

// ---------------------------------------------------------------------------
// 场景 B：入口名冲突（F20 / S11）
// ---------------------------------------------------------------------------

test('boot B: 别的插件已占用 tool_search 时，adapter 必须拒绝组合', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools', 'conflict-entry'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  state.B = boot
})

gate('F20', '入口名冲突：拒绝启用，且不覆盖/不 shadow 既有定义', async () => {
  const boot = state.B
  const thirdParty = boot.ctx.tools.get('tool_search')
  assert.notEqual(thirdParty, undefined, 'the third-party definition is still registered')
  assert.match(String(thirdParty.description), /Third-party plugin/, 'the existing definition was not replaced')
  assert.equal(boot.ctx.tools.get('tool_list'), undefined, 'adapter must not register the other two entries either')
  assert.equal(boot.ctx.tools.get('tool_load'), undefined, 'adapter must not register the other two entries either')
  assert.equal(boot.ctx.get('progressiveDiscovery'), undefined, 'adapter never published its service')
  const errors = boot.activationErrors()
  assert.ok(errors.length > 0, 'activation failure is observable')
  assert.match(errors.join('\n'), /INCOMPATIBLE_COMPOSITION/, `conflict must be an incompatible composition: ${errors.join('\n')}`)
})

// ---------------------------------------------------------------------------
// 场景 C：部分注册失败整组回滚（L09）
// ---------------------------------------------------------------------------

test('boot C: 非法预算配置在注册之后失败 → 整组 disposer 回滚', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: { budgets: { maxActiveTools: 0 } }
  })
  cleanup.push(() => boot.dispose())
  state.C = boot
  const { store, queueResponse } = await storeOf()
  store.reset()
  queueResponse({ toolCalls: [{ id: 'c-orphan-1', name: 'fixture_hidden_inherited', arguments: { text: 'orphan' } }] })
  queueResponse({ text: 'C done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, { sessionId: 'adapter-c-rollback-1' })
  await userTurn(handle, 'Check the rollback.')
  state.CHandle = handle
  state.CStore = store
})

gate('L09', '注册中途失败：三个定义、投影、guard、监听全部回滚，不留孤儿', async () => {
  const boot = state.C
  const errors = boot.activationErrors()
  assert.ok(errors.length > 0, 'activation failure is observable')
  for (const name of ['tool_list', 'tool_search', 'tool_load']) {
    assert.equal(boot.ctx.tools.get(name), undefined, `${name} must be unregistered after rollback`)
  }
  // 正控制：guard 与投影都没留下 —— 隐藏工具既被披露也能执行
  const first = state.CStore.requests[0]
  const names = (first.tools ?? []).map((tool) => tool.name)
  assert.ok(names.includes('fixture_hidden_inherited'), `no orphan projection listener: ${names.join(', ')}`)
  assert.equal(state.CStore.bodyCount('c-orphan-1'), 1, 'no orphan guard: the hidden tool body ran exactly once')
})

// ---------------------------------------------------------------------------
// 场景 D：别的 listener 在我们投影之后重加全量 schema → 必须在 canonical
// request/header 上观察到并整会话 fail closed（03 §3.2 / COMP）
// ---------------------------------------------------------------------------

test('drive D: 另一个 listener 在 adapter 投影之后把全量目录加回去', async () => {
  const boot = await bootAdapterComposition({
    // adapter entry 最后装配 → 它的 assemble listener 在 waterfall 内层，
    // readd listener 更外层，会在拿到 adapter 最终投影后重新追加全量 schema。
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools', 'readd-catalog-listener'],
    adapter: {}
  })
  cleanup.push(() => boot.dispose())
  state.D = boot
  const { store, queueResponse } = await storeOf()
  store.reset()
  queueResponse({ toolCalls: [{ id: 'd-bypass-1', name: 'fixture_hidden_inherited', arguments: { text: 'bypass' } }] })
  queueResponse({ text: 'D done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, { sessionId: 'adapter-d-readd-1' })
  await userTurn(handle, 'Trigger the composition bypass.')
  state.DStore = store
})

gate('COMP', '他者重加全量 schema：不能只报"局部过滤成功"，必须 fail closed', async () => {
  const boot = state.D
  assert.deepEqual(boot.activationErrors(), [], 'the adapter itself activated fine — this is a composition conflict, not an activation failure')
  const first = state.DStore.requests[0]
  const names = (first.tools ?? []).map((tool) => tool.name)
  // 正控制：重加确实发生了（否则下面的 fail closed 断言没有意义）
  assert.ok(names.includes('fixture_hidden_inherited'),
    `fixture re-added the full catalog after the projection: ${names.join(', ')}`)
  assert.ok(names.includes('fixture_hidden_scope'), 'the re-added catalog includes the scope-own tool too')
  assert.equal(state.DStore.bodyCount('d-bypass-1'), 0, 'the leaked tool body must not run')
  const events = await rawEvents(boot.ctx, 'adapter-d-readd-1')
  const result = toolResultFor(events, 'd-bypass-1')
  assert.equal(result.data.message.isError, true, 'the leaked tool call is rejected')
  assert.match(resultTextOf(result), /INCOMPATIBLE_COMPOSITION/, 'rejection cites the incompatible composition')
})

// WL1 runs on its own boot rather than the shared sequence: the whitelist
// contract is about which names survive projection, and reusing the drive-A
// request log would make it depend on that scenario's load history.
test('WL1: alwaysVisible 白名单项免 load 常驻，名单外的后装工具仍被折叠', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: { alwaysVisible: ['fixture_hidden_inherited'] }
  })
  cleanup.push(() => boot.dispose())
  assert.deepEqual(boot.activationErrors(), [], 'no activation errors')

  const { store, queueResponse } = await storeOf()
  store.reset()
  queueResponse({ text: 'wl done' })
  const handle = await drive(boot.ctx, boot.tmpRoot, { sessionId: 'adapter-wl-1' })
  await userTurn(handle, 'Check the whitelist.')

  const names = (store.requests[0].tools ?? []).map((t) => t.name).sort()
  assert.ok(names.includes('fixture_hidden_inherited'),
    `whitelisted tool must be visible without load: ${names.join(', ')}`)
  for (const entry of ['tool_list', 'tool_search', 'tool_load']) {
    assert.ok(names.includes(entry), `${entry} stays visible`)
  }
  for (const collapsed of ['fixture_hidden_scope', 'fixture_mutating']) {
    assert.equal(names.includes(collapsed), false,
      `${collapsed} is later-installed and must stay collapsed`)
  }

  // 可见不等于可执行。guard 必须同样放行白名单项，否则 tool_load 成功后
  // 仍会以 INCOMPATIBLE_COMPOSITION 被拒——这正是白名单上线时漏掉的一处。
  queueResponse({ toolCalls: [{ id: 'wl-exec', name: 'fixture_hidden_inherited', arguments: { text: 'ok' } }] })
  queueResponse({ text: 'wl exec done' })
  await userTurn(handle, 'Call the whitelisted tool.')
  assert.equal(store.bodyCount('wl-exec'), 1,
    'whitelisted tool must actually execute, not merely appear in the request')

  // 白名单项必须同时计入 journal 的 allowed 集合。若漏计，白名单工具会被判成
  // "别的 listener 泄漏"，把整会话标为 compositionBypass，此后所有非白名单
  // 工具一律 INCOMPATIBLE_COMPOSITION —— 即"其它插件全部调用失败"。
  // 这里直接断言 bypass 未被置位，而不是间接观察拒绝文案。
  const runtime = boot.ctx.get('progressiveDiscovery').sessions.get('adapter-wl-1')
  assert.equal(runtime.compositionBypass, null,
    `whitelisted tool must not trigger compositionBypass: ${JSON.stringify(runtime.compositionBypass)}`)
})

// WL3: 白名单不得阻断后装工具的加载与执行（bypass 回归防护）。
test('WL3: 白名单在场时，非白名单工具仍可 load 后正常执行', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: { alwaysVisible: ['fixture_hidden_inherited'] }
  })
  cleanup.push(() => boot.dispose())

  const { store, queueResponse } = await storeOf()
  store.reset()
  queueResponse({ toolCalls: [{ id: 'wl3-load', name: 'tool_load', arguments: { names: ['fixture_hidden_scope'] } }] })
  queueResponse({ text: 'wl3 loaded' })
  const handle = await drive(boot.ctx, boot.tmpRoot, { sessionId: 'adapter-wl-3' })
  await userTurn(handle, 'Load a non-whitelisted tool.')

  const runtime = boot.ctx.get('progressiveDiscovery').sessions.get('adapter-wl-3')
  assert.equal(runtime.compositionBypass, null,
    `non-whitelisted flow must not trip bypass: ${JSON.stringify(runtime.compositionBypass)}`)
  // load 必须真的把该工具带进下一次请求，否则后面的执行无从谈起。
  const afterLoad = (store.requests[store.requests.length - 1].tools ?? []).map((t) => t.name)
  assert.ok(afterLoad.includes('fixture_hidden_scope'),
    `loaded tool must appear in the next request: ${afterLoad.join(', ')}`)

  // 披露在下一轮才可执行：另起一轮调用它。
  queueResponse({ toolCalls: [{ id: 'wl3-exec', name: 'fixture_hidden_scope', arguments: { text: 'ok' } }] })
  queueResponse({ text: 'wl3 done' })
  await userTurn(handle, 'Now call it.')
  assert.equal(store.bodyCount('wl3-exec'), 1,
    'a loaded non-whitelisted tool must execute on the following turn')
})

// WL2: 白名单项在 tool_search 中必须报告 loaded:true（无需 load 即已激活）。
test('WL2: 白名单工具在 tool_search 结果中报告 loaded:true', async () => {
  const boot = await bootAdapterComposition({
    fixtures: ['mock-provider', 'inherited-tools', 'scope-tools'],
    adapter: { alwaysVisible: ['fixture_hidden_inherited'] }
  })
  cleanup.push(() => boot.dispose())

  const { store, queueResponse } = await storeOf()
  store.reset()
  queueResponse({
    toolCalls: [{ id: 'wl-search', name: 'tool_search', arguments: { category: 'all', query: 'fixture hidden inherited' } }]
  })
  queueResponse({ text: 'wl search done' })
  const sessionId = 'adapter-wl-2'
  const handle = await drive(boot.ctx, boot.tmpRoot, { sessionId })
  await userTurn(handle, 'Search for the tool.')

  // 结果事件从 session 读回；宿主用 sourceEventSeqs 关联 call 与 result。
  const { events } = await boot.ctx.sessionQuery.readSession(sessionId)
  const call = events.find((e) => e.type === 'tool/call' && e.data?.callId === 'wl-search')
  assert.ok(call, 'tool_search call event must exist')
  const resultEvent = events.find((e) => e.type === 'tool/result'
    && Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.includes(call.seq))
  assert.ok(resultEvent, 'tool_search result event must exist')
  const payload = JSON.parse((resultEvent.data?.message?.content ?? [])
    .map((b) => b?.text ?? '').join(''))
  const hit = payload.data?.candidates?.find((c) => c.name === 'fixture_hidden_inherited')
  assert.ok(hit, 'whitelisted tool must be discoverable')
  assert.equal(hit.loaded, true,
    'whitelisted tool must report loaded:true without an explicit load')
})

after(async () => {
  for (const handle of handles) {
    try {
      await handle.dispose()
    } catch { /* 场景 D 的 handle 可能已随失败退出而释放 */ }
  }
  for (const dispose of cleanup) {
    try {
      dispose()
    } catch { /* 保留证据目录由调用方决定 */ }
  }
  const failed = results.filter((entry) => entry.status === 'fail')
  console.log(JSON.stringify({
    status: failed.length === 0 ? 'pass' : 'fail',
    covered: results.map((entry) => entry.id),
    failures: failed.map((entry) => entry.id)
  }, null, 2))
})

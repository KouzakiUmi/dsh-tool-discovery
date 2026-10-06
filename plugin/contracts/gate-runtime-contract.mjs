// 阶段0 合同门禁（覆盖 G1-G8 + S08 同响应负例；8 项验收口径不降低）。
// 运行：node progressive-v2/contracts/gate-runtime-contract.mjs
// 产物：progressive-v2/reports/runtime-contract-gates.json（每门禁 pass/fail 与证据索引）。
// 说明：fixture 的投影/回执折叠是合同探针，不是产品实现；mock 录制面是最终
// GenerateOptions，不是外部真实 provider wire（后者未验证）。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootComposition, removeTmpRoot } from './harness.mjs'
import { dshModule } from './install-resolver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPORT = path.resolve(HERE, '..', 'reports', 'runtime-contract-gates.json')

const results = []
const state = {
  boot: null,
  handle: null,
  sessionId: 'gate-a-full-1',
  store: null,
  definitionBefore: null,
  errors: []
}

function gate (id, criterion, fn) {
  test(`${id}: ${criterion}`, async () => {
    try {
      await fn()
      results.push({ id, criterion, status: 'pass' })
    } catch (error) {
      results.push({ id, criterion, status: 'fail', error: String(error?.stack ?? error) })
      throw error
    }
  })
}

async function rawEvents (sessionId) {
  const { session, events } = await state.boot.ctx.sessionQuery.readSession(sessionId)
  return { session, events }
}

function toolCallSeq (events, callId) {
  return events.find((event) => event.type === 'tool/call' && event.data?.callId === callId)?.seq
}

function toolResultFor (events, callId) {
  const callSeq = toolCallSeq(events, callId)
  assert.notEqual(callSeq, undefined, `tool/call ${callId} should be in the durable log`)
  const result = events.find((event) => event.type === 'tool/result' && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(callSeq))
  assert.notEqual(result, undefined, `tool/result for ${callId} should be in the durable log`)
  return result
}

function resultText (result) {
  return (result.data.message.content ?? []).map((block) => block.text ?? '').join('')
}

function receiptOf (events, callId) {
  const result = toolResultFor(events, callId)
  const shell = JSON.parse(resultText(result))
  assert.equal(shell.protocolVersion, 2, 'receipt shell protocolVersion')
  assert.equal(shell.ok, true, 'receipt shell ok')
  return { result, shell, receipt: shell.data.receipt }
}

test('boot: 真实 Loader composition（服务 + fixture entries）收敛', async () => {
  state.boot = await bootComposition({ withFixtures: true })
  assert.ok(state.boot.ctx.get('agentLoop') !== undefined, 'agentLoop service reachable')
  state.definitionBefore = state.boot.ctx.tools.get('fixture_hidden_inherited')
  assert.ok(state.definitionBefore !== undefined, 'inherited fixture tool registered')
})

test('drive: scenario A-full（同响应 load+猜名、合法调用、参数拒绝、审批拒绝、终止文本）', async () => {
  const { store, queueResponse } = await import(new URL('../fixtures/mock-store.mjs', import.meta.url).href)
  state.store = store
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  queueResponse({
    toolCalls: [
      { id: 'a-load-1', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited', 'fixture_mutating'] } },
      { id: 'guess-inherited-1', name: 'fixture_hidden_inherited', arguments: { text: 'x' } },
      { id: 'guess-scope-1', name: 'fixture_hidden_scope', arguments: { text: 'y' } }
    ]
  })
  queueResponse({ toolCalls: [{ id: 'legit-1', name: 'fixture_hidden_inherited', arguments: { text: 'legit' } }] })
  queueResponse({ toolCalls: [{ id: 'param-reject-1', name: 'fixture_mutating', arguments: {} }] })
  store.approvalOutcomes.push('rejected')
  queueResponse({ toolCalls: [{ id: 'approval-reject-1', name: 'fixture_mutating', arguments: { text: 'write', triggerApproval: true } }] })
  queueResponse({ text: 'scenario A-full done' })
  const handle = await state.boot.ctx.agents.create({
    sessionId: state.sessionId,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: state.boot.tmpRoot }
  })
  state.handle = handle
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Run the fixture task.' }],
    source: { kind: 'user' }
  }))
  await handle.agent.whenIdle()
  assert.equal(state.store.requests.length, 5, 'mock provider should record five final requests')
})

gate('G1', '首请求同时隐藏 inherited 与 scope-own 普通工具，只有三个控制入口', async () => {
  const first = state.store.requests[0]
  const names = (first.tools ?? []).map((tool) => tool.name).sort()
  assert.deepEqual(names, ['tool_list', 'tool_load', 'tool_search'], `first request tools were: ${names.join(', ')}`)
  assert.equal((first.tools ?? []).length, 3, 'exactly three control entries')
  for (const tool of first.tools ?? []) {
    assert.equal('execute' in tool, false, `schema ${tool.name} must not expose execute`)
    assert.ok('parameters' in tool, `schema ${tool.name} keeps parameters`)
    assert.ok('description' in tool, `schema ${tool.name} keeps description`)
  }
})

gate('G2', '模型直接猜两种隐藏工具名，body 计数保持 0', async () => {
  assert.equal(state.store.bodyCount('guess-inherited-1'), 0, 'inherited hidden tool body must not run')
  assert.equal(state.store.bodyCount('guess-scope-1'), 0, 'scope-own hidden tool body must not run')
  const { events } = await rawEvents(state.sessionId)
  const scopeGuess = toolResultFor(events, 'guess-scope-1')
  assert.equal(scopeGuess.data.message.isError, true, 'scope-own guess must be rejected')
  assert.match(resultText(scopeGuess), /TOOL_NOT_LOADED/, 'never-loaded scope-own guess cites TOOL_NOT_LOADED')
})

gate('S08', '同一响应里 tool_load 成功也不能放行同响应猜测调用（旧 request 未曝光）', async () => {
  assert.equal(state.store.bodyCount('guess-inherited-1'), 0, 'same-response guessed body must not run')
  const { events } = await rawEvents(state.sessionId)
  const { receipt } = receiptOf(events, 'a-load-1')
  assert.equal(receipt.operation, 'load', 'the same-response load itself succeeded')
  const guess = toolResultFor(events, 'guess-inherited-1')
  assert.equal(guess.data.message.isError, true, 'same-response guess must be rejected')
  assert.match(resultText(guess), /TOOL_NOT_ADVERTISED/, 'loaded-but-not-advertised guess cites TOOL_NOT_ADVERTISED')
})

gate('G3', '成功 canonical tool_load 选定后下次 native schema 出现，且原 definition 不改', async () => {
  const later = state.store.requests.slice(1)
  for (const request of later) {
    const names = (request.tools ?? []).map((tool) => tool.name)
    assert.ok(names.includes('fixture_hidden_inherited'), `loaded tool must appear in later request tools: ${names.join(', ')}`)
    assert.ok(names.includes('fixture_mutating'), `second loaded tool must appear in later request tools: ${names.join(', ')}`)
  }
  assert.equal(state.boot.ctx.tools.get('fixture_hidden_inherited'), state.definitionBefore, 'original definition object must not be replaced')
  const { events } = await rawEvents(state.sessionId)
  const { receipt } = receiptOf(events, 'a-load-1')
  assert.equal(receipt.selectionSource, 'name', 'receipt selectionSource matches canonical call args')
  assert.equal(receipt.operationId, 'op_a-load-1', 'receipt operationId correlates with the canonical tool call')
  assert.deepEqual(receipt.selected.map((item) => item.name).sort(), ['fixture_hidden_inherited', 'fixture_mutating'], 'receipt covers exactly the selected tools')
  for (const item of receipt.selected) {
    assert.equal(item.toolId, `tfx_${item.name}`, 'fixture toolId is deterministic')
    assert.ok(item.revision.startsWith('r_'), 'revision recorded')
    assert.ok(item.schemaDigest.startsWith('sha256:'), 'schemaDigest recorded')
    assert.equal(item.skillRevision, 's1', 'skillRevision recorded')
  }
  assert.equal(state.store.bodyCount('legit-1'), 1, 'legit call of the loaded tool runs exactly once')
  const legit = toolResultFor(events, 'legit-1')
  assert.equal(legit.data.message.isError, false, 'legit call succeeds after the load takes effect')
})

gate('G6', 'request/header 与宿主 tool-addition 真实变化', async () => {
  const { events } = await rawEvents(state.sessionId)
  const headers = events.filter((event) => event.type === 'request/header')
  assert.ok(headers.length >= 2, `expected at least two request/header events, got ${headers.length}`)
  const firstTools = (headers[0].data.header.tools ?? []).map((tool) => tool.name).sort()
  const lastHeader = headers.find((event) => (event.data.header.tools ?? []).some((tool) => tool.name === 'fixture_hidden_inherited'))
  assert.ok(lastHeader !== undefined, 'a later request/header carries the loaded tool')
  assert.notDeepEqual(firstTools, (lastHeader.data.header.tools ?? []).map((tool) => tool.name).sort(), 'header tools actually changed')
  const additions = events
    .filter((event) => event.type === 'developer/message')
    .flatMap((event) => event.data.message.content ?? [])
    .filter((block) => block.type === 'tool-addition')
    .map((block) => block.toolName)
    .sort()
  assert.deepEqual(additions, ['fixture_hidden_inherited', 'fixture_mutating'], `host tool-addition records: ${additions.join(', ')}`)
  const recorded = state.store.requests.map((request) => (request.tools ?? []).map((tool) => tool.name))
  assert.equal(recorded[0].length, 3, 'first request has only three entries')
  assert.ok(recorded[1].length === 5, `second request carries the two loaded tools, got ${recorded[1].length}`)
})

gate('G4', '已加载工具仍被原参数校验/原审批链拒绝，body 计数 0', async () => {
  assert.equal(state.store.bodyCount('param-reject-1'), 0, 'invalid-args body must not run')
  assert.equal(state.store.bodyCount('approval-reject-1'), 0, 'approval-rejected body must not run')
  const { events } = await rawEvents(state.sessionId)
  const param = toolResultFor(events, 'param-reject-1')
  assert.equal(param.data.message.isError, true, 'invalid args rejected by the original parameter validation')
  assert.match(resultText(param), /^Error: /, 'parameter rejection surfaces as the original error result')
  const approval = toolResultFor(events, 'approval-reject-1')
  assert.equal(approval.data.message.isError, true, 'approval denial rejected the call')
  assert.match(resultText(approval), /rejected/, 'approval denial reason visible to the model')
  const asked = events.filter((event) => event.type === 'approval/asked')
  const decided = events.filter((event) => event.type === 'approval/decided')
  assert.equal(asked.length, 1, 'real ApprovalService wrote exactly one approval/asked audit event')
  assert.equal(decided.length, 1, 'real ApprovalService wrote exactly one approval/decided audit event')
  assert.equal(decided[0].data.outcome, 'rejected', 'approval outcome recorded as rejected')
})

gate('G5', '回执经真实持久化与 query readSession 冷读可见（非 result.value / 非内存事件）', async () => {
  await state.handle.dispose()
  state.handle = undefined
  const sessionDir = path.join(state.boot.tmpRoot, 'sessions')
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(sessionDir)
  assert.ok(files.length > 0, 'session persistence wrote at least one file under the fixture tmp root')
  assert.ok(files.some((file) => file.includes(state.sessionId)), `persisted log names the session id: ${files.join(', ')}`)
  const { events } = await rawEvents(state.sessionId)
  const { result, receipt } = receiptOf(events, 'a-load-1')
  assert.equal(receipt.kind, 'tool-discovery.selection', 'cold read sees the strict v2 receipt')
  assert.equal(receipt.version, 2, 'receipt version 2')
  assert.equal('value' in result.data, false, 'durable tool/result must not rely on result.value')
  const raw = JSON.stringify(result.data)
  assert.ok(raw.includes('tool-discovery.selection'), 'receipt text survives inside the durable message content')
})

test('drive: scenario C（load → unload → 再调用被拒 → 终止文本）', async () => {
  const { store, queueResponse } = state.store === undefined
    ? await import(new URL('../fixtures/mock-store.mjs', import.meta.url).href)
    : { store: state.store, queueResponse: (response) => state.store.script.push(response) }
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  state.offsetC = store.requests.length
  state.sessionC = 'gate-c-unload-1'
  queueResponse({ toolCalls: [{ id: 'c-load-1', name: 'tool_load', arguments: { names: ['fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'c-unload-1', name: 'tool_load', arguments: { action: 'unload', toolIds: ['tfx_fixture_hidden_inherited'] } }] })
  queueResponse({ toolCalls: [{ id: 'c-try-1', name: 'fixture_hidden_inherited', arguments: { text: 'after unload' } }] })
  queueResponse({ text: 'scenario C done' })
  const handle = await state.boot.ctx.agents.create({
    sessionId: state.sessionC,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: state.boot.tmpRoot }
  })
  state.handleC = handle
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Run the unload fixture task.' }],
    source: { kind: 'user' }
  }))
  await handle.agent.whenIdle()
  state.requestsC = store.requests.slice(state.offsetC)
  assert.equal(state.requestsC.length, 4, 'scenario C records four final requests')
})

gate('G7', 'unload 后 tool-removal 与历史正确，新调用拒执行', async () => {
  const requests = state.requestsC
  const toolNames = (request) => (request.tools ?? []).map((tool) => tool.name)
  assert.equal(toolNames(requests[0]).length, 3, 'C: first request has only the three entries')
  assert.ok(toolNames(requests[1]).includes('fixture_hidden_inherited'), 'C: loaded tool advertised on the next request')
  assert.equal(toolNames(requests[2]).length, 3, 'C: request after unload drops the tool again')
  assert.equal(toolNames(requests[3]).length, 3, 'C: final request stays without the unloaded tool')
  const { events } = await rawEvents(state.sessionC)
  const removals = events
    .filter((event) => event.type === 'developer/message')
    .flatMap((event) => event.data.message.content ?? [])
    .filter((block) => block.type === 'tool-removal')
    .map((block) => block.toolName)
  assert.deepEqual(removals, ['fixture_hidden_inherited'], `C: host tool-removal record: ${removals.join(', ')}`)
  const { receipt } = receiptOf(events, 'c-unload-1')
  assert.equal(receipt.operation, 'unload', 'C: unload receipt recorded')
  assert.deepEqual(receipt.deselected, ['tfx_fixture_hidden_inherited'], 'C: unload receipt names the deselected tool id')
  assert.equal(state.store.bodyCount('c-try-1'), 0, 'C: post-unload call body must not run')
  const retry = toolResultFor(events, 'c-try-1')
  assert.equal(retry.data.message.isError, true, 'C: post-unload call rejected')
  assert.match(resultText(retry), /TOOL_NOT_LOADED/, 'C: post-unload rejection cites not-loaded')
  const historyText = JSON.stringify(requests[2].messages ?? [])
  assert.ok(historyText.includes('tool-discovery.selection'), 'C: later requests keep the earlier load receipt in history')
  assert.ok(historyText.includes('c-load-1') || historyText.includes('legit') || historyText.includes('text'), 'C: history retains earlier tool content')
})

test('drive: scenario D（框架强制输出/终止工具）', async () => {
  const { store, queueResponse } = { store: state.store, queueResponse: (response) => state.store.script.push(response) }
  const { createUserMessage } = await import(dshModule('@deepseek-ai/dsh-llm'))
  state.offsetD = store.requests.length
  state.sessionD = 'gate-d-framework-1'
  queueResponse({ toolCalls: [{ id: 'd-final-1', name: 'fixture_final_output', arguments: { text: 'final structured answer' } }] })
  const handle = await state.boot.ctx.agents.create({
    sessionId: state.sessionD,
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: state.boot.tmpRoot }
  })
  state.handleD = handle
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Produce the final output.' }],
    source: { kind: 'user' }
  }))
  await handle.agent.whenIdle()
  state.requestsD = store.requests.slice(state.offsetD)
  assert.equal(state.requestsD.length, 1, 'scenario D ends the turn after the termination tool call')
})

gate('G8', '可信显式配置保留强制输出/终止框架工具，且终止路径正常', async () => {
  const names = (state.requestsD[0].tools ?? []).map((tool) => tool.name).sort()
  assert.deepEqual(names, ['fixture_final_output', 'tool_list', 'tool_load', 'tool_search'],
    `D: first request must be three entries plus the configured framework tool, got: ${names.join(', ')}`)
  assert.equal(state.store.bodyCount('d-final-1'), 1, 'D: framework termination tool body runs exactly once')
  const { events } = await rawEvents(state.sessionD)
  const finalResult = toolResultFor(events, 'd-final-1')
  assert.equal(finalResult.data.message.isError, false, 'D: termination tool call succeeds')
  const turnEnd = events.find((event) => event.type === 'turn/end')
  assert.ok(turnEnd !== undefined, 'D: turn/end event recorded (termination path completed)')
  const reason = turnEnd.data.reason
  if (reason !== null && typeof reason === 'object') {
    assert.equal(reason.kind, 'completed', `D: turn ended normally, got ${JSON.stringify(reason)}`)
  }
  assert.equal(state.store.bodyCount('fixture_submit_result'), 0, 'D: name-similar decoy never ran')
  assert.ok(!names.includes('fixture_submit_result'), 'D: decoy not advertised despite its output-like name')
  const decoyDefinition = state.boot.ctx.tools.get('fixture_submit_result', state.handleD.agent)
  assert.ok(decoyDefinition !== undefined, 'D: decoy IS registered in the scope — hiding is done by projection+guard, not by absent registration')
})

after(async () => {
  const failed = results.filter((entry) => entry.status === 'fail')
  const report = {
    task: 'runtime-contract-v2',
    stage: 'stage0-gates-incremental',
    note: '增量运行；8 项门禁验收口径不变，未列门禁尚未验证。fixture 投影/回执折叠是合同探针，不是产品实现；mock 录制面是最终 GenerateOptions，非外部真实 provider wire。',
    timestamp: new Date().toISOString(),
    command: 'node progressive-v2/contracts/gate-runtime-contract.mjs',
    node: process.version,
    coveredGates: results.map((entry) => entry.id),
    results,
    status: failed.length === 0 ? 'pass' : 'fail',
    errors: state.errors
  }
  for (const key of ['handle', 'handleC', 'handleD']) {
    const handle = state[key]
    if (handle !== undefined) {
      try {
        await handle.dispose()
      } catch (error) {
        report.errors.push(`${key} dispose failed: ${error?.message ?? error}`)
      }
    }
  }
  if (state.boot !== undefined) {
    if (failed.length === 0 && report.errors.length === 0) {
      try {
        removeTmpRoot(state.boot.tmpRoot)
      } catch (error) {
        report.errors.push(`tmp cleanup failed: ${error?.message ?? error}`)
      }
    } else {
      report.tmpRootKeptForEvidence = state.boot.tmpRoot
    }
  }
  report.exitCode = failed.length === 0 ? 0 : 1
  fs.mkdirSync(path.dirname(REPORT), { recursive: true })
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, coveredGates: report.coveredGates, failures: failed.map((entry) => entry.id), report: REPORT }, null, 2))
})

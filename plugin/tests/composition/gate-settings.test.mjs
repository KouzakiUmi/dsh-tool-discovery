// 门禁：初始工具设置面（真实 Cordis Loader + 安装内 0.2.1-alpha.1 + 产品 adapter，
// 且**注入 schemastery Schema**，因此 adapter 带 Config —— 走 adapter-entry-schema.mjs）。
//
// 覆盖：
//   SG1  Config 在 Cordis 首次 resolveConfig **之前**就存在：entry.fiber.config.alwaysVisible
//        是 volatile 引用（迟一秒赋 apply.Config 就拿不到，这正是本门禁要锁死的东西）。
//   SG2  默认名单 = DSH 自带工具，且是**替换**不是并集。
//   SG3  显式 [] 确实清空默认；三个发现入口仍被披露。
//   SG4  活目录 meta 含当前真实工具、排除三入口；tools/change 后刷新。
//   SG5  周期中途改配置**不**动已在跑的 runtime；新 runtime 才拿到新名单。
//
// 断言纪律：每条安全断言都配正控制，不做近恒真析取。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { dshModule } from '../../contracts/install-resolver.mjs'
import { bootAdapterComposition } from './harness.mjs'
import { CORE_TOOL_NAMES } from '../../domain/core-tools.mjs'
import { DEFAULT_BUDGETS, OPTIONAL_LIMIT_KEYS } from '../../domain/index.mjs'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const handles = []

after(() => { for (const dispose of handles.reverse()) dispose() })

/** 装一个带 Schema 的 adapter composition。 */
async function boot (adapterConfig) {
  const handle = await bootAdapterComposition({
    fixtures: ['inherited-tools', 'scope-tools'],
    adapter: adapterConfig ?? {},
    adapterSchema: true,
  })
  handles.push(handle.dispose)
  return handle
}

function adapterEntry (handle) {
  return handle.loader.entries().find((e) => e.id === 'progressive-discovery')
}

function serviceOf (ctx) {
  return ctx.get('progressiveDiscovery')
}

/** 造一个最小会话/agent scope，让 lifecycle 建立 runtime。 */
function fakeSession (id) {
  return { id, seq: 0, inheritedEventCount: 0, header: { cwd: 'C:\\' } }
}

/**
 * 组装上下文。dsh-agent-loop 注册了 `provider`/`model`/`cwd` 三个 prompt variable
 * （lib/index.js:1564-1566），它们直接读 `context.agent.options.*` 与
 * `context.agent.session.header.cwd` —— 走真实 systemPrompt.assemble 就必须给全。
 */
function assembleContext (session, agentId = 'a1') {
  return {
    agent: {
      id: agentId,
      session,
      options: { provider: 'fixture-mock', model: 'fixture-model' },
    },
    scope: { id: agentId },
  }
}

test('SG1: Config 在首次 resolveConfig 之前存在 —— alwaysVisible 是 volatile 引用', async () => {
  const { ctx, loader } = await boot({})
  const entry = adapterEntry({ loader })
  assert.equal(entry.fiber._error, undefined, 'adapter 必须激活')
  assert.ok(entry.fiber.runtime.Config !== undefined, 'fiber.runtime.Config 必须在 apply 前就位')

  const resolved = entry.fiber.config.alwaysVisible
  assert.equal(typeof resolved, 'object')
  assert.equal(typeof resolved.get, 'function', 'alwaysVisible 必须是 volatile 引用而非普通数组')
  assert.deepEqual(resolved.get(), [...CORE_TOOL_NAMES])
  void ctx
})

test('SG2/SG3: 默认名单是 DSH 自带工具；显式 [] 清空默认但保留三个发现入口', async () => {
  const withDefault = await boot({})
  const runtimeA = serviceOf(withDefault.ctx).lifecycle.ensureRuntime(fakeSession('s-default'), { id: 'a1' })
  assert.deepEqual(runtimeA.alwaysNames, [...CORE_TOOL_NAMES], '默认即 DSH 自带工具')

  const cleared = await boot({ alwaysVisible: [] })
  const entry = adapterEntry(cleared)
  const live = entry.fiber.config.alwaysVisible
  assert.equal(typeof live.get, 'function')
  assert.deepEqual(live.get(), [], '显式 [] 必须真的清空，不得回落到 CORE')

  const runtimeB = serviceOf(cleared.ctx).lifecycle.ensureRuntime(fakeSession('s-empty'), { id: 'a2' })
  assert.deepEqual(runtimeB.alwaysNames, [], '替换语义：不给就一个都不常驻，不是并集')

  // 三个发现入口独立于该字段：清空默认后它们依然存在
  assert.ok(cleared.ctx.tools.get('tool_list', undefined) !== undefined)
  assert.ok(cleared.ctx.tools.get('tool_search', undefined) !== undefined)
  assert.ok(cleared.ctx.tools.get('tool_load', undefined) !== undefined)
  assert.ok(!runtimeB.alwaysNames.includes('tool_load'), '入口不来自 alwaysVisible 字段')
})

test('SG4: 活目录 meta 含当前真实工具、排除三入口；tools/change 后刷新', async () => {
  const comp = await boot({})
  const { ctx, loader } = comp
  const entry = adapterEntry(comp)
  const meta = entry.fiber.runtime.Config.dict.alwaysVisible.meta.initialToolChoices
  const names = meta.map((c) => c.name)

  assert.ok(names.includes('fixture_hidden_inherited'), '真实注册的第三方工具必须在目录里')
  assert.ok(names.includes('fixture_mutating'))
  for (const fixed of ['tool_list', 'tool_search', 'tool_load']) {
    assert.ok(!names.includes(fixed), `${fixed} 是固定入口，不得出现在可选项里`)
  }
  assert.deepEqual(names, [...names].sort(), '目录按名字典序，面板顺序稳定')

  // 正控制：当前目录里确实还有这些工具（不是空集上的通过）
  assert.ok(ctx.tools.get('fixture_hidden_inherited', undefined) !== undefined)

  // scope 工具（注册在 agent.ctx 上，不在 global 层）也必须在目录里：
  // 只看 view(undefined) 会把它们全漏掉，用户就无法勾选任何 scoped / MCP 工具。
  // 它们要等真实 agent 创建（agent/created）才出现，故这里建一个真 agent。
  const agentHandle = await ctx.agents.create({
    sessionId: 's-scope-agent',
    agentOptions: { provider: 'fixture-mock', model: 'fixture-model' },
    meta: { cwd: comp.tmpRoot },
  })
  const scopeAgent = agentHandle.agent
  const scopedCandidates = ['fixture_hidden_scope', 'fixture_submit_result']
  const scopeVisible = scopedCandidates.filter((n) => ctx.tools.get(n, scopeAgent) !== undefined)
  assert.ok(scopeVisible.length > 0, '正控制：scope 层确实有工具（否则下面断言是空转）')

  // 建一个 runtime：目录由此进入该 runtime 的 catalog，meta 应随之更新。
  const lifecycle = serviceOf(ctx).lifecycle
  lifecycle.ensureRuntime(scopeAgent.session, scopeAgent)
  await new Promise((r) => setImmediate(r))
  const scoped = entry.fiber.runtime.Config.dict.alwaysVisible.meta.initialToolChoices.map((c) => c.name)
  assert.ok(scopeVisible.every((n) => scoped.includes(n)),
    `目录必须含 scope 工具；期望 ${JSON.stringify(scopeVisible)}，实得 ${JSON.stringify(scoped)}`)

  // 再注册一个新工具并广播 tools/change，目录必须跟上
  const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))
  const dispose = ctx.tools.register(defineTool({
    name: 'fixture_late_arrival',
    description: 'registered after activation',
    parameters: { text: { type: 'string', required: true, description: 'Text to echo back.' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async () => 'ok',
  }))
  try {
    const after = entry.fiber.runtime.Config.dict.alwaysVisible.meta.initialToolChoices.map((c) => c.name)
    assert.ok(after.includes('fixture_late_arrival'), 'tools/change 后新工具必须进入目录')
    assert.ok(after.includes('fixture_hidden_scope'), 'tools/change 不得把 scope 工具挤掉')
  } finally {
    dispose()
  }
})

test('SG5: 周期中途改配置不动已在跑的 runtime；新 runtime 才拿到新名单', async () => {
  const { ctx, loader } = await boot({})
  const entry = adapterEntry({ loader })

  const running = serviceOf(ctx).lifecycle.ensureRuntime(fakeSession('s-live'), { id: 'a1' })
  assert.deepEqual(running.alwaysNames, [...CORE_TOOL_NAMES])
  const frozenWireBefore = JSON.stringify(running.engine.getFrozenWire(running.scope))

  // 模拟设置面板写入后 Cordis 重新 resolveConfig：volatile 引用被就地换成新值。
  // 这与 dsh-settings 写路径最终落到 schemastery 的方式同形（共享 volatile.write 协议）。
  entry.fiber.config.alwaysVisible[VOLATILE_WRITE](['fixture_hidden_inherited'])

  assert.deepEqual(running.alwaysNames, [...CORE_TOOL_NAMES], '当前周期不得被配置变更改动')
  assert.equal(JSON.stringify(running.engine.getFrozenWire(running.scope)), frozenWireBefore,
    '当前周期的披露集合不得改变')

  // 正控制：配置确实已经变了（否则上面两条是空转）
  assert.deepEqual(entry.fiber.config.alwaysVisible.get(), ['fixture_hidden_inherited'])

  // 下一个周期（这里用新会话代表）才拿到新名单
  const next = serviceOf(ctx).lifecycle.ensureRuntime(fakeSession('s-next'), { id: 'a2' })
  assert.deepEqual(next.alwaysNames, ['fixture_hidden_inherited'], '新周期采用新配置')
})

/**
 * 宿主在 pre-step 里跑完自动压缩后会返回**压缩前**那份 assembly
 * （dsh-agent-loop lib/index.js:907 / :911 / :921-923）。因此成功压缩换完名单后，
 * 真正发出去的那份 tools 数组必须被就地刷新 —— 否则新周期的初始名单第一请求就错。
 * 事件形状与 gate-cache-epoch 的 CE9 同源（start/summary/shadow/end，无 error）。
 */
function autoCompactionEvents (sessionId, seqBase) {
  const compactionId = 'fixture-auto-compaction'
  return [
    { type: 'compaction/start', seq: seqBase, data: { compactionId, turn: 1 } },
    { type: 'compaction/summary', seq: seqBase + 1, data: { compactionId, summary: [] } },
    { type: 'compaction/shadow', seq: seqBase + 2, data: { compactionId } },
    { type: 'compaction/end', seq: seqBase + 3, data: { compactionId, turn: 1 } },
  ]
}

test('SG6: 成功自动压缩后，未发送的那份 tools 数组被就地刷新成新周期的初始名单', async () => {
  const { ctx, loader } = await boot({ alwaysVisible: ['fixture_hidden_inherited'] })
  const entry = adapterEntry({ loader })
  const lifecycle = serviceOf(ctx).lifecycle
  const session = fakeSession('s-auto')
  const runtime = lifecycle.ensureRuntime(session, { id: 'a1' })
  assert.deepEqual(runtime.alwaysNames, ['fixture_hidden_inherited'])

  // 改配置：下一个周期改用另一个名字。
  entry.fiber.config.alwaysVisible[VOLATILE_WRITE](['fixture_mutating'])

  // 模拟一次 assemble 之后、发送之前发生自动压缩：projection 挂上未发送刷新入口。
  const assembled = await ctx.systemPrompt.assemble(assembleContext(session))
  const pending = assembled.tools
  const before = pending.map((t) => t.name)
  assert.ok(before.includes('fixture_hidden_inherited'), '压缩前这份数组确实带着旧名单')
  assert.equal(typeof runtime.refreshPendingProjection, 'function', '未发送刷新入口应已挂上')

  // 成功压缩（CE9 同形状，start/summary/shadow/end 且无 error）
  for (const event of autoCompactionEvents('s-auto', 10)) {
    lifecycle.onSessionEvent(session, event)
  }

  const after = pending.map((t) => t.name)
  assert.deepEqual(runtime.alwaysNames, ['fixture_mutating'], '压缩即周期边界，应采用新配置')
  assert.ok(!after.includes('fixture_hidden_inherited'), `压缩后仍披露旧工具: ${JSON.stringify(after)}`)
  assert.ok(after.includes('fixture_mutating'), `压缩后未采用新名单: ${JSON.stringify(after)}`)
  assert.ok(after.includes('tool_load'), '三个发现入口恒在')
  // 数组是同一个（就地替换），不是换了一个新数组
  assert.equal(Array.isArray(pending), true)
})

test('SG7: 已发送的数组不再被后来的压缩改写（canonical header 观测后清除刷新入口）', async () => {
  const { ctx, loader } = await boot({ alwaysVisible: ['fixture_hidden_inherited'] })
  const entry = adapterEntry({ loader })
  const lifecycle = serviceOf(ctx).lifecycle
  const session = fakeSession('s-sent')
  const runtime = lifecycle.ensureRuntime(session, { id: 'a1' })

  const assembled = await ctx.systemPrompt.assemble(assembleContext(session))
  const pending = assembled.tools
  const namesAtSend = pending.map((t) => t.name)

  // 这份数组已经作为真实出站 header 被观测到 → 刷新入口必须失效。
  lifecycle.onSessionEvent(session, {
    type: 'request/header',
    seq: 5,
    data: { header: { tools: pending.map((t) => ({ name: t.name })) } },
  })
  assert.equal(runtime.refreshPendingProjection, null, '已发送后不得还留着刷新入口')

  entry.fiber.config.alwaysVisible[VOLATILE_WRITE](['fixture_mutating'])
  for (const event of autoCompactionEvents('s-sent', 20)) {
    lifecycle.onSessionEvent(session, event)
  }

  assert.deepEqual(pending.map((t) => t.name), namesAtSend, '事后压缩不得改写已发送的历史数组')
  assert.deepEqual(runtime.alwaysNames, ['fixture_mutating'], '但下一个周期的名单确实换了')
})

// --- budgets 的 null：真实 Schema + 真实 Loader 下缺省与显式 null 都必须激活 --------
//
// 这里不造假 Schema：`buildConfig` 的 budgets 字段默认值就是 null（"关闭覆盖"），
// schemastery 解析时该键缺省不落到值上（`config({}).budgets === undefined`），
// 但**显式写 null 会真的把 null 交给 apply**。因此真实 Loader 下：
//   缺省 Config        → budgets 缺省 → 激活
//   显式 budgets: null → budgets 为 null → 必须同样激活
// 形状校验曾把 null 当"非对象"拒掉，于是后一条会让整个 adapter 激活失败。

/** 断言该 composition 里 adapter 已激活且 budgets 按预期生效。 */
function budgetsOf (comp, sessionId) {
  const entry = adapterEntry(comp)
  assert.equal(entry.fiber._error, undefined, `adapter 必须激活: ${entry.fiber._error}`)
  const lifecycle = serviceOf(comp.ctx).lifecycle
  const runtime = lifecycle.ensureRuntime(fakeSession(sessionId), { id: 'a1' })
  return { resolved: entry.fiber.config.budgets, budgets: runtime.engine.getBudgets() }
}

test('SG8: 缺省 Config 与显式 budgets: null 都激活，且硬限额保持默认关闭', async () => {
  const omitted = await boot({})
  const a = budgetsOf(omitted, 's-budget-omitted')
  assert.equal(a.resolved, undefined, '缺省时 Loader 不产出 budgets 键（正控制：这里确实没配置）')
  assert.deepEqual(a.budgets, { ...DEFAULT_BUDGETS }, '缺省即冻结默认值')

  const explicitNull = await boot({ budgets: null })
  const b = budgetsOf(explicitNull, 's-budget-null')
  assert.equal(b.resolved, null, '显式 null 必须真的落到 apply 的 rawConfig 上（正控制）')
  assert.deepEqual(b.budgets, { ...DEFAULT_BUDGETS }, 'null = 不覆盖，与缺省同解')
  for (const key of OPTIONAL_LIMIT_KEYS) {
    assert.equal(b.budgets[key], null, `${key} 在显式 null 下仍应是关闭`)
  }
})

test('SG9: 显式有效预算正常生效，其余硬限额仍默认关闭', async () => {
  const comp = await boot({ budgets: { maxActiveTools: 3 } })
  const { resolved, budgets } = budgetsOf(comp, 's-budget-explicit')
  assert.deepEqual(resolved, { maxActiveTools: 3 })
  assert.equal(budgets.maxActiveTools, 3, '显式正整数启用该限额')
  for (const key of OPTIONAL_LIMIT_KEYS.filter((k) => k !== 'maxActiveTools')) {
    assert.equal(budgets[key], null, `未给出的 ${key} 必须保持关闭`)
  }
})

test('SG10: budgets 为非对象（字符串）仍被拒 —— 不得因修 null 而放宽形状校验', async () => {
  const comp = await boot({ budgets: '8' })
  const entry = adapterEntry(comp)
  assert.notEqual(entry.fiber._error, undefined, '非对象 budgets 必须拒绝激活')
  assert.match(comp.activationErrors().join('\n'), /budgets|budget/i,
    `拒绝必须指名 budgets：${comp.activationErrors().join('\n')}`)
  assert.equal(comp.ctx.get('progressiveDiscovery'), undefined, '被拒的组合不得留下半激活服务')
})

// 阶段0 fixture：assembly 投影 + 单调执行披露 guard + 审批策略/应答接缝。
// 折叠算法是从 canonical 日志（session.eventAt 原始事件）回读 v2 回执的极简探针，
// 明确不是产品实现；不使用 snapshotEvents、不读 result.value、不改宿主方法。
import { ENTRY_NAMES } from './fixture-model.mjs'
import { store } from './mock-store.mjs'

/** sessionId -> { lastSeq, selected: Map<toolId, record>, calls: Map<callSeq, call> } */
const folds = new Map()

function extractShell (data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return null
  const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 严格校验 v2 回执与 canonical tool/call 的归属一致性；不通过则不激活。 */
function verifyReceipt (shell, call) {
  if (shell === null) return null
  if (shell.protocolVersion !== 2 || shell.tool !== 'tool_load' || shell.ok !== true) return null
  const receipt = shell.data?.receipt
  if (receipt?.kind !== 'tool-discovery.selection' || receipt.version !== 2) return null
  if (receipt.operationId !== `op_${call.callId}`) return null
  let args
  try {
    args = JSON.parse(call.args || '{}')
  } catch {
    return null
  }
  const operation = args.action ?? 'load'
  if (receipt.operation !== operation) return null
  if (operation === 'load') {
    const expectedSource = Array.isArray(args.names) && args.names.length > 0 ? 'name' : 'candidate'
    if (receipt.selectionSource !== expectedSource) return null
    if (!Array.isArray(receipt.selected)) return null
    for (const item of receipt.selected) {
      if (item === null || typeof item !== 'object') return null
      for (const field of ['toolId', 'name', 'revision', 'schemaDigest', 'skillRevision']) {
        if (typeof item[field] !== 'string') return null
      }
    }
    if (expectedSource === 'name') {
      const names = new Set(args.names ?? [])
      if (receipt.selected.some((item) => !names.has(item.name))) return null
    }
  } else if (operation === 'unload') {
    const ids = new Set(args.toolIds ?? [])
    const deselected = receipt.deselected ?? []
    if (!Array.isArray(deselected) || deselected.some((id) => !ids.has(id))) return null
  } else {
    return null
  }
  return receipt
}

function applyReceipt (selected, receipt) {
  if (receipt.operation === 'load') {
    for (const item of receipt.selected) selected.set(item.toolId, item)
  } else {
    for (const id of receipt.deselected ?? []) selected.delete(id)
  }
}

/** 从原始日志增量折叠 selection 状态（探针）。 */
function foldSession (session) {
  let fold = folds.get(session.id)
  if (fold === undefined) {
    fold = { lastSeq: 0, selected: new Map(), calls: new Map() }
    folds.set(session.id, fold)
  }
  const total = session.seq
  for (let seq = fold.lastSeq; seq < total; seq++) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'tool/call' && event.data?.name === 'tool_load') {
      fold.calls.set(event.seq, { callId: event.data.callId, args: event.data.arguments })
    } else if (event.type === 'tool/result' && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0) {
      const call = fold.calls.get(event.sourceEventSeqs[0])
      if (call === undefined) continue
      if (event.data?.message?.isError === true) continue
      const receipt = verifyReceipt(extractShell(event.data), call)
      if (receipt !== null) applyReceipt(fold.selected, receipt)
    }
  }
  fold.lastSeq = total
  return fold
}

const apply = (ctx, config) => {
  const frameworkRetained = new Set(config?.frameworkRetained ?? [])

  // 投影：在 waterfall next() 之后做最终本插件投影（组合顺序无关）。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const transformed = await next()
    const agent = context.agent
    if (agent === undefined) return transformed
    if (ctx.tools.modeFor(context.scope) !== 'native') {
      throw new Error('INCOMPATIBLE_PRESENTATION: stage-0 disclosure projection is native-only')
    }
    const fold = foldSession(agent.session)
    const allowed = new Set([
      ...ENTRY_NAMES,
      ...frameworkRetained,
      ...[...fold.selected.values()].map((record) => record.name)
    ])
    return { ...transformed, tools: transformed.tools.filter((tool) => allowed.has(tool.name)) }
  })

  // 单调执行披露 guard：只增加拒绝，不授予权限；未就绪 fail closed。
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined) return 'disclosure guard: agent-less calls are not admitted by this composition'
    let fold
    try {
      fold = foldSession(agent.session)
    } catch {
      return 'disclosure guard: session selection state is not ready (STATE_NOT_READY)'
    }
    const name = exec.name
    const selectedRecord = [...fold.selected.values()].find((record) => record.name === name)
    const configured = ENTRY_NAMES.includes(name) || frameworkRetained.has(name)
    if (!configured && selectedRecord === undefined) {
      return `tool "${name}" is not loaded (TOOL_NOT_LOADED): call tool_load first, then wait for the next request`
    }
    const header = agent.session.requestHeader()
    const advertised = (header?.tools ?? []).find((tool) => tool.name === name)
    if (advertised === undefined) {
      return `tool "${name}" is not advertised in the current request (TOOL_NOT_ADVERTISED): a load takes effect on the next request`
    }
    const definition = ctx.tools.get(name, agent)
    if (definition === undefined) {
      return `tool "${name}" no longer resolves in the current registry view`
    }
    if (JSON.stringify(advertised.parameters ?? null) !== JSON.stringify(definition.parameters ?? null)) {
      return `tool "${name}" definition changed since the current request (SELECTION_CHANGED)`
    }
    return undefined
  })

  // 原审批链策略接缝：fixture_mutating 的 triggerApproval 调用走 tools/pre-execute ask。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'fixture_mutating' && exec.arguments?.triggerApproval === true) {
      return { kind: 'ask', reason: 'fixture policy: mutating tool requires user approval' }
    }
    return next()
  })

  // 审批应答接缝（ApprovalService 的官方 answerer waterfall）；脚本化应答。
  ctx.on('approval/request', (req, next) => {
    const outcome = store.approvalOutcomes.shift()
    return outcome ?? next()
  })
}
apply.inject = ['tools']
export default apply

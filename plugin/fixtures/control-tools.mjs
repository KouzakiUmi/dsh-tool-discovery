// 阶段0 fixture：三入口 tool_list / tool_search / tool_load 的最小合同 stub。
// 这是合同探针的极简投影/回执算法，明确不是产品实现；只用于让阶段0门禁可执行。
// tool_load 的回执按协议 v2 严格形状写入 output.render 内容（经真实结果链持久化）。
import { dshModule } from '../contracts/install-resolver.mjs'
import { store } from './mock-store.mjs'
import { ENTRY_NAMES, toolIdFor, schemaDigestFor, revisionFor } from './fixture-model.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))

function sessionKey (exec) {
  return exec.agent?.session?.id ?? '<no-session>'
}

function catalogOf (ctx, exec) {
  const schemas = ctx.tools.schemas(exec.agent)
  return schemas.filter((schema) => !ENTRY_NAMES.includes(schema.name))
}

function buildSelectedItems (ctx, exec, names) {
  return names.map((name) => {
    const definition = ctx.tools.get(name, exec.agent)
    return {
      toolId: toolIdFor(name),
      name,
      revision: revisionFor(definition),
      schemaDigest: schemaDigestFor(definition),
      skillRevision: 's1'
    }
  })
}

const apply = (ctx, config) => {
  ctx.tools.register(defineTool({
    name: 'tool_list',
    description: 'Browse discoverable tool names by category in bounded pages. Returns names only — no descriptions, no schemas. Does not load anything.',
    parameters: {
      view: { type: 'string', enum: ['available', 'loaded', 'categories', 'state'], description: 'Default "available".' },
      category: { type: 'string', description: 'Category id, or "all".' },
      cursor: { type: 'string', description: 'Opaque cursor from a previous page.' },
      limit: { type: 'integer', description: 'Page size, max 20.' }
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }]
    },
    execute (args, exec) {
      const view = args.view ?? 'available'
      const category = args.category ?? 'all'
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 20)
      const names = catalogOf(ctx, exec).map((schema) => schema.name).sort().slice(0, limit)
      return JSON.stringify({
        protocolVersion: 2,
        tool: 'tool_list',
        operation: 'list',
        ok: true,
        data: { category, view, names, nextCursor: null, truncated: false },
        nextAction: '知道用途后可按精确名称调用 tool_load；不确定时调用 tool_search。'
      })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'tool_search',
    description: 'Find a few candidate tools for a task described in natural language within one category. Returns candidates only; loading happens via tool_load on the next request.',
    parameters: {
      category: { type: 'string', required: true, description: 'Category id, or "all".' },
      query: { type: 'string', required: true, description: 'Natural-language description of the task.' },
      limit: { type: 'integer', description: 'Max candidates, default 5, max 8.' }
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }]
    },
    execute (args, exec) {
      const limit = Math.min(Math.max(args.limit ?? 5, 1), 8)
      const needle = String(args.query).toLowerCase()
      const table = store.searchRefs.get(sessionKey(exec)) ?? new Map()
      store.searchRefs.set(sessionKey(exec), table)
      const candidates = []
      for (const schema of catalogOf(ctx, exec)) {
        if (candidates.length >= limit) break
        const haystack = `${schema.name} ${schema.description}`.toLowerCase()
        if (!haystack.includes(needle)) continue
        const definition = ctx.tools.get(schema.name, exec.agent)
        const revision = revisionFor(definition)
        const ref = `cref_${toolIdFor(schema.name)}_${revision}_${table.size + 1}`
        table.set(ref, { name: schema.name, revision, toolId: toolIdFor(schema.name) })
        candidates.push({
          toolId: toolIdFor(schema.name),
          ref,
          revision,
          name: schema.name,
          categories: ['other'],
          summary: String(schema.description ?? '').slice(0, 120),
          matchReasons: ['fixture-substring'],
          loaded: false
        })
      }
      return JSON.stringify({
        protocolVersion: 2,
        tool: 'tool_search',
        operation: 'search',
        ok: true,
        data: { catalogGeneration: 'g_fixture_1', category: args.category, candidates, truncated: false },
        nextAction: candidates.length === 0
          ? '零命中：改写 query 或用 tool_list 浏览名称。'
          : '选定候选后，用 ref 与 revision 调用 tool_load。'
      })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'tool_load',
    description: 'Explicitly select tools by exact name or by candidate ref+revision, or unload previously selected tools. Takes effect on the NEXT request; does not execute any target tool.',
    parameters: {
      action: { type: 'string', enum: ['load', 'unload'], description: 'Default "load".' },
      candidates: {
        type: 'array',
        description: 'Candidate refs from tool_search (load path A).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', required: true },
            revision: { type: 'string', required: true }
          }
        }
      },
      names: { type: 'array', description: 'Exact native tool names (load path B).', items: { type: 'string' } },
      toolIds: { type: 'array', description: 'Selected tool ids to unload.', items: { type: 'string' } }
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }]
    },
    execute (args, exec) {
      for (const key of Object.keys(args)) {
        if (!['action', 'candidates', 'names', 'toolIds'].includes(key)) {
          throw new Error(`INVALID_ARGS: unknown field "${key}"`)
        }
      }
      const action = args.action ?? 'load'
      const hasCandidates = Array.isArray(args.candidates) && args.candidates.length > 0
      const hasNames = Array.isArray(args.names) && args.names.length > 0
      const hasToolIds = Array.isArray(args.toolIds) && args.toolIds.length > 0
      let selectionSource
      let selectedItems = []
      let deselected = []
      if (action === 'load') {
        if (hasToolIds) throw new Error('INVALID_ARGS: toolIds is unload-only')
        if (hasCandidates === hasNames) throw new Error('INVALID_ARGS: provide exactly one of candidates or names')
        if (hasNames) {
          if (args.names.length > 4) throw new Error('INVALID_ARGS: max 4 names per load')
          for (const name of args.names) {
            if (ENTRY_NAMES.includes(name)) throw new Error(`INVALID_ARGS: control entry "${name}" cannot be loaded`)
            const definition = exec.agent === undefined ? undefined : ctx.tools.get(name, exec.agent)
            if (definition === undefined) throw new Error(`TOOL_UNAVAILABLE: no tool "${name}" in the current scope`)
          }
          selectionSource = 'name'
          selectedItems = buildSelectedItems(ctx, exec, args.names)
        } else {
          if (args.candidates.length > 4) throw new Error('INVALID_ARGS: max 4 candidates per load')
          const table = store.searchRefs.get(sessionKey(exec)) ?? new Map()
          const names = []
          for (const candidate of args.candidates) {
            const record = table.get(candidate.ref)
            if (record === undefined) throw new Error('CANDIDATE_UNAVAILABLE: candidate ref is unknown or expired')
            if (record.revision !== candidate.revision) throw new Error('STALE_CANDIDATE: candidate revision no longer matches')
            names.push(record.name)
          }
          selectionSource = 'candidate'
          selectedItems = buildSelectedItems(ctx, exec, names)
        }
      } else if (action === 'unload') {
        if (hasCandidates || hasNames) throw new Error('INVALID_ARGS: unload takes toolIds only')
        if (!hasToolIds) throw new Error('INVALID_ARGS: unload needs non-empty toolIds')
        deselected = [...args.toolIds]
      } else {
        throw new Error(`INVALID_ARGS: unknown action "${action}"`)
      }
      return JSON.stringify({
        protocolVersion: 2,
        tool: 'tool_load',
        operation: action,
        ok: true,
        data: {
          receipt: {
            kind: 'tool-discovery.selection',
            version: 2,
            operationId: `op_${exec.callId}`,
            operation: action,
            ...(selectionSource === undefined ? {} : { selectionSource }),
            selected: selectedItems,
            ...(deselected.length > 0 ? { deselected } : {})
          },
          takesEffect: 'next_request',
          schemaDelivery: 'native_tools_only'
        },
        nextAction: action === 'load'
          ? '下一轮看到工具 schema 后，再调用原工具。'
          : '卸载后该工具的新调用会被拒绝；历史保留。'
      })
    }
  }))
}
apply.inject = ['tools']
export default apply

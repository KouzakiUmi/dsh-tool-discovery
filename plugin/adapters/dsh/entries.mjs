// progressive-v2/adapters/dsh/entries.mjs
// 三个 typed definition：tool_list / tool_search / tool_load。
//
//   * 各自**完整**的输入/输出 schema 与 output.render。
//   * execute 只做接线：把宿主 exec 的 scope/callId 交给 domain，返回协议外壳。
//     不做检索排序、不做预算、不做 receipt 校验（全部在 domain）。
//   * operationId 由宿主 callId 派生（`op_<callId>`），热态 pending 与
//     journal 的 canonical call 共用同一个值，形成 F2 的绑定锚点。
import { DomainError, errorEnvelope } from '../../domain/index.mjs';

function envelopeJson(envelope) {
  return JSON.stringify(envelope);
}

/** 从 exec 解析可信 scope；不可信（无 agent）一律 fail closed。 */
function scopeFromExec(exec) {
  const sessionId = exec?.agent?.session?.id;
  const actorId = exec?.agent?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new DomainError('INCOMPATIBLE_COMPOSITION', '缺少宿主会话身份。');
  }
  return { sessionId, actorId: String(actorId) };
}

/**
 * @param {{defineTool:Function, resolve:(exec:any)=>{engine:any,scope:any}, toolName:string}} deps
 */
function definitionFor(deps, spec) {
  return deps.defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args, exec) => {
      let scope;
      let engine;
      try {
        ({ engine, scope } = deps.resolve(exec));
      } catch (error) {
        const err = error instanceof DomainError
          ? error
          : new DomainError('INCOMPATIBLE_COMPOSITION', '当前会话上下文不可用。');
        // 02 §2/§10：失败一律返回标准错误外壳（ok:false + error.code）作为结果文本，
        // 由 journal/reducer 判据（ok!==true → 不激活）把关；不得抛出——DSH 会把 execute
        // 抛错渲染成 `Error: <message>` 非 JSON 文本，破坏协议外壳契约
        // （gate-adapter-lifecycle S03c 冻结断言：结果可 JSON.parse 且 error.code 保留）。
        return envelopeJson(errorEnvelope(spec.name, spec.operation, err));
      }
      const envelope = await spec.run(engine, scope, args, exec);
      return envelopeJson(envelope);
    },
  });
}

/**
 * 构造三个入口 definition。
 * @param {{defineTool:Function, resolve:(exec:any)=>{engine:any,scope:any}}} deps
 */
export function createEntryDefinitions(deps) {
  return [
    definitionFor({ ...deps, toolName: 'tool_list', operation: 'list' }, {
      name: 'tool_list',
      operation: 'list',
      description:
        'Browse discoverable tool names by category in bounded pages. Returns complete native names only — no descriptions, no schemas, no parameters. Never loads anything.',
      parameters: {
        view: { type: 'string', enum: ['available', 'loaded', 'categories', 'state'], description: 'Which bounded view to read. Default "available".' },
        category: { type: 'string', description: 'Required for view "available"/"loaded"; a controlled category id or "all".' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page of the same view.' },
        limit: { type: 'integer', description: 'Page size. Default 20, max 20.' },
      },
      run: (engine, scope, args) => engine.handleList(args, scope),
    }),
    definitionFor({ ...deps, toolName: 'tool_search', operation: 'search' }, {
      name: 'tool_search',
      operation: 'search',
      description:
        'Find a few candidate tools for a task described in natural language, within one controlled category. Returns candidate cards and short-lived refs only; loading happens later via tool_load.',
      parameters: {
        category: { type: 'string', required: true, description: 'A controlled category id, or "all".' },
        query: { type: 'string', required: true, description: 'Natural-language description of the task (not a tool name).' },
        limit: { type: 'integer', description: 'Max candidates. Default 5, max 8.' },
      },
      run: (engine, scope, args) => engine.handleSearch(args, scope),
    }),
    definitionFor({ ...deps, toolName: 'tool_load', operation: 'load' }, {
      name: 'tool_load',
      operation: 'load',
      description:
        'Explicitly select tools by exact native name, or by candidate ref+revision from tool_search; also unloads previously selected tools. Takes effect on the NEXT request — it never executes a target tool.',
      parameters: {
        action: { type: 'string', enum: ['load', 'unload'], description: 'Default "load".' },
        candidates: {
          type: 'array',
          description: 'Candidate refs returned by tool_search (load path A). Mutually exclusive with names.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ref: { type: 'string', required: true, description: 'Opaque candidate ref.' },
              revision: { type: 'string', required: true, description: 'Exact candidate revision.' },
            },
          },
        },
        names: { type: 'array', description: 'Exact native tool names (load path B). Mutually exclusive with candidates.', items: { type: 'string' } },
        toolIds: { type: 'array', description: 'Selected tool ids to unload (action "unload" only).', items: { type: 'string' } },
      },
      async run(engine, scope, args, exec) {
        const outcome = await engine.handleLoad(args, scope, { operationId: `op_${exec.callId}` });
        return outcome.response;
      },
    }),
  ];
}

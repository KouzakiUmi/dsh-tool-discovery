// plugin/adapters/dsh/entries.mjs
// 四个 typed definition：tool_list / tool_search / tool_load / tool_unload。
//
//   * 各自**完整**的输入/输出 schema 与 output.render。
//   * execute 只做接线：把宿主 exec 的 scope 交给 domain，返回协议外壳。
//     load/unload 成功后由 adapter 把 admitted/revoked 提交给 admission
//     store 与掩码（lifecycle.commitAdmissions / revokeAdmissions）。
//   * 失败一律返回标准错误外壳（ok:false + error.code）作为结果文本，
//     不抛出——DSH 会把 execute 抛错渲染成 `Error: <message>` 非 JSON 文本，
//     破坏协议外壳契约。
import { DomainError, errorEnvelope, createText, domainText } from '../../domain/index.mjs';

function envelopeJson(envelope) {
  return JSON.stringify(envelope);
}

/**
 * @param {{defineTool:Function,
 *          resolve:(exec:any)=>{engine:any,scope:any,runtime:any},
 *          commitAdmissions:(runtime:any, rows:any[])=>void,
 *          revokeAdmissions:(runtime:any, names:string[])=>void}} deps
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
      let resolved;
      try {
        resolved = deps.resolve(exec);
      } catch (error) {
        const err = error instanceof DomainError
          ? error
          : new DomainError('INCOMPATIBLE_COMPOSITION', domainText.t(['sessionContextUnavailable']));
        return envelopeJson(errorEnvelope(spec.name, spec.operation, err));
      }
      const { engine, scope, runtime } = resolved;
      const operation = spec.run(engine, scope, args, runtime);
      const envelope = await (deps.trackOperation?.(operation) ?? operation);
      return envelopeJson(envelope);
    },
  });
}

/**
 * 构造四个入口 definition。
 * @param {{defineTool:Function,
 *          resolve:(exec:any)=>{engine:any,scope:any,runtime:any},
 *          commitAdmissions:(runtime:any, rows:any[])=>void,
 *          revokeAdmissions:(runtime:any, names:string[])=>void,
 *          text?:{t:(p:string[])=>string|undefined}}} deps
 */
export function createEntryDefinitions(deps) {
  const text = deps.text ?? createText();
  const d = (...path) => text.t(path) ?? '';
  const load = (key) => d('entry', 'tool_load', key);
  const shared = (key) => d('entry', 'tool_list', key);

  const runLoad = async (engine, scope, args, runtime) => {
    const { response, admitted } = await engine.handleLoad(args, scope);
    if (response.ok === true && Array.isArray(admitted) && admitted.length > 0 && runtime) {
      deps.commitAdmissions(runtime, admitted);
    }
    return response;
  };

  const runUnload = async (engine, scope, args, runtime) => {
    const { response, revoked } = await engine.handleUnload(args, scope);
    if (response.ok === true && Array.isArray(revoked) && runtime) {
      // 未 seed 的名字也必须记撤销墓碑，避免晚到的 durable seed 复活。
      deps.revokeAdmissions(runtime, args.names);
    }
    return response;
  };

  return [
    definitionFor(deps, {
      name: 'tool_list',
      operation: 'list',
      description: d('entry', 'tool_list', 'description'),
      parameters: {
        view: { type: 'string', enum: ['available', 'loaded', 'categories', 'state'], description: d('entry', 'tool_list', 'view') },
        category: { type: 'string', description: d('entry', 'tool_list', 'category') },
        cursor: { type: 'string', description: d('entry', 'tool_list', 'cursor') },
        limit: { type: 'integer', description: d('entry', 'tool_list', 'limit') },
      },
      run: (engine, scope, args) => Promise.resolve(engine.handleList(args, scope)),
    }),
    definitionFor(deps, {
      name: 'tool_search',
      operation: 'search',
      description: d('entry', 'tool_search', 'description'),
      parameters: {
        category: { type: 'string', required: true, description: d('entry', 'tool_search', 'category') },
        query: { type: 'string', required: true, description: d('entry', 'tool_search', 'query') },
        limit: { type: 'integer', description: d('entry', 'tool_search', 'limit') },
      },
      run: (engine, scope, args) => Promise.resolve(engine.handleSearch(args, scope)),
    }),
    definitionFor(deps, {
      name: 'tool_load',
      operation: 'load',
      description: load('description'),
      parameters: {
        candidates: {
          type: 'array',
          description: load('candidates'),
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ref: { type: 'string', required: true, description: shared('candidateRef') },
              revision: { type: 'string', description: shared('candidateRevision') },
            },
          },
        },
        names: { type: 'array', description: load('names'), items: { type: 'string' } },
      },
      run: runLoad,
    }),
    definitionFor(deps, {
      name: 'tool_unload',
      operation: 'unload',
      description: d('entry', 'tool_unload', 'description'),
      parameters: {
        names: { type: 'array', required: true, description: d('entry', 'tool_unload', 'names'), items: { type: 'string' } },
      },
      run: runUnload,
    }),
  ];
}

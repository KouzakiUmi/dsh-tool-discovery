// PTC 只裁剪公开 tools:sdk 文本，不通过 tools.restrict 改变宿主资格目录。
// 曝光只在已品牌化的真实 agent-loop llm/stream 请求中确认，assemble/旧 header 不授信。
import { ENTRY_TOOL_NAMES, DomainError, digestOf } from '../../domain/index.mjs';
import { wireOfSchema } from './registry.mjs';

const RUN_CODE = 'run_code';

export function createPtcDisclosure(deps) {
  const { ctx, lifecycle, enabled, renderToolsSdk, renderToolsSdkPy, isAgentLoopRequest } = deps;
  const log = deps.log ?? (() => {});
  // assembly 与其实际 SDK 快照一一对应；预览不会自己生成 advertised。
  const pending = new WeakMap();

  function allowNames(runtime) {
    const names = new Set([...ENTRY_TOOL_NAMES, ...(deps.frameworkRetained ?? []), ...(runtime.alwaysNameSet ?? [])]);
    names.delete(RUN_CODE);
    const state = runtime.engine.getState(runtime.scope);
    if (state.mode !== 'ready' || runtime.compositionBypass !== null) return names;
    const catalog = runtime.engine.getCatalog();
    for (const item of state.selected.values()) {
      const entry = catalog.entries.get(item.toolId);
      if (state.invalidated.has(item.toolId) || entry === undefined
        || entry.revision !== item.revision || entry.name !== item.name) continue;
      names.add(item.name);
    }
    return names;
  }

  function project(agent, assembly, runtime) {
    const language = ctx.get('ptcRuntime')?.language;
    const render = language === 'typescript' ? renderToolsSdk : language === 'python' ? renderToolsSdkPy : undefined;
    if (typeof render !== 'function' || typeof isAgentLoopRequest !== 'function') {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'PTC discovery requires the host SDK renderer and agent-loop request observer.');
    }
    const sections = assembly.sections ?? [];
    if (sections.filter((section) => section.name === 'tools:sdk').length !== 1) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'PTC discovery requires exactly one tools:sdk section.');
    }
    const allowed = allowNames(runtime);
    const schemas = ctx.tools.sdkSchemas(agent).filter((schema) => allowed.has(schema.name));
    const text = render(schemas);
    const byName = new Map(schemas.map((schema) => [schema.name, wireOfSchema(schema)]));
    const state = runtime.engine.getState(runtime.scope);
    const records = [];
    if (state.mode === 'ready' && runtime.compositionBypass === null) {
      for (const selection of state.selected.values()) {
        const wire = byName.get(selection.name);
        if (wire === undefined || digestOf(wire) !== selection.schemaDigest || state.invalidated.has(selection.toolId)) continue;
        records.push({ toolId: selection.toolId, name: selection.name, revision: selection.revision,
          schemaDigest: selection.schemaDigest, wire });
      }
    }
    pending.set(runtime, { text, records, epoch: state.epoch });
    return { ...assembly, sections: sections.map((section) => section.name === 'tools:sdk'
      ? { ...section, text, interpolate: false } : section) };
  }

  function observeRequest(options) {
    if (enabled() !== true || typeof isAgentLoopRequest !== 'function' || !isAgentLoopRequest(options)) return;
    const runtime = lifecycle.sessions.get(options.sessionId);
    if (runtime === undefined || ctx.tools.modeFor(runtime.agentScope) === 'native') return;
    const snapshot = pending.get(runtime);
    // in-history 路由可能保留多个 system 节点，只认最后一个非空 system 消息。
    const latest = options.messages?.filter((message) => message.role === 'system')
      .map((message) => (message.content ?? []).map((block) => block.type === 'text' ? block.text : '').join(''))
      .filter((text) => text.length > 0).at(-1);
    if (snapshot === undefined || snapshot.epoch !== runtime.engine.getState(runtime.scope).epoch
      || typeof latest !== 'string' || !latest.includes(snapshot.text)) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', 'The outgoing PTC SDK does not match the discovery projection.');
    }
    runtime.journal.recordSdkAdvertisements(snapshot.records);
    log('ptc:sdk-advertised', { sessionId: options.sessionId, names: snapshot.records.map((record) => record.name) });
  }

  return { project, observeRequest, allowNames };
}

// progressive-v2/adapters/dsh/projection.mjs
// system-prompt/assemble 的最终投影。
//
// 规则（03 §3.2 / adapter-plan §4）：
//   * 在 `await next()` **之后**做最终本插件投影 —— 不假设自己是 waterfall 最后一层。
//   * native-only：mode 非 native 直接拒绝组合（INCOMPATIBLE_PRESENTATION）。
//   * 披露集合 = 三入口 ∪ 可信 framework 保留项 ∪ 本会话**有效** selected。
//   * 对**返回值**做校验：不得有重复名，不得有宿主注册表里不存在的幽灵工具
//     （说明有别的 listener 在我们之后又注入了全量 schema）→ INCOMPATIBLE_COMPOSITION。
//   * 调试/预览式 assemble 不算曝光：advertised 只由 canonical request/header 建立。
import { DomainError, ENTRY_TOOL_NAMES } from '../../domain/index.mjs';

/**
 * @param {{ctx:any, lifecycle:any, frameworkRetained?:readonly string[], alwaysVisible?:readonly string[], log?:Function}} deps
 */
export function createProjection(deps) {
  const { ctx, lifecycle } = deps;
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
  // DSH 自带工具常驻可见；过滤只针对后装的插件/MCP 工具。
  const alwaysVisible = new Set([...(deps.alwaysVisible ?? [])]);
  const log = deps.log ?? (() => {});

  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const transformed = await next();
    const agent = context?.agent;
    if (agent === undefined) return transformed;

    const scope = agent;
    const mode = ctx.tools.modeFor(context.scope ?? scope);
    if (mode !== 'native') {
      throw new DomainError('INCOMPATIBLE_PRESENTATION', `tools mode "${mode}" is not supported`);
    }

    // 首次触达即建立本会话 runtime（可能仍处于 restoring → 只留三入口）
    const runtime = lifecycle.runtimeFor(agent.session, scope);
    const allowed = new Set(ENTRY_TOOL_NAMES);
    for (const name of frameworkRetained) allowed.add(name);
    for (const name of alwaysVisible) allowed.add(name);
    if (runtime.compositionBypass === null) {
      for (const name of runtime.journal.activeSelectedNames()) allowed.add(name);
    }

    const incoming = Array.isArray(transformed?.tools) ? transformed.tools : [];
    /** @type {any[]} */
    const kept = [];
    const seen = new Set();
    for (const tool of incoming) {
      if (!allowed.has(tool?.name)) continue;
      if (seen.has(tool.name)) {
        throw new DomainError('INCOMPATIBLE_COMPOSITION', `duplicate disclosed tool "${tool.name}"`);
      }
      seen.add(tool.name);
      if (ctx.tools.get(tool.name, scope) === undefined) {
        throw new DomainError('INCOMPATIBLE_COMPOSITION', `disclosed tool "${tool.name}" is not resolvable in the host registry`);
      }
      kept.push(tool);
    }
    if (runtime.restoring || runtime.compositionBypass !== null) {
      log('projection:fail-closed', {
        sessionId: agent.session.id,
        restoring: runtime.restoring,
        bypass: runtime.compositionBypass,
        kept: kept.map((t) => t.name),
      });
    }
    return { ...transformed, tools: kept };
  });
}

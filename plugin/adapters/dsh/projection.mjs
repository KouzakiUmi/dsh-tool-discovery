// progressive-v2/adapters/dsh/projection.mjs
// system-prompt/assemble 的最终投影。
//
// 规则（03 §3.2 / adapter-plan §4）：
//   * 在 `await next()` **之后**做最终本插件投影 —— 不假设自己是 waterfall 最后一层。
//   * native-only：mode 非 native 直接拒绝组合（INCOMPATIBLE_PRESENTATION）。
//   * 披露集合 = 三入口 ∪ 可信 framework 保留项 ∪ 常驻工具 ∪ 本会话**有效** selected
//     ∪ 披露缓存（frozen）。
//   * **顺序固化**：本轮组装里已披露的工具保持宿主给出的相对次序，随后**纯追加**
//     披露缓存里尚未出现的项。加载下一个工具不会移动任何既有项；缓存里那份 wire
//     逐字覆盖宿主本轮的同名 schema（宿主换版不得让模型上下文里的定义静默变形）。
//   * 对**返回值**做校验：不得有重复名，不得有宿主注册表里不存在的幽灵工具
//     （说明有别的 listener 在我们之后又注入了全量 schema）→ INCOMPATIBLE_COMPOSITION。
//   * 调试/预览式 assemble 不算曝光：advertised 只由 canonical request/header 建立。
//
// **未发送刷新**（宿主自动压缩边界）：
//   `dsh-agent-loop` 先 `systemPrompt.assemble()`，**之后**才跑 `agent/pre-step`
//   （basic 自动压缩就发生在这里），最后无条件返回当初那份旧 assembly
//   （dsh-agent-loop lib/index.js:907 / :911 / :921-923）。也就是说：一次成功压缩
//   换掉了缓存周期与常驻名单，但**下一次真正发出去的 tools 数组仍是压缩前那份**。
//
//   这里不碰 core、不要求重新 assemble、不新增服务：投影在返回前把"重做一次投影"
//   的回调存到 runtime 上（`refreshPendingProjection`），成功压缩换完名单后调用它，
//   用**同一个数组**原地 `splice` 覆盖内容。`system-prompt` 对 assembly 最多做浅
//   复制（lib/index.js:355-361 不碰 tools），所以调用方持有的正是我们返回的那个数组。
//   一旦 canonical `request/header` 观测到，这份数组已经发出去，journal 立即清掉回调
//   —— 否则一次手动空闲压缩会去改写已发送的历史数组。
//   普通配置更新**不**调它：只有成功压缩重开周期才刷新。
import { DomainError, ENTRY_TOOL_NAMES } from '../../domain/index.mjs';

/**
 * @param {{ctx:any, lifecycle:any, frameworkRetained?:readonly string[], log?:Function}} deps
 */
export function createProjection(deps) {
  const { ctx, lifecycle } = deps;
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
  // 常驻工具名单**不在**这里取用：它是 per-runtime 的（见 lifecycle.adoptEpochNames），
  // 成功压缩会重开一个周期并换上新名单，apply 期的静态快照到那时已经过期。
  const log = deps.log ?? (() => {});

  /**
   * 按 runtime 的**当前**状态重算一次投影。纯读：可安全地重复调用。
   * @param {any} runtime
   * @param {any} scope
   * @param {any[]} incoming 本轮宿主给出的全量工具（顺序基准）
   * @returns {any[]}
   */
  function project(runtime, scope, incoming) {
    // 常驻基线：三入口 + 可信 framework 保留项 + 常驻工具。
    // **不**把 selected 并进基线 —— 加载工具必须由下面的「已加载段」按首次披露
    // 次序追加，否则会被宿主的字典序重新排序。
    const allowed = new Set(ENTRY_TOOL_NAMES);
    for (const name of frameworkRetained) allowed.add(name);
    for (const name of runtime.alwaysNameSet ?? []) allowed.add(name);

    const byName = new Map(incoming.map((tool) => [tool.name, tool]));

    // 常驻基线段保持宿主给出的相对次序（原语义），但**不参与**加载工具的排序。
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

    // 已加载段 = 披露缓存（首次披露次序）+ 尚未披露的 selected（选中次序）。
    // 顺序**只**由首次披露次序决定，绝不由宿主字典序决定：先载 z 再载 a 必须得到
    // [..., z, a]。宿主本轮没提供的（如已被撤权）按冻结 wire 继续披露。
    //
    // fail closed / 恢复中一律不披露任何已加载项：引擎在这两种状态下**按设计保留**
    // selected 与 frozen 作为保守残留，它们不授予执行权（evaluateCall 先判 mode），
    // 但绝不能继续进入出站投影 —— 否则 fail closed 只停在执行面，隐藏工具的完整
    // schema 仍会随下一轮出站泄露（SEQ6 冻结断言）。
    const engineState = runtime.engine.getState(runtime.scope);
    if (runtime.compositionBypass === null && !runtime.restoring && engineState.mode === 'ready') {
      const frozen = runtime.engine.getFrozenWire(runtime.scope);
      const frozenByName = new Map(frozen.map((f) => [f.name, f]));
      const queue = frozen.map((f) => f.name);
      const selected = engineState.selected;
      for (const record of Array.from(selected.values()).sort((a, b) => a.seq - b.seq)) {
        if (!frozenByName.has(record.name)) queue.push(record.name);
      }
      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);
        const record = frozenByName.get(name);
        const host = byName.get(name);
        if (host !== undefined) kept.push(record === undefined ? host : { ...host, ...record.wire });
        else if (record !== undefined) kept.push({ ...record.wire });
      }
    }

    if (runtime.restoring || runtime.compositionBypass !== null) {
      log('projection:fail-closed', {
        sessionId: runtime.scope.sessionId,
        restoring: runtime.restoring,
        bypass: runtime.compositionBypass,
        kept: kept.map((t) => t.name),
      });
    }
    return kept;
  }

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
    const incoming = Array.isArray(transformed?.tools) ? transformed.tools : [];
    const kept = project(runtime, scope, incoming);

    // 留一份"尚未发送"的刷新入口。只保留最新一份：连续两次 assemble 以后一份为准。
    runtime.refreshPendingProjection = () => {
      try {
        const next_kept = project(runtime, scope, incoming);
        kept.splice(0, kept.length, ...next_kept);
        log('projection:pending-refreshed', {
          sessionId: runtime.scope.sessionId,
          kept: kept.map((t) => t.name),
        });
        return true;
      } catch (error) {
        // 数组被冻结 / 投影判据被触发：如实记录并放弃，绝不吞掉。
        log('projection:pending-refresh-failed', { error: String(error) });
        return false;
      }
    };

    return { ...transformed, tools: kept };
  });
}

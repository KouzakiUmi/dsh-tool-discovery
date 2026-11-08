// plugin/adapters/dsh/guard.mjs
// 同步执行披露门禁（rc.1 重设计）：只**增加拒绝**，不授予任何权限。
//
// 判据（docs/14-rc1-redesign.md §执行门禁）：
//   * 入口/framework/alwaysVisible：永远放行（受保护面本来就要求已披露）。
//   * 受控池（engine catalog 内的名字）：
//     - admission 无记录 → NOT_ADMITTED
//     - admission.schemaDigest 与当前解析出的定义不一致（换版/同名覆盖）
//       → DEFINITION_CHANGED，要求重新 load
//   * own-scope 注册的工具遮不住：gateOwnScopeTools=true（默认）时同样要求
//     admission；catalog 解析不到的 own-scope 名字（宿主私有注册）放行——
//     我们不声称能管理自己看不见定义的工具，但遮不住的名下若 catalog
//     有记录仍按 digest 判定。
//   * 调用面不区分存在性：对外文案只由 reason 决定，细节只进宿主日志。
import { ENTRY_TOOL_NAMES, CORE_TOOL_NAMES } from '../../domain/index.mjs';

/**
 * @param {{ctx:any, lifecycle:any, tracker:any,
 *          frameworkRetained?:readonly string[],
 *          respectAlwaysVisible?:()=>boolean,
 *          controlDefinitions?:Map<string,any>,
 *          locale?:string, log?:Function}} deps
 */
export function createGuard(deps) {
  const { ctx, lifecycle, tracker } = deps;
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
  const respectAlwaysVisible = typeof deps.respectAlwaysVisible === 'function'
    ? deps.respectAlwaysVisible
    : () => false;
  const entryNames = new Set(ENTRY_TOOL_NAMES);
  const coreNames = new Set(CORE_TOOL_NAMES);
  const controlDefinitions = deps.controlDefinitions ?? new Map();
  const log = deps.log ?? (() => {});

  /**
   * 定义是否仍与 admission 时一致：按 admission.toolId 直查当前目录。
   * 不用 byName——同名 shadow 时 admission 的 toolId 才是消歧键。
   */
  function currentDigest(runtime, admission) {
    const entry = runtime.engine.getCatalog()?.entries?.get?.(admission.toolId);
    if (entry === undefined || entry === null) return null;
    if (entry.name !== admission.name) return null;
    return entry.schemaDigest;
  }

  /** 名字是否在受控目录里（不管 shadow 几重，只要在就有受控义务）。 */
  function inCatalog(runtime, name) {
    const arr = runtime.engine.getCatalog()?.byName?.get?.(name);
    return Array.isArray(arr) && arr.length > 0;
  }

  const denyReasons = {
    notAdmitted: (name) => `tool "${name}" is not admitted: load it with tool_load first`,
    definitionChanged: (name) => `tool "${name}" changed after admission: load it again with tool_load`,
    shadowedEntry: (name) => `tool "${name}" is shadowed by another registration and cannot be dispatched`,
    unavailable: (name) => `tool "${name}" is not admitted: tool catalog unavailable`,
  };

  const guard = (exec) => {
    const agent = exec?.agent;
    if (!agent || agent.session === undefined) return undefined;
    const name = exec?.name;
    if (typeof name !== 'string' || name.length === 0) return undefined;
    const sessionId = agent.session.id;

    // 入口三件套：被同名覆盖时按宿主语义执行的是别人的定义——拒绝，
    // 不让模型在不知情下调用到一个影子实现。
    if (entryNames.has(name)) {
      const registered = controlDefinitions.get(name);
      if (registered === undefined) return undefined; // 未登记（组合异常）→ 交给宿主
      try {
        return ctx.tools.get(name, agent) === registered ? undefined : denyReasons.shadowedEntry(name);
      } catch {
        return denyReasons.shadowedEntry(name);
      }
    }
    if (frameworkRetained.has(name)) return undefined;

    const runtime = lifecycle.sessions.get(sessionId);
    if (runtime === undefined) {
      // 会话 runtime 未建立：首个被调用的若是隐藏池工具，照样拦——
      // 但此时目录都没建，连"它是不是受控的"都无法判，保守放行非受控名字
      // 只对 runtime 建立后的调用生效；首个调用若是受控工具，说明模型在猜名，
      // 目录不可用就按不可准入拒（fail closed 方向）。
      return undefined;
    }
    if (runtime.alwaysNameSet?.has(name) === true) return undefined;
    if (respectAlwaysVisible() !== true
      && lifecycle.currentInitialToolsEnabled?.() !== false && coreNames.has(name)) {
      // 核心工具免披露放行（装载自证口径与 alwaysNames 计算一致）。
      const view = ctx.tools.view(agent);
      if (view?.visible?.has(name) === true) return undefined;
    }

    const admission = tracker.get(sessionId, name);
    if (admission === undefined || admission === null) {
      if (runtime.gateOwnScope === false) {
        // gateOwnScopeTools=false：own-scope 注册完全不受管（即使名字碰巧在
        // catalog 里）；只有 host 可遮的 global/父 scope 名字仍须准入。
        const restrictable = ctx.tools.view(agent)?.restrictableNames;
        if (restrictable?.has?.(name) !== true) return undefined;
        log('guard:not-admitted', { sessionId, name });
        return denyReasons.notAdmitted(name);
      }
      if (!inCatalog(runtime, name)) {
        // 目录没有该名字：own-scope 私有注册或刚注册的第三方工具，
        // 我们不声称能管理看不见定义的工具 → 放行，由宿主语义兜底。
        const restrictable = ctx.tools.view(agent)?.restrictableNames;
        if (restrictable?.has?.(name) === true) return denyReasons.notAdmitted(name);
        return undefined;
      }
      log('guard:not-admitted', { sessionId, name });
      return denyReasons.notAdmitted(name);
    }
    if (lifecycle.admittedForStep?.(exec.toolSet, name, admission) === false) {
      return `tool "${name}" was loaded during this request: wait for the next request`;
    }
    const digest = currentDigest(runtime, admission);
    if (digest === null || digest !== admission.schemaDigest) {
      log('guard:definition-changed', { sessionId, name });
      return denyReasons.definitionChanged(name);
    }
    return undefined;
  };

  return ctx.tools.guard(guard);
}

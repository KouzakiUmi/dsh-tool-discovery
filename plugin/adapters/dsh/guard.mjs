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
//   * 停用场景（绑定 preset 在 disabledPresets 里）：本插件不增加任何准入拒绝，
//     只拦四个入口——它们已被掩码移出可见面，猜名调用同样不可派发。
import { ENTRY_TOOL_NAMES, CORE_TOOL_NAMES } from '../../domain/index.mjs';

/**
 * @param {{ctx:any, lifecycle:any, tracker:any,
 *          frameworkRetained?:readonly string[],
 *          respectAlwaysVisible?:()=>boolean,
 *          isPresetDisabled?:(agent:any)=>boolean,
 *          controlDefinitions?:Map<string,any>,
 *          locale?:string, log?:Function}} deps
 */
export function createGuard(deps) {
  const { ctx, lifecycle, tracker } = deps;
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
  const respectAlwaysVisible = typeof deps.respectAlwaysVisible === 'function'
    ? deps.respectAlwaysVisible
    : () => false;
  const isPresetDisabled = typeof deps.isPresetDisabled === 'function'
    ? deps.isPresetDisabled
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
    discoveryDisabled: (name) => `tool "${name}" is unavailable: tool discovery is disabled in this preset`,
  };

  const guard = (exec) => {
    const agent = exec?.agent;
    if (!agent || agent.session === undefined) return undefined;
    const name = exec?.name;
    if (typeof name !== 'string' || name.length === 0) return undefined;
    const sessionId = agent.session.id;

    // 停用场景：四个入口一律不可派发（它们已被掩码移出可见面），其余名字不做任何
    // 准入判断——插件在这个 preset 下等于不存在。
    if (isPresetDisabled(agent)) {
      if (!entryNames.has(name)) return undefined;
      log('guard:discovery-disabled', { sessionId, name });
      return denyReasons.discoveryDisabled(name);
    }

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
      // 会话 runtime 未建立是**异常状态**（正常路径下 agent/created 内已同步建好；
      // 走到这里通常是 warmup 因畸形第三方定义失败）。
      //
      // 此时没有目录，判不出"是否受控"，但 own-scope 名字宿主**遮不住**、会被直接
      // 披露，准入是它们唯一的闸门——对这些名字必须 fail-closed，否则该会话的全部
      // own-scope 工具都能不经 tool_load 执行（实测可达，见审查复现 P2/P5）。
      // 可遮（global/父 scope）名字交给宿主可见性与掩码：未准入的名字不在可见面，
      // 猜名也解析不到定义。
      let restrictable = null;
      try { restrictable = ctx.tools.view(agent)?.restrictableNames ?? null; } catch { restrictable = null; }
      if (restrictable?.has?.(name) === true) return undefined;
      log('guard:runtime-missing', { sessionId, name });
      return denyReasons.unavailable(name);
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

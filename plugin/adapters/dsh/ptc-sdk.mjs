// PTC 兼容开启时，披露目标是下一轮 run_code SDK，不是模型可直接调用的 tools。
// SDK 在 system-prompt/assemble 瀑布之前生成，所以 restriction 必须提前装上。
// 开关关闭时不安装 restriction，调用方对 PTC 会话直接 bypass。
import { ENTRY_TOOL_NAMES } from '../../domain/constants.mjs';

const RUN_CODE = 'run_code';

/**
 * @param {{ctx:any, lifecycle:any, enabled:() => boolean, log?:Function}} deps
 */
export function createPtcDisclosure(deps) {
  const { ctx, lifecycle, enabled } = deps;
  const log = deps.log ?? (() => {});
  /** sessionId → { agent, dispose }。必须可枚举，插件卸载时才能全部撤下。 */
  const installed = new Map();

  function lift(agent) {
    const key = agent?.session?.id;
    const entry = key === undefined ? undefined : installed.get(key);
    if (entry === undefined) return;
    installed.delete(key);
    try { entry.dispose(); }
    catch (error) { log('ptc:restriction-lift-failed', { error: String(error) }); }
  }

  function disposeAll() {
    for (const key of [...installed.keys()]) lift(installed.get(key)?.agent);
  }

  function runtimeOf(agent) {
    return lifecycle.sessions?.get(agent?.session?.id);
  }

  /**
   * 下一轮 SDK 应出现的名字。不含 run_code。
   * 有 runtime 时基线只认已采纳的 alwaysNameSet，不读可能已经偏离可信记录的活配置。
   * selected 只保留当前目录里版本仍一致、且引擎已就绪的项。
   */
  function allowNames(agent) {
    const names = new Set(ENTRY_TOOL_NAMES);
    const runtime = runtimeOf(agent);
    const baseline = runtime?.alwaysNameSet ?? lifecycle.currentAlwaysNames?.(agent) ?? [];
    for (const name of baseline) {
      if (typeof name === 'string' && name.length > 0 && name !== RUN_CODE) names.add(name);
    }
    const state = runtime?.engine?.getState?.(runtime.scope);
    if (state?.mode !== 'ready' || typeof state.selected?.values !== 'function') return names;
    const catalog = runtime.engine.getCatalog?.();
    for (const item of state.selected.values()) {
      if (typeof item?.name !== 'string' || item.name === RUN_CODE || item.name.length === 0) continue;
      if (state.invalidated?.has?.(item.toolId) === true) continue;
      const entry = catalog?.entries?.get?.(item.toolId);
      if (entry === undefined || entry.revision !== item.revision || entry.name !== item.name) continue;
      names.add(item.name);
    }
    return names;
  }

  /**
   * 按当前开关和展示模式安装或撤下 restriction。
   * 失败只记日志：agent/created 抛错会拒绝整个 agent 发布。
   */
  function sync(agent) {
    if (agent?.ctx?.tools?.restrict === undefined) return false;
    let mode = 'native';
    try { mode = ctx.tools.modeFor(agent); }
    catch { return false; }
    if (mode === 'native' || enabled() !== true) {
      lift(agent);
      return false;
    }
    let known;
    try { known = ctx.tools.view(agent)?.restrictableNames; }
    catch (error) {
      log('ptc:restriction-view-failed', { error: String(error) });
      return false;
    }
    const allow = [...allowNames(agent)].filter((name) => known?.has?.(name) === true);
    lift(agent);
    try {
      const dispose = agent.ctx.tools.restrict({ allow });
      if (agent.session?.id !== undefined) installed.set(agent.session.id, { agent, dispose });
      log('ptc:sdk-restricted', { sessionId: agent.session?.id, allow });
      return true;
    } catch (error) {
      log('ptc:restriction-failed', { sessionId: agent.session?.id, error: String(error) });
      return false;
    }
  }

  return { sync, lift, disposeAll, allowNames };
}

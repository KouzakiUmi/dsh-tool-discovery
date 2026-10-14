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
  /** @type {WeakMap<object, Function>} */
  const installed = new WeakMap();

  function lift(agent) {
    const dispose = installed.get(agent);
    if (typeof dispose !== 'function') return;
    installed.delete(agent);
    try { dispose(); }
    catch (error) { log('ptc:restriction-lift-failed', { error: String(error) }); }
  }

  /** 下一轮 SDK 应出现的名字。不含 run_code。 */
  function allowNames(agent) {
    const names = new Set(ENTRY_TOOL_NAMES);
    for (const name of lifecycle.currentAlwaysNames?.(agent) ?? []) {
      if (typeof name === 'string' && name.length > 0 && name !== RUN_CODE) names.add(name);
    }
    const runtime = lifecycle.sessions?.get(agent?.session?.id);
    const selected = runtime?.engine?.getState?.(runtime.scope)?.selected;
    if (selected !== undefined && typeof selected.values === 'function') {
      for (const item of selected.values()) {
        if (typeof item?.name === 'string' && item.name !== RUN_CODE) names.add(item.name);
      }
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
      installed.set(agent, agent.ctx.tools.restrict({ allow }));
      log('ptc:sdk-restricted', { sessionId: agent.session?.id, allow });
      return true;
    } catch (error) {
      log('ptc:restriction-failed', { sessionId: agent.session?.id, error: String(error) });
      return false;
    }
  }

  return { sync, lift, allowNames };
}

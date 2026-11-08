// plugin/adapters/dsh/mask.mjs
// rc.1 掩码协调器：每 agent 一个 `restrict({allow})`，allow = 常驻 ∪ admitted。
//
// 设计（docs/14-rc1-redesign.md §掩码）：
//   * 只能遮 `view.restrictableNames`（global/inherited）；own-scope 注册
//     天然不在其中——遮不住不是缺陷，执行门禁兜底，文档化为宿主边界。
//   * allow 名单：三入口 + frameworkRetained + alwaysVisible + admitted 名字，
//     只保留当前确实 restrictable 的名字（未注册名字给 restrict 会抛
//     "unknown global tool"，所以先过滤再排序——排序只是为了稳定 diff 键）。
//   * 换版策略与旧 native-restriction 相同：先装新掩码再解除旧掩码，
//     交集瞬间不会变宽。换版失败旧掩码仍在线（更严），state.error 记录现场。
//   * reconcile 时机：agent/created（宿主 await 内同步装）、tool_load/unload
//     之后、tools/change、agent/pre-step。load 当步立即更新掩码：工具在
//     声明数组里从下一步出现，与宿主声明时间线一致，不需要 pending 两步提交。
//   * PTC 与 native 统一：restrict 影响 view.visible，SDK 投影同源过滤；
//     不再区分展示模式（旧实现为旧宿主绕路而设的 PTC lift 分支删除）。
//   * 自反馈环：自己换掩码触发的 tools/change 由 mutating 计数识别，
//     reconcile 调用方跳过全量重算（registry-change 指纹另有职责）。
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs';

export function createMaskController({ ctx, frameworkRetained = [], getAlwaysVisible, log = () => {} }) {
  /**
   * agent → state：
   *   disposer/active —— 当前生效的 restriction 及其 filter；
   *   filters —— 本插件仍持有、且（据宿主层观察）尚未解除的全部自有 filter；
   *   pending —— 释放时抛错的旧 disposer，留到下一次 reconcile 重试，不丢跟踪。
   * @type {Map<any, {disposer:Function|null, filters:Set<any>, active:any[], pending:{disposer:Function, filters:any[]}[], key:string|null, error:any}>}
   */
  const states = new Map();
  const alwaysVisibleNames = new Set(frameworkRetained);
  const alwaysNamesFor = typeof getAlwaysVisible === 'function' ? getAlwaysVisible : () => [];
  let mutating = 0;

  /**
   * 目标 allow 名单：入口 + framework 保留 + 常驻（alwaysVisible）+ admitted，
   * 按当前 restrictable 过滤。常驻名单必须进 allow：否则初始工具被遮住，
   * 出现"模型看不见但门禁放行"的矛盾面。
   * @param {any} agent
   * @param {Set<string>} admittedNames
   */
  function desired(agent, admittedNames) {
    const restrictable = ctx.tools.view(agent).restrictableNames;
    const names = new Set([...ENTRY_TOOL_NAMES, ...alwaysVisibleNames]);
    for (const name of alwaysNamesFor(agent) ?? []) names.add(name);
    for (const name of admittedNames ?? []) names.add(name);
    return [...names].filter((name) => restrictable.has(name)).sort();
  }

  /** 当前仍留在该 agent 宿主层里的 restriction filter（回收判断的唯一依据）。 */
  function liveFilters(agent) {
    return new Set(ctx.tools.layers.peek(agent)?.restrictions?.values() ?? []);
  }

  /**
   * 释放一个自有 restriction，异常不外抛、也不丢跟踪：
   *   * 调用方按返回值决定是否留待下次 reconcile 重试；
   *   * 只有宿主层里确实已不存在的 filter 才从 state.filters 移除，
   *     仍在生效的自己 filter 保守保留（ownedFilters/filtersFor 继续认领），
   *     第三方的 filter 从不进入 state.filters。
   * @returns {boolean} 其 filter 是否全部离开宿主层（= 已确认解除）
   */
  function releaseOwned(agent, state, entry) {
    try {
      entry.disposer();
    } catch (error) {
      log('mask:release-failed', { agentId: agent?.id, error: String(error?.message ?? error) });
    }
    const live = liveFilters(agent);
    for (const filter of entry.filters) {
      if (!live.has(filter)) state.filters.delete(filter);
    }
    return entry.filters.every((filter) => !live.has(filter));
  }

  /** 重试此前释放失败的旧 disposer；已确认解除的条目出队。 */
  function retryPending(agent, state) {
    if (state.pending.length === 0) return;
    state.pending = state.pending.filter((entry) => !releaseOwned(agent, state, entry));
  }

  /**
   * 同步 reconcile：把 agent 的掩码换成 desired 集合。
   * @param {any} agent
   * @param {Set<string>|Map<string,any>} admittedNames admitted 工具名集合（Set 或 Map 的 keys）
   */
  function update(agent, admittedNames) {
    let state = states.get(agent);
    if (state === undefined) {
      state = { disposer: null, filters: new Set(), active: [], pending: [], key: null, error: null };
      states.set(agent, state);
    }
    const names = admittedNames instanceof Map ? new Set(admittedNames.keys()) : admittedNames;
    const allow = desired(agent, names);
    const key = JSON.stringify(allow);
    // 每次 reconcile 都重试此前释放失败的旧掩码：不换集合也要能自愈。
    if (state.pending.length > 0) {
      mutating++;
      try { retryPending(agent, state); } finally { mutating--; }
    }
    if (state.key === key && state.disposer) { state.error = null; return; }
    const before = liveFilters(agent);
    let disposer;
    let installed = false;
    mutating++;
    try {
      // Add first, then release: temporary intersection never broadens access.
      disposer = agent.ctx.tools.restrict({ allow });
      const added = [...liveFilters(agent)].filter((item) => !before.has(item));
      if (added.length !== 1) throw new Error('Unable to identify the discovery restriction');
      state.filters.add(added[0]);
      installed = true;
      const old = state.disposer;
      const oldFilters = state.active;
      state.disposer = disposer;
      state.active = added;
      state.key = key;
      state.error = null;
      if (old) {
        // 旧 disposer 的异常在这里被隔离：新掩码已是 state.disposer，
        // 不能因为释放旧掩码失败而把新掩码也释放掉（那样会彻底失联）。
        const entry = { disposer: old, filters: oldFilters };
        if (!releaseOwned(agent, state, entry)) state.pending.push(entry);
      }
    } catch (error) {
      // 新掩码装不上时旧掩码仍生效（偏严）：记录现场，reconcile 下一个
      // 触发点（pre-step / tools/change）会重试。
      state.error = error;
      log('mask:update-failed', { agentId: agent?.id, error: String(error?.message ?? error) });
      if (disposer) { try { disposer(); } catch { /* 尽力释放 */ } }
    } finally {
      mutating--;
      if (!installed && state.disposer === null && state.filters.size === 0) {
        // 从未成功安装过且现在也没有掩码：key 置 null，下次仍会尝试。
        state.key = null;
      }
    }
  }

  return {
    /** agent/created（宿主 await）内同步装掩码；admitted 为当前已读回的集合。 */
    ensure(agent, admittedNames) {
      if (states.has(agent)) { update(agent, admittedNames); return; }
      update(agent, admittedNames);
    },
    update,
    disposeAgent(agent) {
      const state = states.get(agent);
      if (state === undefined) return;
      mutating++;
      try {
        for (const entry of state.pending) { try { entry.disposer(); } catch { /* 尽力 */ } }
        if (state.disposer) state.disposer();
      } finally {
        mutating--;
        states.delete(agent);
      }
    },
    /** 本插件持有的全部 restriction filter（registry-change 指纹据此忽略自己）。 */
    ownedFilters() {
      const owned = [];
      for (const state of states.values()) for (const filter of state.filters) owned.push(filter);
      return owned;
    },
    /** 某 agent 的本插件 filters（catalog 构造 unrestricted view 用）。 */
    filtersFor(agent) {
      return states.get(agent)?.filters ?? new Set();
    },
    isMutating: () => mutating > 0,
    /** 观测面：某 agent 的最近错误（诊断/测试用）。 */
    errorOf(agent) { return states.get(agent)?.error; },
    dispose() {
      for (const agent of [...states.keys()]) {
        try { this.disposeAgent(agent); } catch { /* 尽力 */ }
      }
    },
  };
}

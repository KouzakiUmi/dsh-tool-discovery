// plugin/adapters/dsh/lifecycle.mjs
// 会话 runtime 生命周期（rc.1 重设计，docs/14-rc1-redesign.md）。
//
// 每个会话一个 runtime：{engine, scope, admission 视图、alwaysNameSet、mask 回调}。
// 与旧版的全部差异：
//   * 没有 epoch ledger、journal、canonical 回执、恢复缓冲、可信基线屏障与
//     STATE_NOT_READY 等待。会话创建即 ready；resume 的种子是 admission store
//     的 durable 记录，读不回就当零 admitted（全遮），不阻断任何请求。
//   * runtime 目录（engine bindings）来自 **unrestricted view**（忽略本插件
//     掩码）：被掩码的工具必须出现在 tool_list/tool_search 里。
//   * selected 与 admission 的一致性由本层维护：tool_load 成功 → admit；
//     tool_unload → revoke；invalidate（换版/撤权）→ prune admission 并重掩码。
//   * 掩码 reconcile 的触发点：agent/created（index 层调用 ensureMask）、
//     tool_load/unload 之后、tools/change、agent/pre-step。本模块只做
//     session 级事实，agent 级掩码在 mask.mjs。
import { createDiscoveryEngine, CORE_TOOL_NAMES, DomainError, PROTOCOL_VERSION } from '../../domain/index.mjs';
import { resolveAlwaysVisible } from './config.mjs';
import { viewWithoutRestriction } from './restriction-view.mjs';

/**
 * @param {{ctx:any, registry:any, config:any, clock:any, random:any, log?:Function,
 *          tracker:any, mask:any, viewFor?:(scope:any)=>any,
 *          getAlwaysVisible?:()=>readonly string[],
 *          getInitialToolsEnabled?:()=>boolean|{get():boolean},
 *          getRespectAlwaysVisible?:()=>boolean|{get():boolean},
 *          getPresetTools?:(agentScope:any)=>readonly string[],
 *          onRuntimeCreated?:Function}} deps
 */
export function createLifecycle(deps) {
  const { ctx, registry, config, clock, random, tracker, mask, log = () => {} } = deps;
  /** sessionId → runtime */
  const sessions = new Map();
  // 阻止在途组装复活已销毁的 runtime。
  const disposedScopes = new WeakSet();
  const activation = new AbortController();
  const stepAdmissions = new WeakMap();
  const operations = new Set();

  function assertActive() {
    if (activation.signal.aborted) throw activation.signal.reason;
  }

  async function waitForActive(pending) {
    let onAbort;
    try {
      const value = await Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          if (activation.signal.aborted) { reject(activation.signal.reason); return; }
          onAbort = () => reject(activation.signal.reason);
          activation.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      assertActive();
      return value;
    } catch (error) {
      assertActive();
      throw error;
    } finally {
      if (onAbort !== undefined) activation.signal.removeEventListener('abort', onAbort);
    }
  }

  function respectAlwaysVisible() {
    const raw = typeof deps.getRespectAlwaysVisible === 'function'
      ? deps.getRespectAlwaysVisible() : config.respectAlwaysVisible;
    const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
    return value === true;
  }

  function currentInitialToolsEnabled() {
    const raw = typeof deps.getInitialToolsEnabled === 'function'
      ? deps.getInitialToolsEnabled() : config.initialToolsEnabled;
    return (typeof raw?.get === 'function' ? raw.get() : raw) !== false;
  }

  /** 忽略本插件掩码的可见面：目录必须是"资格事实"，不是"当前披露事实"。 */
  function catalogViewFor(agentScope) {
    const filters = mask.filtersFor(agentScope);
    if (filters.size === 0) {
      return typeof deps.viewFor === 'function' ? deps.viewFor(agentScope) : ctx.tools.view(agentScope);
    }
    return viewWithoutRestriction(ctx.tools, agentScope, filters);
  }

  /**
   * 常驻名单的 memo：同一 scope 在"注册表代次 + 各配置读数"未变时直接复用。
   * 本函数在每次 tool_* 入口执行、每次 reconcileMask、每次工具执行 guard 前都
   * 跑；视图探测（preset peek + 核心自证可见面）是它最贵的部分，按代次 memo
   * 后稳态入口调用从两遍 layer 遍历降到零。tools/change（onRegistryChange）
   * 与 disposeSession 显式清缓存；配置值直接进 key，volatile 热改即时生效。
   * @type {Map<string, {key: string, names: string[]}>} scopeKey → 缓存项
   */
  const alwaysCache = new Map();

  /**
   * 此刻配置的常驻名单：显式配置 ∪ preset 保留项 ∪ 运行时装载自证
   * （respectAlwaysVisible 关闭时，把 scope 实际装载的核心工具并入）。
   */
  function currentAlwaysNames(agentScope) {
    const enabled = currentInitialToolsEnabled();
    const configured = typeof deps.getAlwaysVisible === 'function'
      ? resolveAlwaysVisible([...deps.getAlwaysVisible()])
      : enabled === false ? [] : resolveAlwaysVisible(config.alwaysVisible);
    const respect = respectAlwaysVisible();
    const scopeKey = registry.scopeKeyOf(agentScope);
    // presetToken 覆盖「preset 重绑但 tools/change 未同步推进」的边角：token 是
    // 便宜的 generationFor 查询，进 key 后这类变化不会吃到过期缓存。
    const presetToken = typeof deps.getPresetToken === 'function' ? deps.getPresetToken(agentScope) : '';
    // JSON.stringify 做键：天然转义，不存在分隔符碰撞问题。
    const cacheKey = JSON.stringify([scopeKey, registry.generationFor(scopeKey), enabled ? 1 : 0, respect ? 1 : 0, presetToken, ...configured]);
    const hit = alwaysCache.get(scopeKey);
    if (hit !== undefined && hit.key === cacheKey) return hit.names;

    // 本轮共享一遍 unrestricted view：preset 名单与核心自证探测读的是同一份
    // 可见面，分开构造就是两遍 chainLayers + restriction 扫描。失败保持原语义：
    // preset 分支不吞错（旧路径 getPresetTools 的错会外抛），核心探测吞错记日志。
    const viewOnce = () => (typeof deps.viewFor === 'function' ? deps.viewFor(agentScope) : ctx.tools.view(agentScope));
    const preset = typeof deps.getPresetTools === 'function' ? deps.getPresetTools(agentScope, viewOnce) : [];
    const candidates = new Set([...configured, ...preset]);

    if (respect !== true
      && enabled !== false && ctx?.tools && typeof ctx.tools.view === 'function' && agentScope !== undefined) {
      try {
        const view = viewOnce();
        const visible = view?.visible;
        if (visible instanceof Map || (visible && typeof visible.has === 'function')) {
          for (const coreName of CORE_TOOL_NAMES) {
            if (visible.has(coreName)) candidates.add(coreName);
          }
        }
      } catch (reason) {
        log('lifecycle:always-self-admit-view-failed', {
          agentId: agentScope?.id,
          error: String(reason),
        });
      }
    }

    const names = [...candidates];
    alwaysCache.set(scopeKey, { key: cacheKey, names });
    return names;
  }

  function engineConfigFor(scope, sessionId, bindings, alwaysNames) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      categoryConfig: config.categoryConfig,
      locale: config.locale,
      entryToolNames: [...registry.entryNames],
      frameworkToolNames: [...registry.frameworkRetained],
      alwaysToolNames: [...alwaysNames],
      tolerantLoadProtected: config.tolerantLoadProtected !== false,
      budgets: config.budgets,
      bindings,
      clock,
      random,
      generation: `${registry.generationFor(registry.scopeKeyOf(scope))}:${sessionId}`,
    };
  }

  const onRuntimeCreated = typeof deps.onRuntimeCreated === 'function' ? deps.onRuntimeCreated : () => {};

  /**
   * resume 种子：admission store 里该会话的记录按当前目录比对，
   * digest 一致的回填 engine.selected 与 admitted 名单；不一致的丢弃
   * （换版/覆盖的工具 resume 后自然回到隐藏态）。
   */
  function seedRuntime(runtime) {
    const rows = [...tracker.admissionsFor(runtime.scope.sessionId).values()];
    if (rows.length === 0) return;
    const { seeded, dropped } = runtime.engine.seedSelection(runtime.scope, rows);
    for (const name of dropped) tracker.revoke(runtime.scope.sessionId, name);
    if (seeded.length > 0 || dropped.length > 0) {
      log('lifecycle:admission-seeded', { sessionId: runtime.scope.sessionId, seeded, dropped });
    }
  }

  /**
   * 当前 admitted 名字集合（供掩码）：admission store 的会话行。
   * seed 之后 store 与 selected 已按 schemaDigest 对齐。
   */
  function admittedNamesOf(sessionId) {
    return new Set(tracker.admissionsFor(sessionId).keys());
  }

  function ensureRuntime(session, scope) {
    assertActive();
    const sessionId = session.id;
    let runtime = sessions.get(sessionId);
    if (runtime !== undefined) return runtime;
    tracker.seedSession?.(sessionId);

    const view = registry.bindingsFor(scope, catalogViewFor(scope));
    const alwaysNames = currentAlwaysNames(scope);
    const engine = createDiscoveryEngine(engineConfigFor(scope, sessionId, view.bindings, alwaysNames));
    registry.remember(view.scopeKey, view.bindings);

    runtime = {
      session,
      agentScope: scope,
      scope: { sessionId, actorId: String(scope.id) },
      engine,
      alwaysNameSet: new Set(alwaysNames),
      gateOwnScope: (() => {
        const raw = config.gateOwnScopeTools;
        return (typeof raw?.get === 'function' ? raw.get() : raw) !== false;
      })(),
      disposedSignal: new AbortController(),
    };
    sessions.set(sessionId, runtime);
    seedRuntime(runtime);
    onRuntimeCreated();
    return runtime;
  }

  /**
   * alwaysNameSet 按当前配置同步：alwaysVisible 是 volatile——会话半途在设置页
   * 勾选/取消工具时 mask 的 allow 名单立即反映新集合（mask.desired 每次现算），
   * guard 的 runtime.alwaysNameSet 也必须同源，否则出现"已披露但执行被拒"的
   * 矛盾面。就地增删保持 Set 引用不变（guard 只读 membership）。
   */
  function syncAlwaysNames(runtime) {
    const next = new Set(currentAlwaysNames(runtime.agentScope));
    const set = runtime.alwaysNameSet;
    for (const name of set) if (!next.has(name)) set.delete(name);
    for (const name of next) set.add(name);
    runtime.engine.setAlwaysVisibleNames([...set]);
    return set;
  }

  /**
   * tool_load 成功 → 写 admission + 更新该 agent 掩码。
   * @param {any} runtime
   * @param {Array<{toolId:string,name:string,revision:string,schemaDigest:string}>} admitted
   */
  function commitAdmissions(runtime, admitted) {
    if (activation.signal.aborted || runtime.disposedSignal.signal.aborted) return;
    const sessionId = runtime.scope.sessionId;
    for (const row of admitted) {
      tracker.admit(sessionId, {
        name: row.name, toolId: row.toolId, schemaDigest: row.schemaDigest, at: clock.now(),
      });
    }
    syncAlwaysNames(runtime);
    mask.update(runtime.agentScope, admittedNamesOf(sessionId));
  }

  /**
   * tool_unload / invalidate → 撤 admission + 重掩码。
   * @param {any} runtime
   * @param {string[]} names
   */
  function revokeAdmissions(runtime, names) {
    const sessionId = runtime.scope.sessionId;
    for (const name of names) tracker.revoke(sessionId, name);
    if (activation.signal.aborted || runtime.disposedSignal.signal.aborted) return;
    syncAlwaysNames(runtime);
    mask.update(runtime.agentScope, admittedNamesOf(sessionId));
  }

  /** tools/change：逐会话重算资格、同步作废 admission、重掩码。 */
  function onRegistryChange() {
    alwaysCache.clear();
    for (const runtime of sessions.values()) {
      registry.bumpGeneration(runtime.agentScope);
      const view = registry.bindingsFor(runtime.agentScope, catalogViewFor(runtime.agentScope));
      const diff = registry.diffAgainst(runtime.agentScope, view.bindings);
      registry.remember(view.scopeKey, view.bindings);
      const outcome = runtime.engine.refreshCatalog(view.bindings);
      const names = [...outcome.invalidatedNames];
      for (const toolId of diff.removed) {
        names.push(...runtime.engine.invalidate(toolId, 'tool-removed'));
      }
      if (names.length > 0) {
        revokeAdmissions(runtime, [...new Set(names)]);
      } else {
        // 目录没变但 admitted/常驻名字集可能因 store 读回或配置热改不同步：
        // 重掩码幂等且便宜。
        syncAlwaysNames(runtime);
        mask.update(runtime.agentScope, admittedNamesOf(runtime.scope.sessionId));
      }
      log('lifecycle:registry-refreshed', {
        sessionId: runtime.scope.sessionId,
        eligibilityGeneration: outcome.eligibilityGeneration,
        added: diff.added.length,
        removed: diff.removed.length,
      });
    }
  }

  function disposeSession(sessionId) {
    const runtime = sessions.get(sessionId);
    if (runtime === undefined) return;
    if (!runtime.disposedSignal.signal.aborted) {
      runtime.disposedSignal.abort(new DomainError('STATE_NOT_READY', 'Tool discovery session disposed.'));
    }
    if (runtime.agentScope && typeof runtime.agentScope === 'object') disposedScopes.add(runtime.agentScope);
    runtime.engine.destroySession(sessionId);
    tracker.dropSession(sessionId);
    sessions.delete(sessionId);
    alwaysCache.delete(registry.scopeKeyOf(runtime.agentScope));
    // registry 的跨会话字典以 scope 建键：会话释放后这些键不再有任何读者。
    if (typeof registry.disposeScope === 'function') registry.disposeScope(runtime.agentScope);
  }

  return {
    sessions,
    currentAlwaysNames,
    currentInitialToolsEnabled,
    syncAlwaysNames,
    // toolSet 在 assemble 前已由宿主固定；以该对象绑定本请求准入快照。
    captureStep(agent, toolSet) {
      if (!toolSet || stepAdmissions.has(toolSet)) return;
      stepAdmissions.set(toolSet, tracker.admissionsFor(agent.session.id));
    },
    admittedForStep(toolSet, name, admission) {
      if (!toolSet) return true; // 无模型步骤的宿主直接调用仍按即时准入判定。
      const snapshot = stepAdmissions.get(toolSet);
      return snapshot?.get(name) === admission;
    },
    assertActive,
    waitForActive,
    trackOperation(operation) {
      operations.add(operation);
      operation.then(() => operations.delete(operation), () => operations.delete(operation));
      return operation;
    },
    settleOperations() { return Promise.allSettled([...operations]); },

    onRegistryChange,
    disposeSession,

    runtimeFor(session, scope) {
      assertActive();
      const runtime = sessions.get(session.id);
      if (runtime !== undefined) return runtime;
      if (scope !== null && typeof scope === 'object' && disposedScopes.has(scope)) {
        throw new DomainError('STATE_NOT_READY', 'Tool discovery session was disposed; retry the request.');
      }
      return ensureRuntime(session, scope);
    },

    /**
     * tool_load 的 adapter 侧提交点：engine 给出 admitted 列表后调用。
     */
    commitAdmissions,
    revokeAdmissions,

    /** agent/pre-step 等时机对单会话重掩码（同步常驻名单再换掩码）。 */
    reconcileMask(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime === undefined) return;
      syncAlwaysNames(runtime);
      mask.update(runtime.agentScope, admittedNamesOf(sessionId));
    },

    /** 供 index：agent 建立时装初始掩码（读回的种子 admission）。 */
    admittedNamesOf,

    /**
     * 供调用方等待某会话"就绪"——新设计里没有恢复窗口，返回 immediately ready；
     * 保留 API 形状是因为宿主/设置面板可能仍在轮询它。
     */
    whenReady(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime === undefined) return Promise.resolve({ mode: 'unknown' });
      return Promise.resolve({ mode: 'ready' });
    },

    /** 观测面：某会话的准入快照（设置面板/诊断只读）。 */
    baselineOf(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime === undefined) return null;
      return {
        state: 'ready',
        reason: null,
        names: [...syncAlwaysNames(runtime)],
        admitted: [...admittedNamesOf(sessionId)],
      };
    },

    dispose() {
      if (!activation.signal.aborted) {
        activation.abort(new DomainError('STATE_NOT_READY', config.locale === 'zh'
          ? '工具发现插件已卸载；本次在途请求已停止，请重新发起请求。'
          : 'Tool discovery activation was disposed; this in-flight request was stopped. Retry the request.'));
      }
      for (const sessionId of [...sessions.keys()]) disposeSession(sessionId);
    },
  };
}

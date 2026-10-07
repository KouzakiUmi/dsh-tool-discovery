// progressive-v2/adapters/dsh/lifecycle.mjs
// scope 注册、事件分发、registry 变更代次、disposer 所有权。
//
// 关键约束（03 §5 / adapter-plan §8）：
//   * 每个会话一个 DiscoveryEngine（资格目录按该会话的 scope 构造）。
//     → 跨会话 ref/fork 天然不继承；失效不跨会话串味。
//   * 订阅先于恢复：激活期就挂 session/event，未建 runtime 的会话事件先进**有界缓冲**；
//     runtime 建立后按 seq 合并快照再折叠（journal 负责 merge）。
//   * 全部注册项（三个定义、投影、guard、session 监听、恢复订阅、缓存）都持有 disposer；
//     任一步失败由 index.mjs 逆序回滚。
//   * **常驻名单是 per-runtime 的一份快照**，取自"建立 runtime 的那一刻"的配置值。
//     设置面板改动配置只影响**未来**的 runtime：正在跑的周期绝不改 schema，
//     否则一次已经稳定的出站 prefix 会被中途打断。成功压缩是本周期内唯一的
//     换名点（重开一个周期），换名不重建 runtime、不动任何协议状态。
import { createDiscoveryEngine } from '../../domain/index.mjs';
import { createJournal } from './journal.mjs';
import { resolveAlwaysVisible } from './config.mjs';

/** 每个会话在 runtime 建立前缓存的最大事件数（有界，防泄漏）。 */
const MAX_BUFFERED_EVENTS = 4096;

/**
 * @param {{ctx:any, registry:any, config:any, clock:any, random:any, query:any, log?:Function,
 *          getAlwaysVisible?:() => readonly string[]}} deps
 */
export function createLifecycle(deps) {
  const { ctx, registry, config, clock, random, query, log = () => {} } = deps;

  /** sessionId → runtime */
  const sessions = new Map();
  /** sessionId → runtime 建立前的事件缓冲 */
  const buffers = new Map();

  /**
   * 此刻配置的常驻名单。只有在**建立 runtime** 或**成功压缩重开周期**时读它；
   * 周期中途的设置变更不经过这里。
   */
  function currentAlwaysNames() {
    if (typeof deps.getAlwaysVisible === 'function') {
      return resolveAlwaysVisible([...deps.getAlwaysVisible()]);
    }
    return resolveAlwaysVisible(config.alwaysVisible);
  }

  /**
   * 周期边界换名：把新名单交给 runtime 持有的引用、engine 的 protected 判据、
   * 以及 journal 读名单的 provider。三者同步换，不重建 runtime。
   *
   * 换完若本轮**还有一个尚未发送的投影**（宿主在 pre-step 里跑完了自动压缩，却仍会
   * 返回压缩前那份 assembly），就地把它刷成新周期的样子。只在没有未发送投影时静默。
   * @param {any} runtime
   * @param {string} reason
   */
  function adoptEpochNames(runtime, reason) {
    const names = currentAlwaysNames();
    runtime.alwaysNames = names;
    runtime.alwaysNameSet = new Set(names);
    runtime.engine.setAlwaysVisibleNames(names);
    const refreshed = typeof runtime.refreshPendingProjection === 'function'
      ? runtime.refreshPendingProjection()
      : false;
    log('lifecycle:epoch-names', {
      sessionId: runtime.scope.sessionId,
      reason,
      count: names.length,
      pendingProjectionRefreshed: refreshed,
    });
  }

  function engineConfigFor(scope, sessionId, bindings, alwaysNames) {
    return {
      protocolVersion: 2,
      categoryConfig: config.categoryConfig,
      // engine 的 nextAction 与类别卡按此取文案；缺省会静默回落英文。
      locale: config.locale,
      entryToolNames: [...registry.entryNames],
      frameworkToolNames: [...registry.frameworkRetained],
      alwaysToolNames: [...alwaysNames],
      budgets: config.budgets,
      newSessionMode: 'restoring',
      bindings,
      clock,
      random,
      generation: `${registry.generationFor(registry.scopeKeyOf(scope))}:${sessionId}`,
    };
  }

  /** 新 runtime 建立后的回调（新目录里的 scope 工具此时才可见）。 */
  const onRuntimeCreated = typeof deps.onRuntimeCreated === 'function' ? deps.onRuntimeCreated : () => {};

  /**
   * 取得（必要时建立）某会话 runtime。
   * @param {any} session 宿主 Session
   * @param {any} scope 该会话的活动 agent scope
   */
  function ensureRuntime(session, scope) {
    const sessionId = session.id;
    let runtime = sessions.get(sessionId);
    if (runtime !== undefined) return runtime;

    const view = registry.bindingsFor(scope);
    // 建立这一刻的名单快照：新会话从这里开始，之后设置变更不再影响本周期。
    const alwaysNames = currentAlwaysNames();
    const engine = createDiscoveryEngine(engineConfigFor(scope, sessionId, view.bindings, alwaysNames));
    registry.remember(view.scopeKey, view.bindings);
    const discoveryScope = { sessionId, actorId: String(scope.id) };
    const journal = createJournal({
      ctx,
      session,
      scope: discoveryScope,
      engine,
      query,
      log,
      entryNames: registry.entryNames,
      frameworkRetained: registry.frameworkRetained,
      // provider 而非静态数组：成功压缩时 lifecycle 会就地换掉 runtime 上的名单，
      // journal 无需重建也无需知道配置从哪来。
      alwaysVisibleProvider: () => runtime.alwaysNameSet,
      onEpochReset: (reason) => adoptEpochNames(runtime, reason),
      onRequestHeader: () => { runtime.refreshPendingProjection = null; },
      onEpochRestore: (names) => {
        // 冷恢复以日志事实为准，覆盖"此刻配置值"。这是"配置变更只影响下一个周期"
        // 在重启路径上的落点：有历史就不许被新设置悄悄改写。
        runtime.alwaysNames = [...names];
        runtime.alwaysNameSet = new Set(names);
        runtime.engine.setAlwaysVisibleNames(runtime.alwaysNames);
        log('lifecycle:epoch-names-restored', {
          sessionId: runtime.scope.sessionId,
          reason: 'cold-restore',
          count: runtime.alwaysNames.length,
        });
      },
      reportBypass: (details) => {
        runtime.compositionBypass = details;
        log('lifecycle:composition-bypass', details);
      },
    });

    const buffered = buffers.get(sessionId) ?? [];
    runtime = {
      session,
      agentScope: scope,
      scope: discoveryScope,
      engine,
      journal,
      restoring: true,
      compositionBypass: null,
      alwaysNames,
      alwaysNameSet: new Set(alwaysNames),
      // 本轮"已组装但尚未发送"的投影刷新入口；projection 挂上、canonical
      // request/header 观测后由 journal 清掉。见 projection.mjs 的"未发送刷新"段。
      refreshPendingProjection: null,
    };
    sessions.set(sessionId, runtime);
    buffers.delete(sessionId);
    // 该 runtime 目录里的 scope 工具此刻才可枚举 → 通知宿主重发设置面板目录。
    onRuntimeCreated();

    // 缓冲期到达的事件先重放（去重由 domain 的 seq 判据保证）
    for (const event of buffered) journal.onEvent(event);

    if (session.seq === 0) {
      // 全新会话：日志为空，无任何可授权历史 → 直接就绪
      engine.ready(discoveryScope);
      runtime.restoring = false;
      log('lifecycle:new-session-ready', { sessionId });
    } else {
      runtime.restorePromise = journal.restore().then((outcome) => {
        runtime.restoring = false;
        log('lifecycle:restored', { sessionId, outcome });
        return outcome;
      });
    }
    return runtime;
  }

  /** session/event：已建 runtime 直接折叠；否则进有界缓冲。 */
  function onSessionEvent(session, event) {
    const runtime = sessions.get(session.id);
    if (runtime !== undefined) {
      runtime.journal.onEvent(event);
      return;
    }
    const buffer = buffers.get(session.id) ?? [];
    buffer.push(event);
    if (buffer.length > MAX_BUFFERED_EVENTS) buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
    buffers.set(session.id, buffer);
  }

  /** tools/change：逐会话重算资格、升代次、失效消失项。 */
  function onRegistryChange() {
    for (const runtime of sessions.values()) {
      registry.bumpGeneration(runtime.agentScope);
      const view = registry.bindingsFor(runtime.agentScope);
      const diff = registry.diffAgainst(runtime.agentScope, view.bindings);
      registry.remember(view.scopeKey, view.bindings);
      const outcome = runtime.engine.refreshCatalog(view.bindings);
      for (const toolId of diff.removed) runtime.engine.invalidate(toolId, 'tool-removed');
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
    if (runtime !== undefined) {
      runtime.engine.dispose();
      runtime.journal.dispose();
      sessions.delete(sessionId);
    }
    buffers.delete(sessionId);
  }

  return {
    sessions,
    ensureRuntime,
    onSessionEvent,
    onRegistryChange,
    disposeSession,
    /** 此刻配置的常驻名单（只供 UI/日志观测；周期中途调用不改变任何 runtime）。 */
    currentAlwaysNames,
    /** 取 runtime；不存在时用当前 agent scope 建立一个（投影/guard 首次触达时）。 */
    runtimeFor(session, scope) {
      return sessions.get(session.id) ?? ensureRuntime(session, scope);
    },
    /** 供调用方等待某会话恢复完成（宿主不会 await session/created 的返回值）。 */
    whenReady(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime === undefined) return Promise.resolve({ mode: 'unknown' });
      if (!runtime.restoring) return Promise.resolve({ mode: runtime.engine.getState(runtime.scope).mode });
      const pending = runtime.restorePromise;
      if (pending === undefined) return Promise.resolve({ mode: 'restoring' });
      // 「已决失败」与「仍在 pending」必须可区分：等待方（system-prompt/assemble 的
      // 冷恢复等待）据此决定"发只带基线的请求"还是"继续等、不发"。所以恢复被 reject
      // 时**不**归一成 restoring —— 那是把一次已决失败伪装成还在恢复。
      // 这里按既有 fail closed 语义收口：引擎置 incompatible、runtime 落定（restoring
      // 归 false）、journal 的缓冲停止累积，然后如实返回 incompatible。
      return pending.then(
        (outcome) => (outcome === undefined || outcome === null ? { mode: 'restoring' } : outcome),
        (error) => {
          log('lifecycle:restore-rejected', { sessionId, error: String(error) });
          try {
            runtime.engine.failClosed(runtime.scope);
          } catch (failClosedError) {
            log('lifecycle:fail-closed-failed', { sessionId, error: String(failClosedError) });
          }
          // journal 对这个会话已无用途（恢复永远不会再完成）：释放它的缓冲。
          try { runtime.journal.dispose(); } catch { /* 已释放 */ }
          runtime.restoring = false;
          return { mode: 'incompatible', reason: 'restore-rejected', error: String(error) };
        },
      );
    },
    dispose() {
      for (const sessionId of [...sessions.keys()]) disposeSession(sessionId);
      buffers.clear();
    },
  };
}

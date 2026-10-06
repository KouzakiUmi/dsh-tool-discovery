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
import { createDiscoveryEngine } from '../../domain/index.mjs';
import { createJournal } from './journal.mjs';

/** 每个会话在 runtime 建立前缓存的最大事件数（有界，防泄漏）。 */
const MAX_BUFFERED_EVENTS = 4096;

/**
 * @param {{ctx:any, registry:any, config:any, clock:any, random:any, query:any, log?:Function}} deps
 */
export function createLifecycle(deps) {
  const { ctx, registry, config, clock, random, query, log = () => {} } = deps;

  /** sessionId → runtime */
  const sessions = new Map();
  /** sessionId → runtime 建立前的事件缓冲 */
  const buffers = new Map();

  function engineConfigFor(scope, sessionId, bindings) {
    return {
      protocolVersion: 2,
      categoryConfig: config.categoryConfig,
      entryToolNames: [...registry.entryNames],
      frameworkToolNames: [...registry.frameworkRetained],
      alwaysToolNames: [...(config.alwaysVisible ?? [])],
      budgets: config.budgets,
      newSessionMode: 'restoring',
      bindings,
      clock,
      random,
      generation: `${registry.generationFor(registry.scopeKeyOf(scope))}:${sessionId}`,
    };
  }

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
    const engine = createDiscoveryEngine(engineConfigFor(scope, sessionId, view.bindings));
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
      alwaysVisible: config.alwaysVisible ?? [],
      reportBypass: (details) => {
        runtime.compositionBypass = details;
        log('lifecycle:composition-bypass', details);
      },
    });

    const buffered = buffers.get(sessionId) ?? [];
    runtime = { session, agentScope: scope, scope: discoveryScope, engine, journal, restoring: true, compositionBypass: null };
    sessions.set(sessionId, runtime);
    buffers.delete(sessionId);

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
    /** 取 runtime；不存在时用当前 agent scope 建立一个（投影/guard 首次触达时）。 */
    runtimeFor(session, scope) {
      return sessions.get(session.id) ?? ensureRuntime(session, scope);
    },
    /** 供调用方等待某会话恢复完成（宿主不会 await session/created 的返回值）。 */
    whenReady(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime === undefined) return Promise.resolve({ mode: 'unknown' });
      if (!runtime.restoring) return Promise.resolve({ mode: runtime.engine.getState(runtime.scope).mode });
      return runtime.restorePromise ?? Promise.resolve({ mode: 'restoring' });
    },
    dispose() {
      for (const sessionId of [...sessions.keys()]) disposeSession(sessionId);
      buffers.clear();
    },
  };
}

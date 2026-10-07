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
//   * **常驻名单是 per-runtime 的一份快照，但它的权威来自 storageDomain 的可信记录**。
//     设置面板改动配置只影响**未来**的周期：正在跑的周期绝不改 schema，
//     否则一次已经稳定的出站 prefix 会被中途打断。成功压缩是本周期内唯一的
//     换名点（重开一个周期），换名不重建 runtime、不动任何协议状态。
//   * **名单落盘才算授权**（trusted-epoch.mjs）：记录写 durable 之前基线是 pending，
//     pending 与 blocked 都**不发请求**。缺记录的老会话明确报错并等本次 live 的
//     真实用户 `/compact` 迁移，绝不从出站 header 反推授权。
import { createDiscoveryEngine } from '../../domain/index.mjs';
import { createJournal, normalizeInheritedBoundary } from './journal.mjs';
import { resolveAlwaysVisible } from './config.mjs';
import {
  BASELINE_STATE, TRUSTED_EPOCH_REASONS, createEpochLedger, trustedEpochBlockedError,
} from './trusted-epoch.mjs';

/** 每个会话在 runtime 建立前缓存的最大事件数（有界，防泄漏）。 */
const MAX_BUFFERED_EVENTS = 4096;

/** fork 继承边界归一：与 journal 同一口径，缺失/畸形一律 null（交给 journal fail closed）。 */
function normalizeOwnBoundary(session) {
  return normalizeInheritedBoundary(session?.inheritedEventCount);
}

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
   * 此刻配置的常驻名单。只在**建立 runtime** 或**成功压缩重开周期**时读它；
   * 周期中途的设置变更不经过这里。
   */
  function currentAlwaysNames() {
    if (typeof deps.getAlwaysVisible === 'function') {
      return resolveAlwaysVisible([...deps.getAlwaysVisible()]);
    }
    return resolveAlwaysVisible(config.alwaysVisible);
  }

  /** 把一份**已确认可信**的名单装进 runtime（runtime + engine 同步换）。 */
  function adoptNames(runtime, names) {
    runtime.alwaysNames = [...names];
    runtime.alwaysNameSet = new Set(names);
    runtime.engine.setAlwaysVisibleNames(names);
  }

  /** 基线不可授权：清空常驻名单并 fail closed —— 断点一定在"名单为空"之后。 */
  function blockBaseline(runtime, reason) {
    adoptNames(runtime, []);
    runtime.engine.failClosed(runtime.scope);
    log('lifecycle:baseline-blocked', {
      sessionId: runtime.scope.sessionId,
      reason,
      epochId: runtime.ledger.identity.epochId,
    });
  }

  /**
   * **post-next 的 agent/pre-step 屏障**由 index.mjs 调用。
   *
   * 宿主 `dsh-agent-loop` 的顺序是 assemble(:907) → waterfall('agent/pre-step')(:911)
   * → 无条件返回当初那份旧 assembly(:921-923)。basic 的自动压缩就在这个 waterfall 里
   * （dsh-compaction-basic:839）。也就是说：一次成功压缩刚换掉名单与周期，那份还没
   * 发送的 assembly 就带着新名单要被发出去了 —— 而新周期的可信记录可能还没 durable。
   * 这里在 `next()` **之后**等本次新 epoch 的 put 落定，期间尊重宿主的取消信号，
   * **不新增任何超时**。post-next 的位置是有意的：无论 basic 的 handler 排在本插件
   * 之前还是之后，压缩都发生在这棵 waterfall 子树里，屏障一定跑在它之后。
   */
  async function awaitEpochRecord(sessionId, signal) {
    const runtime = sessions.get(sessionId);
    if (runtime === undefined) return { state: 'trusted' };
    // 只在**入场**检查刷新失败是不够的：周期边界的 adopt 回调是在 put **落定之后**才
    // 调 refreshPendingProjection，刷新失败会把现场写进 pendingProjectionError。
    // 因此 await 前后都要查：入场挡住"上一轮已经失败"，收尾挡住"这一轮刚失败"。
    if (runtime.pendingProjectionError !== undefined && runtime.pendingProjectionError !== null) {
      const error = runtime.pendingProjectionError;
      runtime.pendingProjectionError = null;
      throw error;
    }
    const work = async () => {
      // 基线还没落定时（pending）必须先等它：那可能是 load（无在途写），也可能是 put。
      // 顺序很重要：**先**等基线，**再**取当刻的在途写 —— 反过来会把一份陈旧的
      // {state:'pending'} 快照当成结果，从而放过随后才变成 blocked 的状态。
      const baseline = runtime.baselinePromise;
      if (baseline !== undefined && baseline !== null && runtime.ledger.state === BASELINE_STATE.PENDING) {
        await baseline.catch(() => {});
      }
      await runtime.ledger.whenSettled();
      // 读**当下**的状态，不复用任何先前捕获的快照。
      const state = runtime.ledger.state;
      if (state === BASELINE_STATE.BLOCKED) throw trustedEpochBlockedError(runtime.ledger.reason);
      if (state === BASELINE_STATE.PENDING) {
        // 仍在途：不得发请求（没有超时兜底，等落定或宿主取消）。
        throw trustedEpochBlockedError('TRUSTED_EPOCH_PENDING');
      }
      if (runtime.pendingProjectionError !== undefined && runtime.pendingProjectionError !== null) {
        const error = runtime.pendingProjectionError;
        runtime.pendingProjectionError = null;
        throw error;
      }
      return { state, reason: runtime.ledger.reason };
    };
    if (signal === undefined || signal === null || typeof signal.addEventListener !== 'function') {
      return work();
    }
    if (signal.aborted === true) throw signal.reason ?? new Error(`pre-step aborted before the epoch record of "${sessionId}" settled`);
    let onAbort;
    try {
      return await Promise.race([
        work(),
        new Promise((_resolve, reject) => {
          onAbort = () => reject(signal.reason ?? new Error(`pre-step aborted while the epoch record of "${sessionId}" is still pending`));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 周期边界（新压缩 / 迁移）：**同步**捕获此刻的配置名单，再交给 ledger 落盘。
   * 同步捕获是硬要求：等 put 完成后再读配置，拿到的会是用户在等待期间改过的值。
   * @param {any} runtime
   * @param {{compactionId:string, endSeq:number, identity:{epochId:string, compactionEndSeq:number},
   *          userInitiated:boolean}} info
   */
  function onEpochBoundary(runtime, info) {
    const names = currentAlwaysNames();
    const trigger = info.userInitiated ? 'manual' : 'auto';
    const wasTrusted = runtime.ledger.state === BASELINE_STATE.TRUSTED;

    if (!wasTrusted) {
      // 老会话迁移：名单**先不入 runtime**。授权必须来自那份落盘的记录，
      // 否则一个 STORAGE_UNAVAILABLE 的会话也会因为"刚成功压缩"而拿到常驻名单。
      // 用户命令链的最后一环（command/done success）还没到时，这里只把待迁移的
      // 快照存起来；它不会自己落盘（auto 压缩不迁移）。
      runtime.pendingUserEpoch = { compactionId: info.compactionId, identity: info.identity, names, trigger };
      log('lifecycle:epoch-boundary-awaiting-migration', {
        sessionId: runtime.scope.sessionId,
        compactionId: info.compactionId,
        userInitiated: info.userInitiated,
        reason: runtime.ledger.reason,
      });
      return;
    }

    // 已可信会话的既定契约：成功压缩即重开周期、换此刻配置、清 selected/frozen、
    // 并刷新那份**尚未发送**的投影。
    adoptNames(runtime, names);
    runtime.ledger.adopt({ identity: info.identity, names, trigger }).then((outcome) => {
      // **无论 put 成功与否都要先看基线状态**：写失败时 outcome.ok 为 false，
      // 若在这里直接 return，刚换上去的名单就会留在 alwaysNameSet 里 ——
      // 那正是"fail closed 之后仍按旧授权放行"。失败必须清空并落 blocked。
      if (outcome.reason === 'disposed' || outcome.reason === 'superseded') return;
      if (outcome.stale === true) return;
      if (runtime.ledger.state !== BASELINE_STATE.TRUSTED || outcome.ok !== true) {
        blockBaseline(runtime, runtime.ledger.reason ?? TRUSTED_EPOCH_REASONS.UNAVAILABLE);
        return;
      }
      const refreshed = typeof runtime.refreshPendingProjection === 'function'
        ? runtime.refreshPendingProjection()
        : false;
      log('lifecycle:epoch-names', {
        sessionId: runtime.scope.sessionId,
        compactionId: info.compactionId,
        trigger,
        count: names.length,
        pendingProjectionRefreshed: refreshed,
      });
    });
  }

  /**
   * 五条 live 用户命令链全部成立 → 允许把"缺可信记录"的老会话迁出来。
   * 用的是压缩边界那一刻**已经捕获**的名单快照，不是此刻重新读的配置。
   */
  function onUserCompactionComplete(runtime, info) {
    const pending = runtime.pendingUserEpoch;
    if (pending === null || pending.compactionId !== info.compactionId) {
      log('lifecycle:user-compaction-without-pending', {
        sessionId: runtime.scope.sessionId,
        compactionId: info.compactionId,
      });
      return;
    }
    runtime.pendingUserEpoch = null;
    runtime.ledger.adopt({
      identity: info.identity, names: pending.names, trigger: 'manual',
    }).then((outcome) => {
      if (outcome.reason === 'disposed' || outcome.reason === 'superseded') return;
      if (outcome.stale === true) return;
      if (runtime.ledger.state !== BASELINE_STATE.TRUSTED || outcome.ok !== true) {
        // 迁移写失败：仍然清空名单并保持 blocked，绝不"迁移到一半"就沿用名单。
        blockBaseline(runtime, runtime.ledger.reason ?? TRUSTED_EPOCH_REASONS.UNAVAILABLE);
        return;
      }
      adoptNames(runtime, pending.names);
      // fail closed 之后 engine.ready() 不会升 mode（它只在 restoring→ready 之间搬），
      // 但 engine.restore([]) 会**明确**把 mode 置回 ready（engine.mjs:744）。
      // adapter 的存储授权状态与 domain 的执行状态彼此隔离，不互相假设。
      runtime.engine.restore([], runtime.scope);
      if (typeof runtime.refreshPendingProjection === 'function') runtime.refreshPendingProjection();
      log('lifecycle:migrated', {
        sessionId: runtime.scope.sessionId,
        compactionId: info.compactionId,
        epochId: info.identity.epochId,
        count: pending.names.length,
      });
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
    // engine 先按当前配置建一次；可信基线落定后会**整体替换**它（trusted 或 blocked）。
    const bootstrapNames = currentAlwaysNames();
    const engine = createDiscoveryEngine(engineConfigFor(scope, sessionId, view.bindings, bootstrapNames));
    registry.remember(view.scopeKey, view.bindings);
    const discoveryScope = { sessionId, actorId: String(scope.id) };
    const ledger = createEpochLedger({
      storeHolder: deps.trustedEpoch,
      sessionId,
      // ownSeqStart 必须与 journal 判的边界一致（journal 在 restore 时还会与公开
      // query 的 inheritedEventCount 交叉核验）；缺失/畸形时 journal 自己 fail closed，
      // 账本这边退到 0 —— 键不匹配的后果是 MISSING/INVALID（保守方向），不是放行。
      ownSeqStart: normalizeOwnBoundary(session) ?? 0,
      now: () => clock.now(),
      log,
    });
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
      onEpochReset: (info) => onEpochBoundary(runtime, info),
      onUserCompactionComplete: (info) => onUserCompactionComplete(runtime, info),
      onRequestHeader: () => { runtime.refreshPendingProjection = null; },
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
      ledger,
      restoring: true,
      compositionBypass: null,
      // 可信基线落定前**没有**任何常驻名单：0 request 就是靠这个空集兑现的。
      alwaysNames: [],
      alwaysNameSet: new Set(),
      // 本轮"已组装但尚未发送"的投影刷新入口；projection 挂上、canonical
      // request/header 观测后由 journal 清掉。见 projection.mjs 的"未发送刷新"段。
      refreshPendingProjection: null,
      // 就地刷新失败的现场：绝不被吞掉，下一次 assemble / pre-step 会据此中止发请求。
      pendingProjectionError: null,
      // 老会话迁移用的待落盘快照（等 command/done 成功才真正写）。
      pendingUserEpoch: null,
    };
    sessions.set(sessionId, runtime);
    buffers.delete(sessionId);
    // 该 runtime 目录里的 scope 工具此刻才可枚举 → 通知宿主重发设置面板目录。
    onRuntimeCreated();

    // 缓冲期到达的事件先重放（去重由 domain 的 seq 判据保证）
    for (const event of buffered) journal.onEvent(event);

    if (noOwnHistoryPossible(session)) {
      // 完全没有 own 出站事实的会话（新会话或 own-only fork）：仍然**先查同 identity
      // 的 durable 记录** —— 冷崩重放（记录已 durable、首 header 未发出就崩）时，
      // 此刻的配置可能已经改过，权威必须来自已落盘的那一份。
      runtime.baselinePromise = resolveBootstrapBaseline(runtime);
    } else {
      runtime.baselinePromise = journal.restore().then((outcome) => {
        log('lifecycle:restored', { sessionId, outcome });
        return outcome;
      }).then((outcome) => settleRestoreBaseline(runtime, outcome));
    }
    runtime.restorePromise = runtime.baselinePromise;
    // 基线解析永不 reject：失败已由 ledger 落成确定的 blocked 终态。这里再兜一层，
    // 是为了 whenReady 的 reject 分支（它会 dispose journal，从而让用户 /compact
    // 永远无法迁移）绝不会被基线路径触发。
    runtime.baselinePromise = runtime.baselinePromise.catch((error) => {
      log('lifecycle:baseline-rejected', { sessionId, error: String(error) });
      blockBaseline(runtime, TRUSTED_EPOCH_REASONS.UNAVAILABLE);
      runtime.restoring = false;
      return { mode: 'incompatible', reason: TRUSTED_EPOCH_REASONS.UNAVAILABLE };
    });
    runtime.restorePromise = runtime.baselinePromise;
    return runtime;
  }

  /** 本会话是否**不可能**有 own 段事件（全新会话，或 own-only fork 的 own 段为空）。 */
  function noOwnHistoryPossible(session) {
    if (session.seq === 0) return true;
    const boundary = normalizeOwnBoundary(session);
    return boundary !== null && boundary >= session.seq;
  }

  /** 冷恢复折叠落定后，再按"可信记录"落定基线。 */
  async function settleRestoreBaseline(runtime, outcome) {
    if (runtime.journal.isSealed()) {
      // journal 自己封死了：这是**既有**的严重损坏 fail closed 语义，与可信周期无关。
      // 明确落成 FAILED_CLOSED 而不是留在 pending —— 留在 pending 会被投影当成
      // "基线尚未落定"而**永远不发请求**，那既不是既有语义（L11b/RB2 要求请求照发、
      // 只带基线），也会把同 composition 里别的会话的请求队列错位。
      runtime.ledger.failClosed(`journal-sealed:${runtime.journal.sealedReason?.() ?? 'unknown'}`);
      runtime.restoring = false;
      return outcome;
    }
    // readSession 的 await 窗口里可能真的发生过一次压缩：把读取键对齐到 journal 报告的
    // 当前 epoch，否则会拿着 initial 去查新周期那条记录（必然 missing）。
    runtime.ledger.setIdentity(runtime.journal.currentEpoch());
    if (outcome?.mode === 'incompatible') {
      // journal 自身的严重损坏/readSession 失败：既有 fail closed 语义原样保留
      // （请求照发、只带基线、guard 照拒），但**不**封死 journal —— 否则本次 live 的
      // 用户 /compact 永远无法迁移。基线状态必须是 FAILED_CLOSED：它不是"可信记录
      // 缺失/损坏/存储不可用"，因此不适用那三条 0-request 规则。
      runtime.ledger.failClosed(outcome?.reason ?? 'restore-incompatible');
      adoptNames(runtime, []);
      runtime.restoring = false;
      return outcome;
    }
    if (runtime.journal.hasOwnOutboundHistory()) {
      // 有 own 出站事实却**没有**可信记录：这是必须迁移的老会话。
      // 判据里绝不包含"从历史扫描出的命令链"——迁移只认 live 的那一次用户 /compact。
      //
      // **先等在途的写**：缓冲重放（ensureRuntime 在 restore 之前重放 buffered 事件）
      // 可能已经在 live 链上把那次手动 /compact 走完了，此时账本正处在 adopt 的
      // 在途途中。若此处直接 load()：① load 会自增 revision，让那次 adopt 变成
      // superseded（记录永远不落盘）；② load 读的是**新 epoch** 的键，而那条记录还没
      // durable → 必然 MISSING。两者叠加 = 一次**真实成功的用户迁移**被自己的恢复收尾
      // 判成 missing，会话永久 0 request。所以这里先让在途写落定，再读状态。
      await runtime.ledger.whenSettled();
      if (runtime.ledger.state === BASELINE_STATE.TRUSTED) {
        // 迁移已经完成：权威就是那份刚落盘的记录，不读也不重建。
        adoptNames(runtime, runtime.ledger.names);
        runtime.restoring = false;
        log('lifecycle:migrated-during-restore', {
          sessionId: runtime.scope.sessionId,
          epochId: runtime.ledger.identity.epochId,
          count: runtime.ledger.names.length,
        });
        return outcome;
      }
      const verdict = await runtime.ledger.load();
      runtime.restoring = false;
      if (verdict.state !== BASELINE_STATE.TRUSTED) {
        blockBaseline(runtime, verdict.reason);
        return { mode: 'incompatible', reason: verdict.reason };
      }
      adoptNames(runtime, runtime.ledger.names);
      return outcome;
    }
    // own 出站历史为空：仍然先读同 identity 的记录（冷崩重放）。
    return resolveBootstrapBaseline(runtime, outcome);
  }

  /**
   * 建立初始基线：读 → 真的缺失**且**有资格建立 → 才写。
   * pending/blocked 全程保持"不发请求"，落定后 `restoring` 才归 false。
   * @param {any} runtime
   * @param {any} [restoreOutcome] 冷恢复的折叠结果（透传给调用方）
   */
  async function resolveBootstrapBaseline(runtime, restoreOutcome) {
    const loaded = await runtime.ledger.load();
    if (loaded.state === BASELINE_STATE.TRUSTED) {
      adoptNames(runtime, runtime.ledger.names);
      runtime.engine.ready(runtime.scope);
      runtime.restoring = false;
      log('lifecycle:baseline-reused', {
        sessionId: runtime.scope.sessionId,
        epochId: runtime.ledger.identity.epochId,
        count: runtime.ledger.names.length,
        source: 'durable-record',
      });
      return restoreOutcome ?? { mode: 'ready' };
    }
    if (loaded.reason !== TRUSTED_EPOCH_REASONS.MISSING) {
      // 存储不可用 / 坏记录：**不**建立初始记录（那会用当前配置覆盖一条可能还在的记录）。
      blockBaseline(runtime, loaded.reason);
      runtime.restoring = false;
      return { mode: 'incompatible', reason: loaded.reason };
    }
    // 记录确实缺失 —— 但"缺失"本身**不**构成建立初始记录的资格。
    //
    // 唯一的资格判据是 **own 段没有任何真实出站/工具事实**（docs/08 §2.2 的新会话定义）。
    // own 段已经出过站的会话是 legacy：它必须等**本次真实的用户 `/compact`** 才允许迁移，
    // 任何其它路径替它补建记录，都是把时序当授权——本函数正是被 `retryBaseline`
    // （storage 迟到到位时由 index.mjs 触发）复用得到的那条路径，所以这道判据必须
    // 落在这里：它是三个调用点共同的、不变量级的出口。
    if (runtime.journal.hasOwnOutboundHistory()) {
      blockBaseline(runtime, TRUSTED_EPOCH_REASONS.MISSING);
      runtime.restoring = false;
      log('lifecycle:bootstrap-refused-legacy', {
        sessionId: runtime.scope.sessionId,
        reason: TRUSTED_EPOCH_REASONS.MISSING,
        note: 'own 段已有真实出站事实：不得因记录缺失而补建初始记录，只能由本次真实用户 /compact 迁移',
      });
      return { mode: 'incompatible', reason: TRUSTED_EPOCH_REASONS.MISSING };
    }
    // 确实缺失且确有资格 → 建立初始记录。名单在**这一刻**同步捕获。
    await runtime.ledger.begin(currentAlwaysNames(), 'initial');
    if (runtime.ledger.state !== BASELINE_STATE.TRUSTED) {
      blockBaseline(runtime, runtime.ledger.reason);
      runtime.restoring = false;
      return { mode: 'incompatible', reason: runtime.ledger.reason };
    }
    adoptNames(runtime, runtime.ledger.names);
    runtime.engine.ready(runtime.scope);
    runtime.restoring = false;
    log('lifecycle:baseline-created', {
      sessionId: runtime.scope.sessionId,
      epochId: runtime.ledger.identity.epochId,
      count: runtime.ledger.names.length,
    });
    return restoreOutcome ?? { mode: 'ready' };
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
      // ledger 也要 dispose：pending 的写在落定后**不得**再复活授权。
      runtime.ledger.dispose();
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
    /**
     * post-next 的 agent/pre-step 屏障（见 awaitEpochRecord）。index.mjs 的
     * `agent/pre-step` 监听器在 `next()` 之后调用它：等本次新 epoch 的记录 durable，
     * 期间尊重宿主取消信号，不新增任何超时。
     */
    awaitEpochRecord,
    /** 某会话当前的可信基线（供门禁/诊断观测；只读）。 */
    baselineOf(sessionId) {
      const runtime = sessions.get(sessionId);
      if (runtime === undefined) return null;
      return {
        state: runtime.ledger.state,
        reason: runtime.ledger.reason,
        names: runtime.ledger.names,
        epochId: runtime.ledger.identity.epochId,
        compactionEndSeq: runtime.ledger.identity.compactionEndSeq,
        revision: runtime.ledger.revision,
      };
    },
    /** 取 runtime；不存在时用当前 agent scope 建立一个（投影/guard 首次触达时）。 */
    runtimeFor(session, scope) {
      return sessions.get(session.id) ?? ensureRuntime(session, scope);
    },
    /**
     * 存储服务**到位**之后重试一个被 STORAGE_UNAVAILABLE 封住的会话。
     * 只处理这一种终态：MISSING / INVALID 是"需要用户迁移/人工处置"，不靠重试蒙混。
     * @param {any} runtime
     */
    retryBaseline(runtime) {
      if (runtime.restoring) return Promise.resolve(null);
      return resolveBootstrapBaseline(runtime, undefined).then((outcome) => {
        if (runtime.ledger.state !== BASELINE_STATE.TRUSTED) return outcome;
        runtime.engine.restore([], runtime.scope);
        log('lifecycle:baseline-recovered', {
          sessionId: runtime.scope.sessionId,
          epochId: runtime.ledger.identity.epochId,
          count: runtime.ledger.names.length,
        });
        return outcome;
      });
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

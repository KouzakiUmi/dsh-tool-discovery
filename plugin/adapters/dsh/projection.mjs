// plugin/adapters/dsh/projection.mjs
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
//
// **冷恢复窗口**（本轮新增）：
//   runtime 的冷恢复是异步的（`journal.restore()` 要 `await query.readSession`），
//   而宿主的第一次 `preStep` 不等它 —— `systemPrompt.assemble()` 先于恢复完成跑完，
//   于是"已加载段"整段没生成，**发出去的是一份缩水的 tools**：模型上下文里本就有的
//   已披露工具在这一轮凭空消失，而且这条缩水 header 会成为日志里本周期最后一条 header。
//   修法：装配时若 runtime 仍在恢复，就 `await lifecycle.whenReady(sessionId)`。
//   **仍在恢复 = 不发请求**，没有超时降级：任何"等够久就发缩水"的兜底都只是把同一个
//   缺陷推到若干秒之后。等待被终止的途径只有宿主本轮的取消信号（见 awaitRestore），
//   以及恢复自己**失败** —— 那时返回 `mode:'incompatible'`，下面的门槛只留基线，
//   guard 照旧按 `evaluateCall` 拒执行。fail closed 与"仍在 pending"是两种不同状态：
//   前者仍会发请求（只带基线），后者根本不发。
//   死锁证据：`whenReady` 返回的就是 `journal.restore()` 那一个 promise，它只在
//   `await query.readSession(...)` 上让出；读盘不会回调 `system-prompt/assemble`，
//   `ensureRuntime` 里的 `refreshToolChoices()` 也只是同步排一个微任务。无环形等待。
import { DomainError, ENTRY_TOOL_NAMES } from '../../domain/index.mjs';
import { BASELINE_STATE, trustedEpochBlockedError } from './trusted-epoch.mjs';

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
   * 宿主本轮给出的全量工具 → name → schema 索引。
   *
   * **先查重、再建表**：`new Map(tools.map(t => [t.name, t]))` 会静默吞掉同名重复
   * 定义并保留**最后一个**，而宿主允许多个 systemPrompt tool provider 各吐一份同名
   * schema（`dsh-system-prompt` 的 `collected` 只是 `push(...schemas)`，`orderTools`
   * 也不去重）。重复一旦落到「已加载段」，就会拿后一份定义去覆盖/比对冻结 wire，
   * 漂移检测随之失真 —— 正是文件头承诺的「不得有重复名」没有兑现的那一半。
   * 常驻基线段原本就有查重，但只覆盖 `allowed` 里的名字；这里对**整个** incoming
   * 统一判定，基线段与已加载段同等对待。非字符串名沿用既有跳过语义，不新增限制。
   * @param {any[]} incoming
   * @returns {Map<string, any>}
   */
  function indexIncoming(incoming) {
    const names = new Set();
    const byName = new Map();
    for (const tool of incoming) {
      const name = tool?.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      if (names.has(name)) {
        throw new DomainError('INCOMPATIBLE_COMPOSITION', `duplicate disclosed tool "${name}"`);
      }
      names.add(name);
      byName.set(name, tool);
    }
    return byName;
  }

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

    const byName = indexIncoming(incoming);

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

  /**
   * 等本会话的冷恢复**落定**（仅在 `runtime.restoring` 时调用）。
   *
   * 没有超时降级：仍在恢复就一直等，绝不发缩水的那一份。等待只有两个出口 ——
   *   * `whenReady` 落定：`ready` → 正常投影；`incompatible` → 只留基线（既有
   *     fail closed 语义，本次等待没有放宽它）。
   *   * 宿主本轮的取消信号（`context.signal`，由 `assembleContextFor` 注入）：
   *     抛 abort reason，让这一轮沿宿主自己的取消/错误管线退出，而不是由我们
   *     另立一个时限。
   * @param {any} runtime
   * @param {AbortSignal} [signal] 宿主本轮的取消信号
   * @returns {Promise<string|undefined>} 恢复结果 mode，仅供日志
   */
  async function awaitRestore(runtime, signal) {
    const sessionId = runtime.scope.sessionId;
    const pending = Promise.resolve(lifecycle.whenReady(sessionId));
    const report = (outcome) => {
      log('projection:restore-wait', { sessionId, mode: outcome?.mode, restoring: runtime.restoring });
      return outcome?.mode;
    };
    if (signal === undefined || signal === null || typeof signal.addEventListener !== 'function') {
      return report(await pending);
    }
    if (signal.aborted === true) throw signal.reason ?? new Error(`assemble aborted before the restore of "${sessionId}" settled`);
    /** @type {(() => void)|undefined} */
    let onAbort;
    try {
      return report(await Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          onAbort = () => reject(signal.reason ?? new Error(`assemble aborted while the restore of "${sessionId}" is still pending`));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]));
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 可信基线门禁：`runtime.ledger` 不存在（例如既有单测的最小 runtime 替身）时
   * 本插件不做额外约束；存在时 pending / blocked 都**停止发请求**。
   *
   * pending 是"记录正在落盘"：等它落定（同样只在宿主取消信号上退出，没有超时兜底）；
   * blocked 是确定的终态：按 reason 报出明确错误。
   * @param {any} runtime
   * @param {AbortSignal} [signal]
   */
  async function enforceTrustedBaseline(runtime, signal) {
    const ledger = runtime.ledger;
    if (ledger === undefined) return;
    if (ledger.state !== BASELINE_STATE.PENDING && ledger.state !== BASELINE_STATE.BLOCKED) return;
    if (ledger.state === BASELINE_STATE.BLOCKED) throw trustedEpochBlockedError(ledger.reason);
    const settled = await lifecycle.awaitEpochRecord(runtime.scope.sessionId, signal);
    if (settled?.state === BASELINE_STATE.BLOCKED) throw trustedEpochBlockedError(settled.reason);
  }

  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const previous = context?.agent;
    // **进入本次 assemble 就先把上一份"尚未发送的刷新入口"作废**：上一次 pre-step 的
    // assembly 已经被用掉了（而且宿主很可能已经冻结它），此后任何压缩都不该再去改写
    // 那份死数组 —— 改不动（frozen）只是表象，真正的错误是改了一个不会被发送的数组。
    // 本次这一份在返回前重新登记，所以"pre-step 里的自动压缩"仍能就地刷新。
    if (previous?.session !== undefined) {
      const prior = lifecycle.sessions?.get(previous.session.id);
      if (prior !== undefined) prior.refreshPendingProjection = null;
    }
    const transformed = await next();
    const agent = context?.agent;
    if (agent === undefined) return transformed;

    const scope = agent;
    const mode = ctx.tools.modeFor(context.scope ?? scope);
    if (mode !== 'native') {
      throw new DomainError('INCOMPATIBLE_PRESENTATION', `tools mode "${mode}" is not supported`);
    }

    // 首次触达即建立本会话 runtime（可能仍处于 restoring）
    const runtime = lifecycle.runtimeFor(agent.session, scope);
    // 冷恢复未落定就先等它落定：否则这一轮会把已披露工具整段丢掉（见文件头
    //「冷恢复窗口」）。仍在恢复 = 不发请求；已决失败 = 只留基线（fail closed）。
    if (runtime.restoring) await awaitRestore(runtime, context?.signal);
    // 可信基线（trusted-epoch.mjs）：pending/blocked 一律**不发请求**。
    // 这不是"缩水兜底"——发一份只带三入口的请求等于承认"没有授权也照发"，
    // 那正是本轮要移除的出站授信。
    await enforceTrustedBaseline(runtime, context?.signal);
    if (runtime.pendingProjectionError !== undefined && runtime.pendingProjectionError !== null) {
      // 就地刷新失败过：这份还没发送的 assembly 仍是旧样子，绝不能发出去。
      const error = runtime.pendingProjectionError;
      runtime.pendingProjectionError = null;
      throw error;
    }
    const incoming = Array.isArray(transformed?.tools) ? transformed.tools : [];
    const kept = project(runtime, scope, incoming);

    // 留一份"尚未发送"的刷新入口。只保留最新一份：连续两次 assemble 以后一份为准。
    runtime.refreshPendingProjection = () => {
      try {
        const next_kept = project(runtime, scope, incoming);
        kept.splice(0, kept.length, ...next_kept);
        runtime.pendingProjectionError = null;
        log('projection:pending-refreshed', {
          sessionId: runtime.scope.sessionId,
          kept: kept.map((t) => t.name),
        });
        return true;
      } catch (error) {
        // 数组被冻结 / 投影判据被触发：**记录现场并让下一次发请求中止**，
        // 绝不吞掉还继续发一份仍带旧名单的数组。
        runtime.pendingProjectionError = error;
        log('projection:pending-refresh-failed', { error: String(error) });
        return false;
      }
    };

    return { ...transformed, tools: kept };
  });
}

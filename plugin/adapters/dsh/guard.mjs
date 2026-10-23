// plugin/adapters/dsh/guard.mjs
// 同步执行披露门禁：只**增加拒绝**，不授予任何权限，不改动原执行管线。
//
// F1 处置（domain-api §7 / runtime-review §4.1）：调用面**不区分存在性**。
// 对外文案只由 domain 的 `reason` 决定，`visibility` 只进宿主日志，
// 绝不拼进模型可见的拒绝文本；也**不使用** UNKNOWN_TOOL 样式
// （那是宿主原生语义，与本插件拒绝不同义）。
import { ENTRY_TOOL_NAMES, CORE_TOOL_NAMES } from '../../domain/index.mjs';
import { BASELINE_STATE } from './trusted-epoch.mjs';

/**
 * @param {{ctx:any, lifecycle:any, frameworkRetained?:readonly string[], locale?:string, log?:Function}} deps
 */
export function createGuard(deps) {
  const { ctx, lifecycle } = deps;
  const config = { locale: deps.locale };
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
  // 「alwaysVisible 是下限还是精确集合」：由 index 层注入读取器。
  // 默认关闭 = 现状（核心工具自动常驻，且不经 load 即可执行）。
  const respectAlwaysVisible = typeof deps.respectAlwaysVisible === 'function'
    ? deps.respectAlwaysVisible
    : () => false;
  // 三入口与可信 framework 保留项由宿主配置背书，放行判据不受可信周期基线影响。
  // 严格模式的常驻工具只由 storageDomain 记录背书；默认模式使用配置快照，
  // 所以基线判据必须排在 alwaysNameSet 早退**之前**（见下）。
  const entryNames = new Set(ENTRY_TOOL_NAMES);
  // 每次调用线性扫数组 → 预建 Set（这条门禁在每次工具调用上都跑）。
  const coreNames = new Set(CORE_TOOL_NAMES);
  const ptcEnabled = typeof deps.ptcEnabled === 'function' ? deps.ptcEnabled : () => false;
  const log = deps.log ?? (() => {});

  /**
   * native 与 PTC 共用的裁决链（两分支曾各持一份逐字相同的实现）：
   * 可信基线 → 常驻名单早退 → 核心工具自证 → bypass 拒绝 → evaluateCall。
   * 入口名/run_code/framework 保留项的放行顺序在各展示模式分支里各自保持
   * 与抽取前完全一致（native 先取 runtime；PTC 先放行 framework 再取 runtime）。
   * @param {any} runtime
   * @param {any} agent
   * @param {{name:string}} exec
   * @param {'guard:denied'|'guard:ptc-denied'} deniedTag
   */
  function admitShared(runtime, agent, exec, deniedTag) {
    const sessionId = agent.session.id;
    // 可信基线未落定（pending）或已封（blocked）时，**任何**常驻名都不得被放行：
    // 这条必须早于 alwaysNameSet 的早退，否则一份不可信（或根本不存在）的名单
    // 就能凭"猜名"真正执行隐藏工具的 body。
    const baseline = runtime.ledger?.state;
    if (runtime.requireTrustedEpoch !== false && baseline !== undefined && baseline !== BASELINE_STATE.TRUSTED) {
      const reason = runtime.ledger?.reason ?? 'TRUSTED_EPOCH_PENDING';
      log('guard:baseline-not-trusted', { sessionId, name: exec.name, state: baseline, reason });
      return `tool "${exec.name}" is not admitted: STATE_NOT_READY (${reason})`;
    }
    if (runtime.alwaysNameSet?.has(exec.name) === true) return undefined;
    // 运行时装载自证（方案 1 动态兜底）：
    // 若调用的工具属于官方核心工具（CORE_TOOL_NAMES），且宿主当前 agent scope 实际装载了它：
    // 说明它是原本就有的系统工具，动态补入常驻名单并放行，避免产生 TOOL_NOT_LOADED 冲突死锁。
    //
    // `respectAlwaysVisible` 打开时**不走这条路**：那种模式下用户的名单是上限，没列出的核心
    // 工具必须像其它工具一样先 tool_load（名单层也同步不再自证补入）。被拒之后模型 load 一次
    // 即可 —— 被排除的名字**不在**受保护的基线里，engine 的 protected 判据不会拦它。
    // （`tolerantLoadProtected` 管的是另一件事：**已在名单里**的工具重复 load 保持幂等。）
    //
    // `runtime.initialToolsEnabled !== false` 是本周期**快照**：用户禁用初始注入后，宿主自带的
    // 核心工具不再被猜名自证补入 —— 否则一次猜名调用就能悄悄绕开关把名字塞回常驻名单。
    // 快照在 runtime 建立与成功压缩两处刷新，周期中途改 volatile 开关不改变本周期行为。
    if (respectAlwaysVisible() !== true && runtime.initialToolsEnabled !== false
      && coreNames.has(exec.name) && ctx.tools.get(exec.name, agent) !== undefined) {
      if (runtime.alwaysNameSet) runtime.alwaysNameSet.add(exec.name);
      // 可审计：这条放行**不**依赖可信记录、也不要求名字已在常驻集合 —— 它是"宿主自带的
      // 核心工具不被本插件阻断"这一信任边界。放行同时把名字补进常驻集合，因此它也是一次
      // 名单变更；留日志才能看清"配置移除了核心工具、模型猜名仍然执行"这条路径被走到过。
      log('guard:core-self-admitted', { sessionId, name: exec.name });
      return undefined;
    }
    // 有 listener 在我们的投影之后重加了未披露工具 → 整会话 fail closed
    // （位置在 alwaysNameSet 早退之后、evaluateCall 之前，两种展示模式语义对齐。）
    if (runtime.compositionBypass !== null) {
      log('guard:bypass-closed', { sessionId, name: exec.name, leaked: runtime.compositionBypass.names });
      return `tool "${exec.name}" is not admitted: INCOMPATIBLE_COMPOSITION`;
    }
    const outcome = runtime.engine.evaluateCall(runtime.scope, {
      name: exec.name,
      // 当前 scope 是否解析得到该工具只用于诊断字段 registeredInScope，
      // 不影响对外文案（两种 visibility 走同一句 reason）。
      registeredInScope: ctx.tools.get(exec.name, agent) !== undefined,
      // 同一响应内 load 完立刻调用：canonical 回执尚未折叠，属"即将生效"
      // 而非"从未加载"，两者必须给出不同的码与文案。journal 缺失属不可能
      // 形状（lifecycle 建立runtime 时恒挂载），直接调用保持 fail-closed。
      pendingLoad: runtime.journal.pendingLoadNames().has(exec.name),
      locale: config.locale,
      requestId: runtime.journal.currentRequestId(),
    });
    if (outcome.allowed) return undefined;
    log(deniedTag, {
      sessionId,
      name: exec.name,
      code: outcome.code,
      visibility: outcome.visibility,
    });
    return `${exec.name}: ${outcome.reason} (${outcome.code})`;
  }

  return ctx.tools.guard((exec) => {
    const agent = exec.agent;
    // `agent.session` 与 `agent` 同等必需：缺它时 runtimeFor 会抛 TypeError（宿主会把它
    // 兜成 toolError，body 仍不执行，但那是**非结构化**拒绝、不可归因）。这里给出与
    // index.mjs 同一句明确文案。
    if (agent === undefined || agent.session === undefined) {
      return `tool "${exec.name}" is not admitted by this composition: no agent scope (STATE_NOT_READY)`;
    }
    let mode = 'native';
    try { mode = ctx.tools.modeFor(agent); } catch { mode = 'native'; }
    if (mode !== 'native') {
      if (ptcEnabled() !== true) return undefined;
      // PTC 的合法出站表只有 run_code；三入口由协议保证放行。
      if (exec.name === 'run_code' || entryNames.has(exec.name)) return undefined;
      // 可信 framework 保留项是**部署配置即授权**，且它排在基线门禁之前
      // （pending/blocked 时也照放），所以这条放行必须可审计。
      if (frameworkRetained.has(exec.name)) {
        log('guard:framework-admitted', { sessionId: agent.session.id, name: exec.name });
        return undefined;
      }
      return admitShared(lifecycle.runtimeFor(agent.session, agent), agent, exec, 'guard:ptc-denied');
    }
    const runtime = lifecycle.runtimeFor(agent.session, agent);
    // 三入口由协议保证。
    if (entryNames.has(exec.name)) return undefined;
    // 可信 framework 保留项：与 PTC 分支同一句放行与审计（native 侧排在 runtimeFor
    // 与入口之后，与抽取前的顺序一致）。
    if (frameworkRetained.has(exec.name)) {
      log('guard:framework-admitted', { sessionId: agent.session.id, name: exec.name });
      return undefined;
    }
    return admitShared(runtime, agent, exec, 'guard:denied');
  });
}

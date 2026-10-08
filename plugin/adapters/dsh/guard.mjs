// plugin/adapters/dsh/guard.mjs
// 同步执行披露门禁：只**增加拒绝**，不授予任何权限，不改动原执行管线。
//
// F1 处置（domain-api §7 / runtime-review §4.1）：调用面**不区分存在性**。
// 对外文案只由 domain 的 `reason` 决定，`visibility` 只进宿主日志，
// 绝不拼进模型可见的拒绝文本；也**不使用** UNKNOWN_TOOL 字样
// （那是宿主原生语义，与本插件拒绝不同义）。
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs';
import { BASELINE_STATE } from './trusted-epoch.mjs';

/**
 * @param {{ctx:any, lifecycle:any, frameworkRetained?:readonly string[], locale?:string, log?:Function}} deps
 */
export function createGuard(deps) {
  const { ctx, lifecycle } = deps;
  const config = { locale: deps.locale };
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
  // 三入口与可信 framework 保留项由宿主配置背书，放行判据不受可信周期基线影响。
  // 严格模式的常驻工具只由 storageDomain 记录背书；默认模式使用配置快照，
  // 所以基线判据必须排在 alwaysNameSet 早退**之前**（见下）。
  const entryNames = new Set(ENTRY_TOOL_NAMES);
  const log = deps.log ?? (() => {});

  return ctx.tools.guard((exec) => {
    const agent = exec.agent;
    if (agent === undefined) {
      return `tool "${exec.name}" is not admitted by this composition: no agent scope (STATE_NOT_READY)`;
    }
    if (ctx.tools.modeFor(agent) !== 'native') {
      return `tool "${exec.name}" is not admitted: INCOMPATIBLE_PRESENTATION (tools mode is not native)`;
    }
    const runtime = lifecycle.runtimeFor(agent.session, agent);
    if (entryNames.has(exec.name) || frameworkRetained.has(exec.name)) return undefined;
    // 可信基线未落定（pending）或已封（blocked）时，**任何**常驻名都不得被放行：
    // 这条必须早于 alwaysNameSet 的早退，否则一份不可信（或根本不存在）的名单
    // 就能凭"猜名"真正执行隐藏工具的 body。
    const baseline = runtime.ledger?.state;
    if (runtime.requireTrustedEpoch !== false && baseline !== undefined && baseline !== BASELINE_STATE.TRUSTED) {
      const reason = runtime.ledger?.reason ?? 'TRUSTED_EPOCH_PENDING';
      log('guard:baseline-not-trusted', {
        sessionId: agent.session.id, name: exec.name, state: baseline, reason,
      });
      return `tool "${exec.name}" is not admitted: STATE_NOT_READY (${reason})`;
    }
    if (runtime.alwaysNameSet?.has(exec.name) === true) return undefined;
    // 有 listener 在我们的投影之后重加了未披露工具 → 整会话 fail closed
    if (runtime.compositionBypass !== null) {
      log('guard:bypass-closed', { sessionId: agent.session.id, name: exec.name, leaked: runtime.compositionBypass.names });
      return `tool "${exec.name}" is not admitted: INCOMPATIBLE_COMPOSITION`;
    }
    const outcome = runtime.engine.evaluateCall(runtime.scope, {
      name: exec.name,
      // 当前 scope 是否解析得到该工具只用于诊断字段 registeredInScope，
      // 不影响对外文案（两种 visibility 走同一句 reason）。
      registeredInScope: ctx.tools.get(exec.name, agent) !== undefined,
      // 同一响应内 load 完立刻调用：canonical 回执尚未折叠，属"即将生效"
      // 而非"从未加载"，两者必须给出不同的码与文案。
      pendingLoad: runtime.journal.pendingLoadNames().has(exec.name),
      locale: config.locale,
      requestId: runtime.journal.currentRequestId(),
    });
    if (outcome.allowed) return undefined;
    log('guard:denied', {
      sessionId: agent.session.id,
      name: exec.name,
      code: outcome.code,
      visibility: outcome.visibility,
    });
    return `${exec.name}: ${outcome.reason} (${outcome.code})`;
  });
}

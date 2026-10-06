// progressive-v2/adapters/dsh/guard.mjs
// 同步执行披露门禁：只**增加拒绝**，不授予任何权限，不改动原执行管线。
//
// F1 处置（domain-api §7 / runtime-review §4.1）：调用面**不区分存在性**。
// 对外文案只由 domain 的 `reason` 决定，`visibility` 只进宿主日志，
// 绝不拼进模型可见的拒绝文本；也**不使用** UNKNOWN_TOOL 字样
// （那是宿主原生语义，与本插件拒绝不同义）。
import { ENTRY_TOOL_NAMES } from '../../domain/index.mjs';

/**
 * @param {{ctx:any, lifecycle:any, frameworkRetained?:readonly string[], log?:Function}} deps
 */
export function createGuard(deps) {
  const { ctx, lifecycle } = deps;
  const frameworkRetained = new Set([...(deps.frameworkRetained ?? [])]);
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
    if (entryNames.has(exec.name) || frameworkRetained.has(exec.name)) {
      return undefined;
    }
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

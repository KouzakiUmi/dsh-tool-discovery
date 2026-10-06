// 阶段0 fixture 进程内探针状态（测试生命周期管理；不是产品实现）。
export const store = {
  /** 录制的最终 LLM 请求（GenerateOptions 快照，去除 signal）。 */
  requests: [],
  /** 脚本化的 mock 模型响应队列。 */
  script: [],
  /** 实际进入工具 body 的调用记录（body 副作用计数证据）。 */
  bodyCalls: [],
  /** tool_search 披露的短期候选引用：sessionId -> Map(ref -> { name, revision, toolId })。 */
  searchRefs: new Map(),
  /** 脚本化的 approval/request 应答（'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'）。 */
  approvalOutcomes: [],
  reset () {
    this.requests.length = 0
    this.script.length = 0
    this.bodyCalls.length = 0
    this.approvalOutcomes.length = 0
    this.searchRefs.clear()
  },
  bodyCount (callId) {
    return this.bodyCalls.filter((call) => call.callId === callId).length
  }
}

export function queueResponse (response) {
  store.script.push(response)
}

export function recordBody (exec, name) {
  store.bodyCalls.push({
    callId: exec.callId,
    sessionId: exec.agent?.session?.id ?? null,
    name,
    argumentsSnapshot: JSON.stringify(exec.arguments ?? null)
  })
}

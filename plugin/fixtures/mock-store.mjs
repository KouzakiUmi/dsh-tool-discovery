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
  /** 可选的**响应闸门队列**：第 N 个闸门拦住第 N 次 stream 的响应回放（见 holdNextResponse）。 */
  responseGates: [],
  reset () {
    this.requests.length = 0
    this.script.length = 0
    this.bodyCalls.length = 0
    this.approvalOutcomes.length = 0
    this.searchRefs.clear()
    this.responseGates.length = 0
  },
  bodyCount (callId) {
    return this.bodyCalls.filter((call) => call.callId === callId).length
  }
}

export function queueResponse (response) {
  store.script.push(response)
}

/**
 * 挂一道**模型响应闸门**：按顺序拦住下一次 mock 响应，直到 `release()`。
 *
 * 用途：`0.2.1-alpha.2` 会在本地 fork 子代理一轮结束（`result` 落定）后**释放**它
 * （`ctx.agents.get(childId)` → undefined，插件随之清掉内存 runtime）。有些门禁必须在
 * 「子代理仍然活动」时取证，闸门把这个活动期变成测试可控的窗口，而不是靠抢时序。
 *
 * 语义：闸门按 FIFO 与随后各次 stream 配对；`entered` 在真实请求**已被录制之后**、脚本响应
 * 被回放**之前**兑现；`release()` 放行该次响应。连续挂多道即可把同一活动期内的多轮都钉住。
 * 闸门不改动任何产品代码路径 —— 它只让 mock provider 多等一个 promise。
 *
 * @returns {{entered: Promise<void>, release: () => void}}
 */
export function holdNextResponse () {
  let notifyEntered
  let releaseResponse
  const entered = new Promise((resolve) => { notifyEntered = resolve })
  const released = new Promise((resolve) => { releaseResponse = resolve })
  const gate = { entered, released, notifyEntered }
  store.responseGates.push(gate)
  return {
    entered,
    release () {
      const index = store.responseGates.indexOf(gate)
      if (index !== -1) store.responseGates.splice(index, 1)
      releaseResponse()
    }
  }
}

export function recordBody (exec, name) {
  store.bodyCalls.push({
    callId: exec.callId,
    sessionId: exec.agent?.session?.id ?? null,
    name,
    argumentsSnapshot: JSON.stringify(exec.arguments ?? null)
  })
}

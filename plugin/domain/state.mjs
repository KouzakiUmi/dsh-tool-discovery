// plugin/domain/state.mjs
// 会话发现状态（rc.1 重设计，docs/14-rc1-redesign.md）。
//
// 与旧版的不同：没有 epoch、seq、冻结 wire、回执账本与 advertised 曝光表——
// 披露与执行资格的权威在 adapter（掩码 + admission store），domain 只维护
// "本会话已选择（admitted）哪些条目"这一份目录事实，供 list/search/load
// 的幂等判定、预算核算与状态投影使用。
//
//   * selected: Map<toolId, {toolId,name,revision,schemaDigest,skillRevision,
//     selectionSource,activatedAt}> —— load 成功后立即写入；seed（resume）
//     也写入同一形状。
//   * invalidated: Map<toolId, {reason,at,revision}> —— 只增不减的诊断记录；
//     view:'state' 在字节超限时只裁这一段（list.mjs fitStateWithinBudget）。
//   * mode 只保留 'ready'：会话创建即 ready，没有恢复/不兼容终态；
//     保留字段是因为 list.mjs 的 projectState 与若干净载文案按 mode 投影。

/**
 * @param {string} sessionId
 * @returns {{sessionId:string, mode:'ready', selected:Map<string,any>, invalidated:Map<string,any>}}
 */
export function createState(sessionId) {
  return {
    sessionId,
    mode: /** @type {const} */ ('ready'),
    selected: new Map(),
    invalidated: new Map(),
  };
}

/** 浅克隆 + Map 复制（保持 copy-on-write 习惯，不改原 state）。 */
export function cloneState(state) {
  return {
    ...state,
    selected: new Map(state.selected),
    invalidated: new Map(state.invalidated),
  };
}

// invalidated 诊断段的容量上限：它是只增不减的诊断段，长会话里反复撤权会让
// `view:'state'` 的 payload 单调膨胀。上限内保留最新记录（Map 插入序即时间序，
// 淘汰最旧条目），超出后 view:'state' 仍由 fitStateWithinBudget 按字节兜底裁剪。
const INVALIDATED_CAP = 256;

/**
 * 撤权 / 同名替换 / schema 变化：作废 selected，追加 invalidated 诊断。
 * 从未 selected 过且没有既有诊断记录的工具不写记录——`invalidated` 只增不减，
 * 无关撤权事件不能把它喂大；超出 INVALIDATED_CAP 时淘汰最旧条目。
 * @param {ReturnType<typeof createState>} state
 * @param {string} toolId
 * @param {string} reason
 * @param {number} now
 */
export function invalidateTool(state, toolId, reason, now) {
  const sel = state.selected.get(toolId);
  if (!sel && !state.invalidated.has(toolId)) return state;
  const next = cloneState(state);
  next.selected.delete(toolId);
  // 更新既有记录先删再写：让插入序回到“最近更新”位置，容量淘汰才淘汰真旧项。
  next.invalidated.delete(toolId);
  next.invalidated.set(toolId, { reason, at: now, revision: sel ? sel.revision : null });
  while (next.invalidated.size > INVALIDATED_CAP) {
    next.invalidated.delete(next.invalidated.keys().next().value);
  }
  return next;
}

/**
 * 撤销一个 selected 条目（tool_unload）：不写 invalidated——卸载是主动行为，
 * 不是资格失效；重新 load 时按正常幂等/预算路径处理。
 * @returns {boolean} 是否真有条目被移除
 */
export function removeSelection(state, toolId) {
  return state.selected.delete(toolId);
}

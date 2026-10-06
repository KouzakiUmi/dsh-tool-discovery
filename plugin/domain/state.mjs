// progressive-v2/domain/state.mjs
// 纯 reducer + canonical pair 严格核验 + guard 判据。
//
// 这是 runtime-review F2 的**产品实现**:不信任回执自报字段与自报版本,
// 而是从 canonical tool/call 重算输入路径、从当前绑定重算四字段身份后逐项比较。
//
// 纯函数约束:不读时钟、不读随机、不写文件、不发事件;所有外部事实由 ResolverContext 传入。
import { deepEqualCanonical, digestOf } from './canonical.mjs';
import { DomainError } from './errors.mjs';
import { isNonEmptyString, isPlainObject } from './util.mjs';

export const RECEIPT_KIND = 'tool-discovery.selection';
export const RECEIPT_VERSION = 2;

/**
 * @typedef {Object} SelectionRecord
 * @property {string} toolId
 * @property {string} name
 * @property {string} revision
 * @property {string} schemaDigest
 * @property {string} skillRevision
 * @property {'candidate'|'name'} selectionSource
 * @property {string} operationId
 * @property {number} seq
 * @property {number} activatedAt
 */

/**
 * @typedef {Object} SessionDiscoveryState
 * @property {string} sessionId
 * @property {'restoring'|'ready'|'incompatible'} mode
 * @property {Map<string, SelectionRecord>} selected
 * @property {Map<string, {toolId:string,name:string,revision:string,schemaDigest:string,requestId:string,at:number}>} advertised
 * @property {Map<string, {reason:string, at:number, revision:string|null}>} invalidated
 * @property {number} lastAppliedSeq
 * @property {{applied:number,duplicatesIgnored:number,outOfOrderIgnored:number,gaps:number[],rejected:number,coldCandidateRestores:number}} integrity
 */

/** @param {string} sessionId */
export function createState(sessionId) {
  return {
    sessionId,
    mode: /** @type {const} */ ('restoring'),
    selected: new Map(),
    advertised: new Map(),
    invalidated: new Map(),
    lastAppliedSeq: 0,
    integrity: {
      applied: 0,
      duplicatesIgnored: 0,
      outOfOrderIgnored: 0,
      gaps: [],
      rejected: 0,
      coldCandidateRestores: 0,
    },
  };
}

/**
 * 从当前绑定**完整重算**选中项的四字段身份。
 * @param {import('./catalog.mjs').CatalogEntry} entry
 * @param {{toolId:string,name:string,revision:string,schemaDigest:string,skillRevision:string}} claimed 回执自报值
 * @returns {{ok:boolean, reason?:string, computed:{revision:string,schemaDigest:string,skillRevision:string}}}
 */
export function recomputeSelectionIdentity(entry, claimed) {
  const schemaDigest = digestOf(entry.wire);
  const revision = `r_${digestOf({
    schemaDigest,
    skillRevision: entry.skillRevision,
    bindingGeneration: entry.bindingGeneration,
  })}`;
  const computed = { revision, schemaDigest, skillRevision: entry.skillRevision };

  if (claimed.name !== entry.name) return { ok: false, reason: 'name-mismatch', computed };
  if (claimed.toolId !== entry.toolId) return { ok: false, reason: 'toolId-mismatch', computed };
  if (claimed.revision !== computed.revision) return { ok: false, reason: 'revision-mismatch', computed };
  if (claimed.schemaDigest !== computed.schemaDigest) return { ok: false, reason: 'schemaDigest-mismatch', computed };
  if (claimed.skillRevision !== computed.skillRevision) return { ok: false, reason: 'skillRevision-mismatch', computed };
  return { ok: true, computed };
}

/**
 * 严格解析回执 payload 的形状(只检查形状;身份稍后由 catalog 重算比较)。
 * @param {unknown} payload
 * @returns {{ok:true, receipt:any}|{ok:false, reason:string}}
 */
export function parseReceiptShape(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload-not-object' };
  if (payload.kind !== RECEIPT_KIND) return { ok: false, reason: 'kind-mismatch' };
  if (payload.version !== RECEIPT_VERSION) return { ok: false, reason: 'version-mismatch' };
  if (!isNonEmptyString(payload.operationId)) return { ok: false, reason: 'operationId-missing' };
  if (payload.operation !== 'load' && payload.operation !== 'unload') return { ok: false, reason: 'operation-invalid' };
  if (payload.operation === 'load') {
    if (payload.selectionSource !== 'candidate' && payload.selectionSource !== 'name') {
      return { ok: false, reason: 'selectionSource-invalid' };
    }
    if (!Array.isArray(payload.selected) || payload.selected.length === 0) {
      return { ok: false, reason: 'selected-missing' };
    }
    for (const s of payload.selected) {
      if (!isPlainObject(s)) return { ok: false, reason: 'selected-item-not-object' };
      for (const f of ['toolId', 'name', 'revision', 'schemaDigest', 'skillRevision']) {
        if (!isNonEmptyString(s[f])) return { ok: false, reason: `selected-${f}-invalid` };
      }
    }
  } else {
    // deselected 允许为空:unload 未激活 ID 是幂等 no-op(S07/§7)
    if (!Array.isArray(payload.deselected)) {
      return { ok: false, reason: 'deselected-missing' };
    }
    for (const d of payload.deselected) {
      if (!isNonEmptyString(d)) return { ok: false, reason: 'deselected-item-invalid' };
    }
  }
  return { ok: true, receipt: payload };
}

/**
 * 从 canonical call 的**真实输入**重算 selectionSource(不信回执自报)。
 * @param {unknown} input
 * @returns {{ok:true, source:'candidate'|'name', action:'load'|'unload'}|{ok:false, reason:string}}
 */
export function deriveInputPath(input) {
  if (!isPlainObject(input)) return { ok: false, reason: 'input-not-object' };
  const action = input.action === undefined ? 'load' : input.action;
  if (action !== 'load' && action !== 'unload') return { ok: false, reason: 'action-invalid' };
  if (action === 'unload') {
    if (!Array.isArray(input.toolIds) || input.toolIds.length === 0) {
      return { ok: false, reason: 'toolIds-missing' };
    }
    return { ok: true, source: /** @type {any} */ ('name'), action };
  }
  const hasCandidates = input.candidates !== undefined;
  const hasNames = input.names !== undefined;
  if (hasCandidates && hasNames) return { ok: false, reason: 'mixed-input-paths' };
  if (!hasCandidates && !hasNames) return { ok: false, reason: 'no-input-path' };
  if (hasCandidates) {
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
      return { ok: false, reason: 'candidates-empty' };
    }
    return { ok: true, source: /** @type {any} */ ('candidate'), action };
  }
  if (!Array.isArray(input.names) || input.names.length === 0) {
    return { ok: false, reason: 'names-empty' };
  }
  return { ok: true, source: /** @type {any} */ ('name'), action };
}

/**
 * 折叠一对 canonical tool/call → tool/result。**只有全部判据通过才改 selected**。
 *
 * @param {SessionDiscoveryState} state
 * @param {import('./index.mjs').CanonicalPair} pair
 * @param {import('./index.mjs').ResolverContext} ctx
 * @returns {{state:SessionDiscoveryState, applied:boolean, reason?:string}}
 */
export function reducePair(state, pair, ctx) {
  const reject = (reason) => {
    const next = cloneState(state);
    next.integrity.rejected += 1;
    return { state: next, applied: false, reason };
  };

  if (!isPlainObject(pair) || typeof pair.seq !== 'number' || !isNonEmptyString(pair.call?.operationId)) {
    return reject('pair-malformed');
  }
  // 判据 1:只认 tool_load
  if (pair.call.tool !== 'tool_load') return reject('not-tool-load');

  // 判据 2:sourceEventSeqs 若存在必须与 seq 一致
  if (Array.isArray(pair.result?.sourceEventSeqs) && !pair.result.sourceEventSeqs.includes(pair.seq)) {
    return reject('source-seq-mismatch');
  }
  // renderer / pruner 改写标记 → 无条件拒
  if (isNonEmptyString(pair.result?.rewrittenBy)) return reject('result-rewritten');

  // 判据 12:重复 / 更小 seq 忽略
  if (pair.seq <= state.lastAppliedSeq) {
    const next = cloneState(state);
    if (pair.seq === state.lastAppliedSeq) next.integrity.duplicatesIgnored += 1;
    else next.integrity.outOfOrderIgnored += 1;
    return { state: next, applied: false, reason: 'stale-seq' };
  }

  // 判据 3:最终成功 = 外层非 isError **且** 协议 ok=true
  if (pair.result?.isError !== false) return reject('result-is-error');
  if (pair.result?.ok !== true) return reject('protocol-not-ok');

  // 判据 4:回执形状与版本
  const parsed = parseReceiptShape(pair.result.payload);
  if (!parsed.ok) return reject(parsed.reason);
  const receipt = parsed.receipt;

  // 判据 4b:operationId 必须与 canonical call 绑定
  if (receipt.operationId !== pair.call.operationId) return reject('operationId-mismatch');

  // 判据 5:输入路径由 call 重算
  const derived = deriveInputPath(pair.call.input);
  if (!derived.ok) return reject(derived.reason);
  if (receipt.operation !== derived.action) return reject('operation-mismatch');
  if (derived.action === 'load' && receipt.selectionSource !== derived.source) {
    return reject('selectionSource-mismatch');
  }

  const next = cloneState(state);
  if (pair.seq > state.lastAppliedSeq + 1) next.integrity.gaps.push(pair.seq);

  if (derived.action === 'unload') {
    const requested = /** @type {string[]} */ (pair.call.input.toolIds);
    const deselected = /** @type {string[]} */ (receipt.deselected);
    // 判据 10:deselected ⊆ toolIds;入口与框架保留项不可卸载
    for (const d of deselected) {
      if (!requested.includes(d)) return reject('deselected-not-requested');
      if (ctx.protectedToolIds && ctx.protectedToolIds.has(d)) return reject('protected-tool');
    }
    for (const toolId of deselected) {
      next.selected.delete(toolId);
      next.advertised.delete(toolId);
      next.invalidated.delete(toolId);
    }
    next.lastAppliedSeq = pair.seq;
    next.integrity.applied += 1;
    return { state: next, applied: true };
  }

  // load:完整重算比较
  const input = /** @type {any} */ (pair.call.input);
  /** @type {string[]} */
  const claimedNames = [];
  for (const s of receipt.selected) {
    // 判据 8(前置):toolId 与当前绑定必须同 key
    const entry = ctx.catalog.entries.get(s.toolId);
    if (!entry) return reject('toolId-not-in-catalog');
    // D1:load 折叠同样不得选中入口/框架保留项(与 names/candidates 路径对称)
    if (ctx.protectedToolIds && ctx.protectedToolIds.has(s.toolId)) return reject('protected-tool');
    if (ctx.protectedNames && ctx.protectedNames.has(entry.name)) return reject('protected-tool');
    const idCheck = recomputeSelectionIdentity(entry, s);
    if (!idCheck.ok) return reject(idCheck.reason);
    claimedNames.push(s.name);
  }

  if (derived.source === 'name') {
    // 判据 6:名称路径 selected ⊆ call.input.names
    const requestedNames = /** @type {string[]} */ (input.names);
    for (const n of claimedNames) {
      if (!requestedNames.includes(n)) return reject('selected-not-requested');
    }
    if (receipt.selected.length > requestedNames.length) return reject('selected-exceeds-request');
  } else {
    // 判据 7:候选路径 —— 热态交叉校验 ref;冷态只重算定义并计数
    const refs = /** @type {any[]} */ (input.candidates);
    if (receipt.selected.length > refs.length) return reject('selected-exceeds-request');
    if (typeof ctx.resolveRef === 'function') {
      const resolved = [];
      for (const c of refs) {
        const r = ctx.resolveRef(c.ref);
        if (!r) return reject('candidate-ref-unresolvable');
        if (r.revision !== c.revision) return reject('candidate-revision-mismatch');
        resolved.push(r.toolId);
      }
      for (const s of receipt.selected) {
        if (!resolved.includes(s.toolId)) return reject('selected-not-from-candidate');
      }
    } else {
      next.integrity.coldCandidateRestores += 1;
    }
  }

  // 判据 11:幂等 —— 同 toolId 同 revision 不重复计;不同 revision 是显式重选
  for (const s of receipt.selected) {
    const prior = next.selected.get(s.toolId);
    if (prior && prior.revision === s.revision) {
      // 幂等:保持原记录(不重复追加 schema/技能/预算)
      continue;
    }
    next.selected.set(s.toolId, {
      toolId: s.toolId,
      name: s.name,
      revision: s.revision,
      schemaDigest: s.schemaDigest,
      skillRevision: s.skillRevision,
      selectionSource: receipt.selectionSource,
      operationId: receipt.operationId,
      seq: pair.seq,
      activatedAt: ctx.now(),
    });
    // 换了版本 → 旧曝光立即作废
    next.advertised.delete(s.toolId);
    next.invalidated.delete(s.toolId);
  }

  next.lastAppliedSeq = pair.seq;
  next.integrity.applied += 1;
  return { state: next, applied: true };
}

/**
 * 记录一次**真实出站请求**的曝光集合(来自最终 canonical request/header)。
 * 只对 selected 中版本完全一致的项建立 advertised;调试/预览装配不算。
 * @param {SessionDiscoveryState} state
 * @param {{requestId:string, toolId:string, name:string, revision:string, schemaDigest:string, now:number}} rec
 */
export function recordAdvertisement(state, rec) {
  const next = cloneState(state);
  const sel = next.selected.get(rec.toolId);
  // 必须 selected 且 name/revision/schemaDigest 三者全等,否则不算已披露
  if (!sel) return next;
  if (sel.name !== rec.name || sel.revision !== rec.revision || sel.schemaDigest !== rec.schemaDigest) {
    next.advertised.delete(rec.toolId);
    return next;
  }
  next.advertised.set(rec.toolId, {
    toolId: rec.toolId,
    name: rec.name,
    revision: rec.revision,
    schemaDigest: rec.schemaDigest,
    requestId: rec.requestId,
    at: rec.now,
  });
  return next;
}

/**
 * guard 判据(adapter 调用;不伪造宿主 UNKNOWN_TOOL 码)。
 *
 * `visibility` 是**诊断字段**,adapter 禁止把它放进模型可见文本;
 * 对外 `reason` 文案在 hidden / unknown-to-scope 之间必须一致,避免泄漏存在性。
 *
 * @param {SessionDiscoveryState} state
 * @param {{name:string, toolId?:string, requestId?:string, now:number, entryTools?:string[], registeredInScope?:boolean|null, isEntryOrFramework?:boolean}} ctx
 */
export function evaluateCall(state, ctx) {
  const UNIFORM_NOT_LOADED = '该工具未在当前会话中显式加载。';
  const UNIFORM_NOT_ADVERTISED = '该工具未在当前请求中披露。';

  if (state.mode !== 'ready') {
    return { allowed: false, code: /** @type {const} */ ('TOOL_NOT_LOADED'), reason: '会话状态未就绪。', visibility: /** @type {const} */ ('hidden') };
  }
  if (ctx.isEntryOrFramework) return { allowed: true };

  const selectedByName = Array.from(state.selected.values()).filter((s) => s.name === ctx.name);
  if (selectedByName.length === 0) {
    return {
      allowed: false,
      code: /** @type {const} */ ('TOOL_NOT_LOADED'),
      reason: UNIFORM_NOT_LOADED,
      visibility: ctx.registeredInScope === false ? /** @type {const} */ ('unknown-to-scope') : /** @type {const} */ ('hidden'),
    };
  }
  const sel = selectedByName[0];
  if (ctx.toolId && ctx.toolId !== sel.toolId) {
    return { allowed: false, code: /** @type {const} */ ('TOOL_NOT_LOADED'), reason: UNIFORM_NOT_LOADED, visibility: /** @type {const} */ ('hidden') };
  }
  // 记录的定义已被作废(撤权/定义变化)→ 视为未加载
  if (state.invalidated.has(sel.toolId)) {
    return { allowed: false, code: /** @type {const} */ ('TOOL_NOT_LOADED'), reason: UNIFORM_NOT_LOADED, visibility: /** @type {const} */ ('hidden') };
  }
  const adv = state.advertised.get(sel.toolId);
  if (!adv || (ctx.requestId && adv.requestId !== ctx.requestId) || adv.revision !== sel.revision) {
    return {
      allowed: false,
      code: /** @type {const} */ ('TOOL_NOT_ADVERTISED'),
      reason: UNIFORM_NOT_ADVERTISED,
      visibility: adv ? /** @type {const} */ ('stale-revision') : /** @type {const} */ ('hidden'),
    };
  }
  return { allowed: true };
}

/**
 * 工具撤权 / 定义变化 / 同名替换 → 立即失效 selected 与 advertised。
 * @param {SessionDiscoveryState} state
 * @param {string} toolId
 * @param {string} reason
 * @param {number} now
 */
export function invalidateTool(state, toolId, reason, now) {
  const next = cloneState(state);
  const sel = next.selected.get(toolId);
  next.selected.delete(toolId);
  next.advertised.delete(toolId);
  next.invalidated.set(toolId, { reason, at: now, revision: sel ? sel.revision : null });
  return next;
}

/** 浅克隆 + Map 复制(保持 reducer 纯度,不改原 state)。 */
function cloneState(state) {
  return {
    ...state,
    selected: new Map(state.selected),
    advertised: new Map(state.advertised),
    invalidated: new Map(state.invalidated),
    integrity: { ...state.integrity, gaps: state.integrity.gaps.slice() },
  };
}

/** 供 adapter 做"回执逐字比较"(热态 pending 路径)。 */
export { deepEqualCanonical };

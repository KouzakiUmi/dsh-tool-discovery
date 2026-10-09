// plugin/domain/index.mjs
// 阶段1 领域内核的唯一公开出口。
// 宿主无关:不 import Cordis / DSH / 第三方包;仅依赖 node:crypto / node:util。
//
// 冻结的接口说明见 plugin/reports/domain-api.md。
// 签名若需变更,必须先在该文件追加 delta 并通知主代理与独立 reviewer。

export { PROTOCOL_VERSION, CONTROLLED_CATEGORIES, DEFAULT_BUDGETS, OPTIONAL_LIMIT_KEYS, ENTRY_TOOL_NAMES, ERROR_CODES, errorCodes, MATCH_REASONS, SIGNAL_WEIGHTS, SYNONYM_INDEX } from './constants.mjs';
export { CORE_TOOL_NAMES } from './core-tools.mjs';
export { createText, normalizeLocale, tableFor, SUPPORTED_LOCALES, DEFAULT_LOCALE, setDomainLocale, domainText } from './locale.mjs';
export { detectHostLocale } from './host-locale.mjs';
export { DomainError, isDomainError, toDomainError } from './errors.mjs';
export { canonicalJson, sha256Hex, digestOf, utf8Bytes, deepEqualCanonical, deepFreeze } from './canonical.mjs';
export { clampCodePoints, isPlainObject, sortBy, createMutex } from './util.mjs';
export { classifyBinding, isVisibleCategory, buildCategoryCards, resolveCategory, nameSegments } from './categories.mjs';
export {
  buildCatalog, buildEntry, validateBinding, resolveByToolId, resolveByName,
  orderedNamesFor, recomputeIdentity, hasNameConflict,
} from './catalog.mjs';
export {
  resolveBudgets, estimateTokens, estimatedTokenCount, assertBytes,
  createByteAccumulator, activeSchemaBytes, assertActiveBudget,
} from './budgets.mjs';
export { tokenize, buildSearchIndex, search, documentTokens, synonymConcepts } from './search.mjs';
export { createRefStore } from './candidate-refs.mjs';
export { createCursorStore, paginateNames, paginateCategories, projectState } from './list.mjs';
export { validateSkill, projectSkill, skillBytes, assertSkillBudget } from './skills.mjs';
export {
  validateListRequest, validateSearchRequest, validateLoadRequest,
  okEnvelope, errorEnvelope, toErrorEnvelope, LIST_VIEWS,
} from './protocol.mjs';
export {
  createState, reducePair, recordAdvertisement, evaluateCall, invalidateTool,
  recomputeSelectionIdentity, parseReceiptShape, deriveInputPath,
  freezeTool, resetCacheEpoch, frozenWireList,
  RECEIPT_KIND, RECEIPT_VERSION,
} from './state.mjs';
export { createDiscoveryEngine } from './engine.mjs';

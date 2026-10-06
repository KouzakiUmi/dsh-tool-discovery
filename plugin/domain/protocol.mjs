// progressive-v2/domain/protocol.mjs
// 三个入口请求的**严格**校验 + 响应外壳。
// 关键约束:未知字段一律 INVALID_ARGS;不接受 sessionId/agentId/provider/路径/自由技能名/代码。
import { DEFAULT_BUDGETS, PROTOCOL_VERSION } from './constants.mjs';
import { DomainError } from './errors.mjs';
import { isNonEmptyString, isPlainObject } from './util.mjs';

const LIST_VIEWS = Object.freeze(['available', 'loaded', 'categories', 'state']);

/** 明确禁止出现在请求中的字段名(身份/路径/自由文本/代码)。 */
const FORBIDDEN_FIELDS = Object.freeze([
  'sessionid', 'agentid', 'provider', 'providerurl', 'path', 'filepath', 'file',
  'databasepath', 'db', 'url', 'skillname', 'skill', 'code', 'script', 'exec',
  'actor', 'userid', 'token', 'secret', 'apikey',
]);

function assertNoForbiddenFields(obj) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_FIELDS.includes(key.toLowerCase())) {
      throw new DomainError('INVALID_ARGS', `不接受字段: ${key}`);
    }
  }
}

function assertOnlyKeys(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new DomainError('INVALID_ARGS', `未知字段: ${key}`);
  }
}

/** @param {unknown} raw @returns {import('./util.mjs').isPlainObject extends true ? object : never} */
function requireObjectRoot(raw) {
  if (!isPlainObject(raw)) throw new DomainError('INVALID_ARGS', '请求必须是对象根。');
  assertNoForbiddenFields(/** @type {object} */ (raw));
  return /** @type {Record<string, unknown>} */ (raw);
}

/**
 * @param {number} value
 * @param {number} def
 * @param {number} max
 */
function normalizeLimit(value, def, max) {
  if (value === undefined) return def;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DomainError('INVALID_ARGS', 'limit 必须是正整数。');
  }
  if (value > max) throw new DomainError('INVALID_ARGS', 'limit 超过硬上限。', { max });
  return value;
}

/**
 * 校验 tool_list 请求。
 * @param {unknown} raw
 * @param {Readonly<import('./index.mjs').BudgetConfigDTO>} [budgets]
 * @returns {{view:string, category?:string, cursor?:string, limit:number}}
 */
export function validateListRequest(raw, budgets = DEFAULT_BUDGETS) {
  const o = requireObjectRoot(raw);
  const view = o.view === undefined ? 'available' : o.view;
  if (typeof view !== 'string' || !LIST_VIEWS.includes(view)) {
    throw new DomainError('INVALID_ARGS', '未知 view。');
  }
  const limit = normalizeLimit(o.limit, budgets.defaultListLimit, budgets.maxListLimit);
  const cursor = o.cursor;
  if (cursor !== undefined && !isNonEmptyString(cursor)) {
    throw new DomainError('INVALID_ARGS', 'cursor 必须是字符串。');
  }

  if (view === 'state') {
    assertOnlyKeys(o, ['view']);
    if (o.category !== undefined) throw new DomainError('INVALID_ARGS', 'state view 不接受 category。');
    if (o.cursor !== undefined) throw new DomainError('INVALID_ARGS', 'state view 不接受 cursor。');
    return { view, limit };
  }

  if (view === 'categories') {
    assertOnlyKeys(o, ['view', 'cursor', 'limit']);
    return { view, cursor, limit };
  }

  // available / loaded
  assertOnlyKeys(o, ['view', 'category', 'cursor', 'limit']);
  const category = o.category;
  if (category === undefined) throw new DomainError('INVALID_ARGS', 'available/loaded view 需要 category。');
  if (!isNonEmptyString(category)) throw new DomainError('INVALID_ARGS', 'category 必须是字符串。');
  return { view, category, cursor, limit };
}

/**
 * 校验 tool_search 请求。
 * @param {unknown} raw
 * @param {Readonly<import('./index.mjs').BudgetConfigDTO>} [budgets]
 * @returns {{category:string, query:string, limit:number}}
 */
export function validateSearchRequest(raw, budgets = DEFAULT_BUDGETS) {
  const o = requireObjectRoot(raw);
  assertOnlyKeys(o, ['category', 'query', 'limit']);
  const category = o.category;
  if (!isNonEmptyString(category)) throw new DomainError('INVALID_ARGS', 'category 必填。');
  const query = o.query;
  if (!isNonEmptyString(query)) throw new DomainError('INVALID_ARGS', 'query 必填。');
  const codePoints = Array.from(query).length;
  if (codePoints > budgets.maxQueryCodePoints) {
    throw new DomainError('INVALID_ARGS', 'query 超出长度上限。', { codePoints, max: budgets.maxQueryCodePoints });
  }
  const limit = normalizeLimit(o.limit, budgets.defaultSearchLimit, budgets.maxSearchLimit);
  return { category, query, limit };
}

/**
 * 校验 tool_load 请求。candidates 与 names 必须且只能提供一项。
 * @param {unknown} raw
 * @param {Readonly<import('./index.mjs').BudgetConfigDTO>} [budgets]
 * @returns {{action:'load'|'unload', candidates?:Array<{ref:string,revision:string}>, names?:string[], toolIds?:string[]}}
 */
export function validateLoadRequest(raw, budgets = DEFAULT_BUDGETS) {
  const o = requireObjectRoot(raw);
  assertOnlyKeys(o, ['action', 'candidates', 'names', 'toolIds']);
  const action = o.action === undefined ? 'load' : o.action;
  if (action !== 'load' && action !== 'unload') throw new DomainError('INVALID_ARGS', '未知 action。');

  if (action === 'unload') {
    if (o.candidates !== undefined || o.names !== undefined) {
      throw new DomainError('INVALID_ARGS', 'unload 不接受 candidates/names。');
    }
    const toolIds = o.toolIds;
    if (!Array.isArray(toolIds) || toolIds.length === 0) {
      throw new DomainError('INVALID_ARGS', 'unload 需要非空 toolIds。');
    }
    for (const t of toolIds) {
      if (!isNonEmptyString(t)) throw new DomainError('INVALID_ARGS', 'toolIds 必须是字符串。');
    }
    const dedup = Array.from(new Set(toolIds));
    if (dedup.length > budgets.maxActiveTools) {
      throw new DomainError('INVALID_ARGS', 'unload 数量超过活跃上限。');
    }
    return { action: 'unload', toolIds: dedup };
  }

  if (o.toolIds !== undefined) throw new DomainError('INVALID_ARGS', 'load 不接受 toolIds。');
  const hasCandidates = o.candidates !== undefined;
  const hasNames = o.names !== undefined;
  if (hasCandidates && hasNames) {
    throw new DomainError('INVALID_ARGS', 'candidates 与 names 必须且只能提供一项。');
  }
  if (!hasCandidates && !hasNames) {
    throw new DomainError('INVALID_ARGS', 'load 需要 candidates 或 names 之一。');
  }

  if (hasCandidates) {
    const arr = o.candidates;
    if (!Array.isArray(arr) || arr.length === 0) throw new DomainError('INVALID_ARGS', 'candidates 必须非空数组。');
    if (arr.length > budgets.maxLoadBatch) throw new DomainError('INVALID_ARGS', 'candidates 超过批次上限。');
    /** @type {Array<{ref:string,revision:string}>} */
    const out = [];
    /** @type {Map<string,string>} */
    const seen = new Map();
    for (const item of arr) {
      if (!isPlainObject(item)) throw new DomainError('INVALID_ARGS', 'candidate 必须是对象。');
      assertNoForbiddenFields(item);
      assertOnlyKeys(item, ['ref', 'revision']);
      if (!isNonEmptyString(item.ref) || !isNonEmptyString(item.revision)) {
        throw new DomainError('INVALID_ARGS', 'candidate 需要 ref 与 revision。');
      }
      const prev = seen.get(item.ref);
      if (prev !== undefined && prev !== item.revision) {
        throw new DomainError('INVALID_ARGS', '重复 ref 的 revision 冲突。');
      }
      seen.set(item.ref, item.revision);
      out.push({ ref: item.ref, revision: item.revision });
    }
    return { action: 'load', candidates: out };
  }

  const names = o.names;
  if (!Array.isArray(names) || names.length === 0) throw new DomainError('INVALID_ARGS', 'names 必须非空数组。');
  if (names.length > budgets.maxLoadBatch) throw new DomainError('INVALID_ARGS', 'names 超过批次上限。');
  for (const n of names) {
    if (!isNonEmptyString(n)) throw new DomainError('INVALID_ARGS', 'names 必须是字符串。');
  }
  return { action: 'load', names: Array.from(new Set(names)) };
}

/**
 * @param {string} tool
 * @param {string} operation
 * @param {object} data
 * @param {string} [nextAction]
 */
export function okEnvelope(tool, operation, data, nextAction) {
  /** @type {Record<string, unknown>} */
  const env = { protocolVersion: PROTOCOL_VERSION, tool, operation, ok: true, data };
  if (nextAction) env.nextAction = nextAction;
  return env;
}

/**
 * @param {string} tool
 * @param {string} operation
 * @param {import('./errors.mjs').DomainError} err
 */
export function errorEnvelope(tool, operation, err) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    tool,
    operation,
    ok: false,
    error: { code: err.code, message: err.message, retryable: err.retryable, recovery: err.recovery },
  };
}

/**
 * @param {string} tool
 * @param {string} operation
 * @param {string} code
 * @param {object} [details]
 */
export function toErrorEnvelope(tool, operation, code, details) {
  return errorEnvelope(tool, operation, new DomainError(code, undefined, details));
}

export { LIST_VIEWS };

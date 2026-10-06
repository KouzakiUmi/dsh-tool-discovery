// progressive-v2/domain/budgets.mjs
// 字节 / token 预算核算。
// 无 tokenizer 时一律 estimate 并显式标注 method:'estimate'——不用 bytes/4 冒充实测。
// 原则:不截断 schema / name / ref / ids / version;超限只减完整项数或明确失败。
import { DEFAULT_BUDGETS } from './constants.mjs';
import { utf8Bytes } from './canonical.mjs';
import { DomainError } from './errors.mjs';
import { isPlainObject } from './util.mjs';

// --- i18n shim (added by the message migration) ---------------------------
// These validators are pure and take no locale argument. The plugin resolves
// one locale per activation, so bind the text accessor once here rather than
// threading it through every signature. setLocaleForDomain() is called by the
// adapter at activation; tests call it directly to exercise both languages.
import { domainText } from './locale.mjs';
const text = domainText;
const t = (path) => text.t(path);


const NUMERIC_KEYS = Object.keys(DEFAULT_BUDGETS);

/**
 * 合并并校验预算配置。只接受已知数值键;缺失回落默认值。
 * @param {Partial<import('./index.mjs').BudgetConfigDTO>} [partial]
 * @returns {Readonly<import('./index.mjs').BudgetConfigDTO>}
 */
export function resolveBudgets(partial) {
  if (partial === undefined || partial === null) return Object.freeze({ ...DEFAULT_BUDGETS });
  if (!isPlainObject(partial)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'budgetNotObject']));
  /** @type {Record<string, number>} */
  const out = { ...DEFAULT_BUDGETS };
  for (const k of Object.keys(partial)) {
    if (!NUMERIC_KEYS.includes(k)) throw new DomainError('INCOMPATIBLE_COMPOSITION', `未知预算项: ${k}`);
    const v = partial[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION', `预算项 ${k} 必须是正整数。`);
    }
    out[k] = v;
  }
  return Object.freeze(out);
}

/**
 * token 估算。**没有 tokenizer**,结果必须以 estimate 标注。
 * 口径:ASCII 按 4 字符/token,CJK 按 1 code point/token(保守上界),取两者分段求和。
 * @param {string} text
 * @returns {{ value: number; method: 'estimate' }}
 */
export function estimateTokens(text) {
  let ascii = 0;
  let cjk = 0;
  for (const ch of String(text)) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp > 0x2e80) cjk += 1;
    else ascii += 1;
  }
  return { value: Math.ceil(ascii / 4) + cjk, method: /** @type {const} */ ('estimate') };
}

/** @param {string} text */
export function estimatedTokenCount(text) {
  return estimateTokens(text).value;
}

/**
 * 检查 UTF-8 字节硬限。超限抛 BUDGET_EXCEEDED(调用方应先减项数)。
 * @param {string} text
 * @param {number} maxBytes
 * @param {string} what 仅用于 details
 */
export function assertBytes(text, maxBytes, what) {
  const bytes = utf8Bytes(text);
  if (bytes > maxBytes) {
    throw new DomainError('BUDGET_EXCEEDED', `${what} 超过字节预算。`, { bytes, maxBytes });
  }
  return bytes;
}

/**
 * 累计器:在固定预算内放入**完整**项,放不下就停(不截断项内容)。
 * @param {number} maxBytes
 */
export function createByteAccumulator(maxBytes) {
  let used = 0;
  return {
    /** @param {string} text @returns {boolean} 是否放得下 */
    tryAdd(text) {
      const b = utf8Bytes(text);
      if (used + b > maxBytes) return false;
      used += b;
      return true;
    },
    get used() {
      return used;
    },
    get remaining() {
      return maxBytes - used;
    },
  };
}

/**
 * 活跃 schema 字节核算:按选中项的 wire 字节求和(幂等时同版本不重复计)。
 * @param {ReadonlyArray<{ wireBytes: number }>} selections
 */
export function activeSchemaBytes(selections) {
  let total = 0;
  for (const s of selections) total += s.wireBytes;
  return total;
}

/**
 * 校验一批新增选择是否超活跃 schema / 数量预算(全批判定,不半提交)。
 * @param {ReadonlyArray<{ wireBytes: number }>} newSelections
 * @param {ReadonlyArray<{ wireBytes: number }>} alreadyActive
 * @param {Readonly<import('./index.mjs').BudgetConfigDTO>} budgets
 */
export function assertActiveBudget(newSelections, alreadyActive, budgets) {
  const activeCount = alreadyActive.length + newSelections.length;
  if (activeCount > budgets.maxActiveTools) {
    throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'activeToolCount']), {
      activeCount,
      maxActiveTools: budgets.maxActiveTools,
    });
  }
  const totalBytes = activeSchemaBytes([...alreadyActive, ...newSelections]);
  if (totalBytes > budgets.maxActiveSchemaBytes) {
    throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'activeSchemaBytes']), {
      totalBytes,
      maxActiveSchemaBytes: budgets.maxActiveSchemaBytes,
    });
  }
  return { activeCount, totalBytes };
}

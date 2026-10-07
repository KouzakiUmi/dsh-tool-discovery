// plugin/domain/budgets.mjs
// 字节 / token 预算核算。
// 无 tokenizer 时一律 estimate 并显式标注 method:'estimate'——不用 bytes/4 冒充实测。
// 原则:不截断 schema / name / ref / ids / version;超限只减完整项数或明确失败。
//
// 可选限额（optional limits）：OPTIONAL_LIMIT_KEYS 里的硬上限可以用 `null` 关闭，
// 也可以用显式正整数启用。其余键（默认输出策略、TTL、受控分类自然总数、历史目标值）
// 始终必须是正整数。**绝不接受 Infinity** —— 它进不了协议 JSON。
import { DEFAULT_BUDGETS, OPTIONAL_LIMIT_KEYS } from './constants.mjs';
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
const OPTIONAL = new Set(OPTIONAL_LIMIT_KEYS);

/**
 * 合并并校验预算配置。只接受已知键;缺失回落默认值。
 *
 * 可选限额：`null` = 关闭（默认），显式正整数 = 启用。其他取值一律 INCOMPATIBLE_COMPOSITION，
 * 包括 `Infinity` —— 它无法进入协议 JSON，会被 stringify 成 null 并静默改变语义。
 *
 * @param {Partial<import('./index.mjs').BudgetConfigDTO>} [partial]
 * @returns {Readonly<import('./index.mjs').BudgetConfigDTO>}
 */
export function resolveBudgets(partial) {
  if (partial === undefined || partial === null) return Object.freeze({ ...DEFAULT_BUDGETS });
  if (!isPlainObject(partial)) throw new DomainError('INCOMPATIBLE_COMPOSITION', t(['detail', 'budgetNotObject']));
  /** @type {Record<string, number|null>} */
  const out = { ...DEFAULT_BUDGETS };
  for (const k of Object.keys(partial)) {
    if (!NUMERIC_KEYS.includes(k)) throw new DomainError('INCOMPATIBLE_COMPOSITION', text.format(['detail', 'unknownBudgetKey'], { key: k }));
    const v = partial[k];
    // 可选限额：null 明确表示"关闭这项上限"
    if (OPTIONAL.has(k) && v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new DomainError('INCOMPATIBLE_COMPOSITION',
        text.format(['detail', OPTIONAL.has(k) ? 'optionalLimitInvalid' : 'budgetKeyInvalid'], { key: k }));
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
 * 检查 UTF-8 字节硬限。`maxBytes` 为 null 时**不限制**（上限已关闭）。
 * 超限抛 BUDGET_EXCEEDED(调用方应先减项数)。
 * @param {string} text
 * @param {number|null} maxBytes
 * @param {string} what 仅用于 details
 */
export function assertBytes(text, maxBytes, what) {
  const bytes = utf8Bytes(text);
  if (maxBytes !== null && bytes > maxBytes) {
    throw new DomainError('BUDGET_EXCEEDED', text.format(['detail', 'bytesOverBudget'], { what }), { bytes, maxBytes });
  }
  return bytes;
}

/**
 * 累计器:在固定预算内放入**完整**项,放不下就停(不截断项内容)。
 *
 * `maxBytes` 为 null 时上限关闭:什么完整项都放得下,`remaining` 回 `null`
 * （绝不用 Infinity —— 它进不了协议 JSON）。
 * @param {number|null} maxBytes
 */
export function createByteAccumulator(maxBytes) {
  const unlimited = maxBytes === null;
  let used = 0;
  return {
    /** @param {string} text @returns {boolean} 是否放得下 */
    tryAdd(text) {
      const b = utf8Bytes(text);
      if (unlimited) { used += b; return true; }
      if (used + b > maxBytes) return false;
      used += b;
      return true;
    },
    get used() {
      return used;
    },
    /** JSON 可表达：关闭时为 null，不是 Infinity。 */
    get remaining() {
      return unlimited ? null : maxBytes - used;
    },
    /** 上限是否已关闭（供调用方跳过"放不下"分支的语义提示）。 */
    get unlimited() {
      return unlimited;
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
 * 校验一批新增选择是否超活跃 schema / 数量上限(全批判定,不半提交)。
 *
 * **上限为 null 时不做任何判定** —— 默认关闭即"不限制"。启用后仍然只**拒绝新增**，
 * 绝不淘汰已披露(frozen)的项：调用方不会因为这里抛错而丢掉任何既有内容。
 * @param {ReadonlyArray<{ wireBytes: number }>} newSelections
 * @param {ReadonlyArray<{ wireBytes: number }>} alreadyActive
 * @param {Readonly<import('./index.mjs').BudgetConfigDTO>} budgets
 */
export function assertActiveBudget(newSelections, alreadyActive, budgets) {
  const activeCount = alreadyActive.length + newSelections.length;
  const totalBytes = activeSchemaBytes([...alreadyActive, ...newSelections]);
  if (budgets.maxActiveTools !== null && activeCount > budgets.maxActiveTools) {
    throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'activeToolCount']), {
      activeCount,
      maxActiveTools: budgets.maxActiveTools,
    });
  }
  if (budgets.maxActiveSchemaBytes !== null && totalBytes > budgets.maxActiveSchemaBytes) {
    throw new DomainError('BUDGET_EXCEEDED', t(['detail', 'activeSchemaBytes']), {
      totalBytes,
      maxActiveSchemaBytes: budgets.maxActiveSchemaBytes,
    });
  }
  return { activeCount, totalBytes };
}

// progressive-v2/domain/errors.mjs
import { errorCodes } from './constants.mjs';
import { createText, domainText } from './locale.mjs';

/**
 * 领域错误。code 必须存在于错误码表。
 *
 * message 面向模型：默认取**当前界面语言**的码表文案；只有显式传入
 * messageOverride 才覆盖它。这样新增错误点不必逐条翻译，也不会漏。
 * @extends Error
 */
export class DomainError extends Error {
  /**
   * @param {string} code
   * @param {string} [messageOverride]
   * @param {Record<string, unknown>} [details]
   * @param {string} [locale] 宿主界面语言；缺省取激活期绑定的语言
   */
  constructor(code, messageOverride, details, locale) {
    // locale 缺省时必须回落到 domainText，而不是各自 createText(undefined)
    // —— 后者会静默回英文，让中文界面下的 DomainError 变成英文。
    const loc = locale ?? domainText.locale;
    const meta = errorCodes(loc)[code];
    if (!meta) throw new Error(`unknown DomainError code: ${code}`);
    super(messageOverride || meta.message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = meta.retryable;
    this.recovery = meta.recovery;
    if (details && Object.keys(details).length > 0) this.details = details;
  }
}

/** @param {unknown} e */
export function isDomainError(e) {
  return e instanceof Error && e.name === 'DomainError';
}

/**
 * 把任意异常收敛成 DomainError;未知内部错误不泄漏堆栈给模型。
 * @param {unknown} e
 * @param {string} [locale] 缺省取激活期绑定的语言(与 DomainError 构造器同一口径)
 * @returns {DomainError}
 */
export function toDomainError(e, locale) {
  if (isDomainError(e)) return /** @type {DomainError} */ (e);
  // locale 缺省同样回落到 domainText,而不是各自 createText(undefined)：
  // 否则中文界面下一个未预期异常会变成全篇里唯一一句英文(error_internal)。
  const loc = locale ?? domainText.locale;
  return new DomainError('INCOMPATIBLE_COMPOSITION', createText(loc).t(['error_internal']), {
    internal: true,
  }, loc);
}

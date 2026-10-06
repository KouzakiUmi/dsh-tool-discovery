// progressive-v2/domain/errors.mjs
import { ERROR_CODES } from './constants.mjs';

/**
 * 领域错误。code 必须存在于 ERROR_CODES。
 * @extends Error
 */
export class DomainError extends Error {
  /**
   * @param {string} code
   * @param {string} [messageOverride]
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, messageOverride, details) {
    const meta = ERROR_CODES[code];
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
  return e instanceof DomainError;
}

/**
 * 把任意异常收敛成 DomainError;未知内部错误不泄漏堆栈给模型。
 * @param {unknown} e
 * @returns {DomainError}
 */
export function toDomainError(e) {
  if (isDomainError(e)) return /** @type {DomainError} */ (e);
  return new DomainError('INCOMPATIBLE_COMPOSITION', '领域内核内部错误。', {
    internal: true,
  });
}

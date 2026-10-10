// 宿主界面语言探测（**纯函数**：本身不持有任何 I/O 能力）。
//
// DSH 把界面语言写在 $DSH_HOME/desktop-locale.json，形如 {"desktop":"en"}。该路径不在宿主
// 公开 API 内（@deepseek-ai/dsh-client-locale 只暴露设置项 schema 与客户端 apply），服务端
// 插件无法通过 ctx 读到它 —— 因此**路径解析与文件读取都由适配层完成**，结果注入这里。
//
// 本模块刻意不 import node:fs、不读 process.env：
//   * 不 import node:fs —— 内核与宿主 I/O 无关，单测可以完全在内存里跑；
//   * 不读 process.env —— 环境是**部署事实**，不是内核事实；home 由宿主 API 解析。
//
// 任何失败都回落 en：英文是协议文案的安全默认，猜错方向不会误导模型。这里宁可"语言没跟上"
// 也不要"语言猜错"——后者会让模型按另一种语言理解错误码与 nextAction。
import { normalizeLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locale.mjs'

/** Config 中表示"跟随界面语言"的哨兵值。 */
export const AUTO_LOCALE = 'auto'

/**
 * 探测宿主语言。
 * @param {{
 *   localeFile?: string,                    // desktop-locale.json 的绝对路径（适配层用宿主 API 解析）
 *   localeOverride?: string,                // 部署/用户显式钉住的语言（来自插件 Config）
 *   readFile?: (path: string) => string,    // 注入的读取函数；缺省视为"读不到"，直接回落
 *   log?: (message: string) => void,
 * }} [deps]
 * @returns {string} 受支持的 locale id
 */
export function detectHostLocale (deps = {}) {
  const log = deps.log ?? (() => {})

  // 显式覆盖优先：部署或用户可以钉住语言，不必依赖界面设置。
  const override = deps.localeOverride
  if (typeof override === 'string' && override.length > 0 && override !== AUTO_LOCALE) {
    return normalizeLocale(override)
  }

  const file = deps.localeFile
  if (typeof file !== 'string' || file.length === 0) {
    log(`locale: 没有可用的 localeFile，回落 ${DEFAULT_LOCALE}`)
    return DEFAULT_LOCALE
  }
  const read = deps.readFile
  if (typeof read !== 'function') {
    log(`locale: 没有注入 readFile，回落 ${DEFAULT_LOCALE}`)
    return DEFAULT_LOCALE
  }

  try {
    const parsed = JSON.parse(read(file))
    const desktop = parsed?.desktop ?? parsed?.locale ?? parsed?.preference
    if (typeof desktop === 'string') {
      // 能识别就采用（zh-CN 这类区域标签会被归一到 zh，这不算回落）；
      // 识别不了才按默认落，并且**留日志** —— "语言没跟上"必须可诊断。
      const primary = desktop.trim().toLowerCase().replace('_', '-').split('-')[0]
      if (!SUPPORTED_LOCALES.includes(primary)) {
        log(`locale: ${file} 的语言 ${JSON.stringify(desktop)} 不受支持，回落 ${DEFAULT_LOCALE}`)
      }
      return normalizeLocale(desktop)
    }
    log(`locale: ${file} 无可识别字段，回落 ${DEFAULT_LOCALE}`)
  } catch (error) {
    log(`locale: 读取 ${file} 失败（${String(error?.message ?? error)}），回落 ${DEFAULT_LOCALE}`)
  }
  return DEFAULT_LOCALE
}

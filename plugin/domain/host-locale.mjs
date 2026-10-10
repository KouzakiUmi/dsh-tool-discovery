// 宿主界面语言探测（**纯函数**：本身不持有任何 I/O 能力）。
//
// 语言事实有两个来源，按权威性排序；两者都由适配层注入，本模块既不 import node:fs 也不读
// process.env —— 环境与文件形状是**部署事实**，不是内核事实（见 host-locale 的单测：
// 任何一次真实文件系统访问都会让断言失败）。
//
//   1. `localePreference` —— 宿主 settings / profile patch 里的显式 `locale.preference`
//      （见 @deepseek-ai/dsh-client-locale 的 LOCALE_SETTINGS_NAMESPACE / LOCALE_PREFERENCE_FIELD）。
//      它与 profile 名无关，是**权威**来源。
//   2. `localeFile` + `profileKey` —— 桌面壳写的 `$DSH_HOME/desktop-locale.json`。
//      该文件的形状是 `{ "<profile 名>": "<locale>" }`，**不是** `{"desktop": ...}` 这样的固定
//      字段名：本机活跃 profile 恰好叫 `desktop`，所以按固定字段读会在 `web` 之类的 profile 下
//      静默失效，还会在存在同名 profile 时读到**别的 profile** 的语言。因此这里只认调用方
//      给出的 `profileKey`：拿不到就老实回落，不猜。
//
// 任何失败都回落 en：英文是协议文案的安全默认，猜错方向不会误导模型。这里宁可"语言没跟上"
// 也不要"语言猜错"——后者会让模型按另一种语言理解错误码与 nextAction。
import { normalizeLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locale.mjs'

/** Config 中表示"跟随界面语言"的哨兵值。 */
export const AUTO_LOCALE = 'auto'

/**
 * 探测宿主语言。
 * @param {{
 *   localeOverride?: string,                // 插件 Config 的 locale（部署/用户显式钉住）
 *   localePreference?: string|null,         // 宿主 locale 设置项的 preference（权威）
 *   localeFile?: string,                    // desktop-locale.json 的绝对路径
 *   profileKey?: string|null,               // 当前 profile 名（该文件以它为键）
 *   readFile?: (path: string) => string,    // 注入的读取函数；缺省视为"读不到"
 *   log?: (message: string) => void,
 * }} [deps]
 * @returns {string} 受支持的 locale id
 */
export function detectHostLocale (deps = {}) {
  const log = deps.log ?? (() => {})

  // 0) 插件 Config 显式钉住的语言。先归一再比哨兵：`'AUTO'` / `' auto '` 也是"跟随界面语言"，
  //    不能因为大小写或空白被当成一个（识别不了的）语言名而静默钉死默认值。
  const override = typeof deps.localeOverride === 'string' ? deps.localeOverride.trim().toLowerCase() : ''
  if (override.length > 0 && override !== AUTO_LOCALE) return normalizeLocale(override)

  // 1) 宿主设置的显式 preference：与 profile 名无关，最权威。
  const preference = deps.localePreference
  if (typeof preference === 'string' && preference.trim().length > 0) {
    return normalizeLocale(preference.trim())
  }

  // 2) 桌面壳的 per-profile 语言文件。
  const file = deps.localeFile
  const key = deps.profileKey
  if (typeof file !== 'string' || file.length === 0 || typeof deps.readFile !== 'function') {
    log(`locale: 没有可用的语言来源，回落 ${DEFAULT_LOCALE}`)
    return DEFAULT_LOCALE
  }
  if (typeof key !== 'string' || key.length === 0) {
    log(`locale: 拿不到 profile 名，不猜 desktop-locale.json 的键，回落 ${DEFAULT_LOCALE}`)
    return DEFAULT_LOCALE
  }

  try {
    const parsed = JSON.parse(deps.readFile(file))
    const value = parsed?.[key]
    if (typeof value === 'string') {
      const primary = value.trim().toLowerCase().replace('_', '-').split('-')[0]
      if (!SUPPORTED_LOCALES.includes(primary)) {
        log(`locale: ${file} 里 ${JSON.stringify(key)} 的语言 ${JSON.stringify(value)} 不受支持，回落 ${DEFAULT_LOCALE}`)
      }
      return normalizeLocale(value)
    }
    log(`locale: ${file} 没有 ${JSON.stringify(key)} 这个 profile 的条目，回落 ${DEFAULT_LOCALE}`)
  } catch (error) {
    log(`locale: 读取 ${file} 失败（${String(error?.message ?? error)}），回落 ${DEFAULT_LOCALE}`)
  }
  return DEFAULT_LOCALE
}

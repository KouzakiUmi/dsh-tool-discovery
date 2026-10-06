// 宿主界面语言探测。
//
// DSH 把界面语言写在 $DSH_HOME/desktop-locale.json，形如 {"desktop":"en"}。
// 该路径不在宿主公开 API 内（@deepseek-ai/dsh-client-locale 只暴露设置项
// schema 与客户端 apply），服务端插件无法通过 ctx 读到它，因此按约定路径读取。
//
// 任何失败都回退 en：英文是协议文案的安全默认，猜错方向不会误导模型。
// 这里宁可"语言没跟上"也不要"语言猜错"——后者会让模型按另一种语言理解
// 错误码与 nextAction。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeLocale, DEFAULT_LOCALE } from './locale.mjs'

/** 从环境变量名推出 DSH home（与 profile-boot 的解析一致）。 */
function dshHomeFromEnv (env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return env.DSH_HOME
  return join(env.HOME ?? env.USERPROFILE ?? '', '.dsh')
}

/**
 * 探测宿主语言。
 * @param {{env?:Record<string,string|undefined>, readFile?:(p:string)=>string, log?:(m:string)=>void}} [deps]
 * @returns {string} 受支持的 locale id
 */
export function detectHostLocale (deps = {}) {
  const env = deps.env ?? process.env
  const read = deps.readFile ?? ((p) => readFileSync(p, 'utf8'))
  const log = deps.log ?? (() => {})

  // 显式覆盖优先：部署或用户可以钉住语言，不必依赖界面设置。
  if (typeof env.DSH_TOOL_DISCOVERY_LOCALE === 'string' && env.DSH_TOOL_DISCOVERY_LOCALE.length > 0) {
    return normalizeLocale(env.DSH_TOOL_DISCOVERY_LOCALE)
  }

  const file = join(dshHomeFromEnv(env), 'desktop-locale.json')
  try {
    const parsed = JSON.parse(read(file))
    const desktop = parsed?.desktop ?? parsed?.locale ?? parsed?.preference
    if (typeof desktop === 'string') return normalizeLocale(desktop)
    log(`locale: ${file} 无可识别字段，回落 ${DEFAULT_LOCALE}`)
  } catch (error) {
    log(`locale: 读取 ${file} 失败（${String(error?.message ?? error)}），回落 ${DEFAULT_LOCALE}`)
  }
  return DEFAULT_LOCALE
}

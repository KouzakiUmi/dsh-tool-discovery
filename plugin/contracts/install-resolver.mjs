// 阶段0 合同门禁专用 resolver（测试代码，不是产品入口）。
// 以消费安装解析锚点 <install>/package.json 为 createRequire 基点，把安装内公共包
// 解析成显式模块 URL，再用动态 import 取用；不修改任何依赖树，也不把机器绝对路径
// 写进未来产品代码。机器差异只出现在这里与 DSH_INSTALL_ROOT 环境变量覆盖中。
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 本机消费安装（DSH NEXT 桌面壳）的解析锚点目录。可用环境变量覆盖。
const DEFAULT_INSTALL_ROOT = 'C:/Program Files/DSH NEXT/resources/app'

export function installRoot () {
  return path.resolve(process.env.DSH_INSTALL_ROOT ?? DEFAULT_INSTALL_ROOT)
}

const anchorPath = path.join(installRoot(), 'package.json')
const requireFromAnchor = createRequire(anchorPath)

/** 解析安装内公共包为显式 file URL（如 @deepseek-ai/dsh-tools）。 */
export function dshModule (specifier) {
  return pathToFileURL(requireFromAnchor.resolve(specifier)).href
}

/** 该安装内是否存在可解析的包（只做解析探测，不 import、不抛错）。 */
export function hasDshModule (specifier) {
  try {
    requireFromAnchor.resolve(specifier)
    return true
  } catch {
    return false
  }
}

/**
 * 工具侧宿主能力（两版兼容）。
 *
 *   * `defineTool` 一直由 `@deepseek-ai/dsh-tools` 提供；
 *   * PTC SDK 渲染器（renderToolsSdk / renderToolsSdkPy）在 0.2.2 迁到
 *     `@deepseek-ai/dsh-tool-executor-ptc`，旧宿主仍在 dsh-tools 上，且新包在旧宿主
 *     不存在 —— 因此先取 dsh-tools 的导出，缺哪个再按包存在性去新包补。
 */
export async function dshToolCapabilities () {
  const tools = await import(dshModule('@deepseek-ai/dsh-tools'))
  let { renderToolsSdk, renderToolsSdkPy } = tools
  if ((typeof renderToolsSdk !== 'function' || typeof renderToolsSdkPy !== 'function')
    && hasDshModule('@deepseek-ai/dsh-tool-executor-ptc')) {
    const ptc = await import(dshModule('@deepseek-ai/dsh-tool-executor-ptc'))
    if (typeof renderToolsSdk !== 'function') renderToolsSdk = ptc.renderToolsSdk
    if (typeof renderToolsSdkPy !== 'function') renderToolsSdkPy = ptc.renderToolsSdkPy
  }
  return { defineTool: tools.defineTool, renderToolsSdk, renderToolsSdkPy }
}

/** 读取安装内包的 package.json（版本取证用）。 */
export function dshPackageJson (specifier) {
  const modulePath = fileURLToPath(dshModule(specifier))
  const pkgRoot = path.dirname(path.dirname(modulePath))
  return JSON.parse(requireFromAnchor('node:fs').readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
}

/** Loader 解析基：安装锚点目录 URL（裸包名在此解析域内导入）。 */
export function installBaseUrl () {
  return pathToFileURL(installRoot() + path.sep).href
}

/** 工作区内 fixture 模块的运行时 file URL（entry 树用绝对 file URL 导入）。 */
export function fixtureFileUrl (absolutePath) {
  return pathToFileURL(absolutePath).href
}

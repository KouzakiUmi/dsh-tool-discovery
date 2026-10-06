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

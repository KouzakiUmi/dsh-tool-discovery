// 组合测试专用 entry shim：把**测试 resolver** 解析出的 defineTool 注入 adapter。
// 产品代码（progressive-v2/adapters/**）不含任何安装绝对路径；机器差异只在这里
// 与 contracts/install-resolver.mjs 出现。
import { dshModule } from '../../contracts/install-resolver.mjs'
import { createProgressiveDiscoveryAdapter } from '../../adapters/dsh/index.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))

export default createProgressiveDiscoveryAdapter({ defineTool })

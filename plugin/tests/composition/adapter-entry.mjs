// 组合测试专用 entry shim：把**测试 resolver** 解析出的宿主依赖注入 adapter。
// 产品代码（plugin/adapters/**）不含任何安装绝对路径；机器差异只在这里
// 与 contracts/install-resolver.mjs 出现。
import { dshModule } from '../../contracts/install-resolver.mjs'
import { createProgressiveDiscoveryAdapter } from '../../adapters/dsh/index.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))
// 可信周期记录的声明式依赖：defineDomain / domainTable 取自安装内
// @deepseek-ai/dsh-storage-domain（0.2.1-alpha.1），z 取安装内 zod。
// 产品作者若把两者写成裸包名 import，这两个键会被忽略——注入无害。
const storageDomainApi = await import(dshModule('@deepseek-ai/dsh-storage-domain'))
const zModule = await import(dshModule('zod'))

export default createProgressiveDiscoveryAdapter({
  defineTool,
  storageDomainApi: { defineDomain: storageDomainApi.defineDomain, domainTable: storageDomainApi.domainTable },
  z: zModule.default ?? zModule
})

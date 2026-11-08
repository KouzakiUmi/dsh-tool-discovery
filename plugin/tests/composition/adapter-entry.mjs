// 组合测试专用 entry shim：把**测试 resolver** 解析出的宿主依赖注入 adapter。
// 产品代码（plugin/adapters/**）不含任何安装绝对路径；机器差异只在这里
// 与 contracts/install-resolver.mjs 出现。
import { dshModule, dshToolCapabilities } from '../../contracts/install-resolver.mjs'
import { createProgressiveDiscoveryAdapter } from '../../adapters/dsh/index.mjs'

// defineTool 来自 dsh-tools；PTC 渲染器按宿主版本探测（0.2.2 起在新包，见 helper 注释）。
const { defineTool, renderToolsSdk, renderToolsSdkPy } = await dshToolCapabilities()
const { isAgentLoopRequest } = await import(dshModule('@deepseek-ai/dsh-llm'))
// 可信周期记录的声明式依赖：defineDomain / domainTable 取自安装内
// @deepseek-ai/dsh-storage-domain（0.2.1-alpha.1），z 取安装内 zod。
// 产品作者若把两者写成裸包名 import，这两个键会被忽略——注入无害。
const storageDomainApi = await import(dshModule('@deepseek-ai/dsh-storage-domain'))
const zModule = await import(dshModule('zod'))

export default createProgressiveDiscoveryAdapter({
  defineTool, renderToolsSdk, renderToolsSdkPy, isAgentLoopRequest,
  storageDomainApi: { defineDomain: storageDomainApi.defineDomain, domainTable: storageDomainApi.domainTable },
  z: zModule.default ?? zModule
})

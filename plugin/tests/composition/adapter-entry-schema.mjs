// 组合测试专用 entry shim：除 defineTool、storageDomainApi、z 外**再注入 schemastery Schema**，
// 让产品 adapter 在测试里也带上 Config（设置面板的宿主侧前提）。
//
// 与 adapter-entry.mjs 的区别只有 Schema 这一行注入，因此既有 composition 的验收路径
// 完全不受影响：那条路径不注入 Schema，adapter 走"无 Config"降级，行为与从前一致。
import { dshModule, dshToolCapabilities } from '../../contracts/install-resolver.mjs'
import { createProgressiveDiscoveryAdapter } from '../../adapters/dsh/index.mjs'

// defineTool 来自 dsh-tools；PTC 渲染器按宿主版本探测（0.2.2 起在新包，见 helper 注释）。
const { defineTool, renderToolsSdk, renderToolsSdkPy } = await dshToolCapabilities()
const { isAgentLoopRequest } = await import(dshModule('@deepseek-ai/dsh-llm'))
const Schema = (await import(dshModule('@deepseek-ai/schemastery'))).default
const storageDomainApi = await import(dshModule('@deepseek-ai/dsh-storage-domain'))
const zModule = await import(dshModule('zod'))

export default createProgressiveDiscoveryAdapter({
  defineTool, renderToolsSdk, renderToolsSdkPy, isAgentLoopRequest,
  Schema,
  storageDomainApi: { defineDomain: storageDomainApi.defineDomain, domainTable: storageDomainApi.domainTable },
  z: zModule.default ?? zModule
})

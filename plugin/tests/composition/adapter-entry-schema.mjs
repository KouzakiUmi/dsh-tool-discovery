// 组合测试专用 entry shim：除 defineTool 外**再注入 schemastery Schema**，
// 让产品 adapter 在测试里也带上 Config（设置面板的宿主侧前提）。
//
// 与 adapter-entry.mjs 的区别只有这一行注入，因此既有 composition 的验收路径
// 完全不受影响：那条路径不注入 Schema，adapter 走"无 Config"降级，行为与从前一致。
import { dshModule } from '../../contracts/install-resolver.mjs'
import { createProgressiveDiscoveryAdapter } from '../../adapters/dsh/index.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))
const Schema = (await import(dshModule('@deepseek-ai/schemastery'))).default

export default createProgressiveDiscoveryAdapter({ defineTool, Schema })

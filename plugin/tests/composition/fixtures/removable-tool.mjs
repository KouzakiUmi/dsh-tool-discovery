// 组合测试 fixture：注册**一个**普通工具，随后可通过 dispose 该 entry 的 fiber 真实移除。
//
// 与 registry-churn 的区别：那个只加工具（覆盖「增加」面）；本 fixture 的存在意义是
// 让测试拿到一条**真实的减少**路径 —— 宿主把工具从 view() 里撤掉、广播 tools/change。
//
// 生产上确实发生过这种减少（见 .probe/unload-diagnosis-handoff.md 记录的实测：
// header 工具数 28 → 26，少了 hindsight 两项），所以它是真实形态而不是构造出来的边角。
//
// 只读宿主公开的 ctx.tools.register；不改 plugin/**。
import { dshModule } from '../../../contracts/install-resolver.mjs'
import { recordBody } from '../../../fixtures/mock-store.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))

const apply = (ctx) => {
  ctx.tools.register(defineTool({
    name: 'fixture_removable',
    description: 'Removable fixture: an ordinary tool that the test can take away by disposing this entry, then bring back by recreating it.',
    parameters: { text: { type: 'string', required: true, description: 'Payload.' } },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    execute (args, exec) {
      recordBody(exec, 'fixture_removable')
      return `removable ok: ${args?.text ?? ''}`
    },
  }))
}
apply.inject = ['tools']
export default apply
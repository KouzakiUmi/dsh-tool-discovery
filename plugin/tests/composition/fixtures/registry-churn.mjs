// 组合测试 fixture：注册期向宿主目录加入一项普通工具 → 触发真实 tools/change
// （资格代次 bump、ref/cursor 失效）。用于 R6 的"ref 与代次绑定"负控制。
// 不改宿主、不改 plugin/fixtures；仅 tests/composition/fixtures 新增（报告已解释）。
import { dshModule } from '../../../contracts/install-resolver.mjs'
import { recordBody } from '../../../fixtures/mock-store.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))

const apply = (ctx) => {
  ctx.tools.register(defineTool({
    name: 'fixture_churn_extra',
    description: 'Registry churn fixture: registers one extra ordinary tool so tools/change fires and eligibility generation advances.',
    parameters: { text: { type: 'string', required: true, description: 'Payload.' } },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }]
    },
    execute (args, exec) {
      recordBody(exec, 'fixture_churn_extra')
      return 'churn ok'
    }
  }))
}
apply.inject = ['tools']
export default apply

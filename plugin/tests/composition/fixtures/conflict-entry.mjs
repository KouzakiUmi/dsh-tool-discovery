// 组合测试 fixture：别的插件已占用控制入口名 tool_search（F20 / S11 冲突面）。
// adapter 必须在激活期检测到并**拒绝组合**，绝不覆盖本定义。
import { dshModule } from '../../../contracts/install-resolver.mjs'
import { recordBody } from '../../../fixtures/mock-store.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))

const apply = (ctx) => {
  ctx.tools.register(defineTool({
    name: 'tool_search',
    description: 'Third-party plugin already owning the tool_search name. The progressive adapter must refuse the composition, not replace this.',
    parameters: { query: { type: 'string', required: true, description: 'Pre-existing query.' } },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }]
    },
    execute (args, exec) {
      recordBody(exec, 'tool_search_third_party')
      return 'third-party tool_search'
    }
  }))
}
apply.inject = ['tools']
export default apply

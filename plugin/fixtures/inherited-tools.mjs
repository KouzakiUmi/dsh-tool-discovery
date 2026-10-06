// 阶段0 fixture：inherited（global 注册）普通工具。
// fixture_hidden_inherited  = 门禁1/2 的 inherited 隐藏目标；
// fixture_mutating         = 门禁4 的审批/参数拒绝目标（已加载后仍应被原链拒绝）。
import { dshModule } from '../contracts/install-resolver.mjs'
import { recordBody } from './mock-store.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))

const apply = (ctx, config) => {
  ctx.tools.register(defineTool({
    name: 'fixture_hidden_inherited',
    description: 'Fixture normal tool registered at the global layer (inherited by agents). Hidden from the model until explicitly loaded.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to echo back.' }
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }]
    },
    execute (args, exec) {
      recordBody(exec, 'fixture_hidden_inherited')
      return args.text
    }
  }))
  ctx.tools.register(defineTool({
    name: 'fixture_mutating',
    description: 'Fixture tool whose calls require user approval via the original host pipeline. Hidden until explicitly loaded.',
    parameters: {
      text: { type: 'string', required: true, description: 'Payload text.' },
      triggerApproval: { type: 'boolean', description: 'When true, the fixture policy asks for user approval before running.' }
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }]
    },
    execute (args, exec) {
      recordBody(exec, 'fixture_mutating')
      return args.text
    }
  }))
}
apply.inject = ['tools']
export default apply

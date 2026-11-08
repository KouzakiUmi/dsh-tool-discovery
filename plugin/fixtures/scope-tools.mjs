// 阶段0 fixture：scope-own（agent 作用域注册）普通工具与框架终止工具。
// fixture_hidden_scope   = scope-own 目标（rc.1 restrict 遮不住；披露可见，执行由 admission guard 覆盖）。
// fixture_final_output   = 框架强制输出/终止工具（仅 gate-d 会话注册；保留依赖 frameworkRetained 显式配置）。
// fixture_submit_result  = 名称形似输出的 decoy（未在可信配置内，必须保持隐藏）。
import { dshModule } from '../contracts/install-resolver.mjs'
import { recordBody } from './mock-store.mjs'

const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'))

const apply = (ctx, config) => {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.register(defineTool({
      name: 'fixture_hidden_scope',
      description: 'Fixture normal tool registered in the agent scope (scope-own). Visible on rc.1; requires admission before execution.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to echo back.' }
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }]
      },
      execute (args, exec) {
        recordBody(exec, 'fixture_hidden_scope')
        return args.text
      }
    }))
    if (String(agent.id).startsWith('gate-d')) {
      agent.ctx.tools.register(defineTool({
        name: 'fixture_final_output',
        description: 'Framework forced-output/termination tool: submits the final structured answer and concludes the turn.',
        parameters: {
          text: { type: 'string', required: true, description: 'Final structured answer text.' }
        },
        output: {
          schema: { type: 'string' },
          render: (args, value) => [{ type: 'text', text: value }]
        },
        execute (args, exec) {
          recordBody(exec, 'fixture_final_output')
          exec.concludeTurn()
          return args.text
        }
      }))
      agent.ctx.tools.register(defineTool({
        name: 'fixture_submit_result',
        description: 'Decoy whose name resembles an output/termination tool but is NOT configured as a framework retention.',
        parameters: {
          text: { type: 'string', required: true, description: 'Text.' }
        },
        output: {
          schema: { type: 'string' },
          render: (args, value) => [{ type: 'text', text: value }]
        },
        execute (args, exec) {
          recordBody(exec, 'fixture_submit_result')
          return args.text
        }
      }))
    }
  })
}
apply.inject = ['tools', 'agents']
export default apply

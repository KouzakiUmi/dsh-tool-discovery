// 组合测试 fixture：原宿主审批/参数链接缝（沿用阶段0形态，**不是** adapter 的 guard）。
// 目的：证明已加载工具仍被**原**审批链拒绝（S06），adapter 不提供任何旁路授权。
import { dshModule } from '../../../contracts/install-resolver.mjs'

const approvalStore = { outcomes: [] }
export function queueApproval (outcome) {
  approvalStore.outcomes.push(outcome)
}

const apply = (ctx) => {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'fixture_mutating' && exec.arguments?.triggerApproval === true) {
      return { kind: 'ask', reason: 'fixture policy: mutating tool requires user approval' }
    }
    return next()
  })
  ctx.on('approval/request', (req, next) => approvalStore.outcomes.shift() ?? next())
}
apply.inject = ['tools', 'approval']
export default apply

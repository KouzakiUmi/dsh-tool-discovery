// 阶段0 fixture 共享模型：工具 id/版本摘要等确定性投影 + 进程内探针状态。
// 这是合同探针的极简投影/回执折叠素材，明确不是产品实现。
import { createHash } from 'node:crypto'

/** 三个控制入口（门禁固定）。 */
export const ENTRY_NAMES = Object.freeze(['tool_list', 'tool_search', 'tool_load'])

/** 由工具名派生的确定性 fixture 工具 id。 */
export function toolIdFor (name) {
  return `tfx_${name}`
}

export function toolNameForId (toolId) {
  return toolId.startsWith('tfx_') ? toolId.slice(4) : null
}

/** 定义 wire 面（name/description/parameters）的 fixture 摘要。 */
export function schemaDigestFor (definition) {
  const wire = JSON.stringify({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters
  })
  return `sha256:fixture-${createHash('sha256').update(wire).digest('hex').slice(0, 16)}`
}

/** fixture revision：同时覆盖摘要与技能版本 s1（探针语义）。 */
export function revisionFor (definition) {
  return `r_${schemaDigestFor(definition).slice(-8)}`
}

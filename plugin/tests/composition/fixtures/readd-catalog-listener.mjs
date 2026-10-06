// 组合测试 fixture：模拟"别的 listener 在 adapter 投影**之后**把全量 schema 又加回去"
// （03 §3.2 的"其它 waterfall 重加全量 schema → INCOMPATIBLE_COMPOSITION"面）。
//
// 本 fixture 比 adapter entry 更早装配，因此它的 system-prompt/assemble listener
// 在 waterfall 中更外层：会在 next() 拿到 adapter 的**最终投影结果**之后再追加全量目录。
// adapter 必须在 canonical request/header 上观察到这一点并 fail closed。
const apply = (ctx) => {
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const transformed = await next()
    const scope = context?.scope ?? context?.agent
    const extra = ctx.tools.schemas(scope).filter((schema) => !transformed.tools.some((tool) => tool.name === schema.name))
    return { ...transformed, tools: [...transformed.tools, ...extra] }
  })
}
apply.inject = ['tools', 'systemPrompt']
export default apply

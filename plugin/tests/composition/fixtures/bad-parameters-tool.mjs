// 测试专用：一个 `parameters` 为数组的工具定义。
//
// 宿主 `tools.register()` 只校验 output / timeoutMs / name，**接受**这种形状；而 domain 的
// `validateBinding` 会拒绝（`wire.parameters` 必须是普通对象）。用于验证适配层在注册表
// 边界处跳过畸形绑定——若放任它进入目录，`buildCatalog` 会在建 runtime 时抛错，
// 后果是新会话创建被宿主拒绝、tools/change 刷新链中断。
export function badParametersDefinition(name = 'probe_bad_parameters') {
  return {
    name,
    description: 'Malformed definition: parameters is an array instead of an object.',
    parameters: [],
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => 'should never run',
  };
}

export default { badParametersDefinition };

// 仅组合测试：声明式 PTC provider，不执行任意 TS/Python 或启动 worker。
// SDK 渲染、run_code transport、嵌套 tools.execute、canonical 日志和 llm 请求均为真实宿主。
export const runs = [];

export default function apply(ctx, config) {
  ctx.provide('ptcRuntime', {
    language: config.language ?? 'typescript',
    executionInstructions: 'Declarative test runtime; no external effects.',
    resolve: (request) => request,
    async run(request) {
      const tools = request.bindings.find((binding) => binding.global === 'tools').functions;
      const results = [];
      for (const action of JSON.parse(request.program)) {
        try { results.push({ name: action.name, ok: true, value: await tools[action.name](action.arguments) }); }
        catch (error) { results.push({ name: action.name, ok: false, error: String(error.message) }); }
      }
      runs.push(results);
      return { logs: [], value: results };
    },
  });
}

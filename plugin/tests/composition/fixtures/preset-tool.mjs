// 测试专用：在真实 preset 安装作用域内登记工具，不写用户 profile。
import { dshModule } from '../../../contracts/install-resolver.mjs';
import { recordBody } from '../../../fixtures/mock-store.mjs';
const { defineTool } = await import(dshModule('@deepseek-ai/dsh-tools'));
function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: config.name,
    description: 'Fixture tool contributed by the bound preset.',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) { recordBody(exec, config.name); return args.text; },
  }));
}
apply.inject = ['tools'];
export default apply;
